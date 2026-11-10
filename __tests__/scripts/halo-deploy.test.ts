// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildNodePoolCreateArgs,
  imageReference,
  normalizeDigest,
  renderBuildJob,
  renderHelmValues,
  renderSecretProviderClass,
  validateBuildNodePool,
} from "../../scripts/halo-deploy.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const commit = "84d224f45e7647c3a04d4b8ac4af47af22a23b12";

describe("Halo deployment automation", () => {
  it("requires immutable image digests", () => {
    expect(normalizeDigest(digest)).toBe(digest);
    expect(() => normalizeDigest("84d224f45")).toThrow(/immutable sha256/);
    expect(
      imageReference("registry.example", "openhands-halo", digest),
    ).toBe(`registry.example/openhands-halo@${digest}`);
  });

  it("renders an isolated privileged cached build for the exact commit", () => {
    const job = renderBuildJob({ commit });

    expect(job).toContain(`git checkout --detach ${commit}`);
    expect(job).toContain(`OPENHANDS_BUILD_GIT_SHA=${commit}`);
    expect(job).toContain("--import-cache type=registry");
    expect(job).toContain("--export-cache type=registry");
    expect(job).toContain('azure.workload.identity/use: "true"');
    expect(job).toContain("agentpool: halobuild");
    expect(job).toContain("value: halo-build");
    expect(job).toContain("privileged: true");
    expect(job).not.toContain("hostUsers: false");
    expect(job).not.toContain("--oci-worker-no-process-sandbox");
    expect(job).not.toContain('add: ["SYS_ADMIN"]');
    expect(job).not.toContain("type: Unconfined");
    expect(job).not.toContain("ttlSecondsAfterFinished");
  });

  it("defines and validates the scale-to-zero build pool boundary", () => {
    const args = buildNodePoolCreateArgs();

    expect(args).toContain("halobuild");
    expect(args).toContain("Standard_D8s_v5");
    expect(args).toContain("--enable-cluster-autoscaler");
    expect(args).toContain("unrealhands.io/pool=halo-build:NoSchedule");
    expect(() =>
      validateBuildNodePool({
        mode: "User",
        osType: "Linux",
        osSku: "Ubuntu",
        vmSize: "Standard_D8s_v5",
        enableAutoScaling: true,
        minCount: 0,
        maxCount: 1,
        nodeLabels: {
          "unrealhands.io/pool": "halo-build",
        },
        nodeTaints: ["unrealhands.io/pool=halo-build:NoSchedule"],
      }),
    ).not.toThrow();
    expect(() =>
      validateBuildNodePool({
        mode: "User",
        osType: "Linux",
        osSku: "Ubuntu",
        vmSize: "Standard_D8s_v5",
        enableAutoScaling: true,
        minCount: 0,
        maxCount: 1,
        nodeLabels: {
          "unrealhands.io/pool": "halo-build",
        },
        nodeTaints: [],
      }),
    ).toThrow(/taint/);
  });

  it("renders isolated candidate configuration with Key Vault CSI", () => {
    const spc = renderSecretProviderClass("candidate", "runtime-client-id");
    const values = renderHelmValues(
      "candidate",
      digest,
      "runtime-client-id",
    );

    expect(spc).toContain("halo-ppe-entra-client-secret");
    expect(spc).toContain("halo-ppe-session-api-key");
    expect(values).toContain(`digest: ${digest}`);
    expect(values).toContain(
      "host: openhands-ppe-gsbxe2cef0d4gefc.b01.azurefd.net",
    );
    expect(values).toContain(
      "clientId: 9071e6b8-c981-4a11-b975-256cc4b7b841",
    );
    expect(values).toContain(
      "api://9071e6b8-c981-4a11-b975-256cc4b7b841/access_as_user",
    );
    expect(values).toContain("secretProviderClass: openhands-halo-secrets");
    expect(values).not.toContain("halo-primary-entra-client-secret");
  });
});
