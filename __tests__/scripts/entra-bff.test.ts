import { createServer, request, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
} from "jose";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEntraBff,
  loadEntraBffConfig,
} from "../../scripts/entra-bff.mjs";
import { parseArgs, startStaticServer } from "../../scripts/static-server.mjs";

const tenantId = "11111111-1111-1111-1111-111111111111";
const clientId = "22222222-2222-2222-2222-222222222222";
const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;

function entraEnv(overrides: Record<string, string> = {}) {
  return {
    AGENT_CANVAS_ENTRA_TENANT_ID: tenantId,
    AGENT_CANVAS_ENTRA_CLIENT_ID: clientId,
    AGENT_CANVAS_ENTRA_CLIENT_SECRET: "client-secret",
    AGENT_CANVAS_ENTRA_REDIRECT_URI: "https://canvas.example.com/auth/callback",
    AGENT_CANVAS_ENTRA_COOKIE_SECRET: "0123456789abcdef0123456789abcdef",
    ...overrides,
  };
}

function importAssertionKey(secret: string) {
  return importJWK(
    {
      kty: "oct",
      k: Buffer.from(secret, "utf8").toString("base64url"),
      alg: "HS256",
    },
    "HS256",
  );
}

describe("loadEntraBffConfig", () => {
  it("keeps Entra mode disabled when it is not configured", () => {
    expect(loadEntraBffConfig({})).toBeNull();
  });

  it("fails fast when required configuration is incomplete", () => {
    expect(() =>
      loadEntraBffConfig({ AGENT_CANVAS_ENTRA_CLIENT_ID: clientId }),
    ).toThrow(
      /missing: .*TENANT_ID.*CLIENT_SECRET.*REDIRECT_URI.*COOKIE_SECRET/,
    );
  });

  it("requires HTTPS redirects and a strong cookie secret", () => {
    expect(() =>
      loadEntraBffConfig(
        entraEnv({
          AGENT_CANVAS_ENTRA_REDIRECT_URI:
            "http://canvas.example.com/auth/callback",
        }),
      ),
    ).toThrow(/must use https/);
    expect(() =>
      loadEntraBffConfig(
        entraEnv({ AGENT_CANVAS_ENTRA_COOKIE_SECRET: "too-short" }),
      ),
    ).toThrow(/at least 32 bytes/);
  });

  it("requires an internal Agent Server key without exposing it to the browser", () => {
    expect(() => parseArgs([], entraEnv())).toThrow(/requires SESSION_API_KEY/);

    const config = parseArgs([], {
      ...entraEnv(),
      SESSION_API_KEY: "internal-key",
    });
    expect(config.sessionApiKey).toBe("internal-key");
    expect(config.entraBff).not.toBeNull();
  });
});

