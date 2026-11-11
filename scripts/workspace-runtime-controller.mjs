import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";

const API_PREFIX = "/api/workspace-runtimes";
const PROXY_PREFIX = "/workspace-runtimes";
const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
const MANAGED_BY_VALUE = "openhands-halo-workspace-controller";
const WORKSPACE_ID_LABEL = "openhands.halo/workspace-id";
const WORKSPACE_RECORD_LABEL = "openhands.halo/workspace-record";
const WORKSPACE_RECORD_DATA_KEY = "workspace.json";
const DEFAULT_TOKEN_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/token";
const DEFAULT_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
const DEFAULT_HOST = "kubernetes.default.svc";
const DEFAULT_PORT = 443;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const WORKSPACE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,62}$/;
const GIT_REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,254}$/;
const WORKSPACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function trimToNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function parsePositiveInteger(value, name, fallback) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function workspaceResourceName(id) {
  return `workspace-${id}`;
}

function runtimeServiceUrl(namespace, id) {
  return `http://${workspaceResourceName(id)}.${namespace}.svc.cluster.local:8000`;
}

function publicRuntimeUrl(id) {
  return `${PROXY_PREFIX}/${id}`;
}

function encodePathSegment(value) {
  return encodeURIComponent(value);
}

function collectionPath(namespace, resource) {
  return `/apis/${resource.apiGroup}/${resource.apiVersion}/namespaces/${encodePathSegment(namespace)}/${resource.plural}`;
}

function coreCollectionPath(namespace, plural) {
  return `/api/v1/namespaces/${encodePathSegment(namespace)}/${plural}`;
}

function itemPath(collection, name) {
  return `${collection}/${encodePathSegment(name)}`;
}

function jsonResponse(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function errorResponse(res, status, code, message) {
  jsonResponse(res, status, { error: { code, message } });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      error.code = "request_too_large";
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    error.code = "invalid_json";
    throw error;
  }
}

function validateSource(rawSource) {
  if (rawSource === undefined || rawSource === null) return { kind: "none" };
  if (typeof rawSource !== "object" || Array.isArray(rawSource)) {
    throw new Error("source must be an object");
  }
  if (rawSource.kind === "none") return { kind: "none" };
  if (rawSource.kind !== "git") {
    throw new Error("source.kind must be 'none' or 'git'");
  }
  const rawUrl = trimToNull(rawSource.url);
  if (!rawUrl) throw new Error("Git source requires a repository URL");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Git repository URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(
      "Git repository URL must be HTTPS and must not contain credentials or a fragment",
    );
  }
  const ref = trimToNull(rawSource.ref);
  if (ref && !GIT_REF_PATTERN.test(ref)) {
    throw new Error("Git ref contains unsupported characters");
  }
  return {
    kind: "git",
    url: url.href,
    ...(ref ? { ref } : {}),
  };
}

function validateCreateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be an object");
  }
  const name = trimToNull(body.name);
  if (!name || !WORKSPACE_NAME_PATTERN.test(name)) {
    throw new Error(
      "Workspace name must be 1-63 characters and use letters, numbers, spaces, '.', '_' or '-'",
    );
  }
  const id = trimToNull(body.id);
  if (id && !WORKSPACE_ID_PATTERN.test(id)) {
    throw new Error("Workspace id must be a UUID");
  }
  return { id, name, source: validateSource(body.source) };
}

function parseWorkspaceRecord(configMap) {
  const raw = configMap?.data?.[WORKSPACE_RECORD_DATA_KEY];
  if (typeof raw !== "string") {
    throw new Error(`Workspace record ${configMap?.metadata?.name} is invalid`);
  }
  return JSON.parse(raw);
}

