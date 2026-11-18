// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/halo-deploy.yml", "utf8");

describe("Halo deployment workflow", () => {
  it("builds and deploys PPE on branch pushes without accepting pull requests", () => {
    expect(workflow).toContain("branches:\n      - openhands-halo");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).toContain("runs-on: openhands-halo-ci");
    expect(workflow).toContain(
      "__tests__/scripts/workspace-runtime-controller.test.ts",
    );
    expect(workflow).toContain("__tests__/scripts/static-server.test.ts");
    expect(workflow).toContain("node scripts/halo-deploy.mjs resolve-sources");
    expect(workflow).toContain(
      "needs:\n      - resolve-sources\n      - validate",
    );
    expect(workflow).toContain(
      "ref: ${{ needs.resolve-sources.outputs.openhands_sha }}",
    );
    expect(workflow).toContain(
      'node scripts/halo-deploy.mjs build --openhands-sha "${{ needs.resolve-sources.outputs.openhands_sha }}" --agent-server-sha "${{ needs.resolve-sources.outputs.agent_server_sha }}" --sandbox-server-sha "${{ needs.resolve-sources.outputs.sandbox_server_sha }}"',
    );
    expect(workflow).toContain(
      'node scripts/halo-deploy.mjs deploy-candidate --canvas-digest "${{ steps.image.outputs.canvas_digest }}" --agent-server-digest "${{ steps.image.outputs.agent_server_digest }}" --sandbox-server-digest "${{ steps.image.outputs.sandbox_server_digest }}" --sandbox-runtime-digest "${{ steps.image.outputs.sandbox_runtime_digest }}" --windows-runtime-digest "${{ steps.windows-runtime.outputs.digest }}"',
    );
    expect(workflow).toContain("HALO_WINDOWS_RUNTIME_DIGEST");
    expect(workflow).toContain("### Halo candidate provenance");
    expect(workflow).toContain("agent_server_sha");
    expect(workflow).toContain("sandbox_server_sha");
    expect(workflow).toContain(
      "node scripts/halo-deploy.mjs preflight-windows",
    );
    expect(workflow).toContain("prepare-windows-proof");
    expect(workflow).toContain("restore-windows-idle");
    expect(workflow).toContain("deploy-and-promote");
    expect(workflow).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.operation == 'deploy-and-promote'",
    );
    expect(workflow).toContain(
      "patch sandboxwarmpool windows-server-2025-amd64",
    );
    expect(workflow).toContain("ghcr.io/ghermann-msft/agent-server");
    expect(workflow).toContain(
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
    );
    expect(workflow).toContain(
      '--server="https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT_HTTPS}"',
    );
    expect(workflow).toContain(
      "http://openhands-halo.openhands-halo-ppe.svc.cluster.local:8000",
    );
    expect(workflow).toContain("for attempt in {1..30}; do");
    expect(workflow).toContain(
      'if curl --fail --silent --show-error "$base_url/ready"; then',
    );
    expect(workflow).toContain("sleep 2");
    expect(workflow).toContain('"$base_url/api/v1/sandboxes"');
    expect(workflow).toContain(
      "http://openhands-hindsight.openhands-halo-ppe.svc.cluster.local:8888",
    );
    expect(workflow).toContain('"$base_url/health"');
    expect(workflow).toContain('"$base_url/v1/default/banks"');
    expect(workflow).toContain('test "$status" = "401"');
    expect(workflow).not.toContain("/api/workspace-runtimes");
    expect(workflow).not.toContain(
      "https://openhands-ppe-gsbxe2cef0d4gefc.b01.azurefd.net/ready",
    );
    expect(workflow).toContain("environment: halo-ppe");
  });

  it("requires protected approval to promote the digest built by the same run", () => {
    expect(workflow).toContain("environment: halo-production");
    expect(workflow).toContain(
      'node scripts/halo-deploy.mjs promote --canvas-digest "${{ needs.deploy-candidate.outputs.canvas_digest }}" --agent-server-digest "${{ needs.deploy-candidate.outputs.agent_server_digest }}" --sandbox-server-digest "${{ needs.deploy-candidate.outputs.sandbox_server_digest }}" --sandbox-runtime-digest "${{ needs.deploy-candidate.outputs.sandbox_runtime_digest }}" --windows-runtime-digest "${{ needs.deploy-candidate.outputs.windows_runtime_digest }}"',
    );
    expect(workflow).toContain("group: halo-candidate");
    expect(workflow).toContain("group: halo-production");
    expect(workflow).toContain("cancel-in-progress: false");
  });
});
