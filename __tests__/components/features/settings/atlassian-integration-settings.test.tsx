import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AtlassianIntegrationSettings } from "#/components/features/settings/integrations/atlassian-integration-settings";

const mocks = vi.hoisted(() => ({
  canvasIntegrationsEnabled: true,
  settings: {
    mcp_config: {},
  } as {
    mcp_config: Record<string, unknown>;
  },
  deleteMcpServer: vi.fn(),
}));

vi.mock("#/contexts/active-backend-context", () => ({
  useActiveBackend: () => ({
    backend: { id: "halo", kind: "cloud", connectionRevision: 2 },
  }),
}));

vi.mock("#/hooks/query/use-cloud-integrations-config", () => ({
  useCloudIntegrationsConfig: () => ({
    data: {
      isCanvasIntegrationsEnabled: mocks.canvasIntegrationsEnabled,
    },
    isPending: false,
  }),
}));

vi.mock("#/hooks/query/use-settings", () => ({
  useSettings: () => ({
    data: mocks.settings,
    isLoading: false,
  }),
}));

vi.mock("#/hooks/mutation/use-delete-mcp-server", () => ({
  useDeleteMcpServer: () => ({
    mutate: mocks.deleteMcpServer,
    isPending: false,
  }),
}));

vi.mock("#/components/features/mcp-page", () => ({
  InstallServerModal: ({
    entry,
    mcpOnly,
    serverToReplace,
  }: {
    entry: { id: string };
    mcpOnly?: boolean;
    serverToReplace?: { id: string };
  }) => (
    <div
      data-testid="install-server-modal"
      data-entry-id={entry.id}
      data-mcp-only={String(mcpOnly)}
      data-server-id={serverToReplace?.id}
    />
  ),
}));

describe("AtlassianIntegrationSettings", () => {
  beforeEach(() => {
    mocks.canvasIntegrationsEnabled = true;
    mocks.settings = { mcp_config: {} };
    mocks.deleteMcpServer.mockReset();
  });

  it("stays hidden when the backend disables Canvas integrations", () => {
    mocks.canvasIntegrationsEnabled = false;

    render(<AtlassianIntegrationSettings />);

    expect(
      screen.queryByTestId("atlassian-integration-settings"),
    ).not.toBeInTheDocument();
  });

  it("opens the generic MCP installer for Atlassian Rovo", async () => {
    const user = userEvent.setup();
    render(<AtlassianIntegrationSettings />);

    await user.click(screen.getByTestId("atlassian-connect"));

    expect(screen.getByTestId("install-server-modal")).toHaveAttribute(
      "data-entry-id",
      "atlassian-rovo",
    );
    expect(screen.getByTestId("install-server-modal")).toHaveAttribute(
      "data-mcp-only",
      "true",
    );
  });

  it("shows the connected Basic-auth identity and disconnects the generic MCP server", async () => {
    const user = userEvent.setup();
    mocks.settings = {
      mcp_config: {
        "atlassian-rovo": {
          transport: "streamable-http",
          url: "https://mcp.atlassian.com/v2/mcp",
          auth: {
            strategy: "basic",
            username: "user@example.com",
            password: "**********",
          },
        },
      },
    };
    render(<AtlassianIntegrationSettings />);

    expect(screen.getByTestId("atlassian-connected-email")).toHaveTextContent(
      "user@example.com",
    );
    await user.click(screen.getByTestId("atlassian-disconnect"));

    expect(mocks.deleteMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "atlassian-rovo",
        url: "https://mcp.atlassian.com/v2/mcp",
      }),
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("opens the generic server editor for an installed connection", async () => {
    const user = userEvent.setup();
    mocks.settings = {
      mcp_config: {
        "atlassian-rovo": {
          transport: "streamable-http",
          url: "https://mcp.atlassian.com/v2/mcp",
          auth: {
            strategy: "basic",
            username: "user@example.com",
            password: "**********",
          },
        },
      },
    };
    render(<AtlassianIntegrationSettings />);

    await user.click(screen.getByTestId("atlassian-edit"));

    expect(screen.getByTestId("install-server-modal")).toHaveAttribute(
      "data-server-id",
      "atlassian-rovo",
    );
  });
});
