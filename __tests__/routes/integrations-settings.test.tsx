import { fireEvent, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test-utils";
import IntegrationsSettingsRoute from "#/routes/integrations-settings";
import { useCloudIntegrationsConfig } from "#/hooks/query/use-cloud-integrations-config";
import { useUserProviders } from "#/hooks/use-user-providers";
import { useSettings } from "#/hooks/query/use-settings";
import { useAppInstallations } from "#/hooks/query/use-app-installations";
import { useGitRepositories } from "#/hooks/query/use-git-repositories";
import { useCloudOAuthProviders } from "#/hooks/query/use-cloud-oauth-providers";
import { useLinkCloudOAuthProvider } from "#/hooks/mutation/use-link-cloud-oauth-provider";

vi.mock("#/hooks/query/use-cloud-integrations-config");
vi.mock("#/hooks/use-user-providers");
vi.mock("#/hooks/query/use-settings");
vi.mock("#/hooks/query/use-app-installations");
vi.mock("#/hooks/query/use-git-repositories");
vi.mock("#/hooks/query/use-cloud-oauth-providers");
vi.mock("#/hooks/mutation/use-link-cloud-oauth-provider");

const refetchConfig = vi.fn();
const refetchSettings = vi.fn();
const refetchInstallations = vi.fn();
const refetchRepositories = vi.fn();
const refetchOauthProviders = vi.fn();
const linkOauthProvider = vi.fn();

function renderRoute() {
  return renderWithProviders(
    <MemoryRouter initialEntries={["/settings/integrations"]}>
      <Routes>
        <Route
          path="/settings/integrations"
          element={<IntegrationsSettingsRoute />}
        />
        <Route
          path="/settings/app"
          element={<div data-testid="application-settings" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useCloudIntegrationsConfig).mockReturnValue({
    data: {
      providersConfigured: ["github"],
      isJiraEnabled: false,
      isJiraDcEnabled: false,
      isLinearEnabled: false,
      isSlackEnabled: false,
      deploymentMode: "self_hosted",
      isOrgMcpServersEnabled: false,
      isServiceAccountsEnabled: false,
      isCanvasIntegrationsEnabled: true,
      isOauthV2LoginEnabled: false,
      githubAppInstallUrl:
        "https://github.example.com/apps/halo/installations/new",
    },
    isLoading: false,
    isFetching: false,
    refetch: refetchConfig,
  } as unknown as ReturnType<typeof useCloudIntegrationsConfig>);
  vi.mocked(useUserProviders).mockReturnValue({
    providers: [],
    isLoadingSettings: false,
  });
  vi.mocked(useSettings).mockReturnValue({
    isFetching: false,
    refetch: refetchSettings,
  } as unknown as ReturnType<typeof useSettings>);
  vi.mocked(useAppInstallations).mockReturnValue({
    isFetching: false,
    refetch: refetchInstallations,
  } as unknown as ReturnType<typeof useAppInstallations>);
  vi.mocked(useGitRepositories).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    isFetchingNextPage: false,
    refetch: refetchRepositories,
  } as unknown as ReturnType<typeof useGitRepositories>);
  vi.mocked(useCloudOAuthProviders).mockReturnValue({
    data: undefined,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: refetchOauthProviders,
  } as unknown as ReturnType<typeof useCloudOAuthProviders>);
  vi.mocked(useLinkCloudOAuthProvider).mockReturnValue({
    mutate: linkOauthProvider,
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof useLinkCloudOAuthProvider>);
});

