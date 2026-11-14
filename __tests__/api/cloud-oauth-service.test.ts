import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetActiveStoreForTests,
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import type { Backend } from "#/api/backend-registry/types";
import { callCloudProxy } from "#/api/cloud/proxy";
import {
  fetchCloudOAuthProviders,
  linkCloudOAuthProvider,
} from "#/api/cloud/oauth-service.api";

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

describe("cloud OAuth service", () => {
  it("discovers OAuth providers through the authenticated Cloud transport", async () => {
    // Arrange
    const providers = [
      {
        id: 41,
        provider_type: "github",
        connected: true,
        needs_reconnect: false,
      },
      {
        id: 42,
        provider_type: "gitlab",
        connected: false,
        needs_reconnect: false,
      },
    ];
    vi.mocked(callCloudProxy).mockResolvedValue(providers);

    // Act
    const result = await fetchCloudOAuthProviders();

    // Assert
    expect(result).toEqual(providers);
    expect(callCloudProxy).toHaveBeenCalledWith({
      backend: cloudBackend,
      method: "GET",
      path: "/oauth/git-providers",
    });
  });

  it("links the selected provider without a request body", async () => {
    // Arrange
    vi.mocked(callCloudProxy).mockResolvedValue({
      start_url: "https://github.example.com/login/oauth/authorize",
    });

    // Act
    const startUrl = await linkCloudOAuthProvider(41);

    // Assert
    expect(startUrl).toBe("https://github.example.com/login/oauth/authorize");
    expect(callCloudProxy).toHaveBeenCalledWith({
      backend: cloudBackend,
      method: "POST",
      path: "/oauth/41/link",
    });
  });
});
