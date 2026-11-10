// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf-8");
}

describe("npm publish workflow", () => {
  it("uses the canonical GitHub repository in release metadata", () => {
    const packageJson = JSON.parse(read("package.json"));
    const dockerfile = read("docker/Dockerfile");
    const dockerWorkflow = read(".github/workflows/docker.yml");

    expect(packageJson.repository.url).toBe(
      "https://github.com/OpenHands/OpenHands",
    );
    expect(packageJson.homepage).toBe(
      "https://github.com/OpenHands/OpenHands#readme",
    );
    expect(packageJson.bugs.url).toBe(
      "https://github.com/OpenHands/OpenHands/issues",
    );
    expect(dockerfile).toContain(
      'LABEL org.opencontainers.image.source="https://github.com/OpenHands/OpenHands"',
    );
    expect(dockerWorkflow).toContain(
      "https://github.com/OpenHands/OpenHands/pkgs/container/agent-canvas",
    );
  });

  it("does not let electron-builder auto-publish during desktop builds", () => {
    const packageJson = JSON.parse(read("package.json"));

    expect(packageJson.scripts["build:desktop"]).toContain("--publish never");
    expect(packageJson.scripts["build:desktop:universal"]).toContain(
      "--publish never",
    );
  });

  it("builds both package surfaces without telemetry configuration", () => {
    const workflow = read(".github/workflows/npm-publish.yml");
    const buildAppStep = workflow.match(
      /- name: Build app[\s\S]*?(?=\n\s*- name: Build library)/,
    )?.[0];
    const buildLibraryStep = workflow.match(
      /- name: Build library[\s\S]*?(?=\n\s*- name: Verify package contents)/,
    )?.[0];

    expect(buildAppStep).toBeTruthy();
    expect(buildAppStep).toContain("npm run build");
    expect(buildLibraryStep).toContain("npm run build:lib");
    expect(workflow).not.toContain("POSTHOG");
  });

  it("does not expose telemetry build arguments", () => {
    const workflow = read(".github/workflows/docker.yml");
    const dockerfile = read("docker/Dockerfile");

    expect(workflow).not.toContain("POSTHOG");
    expect(dockerfile).not.toContain("POSTHOG");
  });
});
