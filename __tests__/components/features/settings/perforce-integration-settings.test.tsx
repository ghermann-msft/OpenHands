import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PerforceIntegrationSettings } from "#/components/features/settings/integrations/perforce-integration-settings";

const mocks = vi.hoisted(() => ({
  canvasIntegrationsEnabled: true,
  settings: {
    mcp_config: {},
  } as {
    mcp_config: Record<string, unknown>;
  },
  deleteMcpServer: vi.fn(),
  deleteOrganizationConnection: vi.fn(),
  upsertOrganizationConnection: vi.fn(),
  orgId: null as string | null,
  organizationConnections: [] as Array<{
    kind: string;
    connected: boolean;
    editable: boolean;
    scope: string;
    display_name?: string;
    endpoint?: string;
  }>,
}));

vi.mock("@openhands/extensions/integrations", () => ({
  INTEGRATION_CATALOG: [
    {
      id: "perforce",
      name: "Perforce",
      description: "Browse Perforce history.",
      connectionOptions: [
        {
          provider: "mcp",
          auth: { strategy: "none" },
          transport: {
            kind: "stdio",
            serverName: "perforce",
            command: "/usr/local/bin/p4-mcp-server",
            args: ["--readonly"],
            envFields: [],
            argFields: [],
          },
        },
      ],
    },
  ],
}));

vi.mock("#/contexts/active-backend-context", () => ({
  useActiveBackend: () => ({
    backend: { id: "halo", kind: "cloud", connectionRevision: 2 },
    orgId: mocks.orgId,
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

vi.mock("#/hooks/query/use-cloud-organization-connections", () => ({
  useCloudOrganizationConnections: () => ({
    data: mocks.organizationConnections,
    isPending: false,
  }),
}));

vi.mock("#/hooks/mutation/use-cloud-organization-connection", () => ({
  useUpsertCloudOrganizationConnection: () => ({
    mutateAsync: mocks.upsertOrganizationConnection,
    isPending: false,
  }),
  useDeleteCloudOrganizationConnection: () => ({
    mutate: mocks.deleteOrganizationConnection,
    isPending: false,
  }),
}));

vi.mock("#/components/features/mcp-page", () => ({
  InstallServerModal: ({
    entry,
    serverToReplace,
    onPersistServer,
    persistSelectedSecrets,
  }: {
    entry: { id: string };
    serverToReplace?: { id: string };
    onPersistServer?: unknown;
    persistSelectedSecrets?: boolean;
  }) => (
    <div
      data-testid="install-server-modal"
      data-entry-id={entry.id}
      data-server-id={serverToReplace?.id}
      data-custom-persistence={String(!!onPersistServer)}
      data-persist-secrets={String(persistSelectedSecrets)}
    />
  ),
}));

describe("PerforceIntegrationSettings", () => {
  beforeEach(() => {
    mocks.canvasIntegrationsEnabled = true;
    mocks.settings = { mcp_config: {} };
    mocks.orgId = null;
    mocks.organizationConnections = [];
    mocks.deleteMcpServer.mockReset();
    mocks.deleteOrganizationConnection.mockReset();
    mocks.upsertOrganizationConnection.mockReset();
  });

  it("renders one organization connection and uses organization mutations", async () => {
    const user = userEvent.setup();
    mocks.orgId = "org-1";
    mocks.organizationConnections = [
      {
        kind: "perforce",
        connected: true,
        editable: true,
        scope: "shared",
        display_name: "Halo Perforce",
        endpoint: "/usr/local/bin/p4-mcp-server",
      },
    ];

    render(<PerforceIntegrationSettings />);

    expect(screen.getByText("Halo Perforce")).toBeInTheDocument();
    expect(screen.queryByTestId("perforce-add")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("perforce-edit-perforce"));
    expect(screen.getByTestId("install-server-modal")).toHaveAttribute(
      "data-custom-persistence",
      "true",
    );
    expect(screen.getByTestId("install-server-modal")).toHaveAttribute(
      "data-persist-secrets",
      "false",
    );
    await user.click(screen.getByTestId("perforce-disconnect-perforce"));
    expect(mocks.deleteOrganizationConnection).toHaveBeenCalledWith(
      "perforce",
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("stays hidden when the backend disables Canvas integrations", () => {
    mocks.canvasIntegrationsEnabled = false;

    render(<PerforceIntegrationSettings />);

    expect(
      screen.queryByTestId("perforce-integration-settings"),
    ).not.toBeInTheDocument();
  });

  it("manages multiple Perforce connections independently", async () => {
    const user = userEvent.setup();
    mocks.settings = {
      mcp_config: {
        perforce: {
          transport: "stdio",
          command: "/usr/local/bin/p4-mcp-server",
          args: ["--readonly"],
          env: {
            P4PORT: "ssl:perforce-main.example.com:1666",
            P4USER: "main-user",
            P4PASSWD: "**********",
          },
        },
        perforce_1: {
          transport: "stdio",
          command: "/usr/local/bin/p4-mcp-server",
          args: ["--readonly"],
          env: {
            P4PORT: "ssl:perforce-release.example.com:1666",
            P4USER: "release-user",
            P4PASSWD: "**********",
          },
        },
      },
    };
    render(<PerforceIntegrationSettings />);

    expect(
      screen.getByText("ssl:perforce-main.example.com:1666"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("ssl:perforce-release.example.com:1666"),
    ).toBeInTheDocument();
    expect(screen.getByText("perforce_1")).toBeInTheDocument();
    expect(screen.queryByText("**********")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("perforce-edit-perforce_1"));
    expect(screen.getByTestId("install-server-modal")).toHaveAttribute(
      "data-server-id",
      "perforce_1",
    );

    await user.click(screen.getByTestId("perforce-disconnect-perforce"));
    expect(mocks.deleteMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "perforce" }),
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("opens the catalog installer for another connection", async () => {
    const user = userEvent.setup();
    render(<PerforceIntegrationSettings />);

    await user.click(screen.getByTestId("perforce-add"));

    expect(screen.getByTestId("install-server-modal")).toHaveAttribute(
      "data-entry-id",
      "perforce",
    );
  });
});
