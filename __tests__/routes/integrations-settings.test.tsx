import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import IntegrationsSettingsScreen from "#/routes/integrations-settings";

vi.mock(
  "#/components/features/settings/app-settings/github-integration-settings",
  () => ({
    GitHubIntegrationSettings: ({ standalone }: { standalone?: boolean }) => (
      <div
        data-testid="github-integration-settings"
        data-standalone={String(standalone)}
      />
    ),
  }),
);
vi.mock(
  "#/components/features/settings/integrations/atlassian-integration-settings",
  () => ({
    AtlassianIntegrationSettings: () => (
      <div data-testid="atlassian-integration-settings" />
    ),
  }),
);

describe("IntegrationsSettingsScreen", () => {
  it("renders the Canvas-owned integration controls as a standalone page", () => {
    render(<IntegrationsSettingsScreen />);

    expect(screen.getByTestId("github-integration-settings")).toHaveAttribute(
      "data-standalone",
      "true",
    );
    expect(
      screen.getByTestId("atlassian-integration-settings"),
    ).toBeInTheDocument();
  });
});
