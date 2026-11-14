import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetActiveStoreForTests,
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import type { Backend } from "#/api/backend-registry/types";
import { callCloudProxy } from "#/api/cloud/proxy";
import { fetchCloudIntegrationsConfig } from "#/api/cloud/settings-service.api";

vi.mock("#/api/cloud/proxy", () => ({
  callCloudProxy: vi.fn(),
}));

const cloudBackend: Backend = {
  id: "enterprise",
  name: "Enterprise",
  host: "https://halo.example.com",
  apiKey: "token",
  kind: "cloud",
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetActiveStoreForTests();
  setRegisteredBackends([cloudBackend]);
  setActiveSelection({ backendId: cloudBackend.id });
});

describe("fetchCloudIntegrationsConfig", () => {
  it("maps the Canvas ownership capability and Enterprise GitHub App URL", async () => {
    // Arrange
    vi.mocked(callCloudProxy).mockResolvedValue({
      providers_configured: ["github"],
      feature_flags: {
        enable_canvas_integrations: true,
        enable_oauth_v2_login: true,
        github_app_install_url:
          "https://github.example.com/apps/halo/installations/new",
      },
    });

    // Act
    const config = await fetchCloudIntegrationsConfig();

    // Assert
    expect(callCloudProxy).toHaveBeenCalledWith({
      backend: cloudBackend,
      method: "GET",
      path: "/api/v1/web-client/config",
    });
    expect(config.isCanvasIntegrationsEnabled).toBe(true);
    expect(config.isOauthV2LoginEnabled).toBe(true);
    expect(config.githubAppInstallUrl).toBe(
      "https://github.example.com/apps/halo/installations/new",
    );
  });

  it("keeps Canvas ownership disabled when the optional fields are absent", async () => {
    // Arrange
    vi.mocked(callCloudProxy).mockResolvedValue({
      providers_configured: ["github"],
      feature_flags: {},
    });

    // Act
    const config = await fetchCloudIntegrationsConfig();

    // Assert
    expect(config.isCanvasIntegrationsEnabled).toBe(false);
    expect(config.isOauthV2LoginEnabled).toBe(false);
    expect(config.githubAppInstallUrl).toBeNull();
  });
});
