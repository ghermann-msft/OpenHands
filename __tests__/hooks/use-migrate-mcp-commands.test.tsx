import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsService from "#/api/settings-service/settings-service.api";
import { SETTINGS_QUERY_KEYS } from "#/hooks/query/query-keys";
import { useMigrateMcpCommands } from "#/hooks/use-migrate-mcp-commands";
import {
  LEGACY_PERFORCE_MCP_COMMAND,
  PERFORCE_MCP_COMMAND,
} from "#/utils/mcp-command-migrations";

const useSettingsMock = vi.fn();
const useActiveBackendMock = vi.fn();

vi.mock("#/hooks/query/use-settings", () => ({
  useSettings: () => useSettingsMock(),
}));
vi.mock("#/contexts/active-backend-context", () => ({
  useActiveBackend: () => useActiveBackendMock(),
}));

function wrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useMigrateMcpCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useActiveBackendMock.mockReturnValue({
      backend: { kind: "cloud", id: "ppe" },
      orgId: null,
    });
  });

  it("sparsely patches legacy commands once and refreshes settings", async () => {
    useSettingsMock.mockReturnValue({
      data: {
        mcp_config: {
          MCC: {
            transport: "stdio",
            command: LEGACY_PERFORCE_MCP_COMMAND,
            args: ["--readonly"],
            env: {
              P4PORT: "ssl:mcc.example.com:1666",
              P4PASSWD: "**********",
            },
          },
          Miramonte: {
            transport: "stdio",
            command: LEGACY_PERFORCE_MCP_COMMAND,
            args: ["--readonly"],
          },
        },
      },
      isLoading: false,
      isError: false,
    });
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const patchMcpConfig = vi
      .spyOn(SettingsService, "patchMcpConfig")
      .mockResolvedValue(true);

    const { rerender } = renderHook(() => useMigrateMcpCommands(), {
      wrapper: wrapper(queryClient),
    });
    rerender();

    await waitFor(() =>
      expect(patchMcpConfig).toHaveBeenCalledWith({
        MCC: { command: PERFORCE_MCP_COMMAND },
        Miramonte: { command: PERFORCE_MCP_COMMAND },
      }),
    );
    await waitFor(() =>
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: SETTINGS_QUERY_KEYS.all,
      }),
    );
    expect(patchMcpConfig).toHaveBeenCalledTimes(1);
  });

  it("does not write when settings already use the portable command", async () => {
    useSettingsMock.mockReturnValue({
      data: {
        mcp_config: {
          perforce: {
            transport: "stdio",
            command: PERFORCE_MCP_COMMAND,
            args: ["--readonly"],
          },
        },
      },
      isLoading: false,
      isError: false,
    });
    const patchMcpConfig = vi.spyOn(SettingsService, "patchMcpConfig");

    renderHook(() => useMigrateMcpCommands(), {
      wrapper: wrapper(new QueryClient()),
    });

    await waitFor(() => expect(patchMcpConfig).not.toHaveBeenCalled());
  });

  it("does not write defaults when settings failed to load", async () => {
    useSettingsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    const patchMcpConfig = vi.spyOn(SettingsService, "patchMcpConfig");

    renderHook(() => useMigrateMcpCommands(), {
      wrapper: wrapper(new QueryClient()),
    });

    await waitFor(() => expect(patchMcpConfig).not.toHaveBeenCalled());
  });
});
