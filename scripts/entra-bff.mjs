import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  EncryptJWT,
  customFetch,
  createRemoteJWKSet,
  jwtDecrypt,
  jwtVerify,
} from "jose";

const REQUIRED_ENV = {
  tenantId: "AGENT_CANVAS_ENTRA_TENANT_ID",
  clientId: "AGENT_CANVAS_ENTRA_CLIENT_ID",
  clientSecret: "AGENT_CANVAS_ENTRA_CLIENT_SECRET",
  redirectUri: "AGENT_CANVAS_ENTRA_REDIRECT_URI",
  cookieSecret: "AGENT_CANVAS_ENTRA_COOKIE_SECRET",
};
const OPTIONAL_ENV = [
  "AGENT_CANVAS_ENTRA_AUTHORITY",
  "AGENT_CANVAS_ENTRA_SCOPES",
  "AGENT_CANVAS_ENTRA_SESSION_MAX_AGE_SECONDS",
];
const DEFAULT_AUTHORITY = "https://login.microsoftonline.com";
const DEFAULT_SCOPES = ["openid", "profile", "email"];
const DEFAULT_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const AUTH_COOKIE_MAX_AGE_SECONDS = 10 * 60;
const PROBE_PATHS = new Set(["/alive", "/health", "/ready"]);

function trimToNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeAuthority(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("AGENT_CANVAS_ENTRA_AUTHORITY must use https");
  }
  return url.href.replace(/\/+$/, "");
}

function parsePositiveInteger(value, name, fallback) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function validateRedirectUri(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("AGENT_CANVAS_ENTRA_REDIRECT_URI must use https");
  }
  return url.href;
}

export function loadEntraBffConfig(env = process.env) {
  const configuredNames = [
    ...Object.values(REQUIRED_ENV),
    ...OPTIONAL_ENV,
  ].filter((name) => trimToNull(env[name]));
  if (configuredNames.length === 0) return null;

  const missing = Object.values(REQUIRED_ENV).filter(
    (name) => !trimToNull(env[name]),
  );
  if (missing.length > 0) {
    throw new Error(
      `Incomplete Microsoft Entra BFF configuration; missing: ${missing.join(", ")}`,
    );
  }

  const cookieSecret = trimToNull(env[REQUIRED_ENV.cookieSecret]);
  if (Buffer.byteLength(cookieSecret, "utf8") < 32) {
    throw new Error(
      "AGENT_CANVAS_ENTRA_COOKIE_SECRET must be at least 32 bytes",
    );
  }

  const authority = normalizeAuthority(
    trimToNull(env.AGENT_CANVAS_ENTRA_AUTHORITY) ?? DEFAULT_AUTHORITY,
  );
  const tenantId = trimToNull(env[REQUIRED_ENV.tenantId]);
  const issuer = `${authority}/${encodeURIComponent(tenantId)}/v2.0`;
  const scopes =
    trimToNull(env.AGENT_CANVAS_ENTRA_SCOPES)?.split(/\s+/).filter(Boolean) ??
    DEFAULT_SCOPES;
  for (const requiredScope of ["openid", "profile"]) {
    if (!scopes.includes(requiredScope)) {
      throw new Error(
        `AGENT_CANVAS_ENTRA_SCOPES must include ${requiredScope}`,
      );
    }
  }

  return {
    tenantId,
    clientId: trimToNull(env[REQUIRED_ENV.clientId]),
    clientSecret: trimToNull(env[REQUIRED_ENV.clientSecret]),
    redirectUri: validateRedirectUri(trimToNull(env[REQUIRED_ENV.redirectUri])),
    cookieSecret,
    authority,
    issuer,
    scopes,
    sessionMaxAgeSeconds: parsePositiveInteger(
      trimToNull(env.AGENT_CANVAS_ENTRA_SESSION_MAX_AGE_SECONDS),
      "AGENT_CANVAS_ENTRA_SESSION_MAX_AGE_SECONDS",
      DEFAULT_SESSION_MAX_AGE_SECONDS,
    ),
    secureCookies: true,
  };
}

function deriveCookieKey(secret) {
  return new Uint8Array(createHash("sha256").update(secret, "utf8").digest());
}

function base64UrlRandom(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    try {
      cookies.set(
        part.slice(0, separator).trim(),
        decodeURIComponent(part.slice(separator + 1).trim()),
      );
    } catch {
      // Ignore malformed cookies instead of failing the whole request.
    }
  }
  return cookies;
}

