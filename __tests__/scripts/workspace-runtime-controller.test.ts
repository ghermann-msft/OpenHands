import { createServer, request, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KubernetesClient,
  WorkspaceRuntimeController,
  loadWorkspaceRuntimeConfig,
  renderWorkspaceResources,
} from "../../scripts/workspace-runtime-controller.mjs";

const runtimeConfig = {
  namespace: "openhands-halo-ppe",
  image: "example.azurecr.io/openhands-halo@sha256:" + "a".repeat(64),
  storageClass: "openhands-halo-workspace-disk",
  storageSize: "50Gi",
  conversationPvc: "openhands-halo-conversations",
  sharedSecret: "openhands-halo-secrets",
  sessionApiKeyKey: "sessionApiKey",
  ohSecretKeyKey: "ohSecretKey",
  runtimeServiceAccount: "openhands-halo",
  llmEnvironment: [
    { name: "LLM_MODEL", value: "azure/gpt-5.6-sol" },
    {
      name: "LLM_BASE_URL",
      value: "https://mortmain-openai2.openai.azure.com/",
    },
    { name: "LLM_API_VERSION", value: "2024-12-01-preview" },
    { name: "LLM_AUTH_TYPE", value: "azure_workload_identity" },
  ],
  nodeSelector: {
    "kubernetes.io/os": "linux",
    "kubernetes.io/arch": "amd64",
    agentpool: "services",
  },
  tolerations: [
    {
      key: "unrealhands.io/pool",
      operator: "Equal",
      value: "services",
      effect: "NoSchedule",
    },
  ],
  resources: {
    requests: { cpu: "500m", memory: "1Gi" },
    limits: { cpu: "2", memory: "4Gi" },
  },
};

const workspaceRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Engine",
  source: {
    kind: "git",
    url: "https://github.com/example/engine.git",
    ref: "main",
  },
  created_at: "2026-11-10T00:00:00.000Z",
  updated_at: "2026-11-10T00:00:00.000Z",
};

class FakeKubernetesClient extends KubernetesClient {
  resources = new Map<string, unknown>();

  constructor() {
    super({
      host: "kubernetes.test",
      port: 443,
      token: "test-token",
      ca: Buffer.from("test-ca"),
    });
  }

  async get(path: string) {
    const resource = this.resources.get(path);
    if (!resource) {
      throw Object.assign(new Error(`Missing fake resource: ${path}`), {
        statusCode: 404,
      });
    }
    return structuredClone(resource);
  }

  async list(path: string) {
    const prefix = `${path}/`;
    return {
      items: [...this.resources.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => structuredClone(value)),
    };
  }

  async ensure(path: string, resource: { metadata: { name: string } }) {
    this.resources.set(
      `${path}/${resource.metadata.name}`,
      structuredClone(resource),
    );
    return resource;
  }

  async delete(path: string) {
    this.resources.delete(path);
    return null;
  }
}

describe("workspace runtime configuration", () => {
  it("stays disabled without a namespace and validates a complete environment", () => {
    expect(loadWorkspaceRuntimeConfig({})).toBeNull();
    expect(() =>
      loadWorkspaceRuntimeConfig({
        AGENT_CANVAS_WORKSPACE_RUNTIME_NAMESPACE: "openhands-halo-ppe",
      }),
    ).toThrow(/missing: .*RUNTIME_IMAGE.*STORAGE_CLASS/);

    expect(
      loadWorkspaceRuntimeConfig({
        AGENT_CANVAS_WORKSPACE_RUNTIME_NAMESPACE: "openhands-halo-ppe",
        AGENT_CANVAS_WORKSPACE_RUNTIME_IMAGE: "example/image@sha256:test",
        AGENT_CANVAS_WORKSPACE_STORAGE_CLASS: "workspace-disk",
        AGENT_CANVAS_WORKSPACE_CONVERSATION_PVC: "conversations",
        AGENT_CANVAS_WORKSPACE_SHARED_SECRET: "shared-secrets",
        AGENT_CANVAS_WORKSPACE_SERVICE_ACCOUNT: "runtime",
        AGENT_CANVAS_WORKSPACE_LLM_MODEL: "azure/gpt-5.6-sol",
        AGENT_CANVAS_WORKSPACE_LLM_BASE_URL:
          "https://mortmain-openai2.openai.azure.com/",
        AGENT_CANVAS_WORKSPACE_LLM_API_VERSION: "2024-12-01-preview",
        AGENT_CANVAS_WORKSPACE_LLM_AUTH_TYPE: "azure_workload_identity",
      }),
    ).toMatchObject({
      namespace: "openhands-halo-ppe",
      storageSize: "50Gi",
      runtimeServiceAccount: "runtime",
      llmEnvironment: [
        { name: "LLM_MODEL", value: "azure/gpt-5.6-sol" },
        {
          name: "LLM_BASE_URL",
          value: "https://mortmain-openai2.openai.azure.com/",
        },
        { name: "LLM_API_VERSION", value: "2024-12-01-preview" },
        { name: "LLM_AUTH_TYPE", value: "azure_workload_identity" },
      ],
      nodeSelector: { agentpool: "services" },
    });
  });
});

