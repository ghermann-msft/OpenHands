// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  imageReference,
  normalizeDigest,
  renderBuildJob,
  renderHelmValues,
  renderSecretProviderClass,
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

  it("renders a rootless cached build for the exact commit", () => {
    const job = renderBuildJob({
      commit,
      builderClientId: "builder-client-id",
    });

    expect(job).toContain(`git checkout --detach ${commit}`);
    expect(job).toContain(`OPENHANDS_BUILD_GIT_SHA=${commit}`);
    expect(job).toContain("hostUsers: false");
    expect(job).toContain("--oci-worker-snapshotter=native");
    expect(job).toContain("--oci-worker-no-process-sandbox");
    expect(job).toContain("--import-cache type=registry");
    expect(job).toContain("--export-cache type=registry");
    expect(job).toContain("azure.workload.identity/use: \"true\"");
    expect(job).toContain("allowPrivilegeEscalation: false");
    expect(job).toContain('add: ["SYS_ADMIN"]');
    expect(job).not.toContain("privileged: true");
    expect(job).not.toContain("ttlSecondsAfterFinished");
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