function cookieNames(secure) {
  const prefix = secure ? "__Host-" : "";
  return {
    auth: `${prefix}agent-canvas-entra-auth`,
    session: `${prefix}agent-canvas-entra-session`,
  };
}

function serializeCookie(name, value, { maxAge, secure }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(name, secure) {
  return serializeCookie(name, "", { maxAge: 0, secure });
}

function safeReturnTo(value, fallback = "/") {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return fallback;
  }
  return value;
}

function equalSecret(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function writeJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function writeUnauthorized(res) {
  writeJson(res, 401, { error: "authentication_required" });
}

function requireHttpsEndpoint(value, name) {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`Microsoft Entra ${name} must use https`);
  }
  return url.href;
}

function rejectWebSocket(socket) {
  socket.end(
    "HTTP/1.1 401 Unauthorized\r\n" +
      "Connection: close\r\n" +
      "Content-Type: application/json\r\n" +
      "Content-Length: 35\r\n\r\n" +
      '{"error":"authentication_required"}',
  );
}

async function encryptCookie(payload, key, maxAgeSeconds) {
  return new EncryptJWT(payload)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${maxAgeSeconds}s`)
    .encrypt(key);
}

async function decryptCookie(value, key) {
  const { payload } = await jwtDecrypt(value, key, {
    keyManagementAlgorithms: ["dir"],
    contentEncryptionAlgorithms: ["A256GCM"],
  });
  return payload;
}

function publicUser(payload) {
  return {
    id: payload.oid ?? payload.sub,
    name: payload.name ?? null,
    username: payload.preferred_username ?? payload.email ?? null,
    tenantId: payload.tid,
  };
}

export function createEntraBff(
  config,
  { fetchImpl = globalThis.fetch, jwks = null } = {},
) {
  if (!config) return null;
  const key = deriveCookieKey(config.cookieSecret);
  const names = cookieNames(config.secureCookies);
  let discoveryPromise;
  let remoteJwks;

  async function getDiscovery() {
    discoveryPromise ??= (async () => {
      const response = await fetchImpl(
        `${config.issuer}/.well-known/openid-configuration`,
        { headers: { Accept: "application/json" } },
      );
      if (!response.ok) {
        throw new Error(
          `Microsoft Entra discovery failed with HTTP ${response.status}`,
        );
      }
      const discovery = await response.json();
      if (
        discovery.issuer !== config.issuer ||
        typeof discovery.authorization_endpoint !== "string" ||
        typeof discovery.token_endpoint !== "string" ||
        typeof discovery.jwks_uri !== "string"
      ) {
        throw new Error("Microsoft Entra discovery document is invalid");
      }
      return {
        ...discovery,
        authorization_endpoint: requireHttpsEndpoint(
          discovery.authorization_endpoint,
          "authorization endpoint",
        ),
        token_endpoint: requireHttpsEndpoint(
          discovery.token_endpoint,
          "token endpoint",
        ),
        jwks_uri: requireHttpsEndpoint(discovery.jwks_uri, "JWKS endpoint"),
      };
    })();
    try {
      return await discoveryPromise;
    } catch (error) {
      discoveryPromise = undefined;
      throw error;
    }
  }

  async function getSession(req) {
    const value = parseCookies(req.headers.cookie).get(names.session);
    if (!value) return null;
    try {
      return await decryptCookie(value, key);
    } catch {
      return null;
    }
  }

  async function handleLogin(req, res, requestUrl) {
    const discovery = await getDiscovery();
    const state = base64UrlRandom();
    const nonce = base64UrlRandom();
    const verifier = base64UrlRandom(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authCookie = await encryptCookie(
      {
        state,
        nonce,
        verifier,
        returnTo: safeReturnTo(requestUrl.searchParams.get("returnTo")),
      },
      key,
      AUTH_COOKIE_MAX_AGE_SECONDS,
    );
    const authorizationUrl = new URL(discovery.authorization_endpoint);
    authorizationUrl.searchParams.set("client_id", config.clientId);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
    authorizationUrl.searchParams.set("response_mode", "query");
    authorizationUrl.searchParams.set("scope", config.scopes.join(" "));
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    res.writeHead(302, {
      Location: authorizationUrl.href,
      "Cache-Control": "no-store",
      "Set-Cookie": serializeCookie(names.auth, authCookie, {
        maxAge: AUTH_COOKIE_MAX_AGE_SECONDS,
        secure: config.secureCookies,
      }),
    });
    res.end();
  }

  async function handleCallback(req, res, requestUrl) {
    const authCookieValue = parseCookies(req.headers.cookie).get(names.auth);
    const code = requestUrl.searchParams.get("code");
    const returnedState = requestUrl.searchParams.get("state");
    if (!authCookieValue || !code || !returnedState) {
      writeJson(res, 400, { error: "invalid_callback" });
      return;
    }

    let authState;
    try {
      authState = await decryptCookie(authCookieValue, key);
    } catch {
      writeJson(res, 400, { error: "invalid_callback" });
      return;
    }
    if (
      typeof authState.state !== "string" ||
      typeof authState.nonce !== "string" ||
      typeof authState.verifier !== "string" ||
      !equalSecret(returnedState, authState.state)
    ) {
      writeJson(res, 400, { error: "invalid_state" });
      return;
    }

    const discovery = await getDiscovery();
    const tokenResponse = await fetchImpl(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        code_verifier: authState.verifier,
        scope: config.scopes.join(" "),
      }),
    });
    if (!tokenResponse.ok) {
      writeJson(res, 401, { error: "token_exchange_failed" });
      return;
    }
    const tokenBody = await tokenResponse.json();
    if (typeof tokenBody.id_token !== "string") {
      writeJson(res, 401, { error: "missing_id_token" });
      return;
    }

    const verificationKey =
      jwks ??
      (remoteJwks ??= createRemoteJWKSet(new URL(discovery.jwks_uri), {
        [customFetch]: fetchImpl,
      }));
    let payload;
    try {
      ({ payload } = await jwtVerify(tokenBody.id_token, verificationKey, {
        issuer: config.issuer,
        audience: config.clientId,
        algorithms: ["RS256"],
      }));
    } catch {
      writeJson(res, 401, { error: "invalid_id_token" });
      return;
    }
    if (
      payload.tid !== config.tenantId ||
      typeof payload.nonce !== "string" ||
      !equalSecret(payload.nonce, authState.nonce)
    ) {
      writeJson(res, 401, { error: "invalid_id_token" });
      return;
    }

    const sessionCookie = await encryptCookie(
      {
        sub: payload.sub,
        oid: payload.oid,
        tid: payload.tid,
        name: payload.name,
        preferred_username: payload.preferred_username,
        email: payload.email,
      },
      key,
      config.sessionMaxAgeSeconds,
    );
    res.writeHead(302, {
      Location: safeReturnTo(authState.returnTo),
      "Cache-Control": "no-store",
      "Set-Cookie": [
        serializeCookie(names.session, sessionCookie, {
          maxAge: config.sessionMaxAgeSeconds,
          secure: config.secureCookies,
        }),
        clearCookie(names.auth, config.secureCookies),
      ],
    });
    res.end();
  }

  async function handleHttp(req, res) {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;

    if (PROBE_PATHS.has(pathname)) return false;
    if (pathname === "/auth/login") {
      if (req.method !== "GET") {
        writeJson(res, 405, { error: "method_not_allowed" });
      } else {
        await handleLogin(req, res, requestUrl);
      }
      return true;
    }
    if (pathname === "/auth/callback") {
      if (req.method !== "GET") {
        writeJson(res, 405, { error: "method_not_allowed" });
      } else if (requestUrl.searchParams.has("error")) {
        writeJson(res, 401, { error: "entra_authorization_failed" });
      } else {
        await handleCallback(req, res, requestUrl);
      }
      return true;
    }
    if (pathname === "/auth/logout") {
      res.writeHead(req.method === "GET" ? 302 : 204, {
        ...(req.method === "GET" ? { Location: "/" } : {}),
        "Cache-Control": "no-store",
        "Set-Cookie": clearCookie(names.session, config.secureCookies),
      });
      res.end();
      return true;
    }
    if (pathname === "/auth/me") {
      const session = await getSession(req);
      if (!session) writeUnauthorized(res);
      else writeJson(res, 200, publicUser(session));
      return true;
    }

    const session = await getSession(req);
    if (session) return false;
    const acceptsHtml = /\btext\/html\b/i.test(req.headers.accept ?? "");
    if ((req.method === "GET" || req.method === "HEAD") && acceptsHtml) {
      const returnTo = safeReturnTo(req.url ?? "/");
      res.writeHead(302, {
        Location: `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
        "Cache-Control": "no-store",
      });
      res.end();
    } else {
      writeUnauthorized(res);
    }
    return true;
  }

  async function authorizeWebSocket(req, socket) {
    const session = await getSession(req);
    if (session) return true;
    rejectWebSocket(socket);
    return false;
  }

  return { authorizeWebSocket, handleHttp, names };
}