describe("Kubernetes reconciliation", () => {
  it("uses server-side apply so Kubernetes-owned immutable fields are preserved", async () => {
    const client = new KubernetesClient({
      host: "kubernetes.test",
      port: 443,
      token: "test-token",
      ca: Buffer.from("test-ca"),
    });
    const requestSpy = vi
      .spyOn(client, "request")
      .mockResolvedValue({ metadata: { name: "workspace-test" } });
    const resource = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "workspace-test" },
      spec: { type: "ClusterIP" },
    };

    await client.ensure("/api/v1/namespaces/test/services", resource);

    expect(requestSpy).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/namespaces/test/services/workspace-test?fieldManager=openhands-halo-workspace-controller&force=true",
      resource,
      { contentType: "application/apply-patch+yaml" },
    );
  });
});

describe("workspace runtime resources", () => {
  it("reconciles retained runtimes to deployment-managed image and LLM defaults", async () => {
    const kubernetes = new FakeKubernetesClient();
    const initial = new WorkspaceRuntimeController(
      {
        ...runtimeConfig,
        image: "example.azurecr.io/openhands-halo@sha256:" + "b".repeat(64),
        llmEnvironment: [],
      },
      { kubernetes },
    );
    const created = await initial.create({
      id: workspaceRecord.id,
      name: workspaceRecord.name,
      source: workspaceRecord.source,
    });
    expect(created.status).toBe("provisioning");

    const reconciler = new WorkspaceRuntimeController(runtimeConfig, {
      kubernetes,
    });
    await reconciler.reconcile();

    const deployment = await reconciler.getDeployment(workspaceRecord.id);
    expect(deployment.spec.template.spec.containers[0]).toMatchObject({
      image: runtimeConfig.image,
      env: expect.arrayContaining(runtimeConfig.llmEnvironment),
    });
  });

  it("renders a retained-disk runtime with idempotent Git initialization", () => {
    const resources = renderWorkspaceResources(runtimeConfig, workspaceRecord);

    expect(resources.pvc.spec).toMatchObject({
      accessModes: ["ReadWriteOnce"],
      storageClassName: "openhands-halo-workspace-disk",
      resources: { requests: { storage: "50Gi" } },
    });
    expect(resources.deployment.spec).toMatchObject({
      replicas: 1,
      strategy: { type: "Recreate" },
    });
    const podSpec = resources.deployment.spec.template.spec;
    expect(podSpec.automountServiceAccountToken).toBe(false);
    expect(podSpec.nodeSelector.agentpool).toBe("services");
    expect(podSpec.initContainers[0].args[0]).toContain(
      "find /workspace -mindepth 1 -maxdepth 1 ! -name lost+found",
    );
    expect(podSpec.initContainers[0].args[0]).toContain(
      'git clone --single-branch --branch "$GIT_REF" "$GIT_URL" /clone/repository',
    );
    expect(podSpec.initContainers[0].args[0]).toContain(
      "git -c safe.directory=/workspace -C /workspace",
    );
    expect(podSpec.initContainers[0].args[0]).toContain(
      'origin="$(git_workspace config --get remote.origin.url)"',
    );
    expect(podSpec.initContainers[0].args[0]).toContain(
      "Existing Git checkout does not match the configured workspace ref",
    );
    expect(podSpec.initContainers[0].args[0]).toContain(
      "! -name .openhands-workspace-initializing -exec rm -rf -- {} +",
    );
    expect(podSpec.initContainers[0].args[0]).toContain(
      "find /clone/repository -mindepth 1 -maxdepth 1 ! -name .git -exec cp -R",
    );
    expect(podSpec.initContainers[0].args[0]).toContain(
      "cp -R /clone/repository/.git /workspace/.git",
    );
    expect(podSpec.initContainers[0].args[0]).not.toContain(
      "cp -a /clone/repository/. /workspace/",
    );
    expect(podSpec.initContainers[0].volumeMounts).toContainEqual({
      name: "workspace-init",
      mountPath: "/clone",
    });
    expect(podSpec.containers[0]).toMatchObject({
      command: ["openhands-agent-server"],
      args: ["--port", "8000", "--import-modules", "canvas_ui_tool"],
    });
    expect(podSpec.containers[0].env).toEqual(
      expect.arrayContaining(runtimeConfig.llmEnvironment),
    );
    expect(podSpec.volumes).toContainEqual({
      name: "conversations",
      persistentVolumeClaim: { claimName: "openhands-halo-conversations" },
    });
  });

  it("uses the same lifecycle for an empty workspace without invoking Git", () => {
    const resources = renderWorkspaceResources(runtimeConfig, {
      ...workspaceRecord,
      source: { kind: "none" },
    });

    expect(
      resources.deployment.spec.template.spec.initContainers[0],
    ).toMatchObject({
      command: ["/bin/sh", "-ec"],
      args: ["mkdir -p /workspace"],
    });
  });
});