describe("IntegrationsSettingsRoute", () => {
  it("redirects direct access when the backend does not advertise Canvas ownership", () => {
    // Arrange
    vi.mocked(useCloudIntegrationsConfig).mockReturnValue({
      data: {
        providersConfigured: ["github"],
        isJiraEnabled: false,
        isJiraDcEnabled: false,
        isLinearEnabled: false,
        isSlackEnabled: false,
        deploymentMode: "cloud",
        isOrgMcpServersEnabled: false,
        isServiceAccountsEnabled: false,
        isCanvasIntegrationsEnabled: false,
        isOauthV2LoginEnabled: true,
        githubAppInstallUrl: null,
      },
      isLoading: false,
      isFetching: false,
      refetch: refetchConfig,
    } as unknown as ReturnType<typeof useCloudIntegrationsConfig>);

    // Act
    renderRoute();

    // Assert
    expect(screen.getByTestId("application-settings")).toBeInTheDocument();
    expect(
      screen.queryByTestId("hosted-git-integrations"),
    ).not.toBeInTheDocument();
  });

  it("shows the Enterprise GitHub App install CTA when disconnected", () => {
    // Act
    renderRoute();
    fireEvent.click(screen.getByTestId("refresh-integrations"));

    // Assert
    const installLink = screen.getByTestId("github-app-install-link");
    expect(installLink).toHaveAttribute(
      "href",
      "https://github.example.com/apps/halo/installations/new",
    );
    expect(installLink).toHaveAttribute("target", "_blank");
    expect(
      screen.queryByTestId("github-oauth-connect"),
    ).not.toBeInTheDocument();
    expect(useCloudOAuthProviders).toHaveBeenCalledWith({ enabled: false });
    expect(refetchInstallations).not.toHaveBeenCalled();
    expect(refetchRepositories).not.toHaveBeenCalled();
  });

  it("uses the provider token as connected status when OAuth-v2 is disabled", () => {
    // Arrange
    vi.mocked(useUserProviders).mockReturnValue({
      providers: ["github"],
      isLoadingSettings: false,
    });

    // Act
    renderRoute();

    // Assert
    expect(
      screen.getByText("SETTINGS$INTEGRATIONS_ACCOUNT_CONNECTED"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("SETTINGS$INTEGRATIONS_ACCOUNT_DISCONNECTED"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("octocat/connected-repository"),
    ).not.toBeInTheDocument();
  });

  it("shows connected repositories and refreshes all backing queries", async () => {
    // Arrange
    vi.mocked(useUserProviders).mockReturnValue({
      providers: ["github"],
      isLoadingSettings: false,
    });
    vi.mocked(useGitRepositories).mockReturnValue({
      data: {
        pages: [
          {
            items: [
              {
                id: "repo-1",
                full_name: "octocat/connected-repository",
                git_provider: "github",
                is_public: false,
              },
            ],
            next_page_id: null,
          },
        ],
        pageParams: [null],
      },
      isLoading: false,
      isError: false,
      isFetchingNextPage: false,
      refetch: refetchRepositories,
    } as unknown as ReturnType<typeof useGitRepositories>);

    // Act
    renderRoute();
    fireEvent.click(screen.getByTestId("refresh-integrations"));

    // Assert
    expect(
      screen.getByText("octocat/connected-repository"),
    ).toBeInTheDocument();
    expect(refetchConfig).toHaveBeenCalledOnce();
    expect(refetchSettings).toHaveBeenCalledOnce();
    expect(refetchInstallations).toHaveBeenCalledOnce();
    expect(refetchRepositories).toHaveBeenCalledOnce();
    expect(refetchOauthProviders).not.toHaveBeenCalled();
  });

  it("uses the discovered GitHub OAuth provider for connect and keeps install separate", () => {
    // Arrange
    vi.mocked(useCloudIntegrationsConfig).mockReturnValue({
      data: {
        providersConfigured: ["github"],
        isJiraEnabled: false,
        isJiraDcEnabled: false,
        isLinearEnabled: false,
        isSlackEnabled: false,
        deploymentMode: "self_hosted",
        isOrgMcpServersEnabled: false,
        isServiceAccountsEnabled: false,
        isCanvasIntegrationsEnabled: true,
        isOauthV2LoginEnabled: true,
        githubAppInstallUrl:
          "https://github.example.com/apps/halo/installations/new",
      },
      isLoading: false,
      isFetching: false,
      refetch: refetchConfig,
    } as unknown as ReturnType<typeof useCloudIntegrationsConfig>);
    vi.mocked(useCloudOAuthProviders).mockReturnValue({
      data: [
        {
          id: 17,
          provider_type: "gitlab",
          connected: false,
          needs_reconnect: false,
        },
        {
          id: 41,
          provider_type: "github",
          connected: false,
          needs_reconnect: false,
        },
      ],
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: refetchOauthProviders,
    } as unknown as ReturnType<typeof useCloudOAuthProviders>);

    // Act
    renderRoute();
    fireEvent.click(screen.getByTestId("github-oauth-connect"));
    fireEvent.click(screen.getByTestId("refresh-integrations"));

    // Assert
    expect(linkOauthProvider).toHaveBeenCalledWith(41);
    expect(useCloudOAuthProviders).toHaveBeenCalledWith({ enabled: true });
    expect(refetchOauthProviders).toHaveBeenCalledOnce();
    expect(screen.getByTestId("github-app-install-link")).toHaveAttribute(
      "href",
      "https://github.example.com/apps/halo/installations/new",
    );
  });

  it("offers reconnect for an existing GitHub connection", () => {
    // Arrange
    vi.mocked(useCloudIntegrationsConfig).mockReturnValue({
      data: {
        providersConfigured: ["github"],
        isJiraEnabled: false,
        isJiraDcEnabled: false,
        isLinearEnabled: false,
        isSlackEnabled: false,
        deploymentMode: "self_hosted",
        isOrgMcpServersEnabled: false,
        isServiceAccountsEnabled: false,
        isCanvasIntegrationsEnabled: true,
        isOauthV2LoginEnabled: true,
        githubAppInstallUrl:
          "https://github.example.com/apps/halo/installations/new",
      },
      isLoading: false,
      isFetching: false,
      refetch: refetchConfig,
    } as unknown as ReturnType<typeof useCloudIntegrationsConfig>);
    vi.mocked(useCloudOAuthProviders).mockReturnValue({
      data: [
        {
          id: 41,
          provider_type: "github",
          connected: true,
          needs_reconnect: false,
        },
      ],
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: refetchOauthProviders,
    } as unknown as ReturnType<typeof useCloudOAuthProviders>);
    vi.mocked(useUserProviders).mockReturnValue({
      providers: ["github"],
      isLoadingSettings: false,
    });

    // Act
    renderRoute();

    // Assert
    expect(screen.getByTestId("github-oauth-connect")).toHaveTextContent(
      "SETTINGS$INTEGRATIONS_RECONNECT_GITHUB",
    );
    expect(screen.getByTestId("github-app-install-link")).toHaveTextContent(
      "SETTINGS$INTEGRATIONS_INSTALL_GITHUB",
    );
  });

  it("shows reconnect-required status when the OAuth provider is stale", () => {
    // Arrange
    vi.mocked(useCloudIntegrationsConfig).mockReturnValue({
      data: {
        providersConfigured: ["github"],
        isJiraEnabled: false,
        isJiraDcEnabled: false,
        isLinearEnabled: false,
        isSlackEnabled: false,
        deploymentMode: "self_hosted",
        isOrgMcpServersEnabled: false,
        isServiceAccountsEnabled: false,
        isCanvasIntegrationsEnabled: true,
        isOauthV2LoginEnabled: true,
        githubAppInstallUrl:
          "https://github.example.com/apps/halo/installations/new",
      },
      isLoading: false,
      isFetching: false,
      refetch: refetchConfig,
    } as unknown as ReturnType<typeof useCloudIntegrationsConfig>);
    vi.mocked(useCloudOAuthProviders).mockReturnValue({
      data: [
        {
          id: 41,
          provider_type: "github",
          connected: true,
          needs_reconnect: true,
        },
      ],
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: refetchOauthProviders,
    } as unknown as ReturnType<typeof useCloudOAuthProviders>);
    vi.mocked(useUserProviders).mockReturnValue({
      providers: ["github"],
      isLoadingSettings: false,
    });

    // Act
    renderRoute();

    // Assert
    expect(
      screen.getByText("SETTINGS$INTEGRATIONS_ACCOUNT_RECONNECT_REQUIRED"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("github-oauth-connect")).toHaveTextContent(
      "SETTINGS$INTEGRATIONS_RECONNECT_GITHUB",
    );
    expect(
      screen.queryByText("SETTINGS$INTEGRATIONS_ACCOUNT_CONNECTED"),
    ).not.toBeInTheDocument();
  });

  it("uses installation data, not OAuth state, for the Configure label", () => {
    // Arrange
    vi.mocked(useUserProviders).mockReturnValue({
      providers: ["github"],
      isLoadingSettings: false,
    });
    vi.mocked(useAppInstallations).mockReturnValue({
      data: { items: ["installation-1"], next_page_id: null },
      isFetching: false,
      refetch: refetchInstallations,
    } as unknown as ReturnType<typeof useAppInstallations>);

    // Act
    renderRoute();

    // Assert
    expect(screen.getByTestId("github-app-install-link")).toHaveTextContent(
      "SETTINGS$INTEGRATIONS_CONFIGURE_GITHUB",
    );
  });

  it("shows OAuth unavailable when discovery has no GitHub provider", () => {
    // Arrange
    vi.mocked(useCloudIntegrationsConfig).mockReturnValue({
      data: {
        providersConfigured: ["github"],
        isJiraEnabled: false,
        isJiraDcEnabled: false,
        isLinearEnabled: false,
        isSlackEnabled: false,
        deploymentMode: "self_hosted",
        isOrgMcpServersEnabled: false,
        isServiceAccountsEnabled: false,
        isCanvasIntegrationsEnabled: true,
        isOauthV2LoginEnabled: true,
        githubAppInstallUrl:
          "https://github.example.com/apps/halo/installations/new",
      },
      isLoading: false,
      isFetching: false,
      refetch: refetchConfig,
    } as unknown as ReturnType<typeof useCloudIntegrationsConfig>);
    vi.mocked(useCloudOAuthProviders).mockReturnValue({
      data: [
        {
          id: 17,
          provider_type: "gitlab",
          connected: false,
          needs_reconnect: false,
        },
      ],
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: refetchOauthProviders,
    } as unknown as ReturnType<typeof useCloudOAuthProviders>);

    // Act
    renderRoute();

    // Assert
    expect(screen.getByTestId("github-oauth-unavailable")).toBeInTheDocument();
    expect(
      screen.queryByTestId("github-oauth-connect"),
    ).not.toBeInTheDocument();
  });

  it("uses the provider token as fallback when OAuth discovery has no GitHub provider", () => {
    // Arrange
    vi.mocked(useCloudIntegrationsConfig).mockReturnValue({
      data: {
        providersConfigured: ["github"],
        isJiraEnabled: false,
        isJiraDcEnabled: false,
        isLinearEnabled: false,
        isSlackEnabled: false,
        deploymentMode: "self_hosted",
        isOrgMcpServersEnabled: false,
        isServiceAccountsEnabled: false,
        isCanvasIntegrationsEnabled: true,
        isOauthV2LoginEnabled: true,
        githubAppInstallUrl:
          "https://github.example.com/apps/halo/installations/new",
      },
      isLoading: false,
      isFetching: false,
      refetch: refetchConfig,
    } as unknown as ReturnType<typeof useCloudIntegrationsConfig>);
    vi.mocked(useCloudOAuthProviders).mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: refetchOauthProviders,
    } as unknown as ReturnType<typeof useCloudOAuthProviders>);
    vi.mocked(useUserProviders).mockReturnValue({
      providers: ["github"],
      isLoadingSettings: false,
    });

    // Act
    renderRoute();

    // Assert
    expect(
      screen.getByText("SETTINGS$INTEGRATIONS_ACCOUNT_CONNECTED"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("github-oauth-unavailable")).toBeInTheDocument();
  });

  it("shows an unconfigured state without an install URL", () => {
    // Arrange
    vi.mocked(useCloudIntegrationsConfig).mockReturnValue({
      data: {
        providersConfigured: ["github"],
        isJiraEnabled: false,
        isJiraDcEnabled: false,
        isLinearEnabled: false,
        isSlackEnabled: false,
        deploymentMode: "self_hosted",
        isOrgMcpServersEnabled: false,
        isServiceAccountsEnabled: false,
        isCanvasIntegrationsEnabled: true,
        isOauthV2LoginEnabled: false,
        githubAppInstallUrl: null,
      },
      isLoading: false,
      isFetching: false,
      refetch: refetchConfig,
    } as unknown as ReturnType<typeof useCloudIntegrationsConfig>);

    // Act
    renderRoute();

    // Assert
    expect(screen.getByTestId("integrations-unconfigured")).toBeInTheDocument();
    expect(
      screen.queryByTestId("github-app-install-link"),
    ).not.toBeInTheDocument();
  });

  it("keeps OAuth connect available when GitHub App installation is unconfigured", () => {
    // Arrange
    vi.mocked(useCloudIntegrationsConfig).mockReturnValue({
      data: {
        providersConfigured: ["github"],
        isJiraEnabled: false,
        isJiraDcEnabled: false,
        isLinearEnabled: false,
        isSlackEnabled: false,
        deploymentMode: "self_hosted",
        isOrgMcpServersEnabled: false,
        isServiceAccountsEnabled: false,
        isCanvasIntegrationsEnabled: true,
        isOauthV2LoginEnabled: true,
        githubAppInstallUrl: null,
      },
      isLoading: false,
      isFetching: false,
      refetch: refetchConfig,
    } as unknown as ReturnType<typeof useCloudIntegrationsConfig>);
    vi.mocked(useCloudOAuthProviders).mockReturnValue({
      data: [
        {
          id: 41,
          provider_type: "github",
          connected: false,
          needs_reconnect: false,
        },
      ],
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: refetchOauthProviders,
    } as unknown as ReturnType<typeof useCloudOAuthProviders>);

    // Act
    renderRoute();

    // Assert
    expect(screen.getByTestId("github-oauth-connect")).toBeInTheDocument();
    expect(screen.getByTestId("github-app-unavailable")).toBeInTheDocument();
    expect(
      screen.queryByTestId("github-app-install-link"),
    ).not.toBeInTheDocument();
  });
});