function runtimeDescriptor(record, deployment) {
  const deleting = Boolean(deployment?.metadata?.deletionTimestamp);
  const replicas = deployment?.spec?.replicas ?? 0;
  const readyReplicas = deployment?.status?.readyReplicas ?? 0;
  const failedCondition = deployment?.status?.conditions?.find(
    (condition) =>
      condition.status === "False" &&
      (condition.type === "Available" || condition.type === "Progressing"),
  );
  const status = deleting
    ? "deleting"
    : failedCondition
      ? "error"
      : replicas === 0
        ? "stopped"
        : readyReplicas > 0
          ? "ready"
          : "provisioning";
  return {
    ...record,
    status,
    can_resume: status === "stopped",
    agent_server_url: publicRuntimeUrl(record.id),
    working_dir: "/workspace",
    error: failedCondition
      ? {
          code: failedCondition.reason ?? "deployment_failed",
          message:
            failedCondition.message ?? "Workspace runtime deployment failed",
        }
      : null,
  };
}

function labels(id, component) {
  return {
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [WORKSPACE_ID_LABEL]: id,
    "app.kubernetes.io/name": "openhands-workspace-runtime",
    "app.kubernetes.io/component": component,
  };
}

function sourceInitContainer(config, source) {
  const common = {
    name: "initialize-workspace",
    image: config.image,
    imagePullPolicy: "IfNotPresent",
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      allowPrivilegeEscalation: false,
    },
    volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
  };
  if (source.kind === "none") {
    return {
      ...common,
      command: ["/bin/sh", "-ec"],
      args: ["mkdir -p /workspace"],
    };
  }
  return {
    ...common,
    command: ["/bin/sh", "-ec"],
    args: [
      [
        "if [ ! -e /workspace/.openhands-workspace-initialized ]; then",
        '  if [ -n "$(find /workspace -mindepth 1 -maxdepth 1 ! -name lost+found -print -quit)" ]; then',
        '    echo "Workspace disk contains unexpected data; refusing to overwrite it" >&2',
        "    exit 1",
        "  fi",
        '  if [ -n "${GIT_REF:-}" ]; then',
        '    git clone --single-branch --branch "$GIT_REF" "$GIT_URL" /clone/repository',
        "  else",
        '    git clone "$GIT_URL" /clone/repository',
        "  fi",
        "  cp -a /clone/repository/. /workspace/",
        "  touch /workspace/.openhands-workspace-initialized",
        "fi",
      ].join("\n"),
    ],
    env: [
      { name: "GIT_URL", value: source.url },
      { name: "GIT_REF", value: source.ref ?? "" },
    ],
    volumeMounts: [
      ...common.volumeMounts,
      { name: "workspace-init", mountPath: "/clone" },
    ],
  };
}

