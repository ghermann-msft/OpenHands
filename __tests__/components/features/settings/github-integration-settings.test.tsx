import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  linkCloudOAuthProvider,
  unlinkCloudOAuthProvider,
} from "#/api/cloud/oauth-service.api";
import { GitHubIntegrationSettings } from "#/components/features/settings/app-settings/github-integration-settings";

const config = vi.hoisted(() => ({
  providers: [
    {
      id: 7,
      provider_type: "github",
      connected: false,
      needs_reconnect: false,
    },
  ],
}));
const originalLocation = window.location;

vi.mock("#/contexts/active-backend-context", () => ({
  useActiveBackend: () => ({
    backend: { id: "halo", kind: "cloud", connectionRevision: 2 },
  }),
}));

vi.mock("#/hooks/query/use-cloud-integrations-config", () => ({
  useCloudIntegrationsConfig: () => ({
    data: {
      providersConfigured: ["github"],
      isCanvasIntegrationsEnabled: true,
      isOauthV2LoginEnabled: true,
      githubAppInstallUrl:
        "https://github.com/apps/openhands-halo-ppe/installations/new",
    },
  }),
}));

vi.mock("#/api/cloud/oauth-service.api", () => ({
  fetchCloudOAuthProviders: vi.fn(async () => config.providers),
  linkCloudOAuthProvider: vi.fn(),
  unlinkCloudOAuthProvider: vi.fn(),
}));

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GitHubIntegrationSettings />
    </QueryClientProvider>,
  );
}

describe("GitHubIntegrationSettings", () => {
  beforeEach(() => {
    config.providers[0] = {
      id: 7,
      provider_type: "github",
      connected: false,
      needs_reconnect: false,
    };
    vi.mocked(linkCloudOAuthProvider).mockReset();
    vi.mocked(unlinkCloudOAuthProvider).mockReset();
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("starts GitHub OAuth using the provider id returned by the backend", async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign },
    });
    vi.mocked(linkCloudOAuthProvider).mockResolvedValue(
      "https://github.com/login/oauth/authorize?state=signed",
    );
    renderSettings();

    await user.click(await screen.findByTestId("github-oauth-connect"));

    await waitFor(() =>
      expect(linkCloudOAuthProvider).toHaveBeenCalledWith(7),
    );
    expect(assign).toHaveBeenCalledWith(
      "https://github.com/login/oauth/authorize?state=signed",
    );
  });

  it("disconnects a connected GitHub account and retains the app link", async () => {
    const user = userEvent.setup();
    config.providers[0] = {
      ...config.providers[0],
      connected: true,
    };
    vi.mocked(unlinkCloudOAuthProvider).mockResolvedValue();
    renderSettings();

    await user.click(await screen.findByTestId("github-oauth-disconnect"));

    await waitFor(() =>
      expect(unlinkCloudOAuthProvider).toHaveBeenCalledWith(7),
    );
    expect(screen.getByTestId("github-app-install-link")).toHaveAttribute(
      "href",
      "https://github.com/apps/openhands-halo-ppe/installations/new",
    );
  });
});
