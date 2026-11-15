import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectAtlassianIntegration,
  disconnectAtlassianIntegration,
  fetchAtlassianIntegration,
} from "#/api/cloud/atlassian-integration-service.api";
import { AtlassianIntegrationSettings } from "#/components/features/settings/integrations/atlassian-integration-settings";

const config = vi.hoisted(() => ({
  enabled: true,
}));

vi.mock("#/contexts/active-backend-context", () => ({
  useActiveBackend: () => ({
    backend: { id: "halo", kind: "cloud", connectionRevision: 2 },
    orgId: null,
  }),
}));

vi.mock("#/hooks/query/use-cloud-integrations-config", () => ({
  useCloudIntegrationsConfig: () => ({
    data: {
      isCanvasIntegrationsEnabled: true,
      isAtlassianApiTokenEnabled: config.enabled,
    },
  }),
}));

vi.mock("#/api/cloud/atlassian-integration-service.api", () => ({
  fetchAtlassianIntegration: vi.fn(),
  connectAtlassianIntegration: vi.fn(),
  disconnectAtlassianIntegration: vi.fn(),
}));

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AtlassianIntegrationSettings />
    </QueryClientProvider>,
  );
}

describe("AtlassianIntegrationSettings", () => {
  beforeEach(() => {
    config.enabled = true;
    vi.mocked(fetchAtlassianIntegration).mockReset();
    vi.mocked(connectAtlassianIntegration).mockReset();
    vi.mocked(disconnectAtlassianIntegration).mockReset();
  });

  it("stays hidden when the backend does not advertise token support", () => {
    config.enabled = false;

    renderSettings();

    expect(
      screen.queryByTestId("atlassian-integration-settings"),
    ).not.toBeInTheDocument();
    expect(fetchAtlassianIntegration).not.toHaveBeenCalled();
  });

  it("saves Jira and Confluence credentials independently", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAtlassianIntegration).mockResolvedValue({
      jira: { connected: false, site_url: null, email: null },
      confluence: { connected: false, site_url: null, email: null },
    });
    vi.mocked(connectAtlassianIntegration).mockResolvedValue({
      connected: true,
      site_url: "https://example.atlassian.net",
      email: "user@example.com",
    });
    renderSettings();

    await user.type(
      await screen.findByTestId("atlassian-jira-site-url"),
      "https://example.atlassian.net",
    );
    await user.type(
      screen.getByTestId("atlassian-jira-email"),
      "user@example.com",
    );
    await user.type(
      screen.getByTestId("atlassian-jira-api-token"),
      "jira-token",
    );
    await user.click(screen.getByTestId("atlassian-jira-connect"));

    await waitFor(() =>
      expect(connectAtlassianIntegration).toHaveBeenCalledWith("jira", {
        site_url: "https://example.atlassian.net",
        email: "user@example.com",
        api_token: "jira-token",
      }),
    );
    expect(connectAtlassianIntegration).not.toHaveBeenCalledWith(
      "confluence",
      expect.anything(),
    );
  });

  it("disconnects Jira without changing Confluence", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAtlassianIntegration).mockResolvedValue({
      jira: {
        connected: true,
        site_url: "https://example.atlassian.net",
        email: "user@example.com",
      },
      confluence: {
        connected: true,
        site_url: "https://example.atlassian.net",
        email: "user@example.com",
      },
    });
    vi.mocked(disconnectAtlassianIntegration).mockResolvedValue();
    renderSettings();

    await user.click(
      await screen.findByTestId("atlassian-jira-disconnect"),
    );

    await waitFor(() =>
      expect(disconnectAtlassianIntegration).toHaveBeenCalledWith("jira"),
    );
    expect(disconnectAtlassianIntegration).not.toHaveBeenCalledWith(
      "confluence",
    );
  });

  it("keeps only the failing product form open", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchAtlassianIntegration).mockResolvedValue({
      jira: { connected: false, site_url: null, email: null },
      confluence: {
        connected: true,
        site_url: "https://example.atlassian.net",
        email: "user@example.com",
      },
    });
    vi.mocked(connectAtlassianIntegration).mockRejectedValue(
      new Error("Jira authentication failed."),
    );
    renderSettings();

    await user.type(
      await screen.findByTestId("atlassian-jira-site-url"),
      "https://example.atlassian.net",
    );
    await user.type(
      screen.getByTestId("atlassian-jira-email"),
      "user@example.com",
    );
    await user.type(
      screen.getByTestId("atlassian-jira-api-token"),
      "bad-token",
    );
    await user.click(screen.getByTestId("atlassian-jira-connect"));

    expect(
      await screen.findByText("Jira authentication failed."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("atlassian-jira-api-token")).toHaveValue(
      "bad-token",
    );
    expect(
      screen.queryByTestId("atlassian-confluence-api-token"),
    ).not.toBeInTheDocument();
  });
});
