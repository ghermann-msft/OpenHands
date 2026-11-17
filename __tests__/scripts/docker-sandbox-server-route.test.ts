// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const entrypoint = readFileSync("docker/entrypoint.sh", "utf8");

describe("Docker Sandbox Server routing", () => {
  it("routes V1 APIs to the configured control plane and locks Canvas to it", () => {
    expect(entrypoint).toContain(
      'SANDBOX_SERVER_URL="${SANDBOX_SERVER_URL:-}"',
    );
    expect(entrypoint).toContain(
      'STATIC_SERVER_CLOUD_ARGS+=(--route "/api/v1=${SANDBOX_SERVER_URL}")',
    );
    expect(entrypoint).toContain(
      'STATIC_SERVER_CLOUD_ARGS+=(--route "/api/organizations=${SANDBOX_SERVER_URL}")',
    );
    expect(entrypoint).toContain(
      'STATIC_SERVER_CLOUD_ARGS+=(--route "/oauth=${SANDBOX_SERVER_URL}")',
    );
    expect(entrypoint).toContain(
      'STATIC_SERVER_CLOUD_ARGS+=(--lock-to-cloud "$AGENT_CANVAS_CLOUD_URL")',
    );
    expect(entrypoint).toContain(
      'AGENT_CANVAS_CLOUD_ORGANIZATION_MODE="${AGENT_CANVAS_CLOUD_ORGANIZATION_MODE:-none}"',
    );
    expect(entrypoint).toContain(
      'STATIC_SERVER_CLOUD_ARGS+=(--cloud-organization-mode "$AGENT_CANVAS_CLOUD_ORGANIZATION_MODE")',
    );
    expect(entrypoint).toContain(
      "STATIC_SERVER_CLOUD_ARGS+=(--no-external-settings-shell)",
    );
    expect(entrypoint).toContain('"${STATIC_SERVER_CLOUD_ARGS[@]}"');
  });
});