describe("workspace runtime controller", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    );
  });

  async function call(
    origin: string,
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = request(`${origin}${path}`, {
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
              ...headers,
            }
          : headers,
      });
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body: text ? JSON.parse(text) : null,
          });
        });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function startController() {
    const kubernetes = new FakeKubernetesClient();
    const controller = new WorkspaceRuntimeController(runtimeConfig, {
      kubernetes,
    });
    const server = createServer((req, res) => {
      void controller.handleHttp(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    return {
      controller,
      origin: `http://127.0.0.1:${address.port}`,
    };
  }

  it("creates, lists, stops, and resumes a workspace by stable id", async () => {
    const { origin } = await startController();
    const created = await call(origin, "/api/workspace-runtimes", "POST", {
      name: "Engine",
      source: {
        kind: "git",
        url: "https://github.com/example/engine.git",
        ref: "main",
      },
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "Engine",
      status: "provisioning",
      working_dir: "/workspace",
      source: { kind: "git" },
    });

    const id = (created.body as { id: string }).id;

    const listed = await call(origin, "/api/workspace-runtimes");
    expect(listed.body).toMatchObject({
      items: [{ id, name: "Engine" }],
    });

    const stopped = await call(
      origin,
      `/api/workspace-runtimes/${id}/stop`,
      "POST",
    );
    expect(stopped.body).toMatchObject({ status: "stopped", can_resume: true });

    const resumed = await call(
      origin,
      `/api/workspace-runtimes/${id}/resume`,
      "POST",
    );
    expect(resumed.body).toMatchObject({
      status: "provisioning",
      can_resume: false,
    });
  });

  it("uses the idempotency key as the stable workspace identity", async () => {
    const { origin } = await startController();
    const id = "22222222-2222-4222-8222-222222222222";
    const requestBody = { name: "Stable", source: { kind: "none" } };
    const first = await call(
      origin,
      "/api/workspace-runtimes",
      "POST",
      requestBody,
      { "Idempotency-Key": id },
    );
    const retry = await call(
      origin,
      "/api/workspace-runtimes",
      "POST",
      requestBody,
      { "Idempotency-Key": id },
    );

    expect(first.body).toMatchObject({ id });
    expect(retry.body).toMatchObject({ id });
  });

  it("rejects unsafe Git URLs and requires explicit storage deletion", async () => {
    const { origin } = await startController();
    const unsafe = await call(origin, "/api/workspace-runtimes", "POST", {
      name: "Unsafe",
      source: { kind: "git", url: "file:///etc/passwd" },
    });
    expect(unsafe.status).toBe(400);

    const created = await call(origin, "/api/workspace-runtimes", "POST", {
      name: "Empty",
      source: { kind: "none" },
    });
    const id = (created.body as { id: string }).id;
    const deletion = await call(
      origin,
      `/api/workspace-runtimes/${id}`,
      "DELETE",
    );
    expect(deletion).toEqual({
      status: 400,
      body: {
        error: {
          code: "storage_confirmation_required",
          message: "Workspace deletion requires deleteStorage=true",
        },
      },
    });
  });

  it("resolves runtime HTTP and WebSocket paths to the workspace Service", () => {
    const controller = new WorkspaceRuntimeController(runtimeConfig, {
      kubernetes: new FakeKubernetesClient(),
    });

    expect(
      controller.resolveProxyRequest(
        "/workspace-runtimes/11111111-1111-4111-8111-111111111111/api/settings?x=1",
      ),
    ).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      target:
        "http://workspace-11111111-1111-4111-8111-111111111111.openhands-halo-ppe.svc.cluster.local:8000",
      upstreamPath: "/api/settings?x=1",
    });
  });
});