export function renderWorkspaceResources(config, record) {
  const name = workspaceResourceName(record.id);
  const selectorLabels = {
    [WORKSPACE_ID_LABEL]: record.id,
    "app.kubernetes.io/name": "openhands-workspace-runtime",
  };
  const persistencePath = `/home/openhands/workspace-state/${record.id}`;
  const conversationPath = `${persistencePath}/conversations`;
  const podLabels = {
    ...labels(record.id, "runtime"),
    ...selectorLabels,
    "azure.workload.identity/use": "true",
  };
  const env = [
    { name: "OH_WORKSPACE_PATH", value: "/workspace" },
    { name: "OH_PERSISTENCE_DIR", value: `${persistencePath}/persistence` },
    { name: "OH_CONVERSATIONS_PATH", value: conversationPath },
    { name: "OH_ENABLE_BROWSER", value: "false" },
    {
      name: "OH_EXTRA_PYTHON_PATH",
      value: "/opt/agent-canvas/tools",
    },
    {
      name: "EXTENSIONS_PATH",
      value: "/opt/agent-canvas/node_modules/@openhands/extensions",
    },
    { name: "DO_NOT_TRACK", value: "1" },
    {
      name: "OH_SECRET_KEY",
      valueFrom: {
        secretKeyRef: {
          name: config.sharedSecret,
          key: config.ohSecretKeyKey,
        },
      },
    },
    {
      name: "OH_SESSION_API_KEYS_0",
      valueFrom: {
        secretKeyRef: {
          name: config.sharedSecret,
          key: config.sessionApiKeyKey,
        },
      },
    },
  ];
  const metadata = {
    name,
    namespace: config.namespace,
    labels: labels(record.id, "record"),
  };

  return {
    configMap: {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        ...metadata,
        labels: {
          ...metadata.labels,
          [WORKSPACE_RECORD_LABEL]: "true",
        },
      },
      data: {
        [WORKSPACE_RECORD_DATA_KEY]: JSON.stringify(record),
      },
    },
    pvc: {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name,
        namespace: config.namespace,
        labels: labels(record.id, "storage"),
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: config.storageClass,
        resources: { requests: { storage: config.storageSize } },
      },
    },
    service: {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name,
        namespace: config.namespace,
        labels: labels(record.id, "service"),
      },
      spec: {
        type: "ClusterIP",
        selector: selectorLabels,
        ports: [{ name: "http", port: 8000, targetPort: "http" }],
      },
    },
    deployment: {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name,
        namespace: config.namespace,
        labels: labels(record.id, "runtime"),
      },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: selectorLabels },
        template: {
          metadata: { labels: podLabels },
          spec: {
            serviceAccountName: config.runtimeServiceAccount,
            automountServiceAccountToken: false,
            securityContext: {
              fsGroup: 10001,
              runAsNonRoot: true,
              runAsUser: 10001,
              runAsGroup: 10001,
            },
            nodeSelector: config.nodeSelector,
            tolerations: config.tolerations,
            initContainers: [sourceInitContainer(config, record.source)],
            containers: [
              {
                name: "agent-server",
                image: config.image,
                imagePullPolicy: "IfNotPresent",
                command: ["openhands-agent-server"],
                args: ["--port", "8000", "--import-modules", "canvas_ui_tool"],
                env,
                ports: [{ name: "http", containerPort: 8000 }],
                readinessProbe: {
                  httpGet: { path: "/ready", port: "http" },
                  periodSeconds: 5,
                  timeoutSeconds: 3,
                  failureThreshold: 12,
                },
                startupProbe: {
                  httpGet: { path: "/alive", port: "http" },
                  periodSeconds: 5,
                  timeoutSeconds: 3,
                  failureThreshold: 60,
                },
                resources: config.resources,
                securityContext: {
                  runAsNonRoot: true,
                  runAsUser: 10001,
                  runAsGroup: 10001,
                  allowPrivilegeEscalation: false,
                },
                volumeMounts: [
                  { name: "workspace", mountPath: "/workspace" },
                  {
                    name: "conversations",
                    mountPath: "/home/openhands/workspace-state",
                  },
                ],
              },
            ],
            volumes: [
              {
                name: "workspace",
                persistentVolumeClaim: { claimName: name },
              },
              {
                name: "conversations",
                persistentVolumeClaim: {
                  claimName: config.conversationPvc,
                },
              },
              { name: "workspace-init", emptyDir: {} },
            ],
          },
        },
      },
    },
  };
}

