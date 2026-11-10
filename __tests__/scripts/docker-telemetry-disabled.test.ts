// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("Docker telemetry policy", () => {
  it("forces all bundled services to run without telemetry", () => {
    const entrypoint = readFileSync(
      path.join(repoRoot, "docker", "entrypoint.sh"),
      "utf8",
    );

    expect(entrypoint).toContain("export DO_NOT_TRACK=1");
    expect(entrypoint).toContain("export VITE_DO_NOT_TRACK=1");
    expect(entrypoint).toContain("export AGENT_CANVAS_DISABLE_TELEMETRY=1");
    expect(entrypoint).toContain(
      "unset AUTOMATION_POSTHOG_API_KEY AUTOMATION_POSTHOG_HOST",
    );
    expect(entrypoint).toContain(
      "unset OH_TELEMETRY_EXPORTER OH_TELEMETRY_POSTHOG_API_KEY OH_TELEMETRY_POSTHOG_HOST",
    );
  });
});
