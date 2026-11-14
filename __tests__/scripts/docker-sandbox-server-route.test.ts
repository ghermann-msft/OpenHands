// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const entrypoint = readFileSync("docker/entrypoint.sh", "utf8");
const staticServer = readFileSync("scripts/static-server.mjs", "utf8");

describe("Docker Sandbox Server routing", () => {
  it("routes V1 APIs to the Enterprise app server and keeps the control plane separate", () => {
    expect(entrypoint).toContain(
      'SANDBOX_SERVER_URL="${SANDBOX_SERVER_URL:-}"',
    );
    expect(entrypoint).toContain('APP_SERVER_URL="${APP_SERVER_URL:-}"');
    expect(entrypoint).toContain(
      'STATIC_SERVER_CLOUD_ARGS+=(--route "/api/v1=${APP_SERVER_URL}")',
    );
    for (const path of [
      "/oauth",
      "/integration",
      "/saml",
      "/slack",
      "/bitbucket-dc-proxy",
      "/mcp",
    ]) {
      expect(entrypoint).toContain(
        `STATIC_SERVER_CLOUD_ARGS+=(--route "${path}=\${APP_SERVER_URL}")`,
      );
      expect(entrypoint).not.toContain(
        `STATIC_SERVER_CLOUD_ARGS+=(--route "${path}=\${SANDBOX_SERVER_URL}")`,
      );
    }
    expect(entrypoint).toContain(
      'STATIC_SERVER_CLOUD_ARGS+=(--lock-to-cloud "$AGENT_CANVAS_CLOUD_URL")',
    );
    expect(entrypoint).toContain(
      "STATIC_SERVER_CLOUD_ARGS+=(--cloud-organization-mode none)",
    );
    expect(entrypoint).not.toContain(
      'STATIC_SERVER_CLOUD_ARGS+=(--route "/api/v1=${SANDBOX_SERVER_URL}")',
    );
    expect(entrypoint).toContain('"${STATIC_SERVER_CLOUD_ARGS[@]}"');
    expect(staticServer).toContain(
      "proxy.proxyWebSocket(req, socket, head, backend",
    );
  });
});
