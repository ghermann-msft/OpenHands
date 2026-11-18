import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OrganizationSettingsScreen from "#/routes/organization-settings";

const mocks = vi.hoisted(() => ({
  me: {
    orgId: "org-1",
    userId: "user-1",
    role: "owner",
    permissions: ["organization:manage_members"],
  },
  members: [
    {
      user_id: "user-1",
      identity: {
        provider: "entra",
        tenant_id: "tenant-1",
        subject_id: "subject-owner",
      },
      role: "owner",
    },
    {
      user_id: "user-2",
      identity: {
        provider: "entra",
        tenant_id: null,
        subject_id: "subject-member",
      },
      role: "member",
    },
  ],
  updateRole: vi.fn(),
  mutationError: null as Error | null,
  meError: null as Error | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("#/hooks/query/use-cloud-organization-members", () => ({
  useCloudOrganizationMe: () => ({
    data: mocks.me,
    isLoading: false,
    isError: mocks.meError !== null,
    error: mocks.meError,
  }),
  useCloudOrganizationMembers: () => ({
    data: mocks.members,
    isLoading: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("#/hooks/mutation/use-update-cloud-organization-member-role", () => ({
  useUpdateCloudOrganizationMemberRole: () => ({
    mutateAsync: mocks.updateRole,
    isPending: false,
    error: mocks.mutationError,
  }),
}));

describe("OrganizationSettingsScreen", () => {
  beforeEach(() => {
    mocks.me = {
      orgId: "org-1",
      userId: "user-1",
      role: "owner",
      permissions: ["organization:manage_members"],
    };
    mocks.updateRole.mockReset();
    mocks.updateRole.mockResolvedValue(undefined);
    mocks.mutationError = null;
    mocks.meError = null;
  });

  it("lists immutable Entra identities and lets an authorized owner change roles", async () => {
    render(<OrganizationSettingsScreen />);

    expect(screen.getByText("subject-owner")).toBeInTheDocument();
    expect(screen.getByText("tenant-1")).toBeInTheDocument();
    expect(screen.getAllByText("entra")).toHaveLength(2);

    fireEvent.change(screen.getByTestId("organization-role-user-2"), {
      target: { value: "admin" },
    });

    await waitFor(() =>
      expect(mocks.updateRole).toHaveBeenCalledWith({
        userId: "user-2",
        role: "admin",
      }),
    );
  });

  it("keeps role controls read-only without organization:manage_members", () => {
    mocks.me = {
      ...mocks.me,
      role: "member",
      permissions: ["organization:view"],
    };

    render(<OrganizationSettingsScreen />);

    expect(screen.getByTestId("organization-role-user-2")).toBeDisabled();
    expect(
      screen.getByTestId("organization-members-read-only"),
    ).toBeInTheDocument();
  });

  it("does not render organization controls for a personal workspace", () => {
    mocks.me = {
      ...mocks.me,
      orgId: "user-1",
      userId: "user-1",
    };

    render(<OrganizationSettingsScreen />);

    expect(
      screen.queryByTestId("organization-settings"),
    ).not.toBeInTheDocument();
  });

  it("surfaces the backend detail when a role mutation fails", () => {
    mocks.mutationError = new Error(
      "An organization must have at least one owner",
    );

    render(<OrganizationSettingsScreen />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "An organization must have at least one owner",
    );
  });

  it("surfaces a membership lookup failure", () => {
    mocks.meError = new Error("Not a member of the requested organization");

    render(<OrganizationSettingsScreen />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Not a member of the requested organization",
    );
  });
});
