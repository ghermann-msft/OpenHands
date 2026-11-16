import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ExecutionProfilesSettingsScreen from "#/routes/execution-profiles-settings";

const mocks = vi.hoisted(() => ({
  canManage: false,
  update: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("#/hooks/query/use-sandbox-specs", () => ({
  useSandboxSpecAdminCapabilities: () => ({
    data: { can_manage: mocks.canManage },
    isLoading: false,
  }),
  useAdminSandboxSpecs: () => ({
    isLoading: false,
    data: {
      items: [
        {
          id: "windows-build",
          display_name: "Windows Build",
          enabled: true,
          immutable: false,
          availability: "available",
          availability_reason: null,
          operating_system: "windows",
          resource_class: "build",
          cpu_cores: 8,
          memory_gib: 16,
        },
      ],
    },
  }),
}));

vi.mock("#/hooks/mutation/use-sandbox-spec-mutations", () => ({
  useSandboxSpecMutations: () => ({
    create: { isPending: false, mutateAsync: vi.fn() },
    update: {
      isPending: false,
      mutate: mocks.update,
      mutateAsync: vi.fn(),
    },
    remove: { isPending: false, mutateAsync: vi.fn() },
  }),
}));

describe("ExecutionProfilesSettingsScreen", () => {
  beforeEach(() => {
    mocks.canManage = false;
    mocks.update.mockReset();
  });

  it("shows an explicit unauthorized state from the server capability", () => {
    render(<ExecutionProfilesSettingsScreen />);

    expect(
      screen.getByTestId("execution-profiles-unauthorized"),
    ).toHaveTextContent("SETTINGS$EXECUTION_PROFILES_UNAUTHORIZED");
  });

  it("allows an authorized administrator to disable a mutable profile", () => {
    mocks.canManage = true;
    render(<ExecutionProfilesSettingsScreen />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "SETTINGS$EXECUTION_PROFILE_DISABLE",
      }),
    );

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "windows-build", enabled: false }),
    );
  });
});