describe("Microsoft Entra BFF", () => {
  const servers: Server[] = [];
  const tempDirs: string[] = [];
  let privateKey: CryptoKey;
  let localJwks: ReturnType<typeof createLocalJWKSet>;

  beforeEach(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    localJwks = createLocalJWKSet({
      keys: [{ ...publicJwk, kid: "test-key", alg: "RS256", use: "sig" }],
    });
  });

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    );
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function listen(server: Server) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    return `http://127.0.0.1:${address.port}`;
  }

  async function rawRequest(
    url: string,
    headers: Record<string, string> = {},
    method = "GET",
  ) {
    return new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const req = request(url, { headers, method }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          }),
        );
      });
      req.on("error", reject);
      req.end();
    });
  }

  function makeConfig(overrides: Record<string, string> = {}) {
    return {
      ...loadEntraBffConfig(entraEnv(overrides)),
      secureCookies: false,
    };
  }

  async function startAuthenticatedServer({
    idTokenNonce,
  }: { idTokenNonce?: string } = {}) {
    let nonce = "";
    let tokenRequestBody = "";
    let upstreamIdentityAssertion: string | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/keys`,
        });
      }
      if (url === `${issuer}/token`) {
        tokenRequestBody = String(init?.body);
        const idToken = await new SignJWT({
          nonce: idTokenNonce ?? nonce,
          tid: tenantId,
          oid: "user-object-id",
          name: "Halo User",
          preferred_username: "halo@example.com",
        })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer(issuer)
          .setAudience(clientId)
          .setSubject("user-subject")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        return Response.json({ id_token: idToken });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };

    let upstreamHttpKey: string | undefined;
    const upstream = createServer((req, res) => {
      upstreamHttpKey = req.headers["x-session-api-key"] as string | undefined;
      upstreamIdentityAssertion = req.headers[
        "x-openhands-identity-assertion"
      ] as string | undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    const upstreamOrigin = await listen(upstream);

    const buildDir = mkdtempSync(path.join(tmpdir(), "entra-bff-"));
    tempDirs.push(buildDir);
    writeFileSync(
      path.join(buildDir, "index.html"),
      "<html><head></head><body>app</body></html>",
    );

    const server = await startStaticServer({
      port: 0,
      host: "127.0.0.1",
      dir: buildDir,
      routes: {
        "/api": upstreamOrigin,
        "/alive": upstreamOrigin,
        "/sockets": upstreamOrigin,
      },
      sessionApiKey: "internal-agent-server-key",
      entraBff: makeConfig({
        OH_TRUSTED_IDENTITY_ASSERTION_SECRET:
          "halo-identity-assertion-secret-32-bytes",
      }),
      entraBffOptions: { fetchImpl, jwks: localJwks },
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const origin = `http://127.0.0.1:${address.port}`;

    const login = await fetch(`${origin}/auth/login?returnTo=%2Fcanvas`, {
      redirect: "manual",
    });
    const authorizationUrl = new URL(login.headers.get("location")!);
    nonce = authorizationUrl.searchParams.get("nonce")!;
    const state = authorizationUrl.searchParams.get("state")!;
    const authCookie = login.headers.getSetCookie()[0].split(";")[0];

    return {
      authCookie,
      authorizationUrl,
      getTokenRequestBody: () => tokenRequestBody,
      getUpstreamHttpKey: () => upstreamHttpKey,
      getUpstreamIdentityAssertion: () => upstreamIdentityAssertion,
      origin,
      state,
      upstream,
    };
  }

  it("starts authorization-code flow with PKCE, state, nonce, and secure cookie attributes", async () => {
    const config = loadEntraBffConfig(entraEnv());
    const bff = createEntraBff(config, {
      fetchImpl: async () =>
        Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/keys`,
        }),
    });
    const server = createServer((req, res) => {
      void bff!.handleHttp(req, res);
    });
    const origin = await listen(server);

    const response = await fetch(`${origin}/auth/login`, {
      redirect: "manual",
    });
    const authorizationUrl = new URL(response.headers.get("location")!);
    const cookie = response.headers.getSetCookie()[0];

    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorizationUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorizationUrl.searchParams.get("state")).toBeTruthy();
    expect(authorizationUrl.searchParams.get("nonce")).toBeTruthy();
    expect(cookie).toContain("__Host-agent-canvas-entra-auth=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("rejects invalid state, validates the ID token, and creates a current-user session", async () => {
    const { authCookie, origin, state, getTokenRequestBody } =
      await startAuthenticatedServer();

    const invalid = await fetch(
      `${origin}/auth/callback?code=test-code&state=wrong`,
      { headers: { Cookie: authCookie }, redirect: "manual" },
    );
    expect(invalid.status).toBe(400);

    const callback = await fetch(
      `${origin}/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: authCookie }, redirect: "manual" },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/canvas");
    expect(getTokenRequestBody()).toContain("code_verifier=");
    expect(getTokenRequestBody()).toContain("client_secret=client-secret");

    const sessionCookie = callback.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("agent-canvas-entra-session="))!
      .split(";")[0];
    const currentUser = await fetch(`${origin}/auth/me`, {
      headers: { Cookie: sessionCookie },
    });

    expect(await currentUser.json()).toEqual({
      id: "user-object-id",
      name: "Halo User",
      username: "halo@example.com",
      tenantId,
    });
  });

  it("rejects an ID token whose nonce does not match the authorization request", async () => {
    const { authCookie, origin, state } = await startAuthenticatedServer({
      idTokenNonce: "wrong-nonce",
    });

    const callback = await fetch(
      `${origin}/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: authCookie }, redirect: "manual" },
    );

    expect(callback.status).toBe(401);
    await expect(callback.json()).resolves.toEqual({
      error: "invalid_id_token",
    });
  });

  it("signs the Entra identity for trusted upstream services", async () => {
    const assertionSecret = "halo-identity-assertion-secret-32-bytes";
    const config = {
      ...makeConfig(),
      identityAssertion: {
        secret: assertionSecret,
        issuer: "openhands-halo-bff",
        audience: "openhands-sandbox-server",
        header: "X-OpenHands-Identity-Assertion",
        lifetimeSeconds: 60,
      },
    };
    const bff = createEntraBff(config);
    const req = {
      trustedIdentity: {
        oid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        tid: tenantId,
        name: "Halo User",
        preferred_username: "halo@example.com",
      },
    };

    const headers = await bff!.getUpstreamIdentityHeaders(req);
    const assertion = headers["X-OpenHands-Identity-Assertion"];
    const verified = await jwtVerify(
      assertion,
      await importAssertionKey(assertionSecret),
      {
        issuer: "openhands-halo-bff",
        audience: "openhands-sandbox-server",
      },
    );

    expect(verified.payload).toMatchObject({
      sub: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      oid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      tid: tenantId,
      name: "Halo User",
      preferred_username: "halo@example.com",
    });
  });

  it("protects static and API routes, exempts probes, injects the internal key, and logs out", async () => {
    const {
      authCookie,
      origin,
      state,
      getUpstreamHttpKey,
      getUpstreamIdentityAssertion,
    } = await startAuthenticatedServer();

    const staticResponse = await fetch(origin, {
      headers: { Accept: "text/html" },
      redirect: "manual",
    });
    expect(staticResponse.status).toBe(302);
    expect(staticResponse.headers.get("location")).toContain("/auth/login");

    const apiResponse = await rawRequest(`${origin}/api/settings`);
    expect(apiResponse.status).toBe(401);
    const probeResponse = await rawRequest(`${origin}/alive`);
    expect(probeResponse.status).toBe(200);

    const callback = await fetch(
      `${origin}/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: authCookie }, redirect: "manual" },
    );
    const sessionCookie = callback.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("agent-canvas-entra-session="))!
      .split(";")[0];
    const protectedApi = await rawRequest(`${origin}/api/halo-identity-test`, {
      Cookie: sessionCookie,
      "X-OpenHands-Identity-Assertion": "attacker-assertion",
      "X-Session-API-Key": "attacker-key",
    });
    expect(protectedApi.status).toBe(200);
    expect(getUpstreamHttpKey()).toBe("internal-agent-server-key");
    const identityAssertion = getUpstreamIdentityAssertion();
    expect(identityAssertion).toBeTruthy();
    const verifiedIdentity = await jwtVerify(
      identityAssertion!,
      await importAssertionKey("halo-identity-assertion-secret-32-bytes"),
      {
        issuer: "openhands-halo-bff",
        audience: "openhands-sandbox-server",
      },
    );
    expect(verifiedIdentity.payload).toMatchObject({
      sub: "user-object-id",
      oid: "user-object-id",
      tid: tenantId,
    });

    const authenticated = await rawRequest(
      `${origin}/api/authenticate`,
      { Cookie: sessionCookie },
      "POST",
    );
    expect(authenticated.status).toBe(200);
    const login = await fetch(`${origin}/login?returnTo=%2Fcanvas`, {
      redirect: "manual",
    });
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe(
      "/auth/login?returnTo=%2Fcanvas",
    );

    const protectedHtml = await rawRequest(origin, {
      Accept: "text/html",
      Cookie: sessionCookie,
    });
    expect(protectedHtml.body).toContain(
      "window.__AGENT_CANVAS_ENTRA_BFF__=true",
    );
    expect(protectedHtml.body).not.toContain("internal-agent-server-key");

    const logout = await fetch(`${origin}/auth/logout`, {
      headers: { Cookie: sessionCookie },
      redirect: "manual",
    });
    expect(logout.status).toBe(302);
    expect(logout.headers.getSetCookie()[0]).toContain("Max-Age=0");
  });

  it("rejects unauthenticated WebSockets and injects the internal key after login", async () => {
    const { authCookie, origin, state, upstream } =
      await startAuthenticatedServer();
    const wsServer = new WebSocketServer({ server: upstream });
    let upstreamIdentityAssertion: string | undefined;
    let upstreamKey: string | undefined;
    wsServer.on("connection", (socket, req) => {
      upstreamIdentityAssertion = req.headers[
        "x-openhands-identity-assertion"
      ] as string | undefined;
      upstreamKey = req.headers["x-session-api-key"] as string | undefined;
      socket.close();
    });

    const unauthenticatedStatus = await new Promise<number>((resolve) => {
      const socket = new WebSocket(origin.replace("http", "ws") + "/sockets");
      socket.on("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
      });
    });
    expect(unauthenticatedStatus).toBe(401);

    const callback = await fetch(
      `${origin}/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: authCookie }, redirect: "manual" },
    );
    const sessionCookie = callback.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("agent-canvas-entra-session="))!
      .split(";")[0];

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(origin.replace("http", "ws") + "/sockets", {
        headers: { Cookie: sessionCookie },
      });
      socket.on("open", () => resolve());
      socket.on("error", reject);
    });
    expect(upstreamKey).toBe("internal-agent-server-key");
    const verifiedIdentity = await jwtVerify(
      upstreamIdentityAssertion!,
      await importAssertionKey("halo-identity-assertion-secret-32-bytes"),
      {
        issuer: "openhands-halo-bff",
        audience: "openhands-sandbox-server",
      },
    );
    expect(verifiedIdentity.payload.oid).toBe("user-object-id");
    wsServer.close();
  });
});
