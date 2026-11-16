import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsService from "#/api/settings-service/settings-service.api";
import { MOCK_DEFAULT_USER_SETTINGS } from "#/mocks/handlers";
import RuntimeSettingsScreen from "#/routes/runtime-settings";
import type { SettingsValue } from "#/types/settings";
import * as SandboxSpecService from "#/api/cloud/sandbox-spec-service.api";

const mockUseConversationWorkspace = vi.hoisted(() => vi.fn());
const backendState = vi.hoisted(() => ({ kind: "local" as "local" | "cloud" }));
vi.mock("#/hooks/query/use-conversation-workspace", () => ({
  useConversationWorkspace: () => mockUseConversationWorkspace(),
}));
vi.mock("#/contexts/active-backend-context", () => ({
  useActiveBackend: () => ({
    backend: {
      id: backendState.kind,
      name: backendState.kind,
      host: "https://halo.example.com",
      apiKey: "test",
      kind: backendState.kind,
    },
    orgId: null,
  }),
}));

const RUNTIME_OPTION_IDS = [
  "sdk-settings-worktree_base",
  "sdk-settings-worktree_base_ref",
  "sdk-settings-worktree_branch_prefix",
  "sdk-settings-container_memory",
  "sdk-settings-container_cpus",
  "sdk-settings-container_browser",
];

async function renderRuntimeOptions(
  conversationSettings: Record<string, SettingsValue>,
) {
  vi.spyOn(SettingsService, "getSettings").mockResolvedValue({
    ...MOCK_DEFAULT_USER_SETTINGS,
    conversation_settings: conversationSettings,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(<RuntimeSettingsScreen />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  await screen.findByTestId("sdk-settings-default_runtime");
  return RUNTIME_OPTION_IDS.filter((id) => screen.queryByTestId(id));
}

describe("RuntimeSettingsScreen", () => {
  beforeEach(() => {
    backendState.kind = "local";
    mockUseConversationWorkspace.mockReturnValue({
      dockerSelectable: true,
      serverInfoLoading: false,
    });
  });

  it("persists the selected default execution profile for cloud conversations", async () => {
    backendState.kind = "cloud";
    vi.spyOn(SandboxSpecService, "searchSandboxSpecs").mockResolvedValue({
      items: [
        {
          id: "openhands-pool",
          display_name: "Linux Standard",
          enabled: true,
          published: true,
          availability: "available",
          operating_system: "linux",
          resource_class: "standard",
          cpu_cores: 4,
          memory_gib: 8,
          capabilities: ["git"],
        },
        {
          id: "windows-build",
          display_name: "Windows Build",
          enabled: true,
          published: true,
          availability: "available",
          operating_system: "windows",
          resource_class: "build",
          cpu_cores: 8,
          memory_gib: 16,
          capabilities: ["git", "perforce"],
        },
      ],
      next_page_id: null,
    } as never);
    const saveSettings = vi
      .spyOn(SettingsService, "saveSettings")
      .mockResolvedValue(true);

    await renderRuntimeOptions({ default_runtime: "local" });
    await screen.findByRole("option", { name: /Windows Build/ });
    await userEvent.selectOptions(
      screen.getByTestId("execution-profile-select"),
      "windows-build",
    );

    await waitFor(() =>
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          default_sandbox_spec_id: "windows-build",
        }),
      ),
    );
  });

  it.each<[string, Record<string, SettingsValue>, string[]]>([
    ["local", { default_runtime: "local" }, []],
    [
      "worktree",
      { default_runtime: "worktree" },
      ["sdk-settings-worktree_base", "sdk-settings-worktree_branch_prefix"],
    ],
    [
      "worktree from a ref",
      { default_runtime: "worktree", worktree_base: "ref" },
      [
        "sdk-settings-worktree_base",
        "sdk-settings-worktree_base_ref",
        "sdk-settings-worktree_branch_prefix",
      ],
    ],
    [
      "docker",
      { default_runtime: "docker" },
      [
        "sdk-settings-container_memory",
        "sdk-settings-container_cpus",
        "sdk-settings-container_browser",
      ],
    ],
  ])("shows only the %s runtime's options", async (_, settings, expected) => {
    expect(await renderRuntimeOptions(settings)).toEqual(expected);
  });

  describe("on a server that cannot run Docker", () => {
    beforeEach(() => {
      mockUseConversationWorkspace.mockReturnValue({
        dockerSelectable: false,
        serverInfoLoading: false,
      });
    });

    it("does not offer Docker as the default runtime", async () => {
      await renderRuntimeOptions({ default_runtime: "local" });
      await userEvent.click(screen.getByTestId("sdk-settings-default_runtime"));
      expect(
        screen.getAllByRole("option").map((option) => option.textContent),
      ).toEqual([
        "SCHEMA$DEFAULT_RUNTIME$CHOICE$LOCAL",
        "SCHEMA$DEFAULT_RUNTIME$CHOICE$WORKTREE",
      ]);
      expect(
        screen.queryByTestId("runtime-docker-unavailable"),
      ).not.toBeInTheDocument();
    });

    it("hides the container options and explains a saved Docker default", async () => {
      expect(await renderRuntimeOptions({ default_runtime: "docker" })).toEqual(
        [],
      );
      expect(
        screen.getByTestId("runtime-docker-unavailable"),
      ).toBeInTheDocument();
    });
  });
});
