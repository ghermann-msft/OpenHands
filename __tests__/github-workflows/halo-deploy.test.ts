// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/halo-deploy.yml", "utf8");

describe("Halo deployment workflow", () => {
  it("builds and deploys PPE on branch pushes without accepting pull requests", () => {
    expect(workflow).toContain("branches:\n      - openhands-halo");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).toContain("runs-on: openhands-halo-ci");
    expect(workflow).toContain(
      "__tests__/scripts/workspace-runtime-controller.test.ts",
    );
    expect(workflow).toContain("__tests__/scripts/static-server.test.ts");
    expect(workflow).toContain(
      'node scripts/halo-deploy.mjs build --ref "$GITHUB_SHA"',
    );
    expect(workflow).toContain(
      'node scripts/halo-deploy.mjs deploy-candidate --digest "${{ steps.image.outputs.digest }}"',
    );
    expect(workflow).toContain(
      "/var/run/secrets/kubernetes.io/serviceaccount/token",
    );
    expect(workflow).toContain(
      '--server="https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT_HTTPS}"',
    );
    expect(workflow).toContain("environment: halo-ppe");
  });

  it("requires a protected manual job to promote the existing candidate digest", () => {
    expect(workflow).toContain("inputs.action == 'promote-candidate'");
    expect(workflow).toContain("environment: halo-production");
    expect(workflow).toContain("node scripts/halo-deploy.mjs promote");
    expect(workflow).toContain("cancel-in-progress: false");
  });
});