class KubernetesApiError extends Error {
  constructor(statusCode, body) {
    super(
      body?.message ?? `Kubernetes API request failed with HTTP ${statusCode}`,
    );
    this.name = "KubernetesApiError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

export class KubernetesClient {
  constructor({
    host = process.env.KUBERNETES_SERVICE_HOST ?? DEFAULT_HOST,
    port = parsePositiveInteger(
      process.env.KUBERNETES_SERVICE_PORT_HTTPS,
      "KUBERNETES_SERVICE_PORT_HTTPS",
      DEFAULT_PORT,
    ),
    token = readFileSync(DEFAULT_TOKEN_PATH, "utf8").trim(),
    ca = readFileSync(DEFAULT_CA_PATH),
  } = {}) {
    this.host = host;
    this.port = port;
    this.token = token;
    this.ca = ca;
  }

  request(method, path, body, { contentType = "application/json" } = {}) {
    return new Promise((resolve, reject) => {
      const payload =
        body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = httpsRequest(
        {
          hostname: this.host,
          port: this.port,
          path,
          method,
          ca: this.ca,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
            ...(payload
              ? {
                  "Content-Type": contentType,
                  "Content-Length": payload.length,
                }
              : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed = null;
            if (text) {
              try {
                parsed = JSON.parse(text);
              } catch {
                parsed = { message: text };
              }
            }
            if ((res.statusCode ?? 500) >= 400) {
              reject(new KubernetesApiError(res.statusCode ?? 500, parsed));
              return;
            }
            resolve(parsed);
          });
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async get(path) {
    return this.request("GET", path);
  }

  async list(path, labelSelector) {
    const query = labelSelector
      ? `?labelSelector=${encodeURIComponent(labelSelector)}`
      : "";
    return this.get(`${path}${query}`);
  }

  async ensure(path, resource) {
    const target = itemPath(path, resource.metadata.name);
    return this.request(
      "PATCH",
      `${target}?fieldManager=openhands-halo-workspace-controller&force=true`,
      resource,
      { contentType: "application/apply-patch+yaml" },
    );
  }

  async delete(path, { ignoreNotFound = true } = {}) {
    try {
      return await this.request("DELETE", path, {
        propagationPolicy: "Foreground",
      });
    } catch (error) {
      if (
        ignoreNotFound &&
        error instanceof KubernetesApiError &&
        error.statusCode === 404
      ) {
        return null;
      }
      throw error;
    }
  }
}

export function loadWorkspaceRuntimeConfig(env = process.env) {
  const namespace = trimToNull(env.AGENT_CANVAS_WORKSPACE_RUNTIME_NAMESPACE);
  if (!namespace) return null;
  const required = [
    "AGENT_CANVAS_WORKSPACE_RUNTIME_IMAGE",
    "AGENT_CANVAS_WORKSPACE_STORAGE_CLASS",
    "AGENT_CANVAS_WORKSPACE_CONVERSATION_PVC",
    "AGENT_CANVAS_WORKSPACE_SHARED_SECRET",
    "AGENT_CANVAS_WORKSPACE_SERVICE_ACCOUNT",
  ];
  const missing = required.filter((name) => !trimToNull(env[name]));
  if (missing.length > 0) {
    throw new Error(
      `Incomplete workspace runtime configuration; missing: ${missing.join(", ")}`,
    );
  }
  const nodePool =
    trimToNull(env.AGENT_CANVAS_WORKSPACE_NODE_POOL) ?? "services";
  const taintKey =
    trimToNull(env.AGENT_CANVAS_WORKSPACE_TAINT_KEY) ?? "unrealhands.io/pool";
  const taintValue =
    trimToNull(env.AGENT_CANVAS_WORKSPACE_TAINT_VALUE) ?? nodePool;
  return {
    namespace,
    image: trimToNull(env.AGENT_CANVAS_WORKSPACE_RUNTIME_IMAGE),
    storageClass: trimToNull(env.AGENT_CANVAS_WORKSPACE_STORAGE_CLASS),
    storageSize: trimToNull(env.AGENT_CANVAS_WORKSPACE_STORAGE_SIZE) ?? "50Gi",
    conversationPvc: trimToNull(env.AGENT_CANVAS_WORKSPACE_CONVERSATION_PVC),
    sharedSecret: trimToNull(env.AGENT_CANVAS_WORKSPACE_SHARED_SECRET),
    sessionApiKeyKey:
      trimToNull(env.AGENT_CANVAS_WORKSPACE_SESSION_KEY_KEY) ?? "sessionApiKey",
    ohSecretKeyKey:
      trimToNull(env.AGENT_CANVAS_WORKSPACE_OH_SECRET_KEY_KEY) ?? "ohSecretKey",
    runtimeServiceAccount: trimToNull(
      env.AGENT_CANVAS_WORKSPACE_SERVICE_ACCOUNT,
    ),
    nodeSelector: {
      "kubernetes.io/os": "linux",
      "kubernetes.io/arch": "amd64",
      agentpool: nodePool,
    },
    tolerations: [
      {
        key: taintKey,
        operator: "Equal",
        value: taintValue,
        effect: "NoSchedule",
      },
    ],
    resources: {
      requests: {
        cpu: trimToNull(env.AGENT_CANVAS_WORKSPACE_CPU_REQUEST) ?? "500m",
        memory: trimToNull(env.AGENT_CANVAS_WORKSPACE_MEMORY_REQUEST) ?? "1Gi",
      },
      limits: {
        cpu: trimToNull(env.AGENT_CANVAS_WORKSPACE_CPU_LIMIT) ?? "2",
        memory: trimToNull(env.AGENT_CANVAS_WORKSPACE_MEMORY_LIMIT) ?? "4Gi",
      },
    },
  };
}

export class WorkspaceRuntimeController {
  constructor(config, { kubernetes = new KubernetesClient() } = {}) {
    this.config = config;
    this.kubernetes = kubernetes;
    this.configMapsPath = coreCollectionPath(config.namespace, "configmaps");
    this.pvcsPath = coreCollectionPath(
      config.namespace,
      "persistentvolumeclaims",
    );
    this.servicesPath = coreCollectionPath(config.namespace, "services");
    this.deploymentsPath = collectionPath(config.namespace, {
      apiGroup: "apps",
      apiVersion: "v1",
      plural: "deployments",
    });
  }

  async getRecord(id) {
    if (!WORKSPACE_ID_PATTERN.test(id)) return null;
    try {
      const configMap = await this.kubernetes.get(
        itemPath(this.configMapsPath, workspaceResourceName(id)),
      );
      return parseWorkspaceRecord(configMap);
    } catch (error) {
      if (error?.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async getDeployment(id) {
    try {
      return await this.kubernetes.get(
        itemPath(this.deploymentsPath, workspaceResourceName(id)),
      );
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async describe(id) {
    const record = await this.getRecord(id);
    if (!record) return null;
    return runtimeDescriptor(record, await this.getDeployment(id));
  }

  async list() {
    const response = await this.kubernetes.list(
      this.configMapsPath,
      `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${WORKSPACE_RECORD_LABEL}=true`,
    );
    const records = (response?.items ?? []).map(parseWorkspaceRecord);
    const descriptors = await Promise.all(
      records.map(async (record) =>
        runtimeDescriptor(record, await this.getDeployment(record.id)),
      ),
    );
    return descriptors.sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  async create(input) {
    let request;
    try {
      request = validateCreateRequest(input);
    } catch (error) {
      error.statusCode = 400;
      error.code = "invalid_request";
      throw error;
    }
    if (request.id) {
      const existing = await this.describe(request.id);
      if (existing) {
        if (
          existing.name === request.name &&
          JSON.stringify(existing.source) === JSON.stringify(request.source)
        ) {
          return existing;
        }
        const error = new Error(
          "Workspace id already exists with different configuration",
        );
        error.statusCode = 409;
        error.code = "workspace_conflict";
        throw error;
      }
    }
    const now = new Date().toISOString();
    const record = {
      id: request.id ?? randomUUID(),
      name: request.name,
      source: request.source,
      created_at: now,
      updated_at: now,
    };
    const resources = renderWorkspaceResources(this.config, record);
    await this.kubernetes.ensure(this.configMapsPath, resources.configMap);
    await this.kubernetes.ensure(this.pvcsPath, resources.pvc);
    await this.kubernetes.ensure(this.servicesPath, resources.service);
    await this.kubernetes.ensure(this.deploymentsPath, resources.deployment);
    return runtimeDescriptor(record, resources.deployment);
  }

  async setReplicas(id, replicas) {
    const record = await this.getRecord(id);
    if (!record) return null;
    const updatedRecord = {
      ...record,
      updated_at: new Date().toISOString(),
    };
    const resources = renderWorkspaceResources(this.config, updatedRecord);
    resources.deployment.spec.replicas = replicas;
    await this.kubernetes.ensure(this.configMapsPath, resources.configMap);
    await this.kubernetes.ensure(this.deploymentsPath, resources.deployment);
    return runtimeDescriptor(updatedRecord, resources.deployment);
  }

  async delete(id, deleteStorage) {
    const record = await this.getRecord(id);
    if (!record) return false;
    const name = workspaceResourceName(id);
    await this.kubernetes.delete(itemPath(this.deploymentsPath, name));
    await this.kubernetes.delete(itemPath(this.servicesPath, name));
    if (deleteStorage) {
      await this.kubernetes.delete(itemPath(this.pvcsPath, name));
      await this.kubernetes.delete(itemPath(this.configMapsPath, name));
    }
    return true;
  }

  proxyTarget(id) {
    if (!WORKSPACE_ID_PATTERN.test(id)) return null;
    return runtimeServiceUrl(this.config.namespace, id);
  }

  async handleHttp(req, res) {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    if (!requestUrl.pathname.startsWith(API_PREFIX)) return false;

    try {
      const suffix = requestUrl.pathname.slice(API_PREFIX.length);
      if (!suffix || suffix === "/") {
        if (req.method === "GET") {
          jsonResponse(res, 200, { items: await this.list() });
          return true;
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          const idempotencyKey = trimToNull(req.headers["idempotency-key"]);
          jsonResponse(
            res,
            201,
            await this.create({
              ...body,
              ...(idempotencyKey ? { id: idempotencyKey } : {}),
            }),
          );
          return true;
        }
        errorResponse(res, 405, "method_not_allowed", "Method not allowed");
        return true;
      }

      const parts = suffix.split("/").filter(Boolean);
      const id = parts[0];
      if (!WORKSPACE_ID_PATTERN.test(id)) {
        errorResponse(res, 404, "workspace_not_found", "Workspace not found");
        return true;
      }
      const action = parts[1] ?? null;
      if (!action && req.method === "GET") {
        const descriptor = await this.describe(id);
        if (!descriptor) {
          errorResponse(res, 404, "workspace_not_found", "Workspace not found");
        } else {
          jsonResponse(res, 200, descriptor);
        }
        return true;
      }
      if (action === "resume" && req.method === "POST") {
        const descriptor = await this.setReplicas(id, 1);
        if (!descriptor) {
          errorResponse(res, 404, "workspace_not_found", "Workspace not found");
        } else {
          jsonResponse(res, 202, descriptor);
        }
        return true;
      }
      if (action === "stop" && req.method === "POST") {
        const descriptor = await this.setReplicas(id, 0);
        if (!descriptor) {
          errorResponse(res, 404, "workspace_not_found", "Workspace not found");
        } else {
          jsonResponse(res, 202, descriptor);
        }
        return true;
      }
      if (!action && req.method === "DELETE") {
        const deleteStorage =
          requestUrl.searchParams.get("deleteStorage") === "true";
        if (!deleteStorage) {
          errorResponse(
            res,
            400,
            "storage_confirmation_required",
            "Workspace deletion requires deleteStorage=true",
          );
          return true;
        }
        const deleted = await this.delete(id, true);
        if (!deleted) {
          errorResponse(res, 404, "workspace_not_found", "Workspace not found");
        } else {
          res.writeHead(204, { "Cache-Control": "no-store" });
          res.end();
        }
        return true;
      }
      errorResponse(res, 405, "method_not_allowed", "Method not allowed");
      return true;
    } catch (error) {
      const status = error.statusCode ?? 500;
      const code =
        error.code ??
        (error instanceof KubernetesApiError
          ? "kubernetes_api_error"
          : status < 500
            ? "invalid_request"
            : "workspace_runtime_error");
      errorResponse(
        res,
        status,
        code,
        status < 500 ? error.message : "Workspace runtime operation failed",
      );
      if (status >= 500) {
        console.error("Workspace runtime operation failed:", error);
      }
      return true;
    }
  }

  resolveProxyRequest(url) {
    const requestUrl = new URL(url ?? "/", "http://localhost");
    if (!requestUrl.pathname.startsWith(`${PROXY_PREFIX}/`)) return null;
    const parts = requestUrl.pathname.split("/").filter(Boolean);
    const id = parts[1];
    if (!WORKSPACE_ID_PATTERN.test(id)) return null;
    const upstreamPath = `/${parts.slice(2).join("/")}${requestUrl.search}`;
    return {
      id,
      target: this.proxyTarget(id),
      upstreamPath,
    };
  }
}

export function createWorkspaceRuntimeController(
  env = process.env,
  options = {},
) {
  const config = loadWorkspaceRuntimeConfig(env);
  return config ? new WorkspaceRuntimeController(config, options) : null;
}

export const workspaceRuntimeConstants = {
  apiPrefix: API_PREFIX,
  proxyPrefix: PROXY_PREFIX,
};
