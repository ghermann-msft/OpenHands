import { useCallback, useEffect } from "react";
import { Navigate } from "react-router";
import { ExternalLink, RefreshCw } from "lucide-react";
import { FaGithub } from "react-icons/fa6";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { useCloudIntegrationsConfig } from "#/hooks/query/use-cloud-integrations-config";
import { useUserProviders } from "#/hooks/use-user-providers";
import { useSettings } from "#/hooks/query/use-settings";
import { useAppInstallations } from "#/hooks/query/use-app-installations";
import { useGitRepositories } from "#/hooks/query/use-git-repositories";
import { LoadingSpinner } from "#/components/shared/loading-spinner";
import { BrandButton } from "#/components/features/settings/brand-button";
import { LOCKED_CLOUD_SETTINGS_NAV_PATH } from "#/constants/settings-nav";
import { useCloudOAuthProviders } from "#/hooks/query/use-cloud-oauth-providers";
import { useLinkCloudOAuthProvider } from "#/hooks/mutation/use-link-cloud-oauth-provider";

const GITHUB_PROVIDER_TYPE = "github";

export default function IntegrationsSettingsRoute() {
  const { t } = useTranslation("openhands");
  const config = useCloudIntegrationsConfig();
  const settings = useSettings();
  const { providers, isLoadingSettings } = useUserProviders();
  const isGithubRepositoryConnected = providers.includes("github");
  const githubAppInstallUrl = config.data?.githubAppInstallUrl ?? null;
  const isOauthEnabled = config.data?.isOauthV2LoginEnabled === true;
  const oauthProviders = useCloudOAuthProviders({
    enabled:
      config.data?.isCanvasIntegrationsEnabled === true && isOauthEnabled,
  });
  const githubOauthProvider = oauthProviders.data?.find(
    (provider) => provider.provider_type === GITHUB_PROVIDER_TYPE,
  );
  const hasAuthoritativeGithubOauthState =
    isOauthEnabled && githubOauthProvider !== undefined;
  const isGithubOauthHealthy = hasAuthoritativeGithubOauthState
    ? githubOauthProvider.connected && !githubOauthProvider.needs_reconnect
    : isGithubRepositoryConnected;
  const shouldReconnectGithub = hasAuthoritativeGithubOauthState
    ? githubOauthProvider.needs_reconnect || githubOauthProvider.connected
    : isGithubRepositoryConnected;
  const linkOauthProvider = useLinkCloudOAuthProvider();
  const isGithubConfigured =
    config.data?.providersConfigured.includes("github") === true;
  const installations = useAppInstallations("github", {
    enabled: isGithubConfigured && isGithubRepositoryConnected,
  });
  const hasGithubInstallation = (installations.data?.items.length ?? 0) > 0;
  const repositories = useGitRepositories({
    provider: "github",
    pageSize: 100,
    enabled: isGithubConfigured && isGithubRepositoryConnected,
  });

  const refresh = useCallback(async () => {
    const requests: Promise<unknown>[] = [config.refetch(), settings.refetch()];
    if (isOauthEnabled) {
      requests.push(oauthProviders.refetch());
    }
    if (isGithubConfigured && isGithubRepositoryConnected) {
      requests.push(installations.refetch(), repositories.refetch());
    }
    await Promise.all(requests);
  }, [
    config,
    installations,
    isGithubConfigured,
    isGithubRepositoryConnected,
    isOauthEnabled,
    oauthProviders,
    repositories,
    settings,
  ]);

  useEffect(() => {
    const handleFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refresh]);

  if (
    config.isLoading ||
    isLoadingSettings ||
    (isOauthEnabled && oauthProviders.isLoading)
  ) {
    return (
      <div className="flex min-h-40 items-center justify-center">
        <LoadingSpinner size="large" />
      </div>
    );
  }

  if (!config.data?.isCanvasIntegrationsEnabled) {
    return <Navigate to={LOCKED_CLOUD_SETTINGS_NAV_PATH} replace />;
  }

  if (!isOauthEnabled && (!isGithubConfigured || !githubAppInstallUrl)) {
    return (
      <div
        data-testid="integrations-unconfigured"
        className="rounded-xl border border-border bg-base-secondary p-6"
      >
        <p className="text-sm text-tertiary-light">
          {t(I18nKey.SETTINGS$INTEGRATIONS_UNCONFIGURED)}
        </p>
      </div>
    );
  }

  const repositoryItems =
    repositories.data?.pages.flatMap((page) => page.items) ?? [];
  const isRefreshing =
    config.isFetching ||
    settings.isFetching ||
    installations.isFetching ||
    oauthProviders.isFetching ||
    linkOauthProvider.isPending ||
    repositories.isLoading ||
    repositories.isFetchingNextPage;

  return (
    <section
      data-testid="hosted-git-integrations"
      className="rounded-xl border border-border bg-base-secondary p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <FaGithub className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <h3 className="font-medium text-contrast">
              {t(I18nKey.SETTINGS$INTEGRATIONS_GITHUB_TITLE)}
            </h3>
            <p className="mt-1 text-sm text-tertiary-light">
              {isGithubOauthHealthy
                ? t(I18nKey.SETTINGS$INTEGRATIONS_GITHUB_CONNECTED)
                : githubOauthProvider?.needs_reconnect
                  ? t(I18nKey.SETTINGS$INTEGRATIONS_GITHUB_RECONNECT_REQUIRED)
                  : t(I18nKey.SETTINGS$INTEGRATIONS_GITHUB_DISCONNECTED)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <BrandButton
            testId="refresh-integrations"
            type="button"
            variant="secondary"
            isDisabled={isRefreshing}
            startContent={<RefreshCw className="size-4" aria-hidden />}
            onClick={() => void refresh()}
          >
            {t(I18nKey.BUTTON$REFRESH)}
          </BrandButton>
        </div>
      </div>

      <div className="mt-6 border-t border-border pt-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-contrast">
              {t(I18nKey.SETTINGS$INTEGRATIONS_ACCOUNT_CONNECTION)}
            </p>
            <p className="mt-1 text-sm text-tertiary-light">
              {isGithubOauthHealthy
                ? t(I18nKey.SETTINGS$INTEGRATIONS_ACCOUNT_CONNECTED)
                : githubOauthProvider?.needs_reconnect
                  ? t(I18nKey.SETTINGS$INTEGRATIONS_ACCOUNT_RECONNECT_REQUIRED)
                  : t(I18nKey.SETTINGS$INTEGRATIONS_ACCOUNT_DISCONNECTED)}
            </p>
          </div>
          {isOauthEnabled && githubOauthProvider ? (
            <BrandButton
              testId="github-oauth-connect"
              type="button"
              variant="primary"
              isDisabled={linkOauthProvider.isPending}
              onClick={() => linkOauthProvider.mutate(githubOauthProvider.id)}
            >
              {shouldReconnectGithub
                ? t(I18nKey.SETTINGS$INTEGRATIONS_RECONNECT_GITHUB)
                : t(I18nKey.SETTINGS$INTEGRATIONS_CONNECT_GITHUB)}
            </BrandButton>
          ) : (
            <p
              data-testid="github-oauth-unavailable"
              className="text-sm text-tertiary-light"
            >
              {t(I18nKey.SETTINGS$INTEGRATIONS_OAUTH_UNAVAILABLE)}
            </p>
          )}
        </div>
        {oauthProviders.isError || linkOauthProvider.isError ? (
          <p className="mt-2 text-sm text-feedback-error">
            {t(I18nKey.SETTINGS$INTEGRATIONS_OAUTH_ERROR)}
          </p>
        ) : null}
      </div>

      <div className="mt-6 border-t border-border pt-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-contrast">
              {t(I18nKey.SETTINGS$INTEGRATIONS_REPOSITORY_ACCESS)}
            </p>
            <p className="mt-1 text-sm text-tertiary-light">
              {t(I18nKey.SETTINGS$INTEGRATIONS_REPOSITORY_ACCESS_SUBLINE)}
            </p>
          </div>
          {githubAppInstallUrl ? (
            <a
              data-testid="github-app-install-link"
              href={githubAppInstallUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:opacity-80"
            >
              {hasGithubInstallation
                ? t(I18nKey.SETTINGS$INTEGRATIONS_CONFIGURE_GITHUB)
                : t(I18nKey.SETTINGS$INTEGRATIONS_INSTALL_GITHUB)}
              <ExternalLink className="size-4" aria-hidden />
            </a>
          ) : (
            <p
              data-testid="github-app-unavailable"
              className="text-sm text-tertiary-light"
            >
              {t(I18nKey.SETTINGS$INTEGRATIONS_APP_UNAVAILABLE)}
            </p>
          )}
        </div>
      </div>

      {isGithubRepositoryConnected && (
        <div className="mt-6 border-t border-border pt-5">
          <p className="text-sm font-medium text-contrast">
            {t(I18nKey.SETTINGS$INTEGRATIONS_REPOSITORIES, {
              count: repositoryItems.length,
            })}
          </p>
          {repositories.isError ? (
            <p className="mt-2 text-sm text-feedback-error">
              {t(I18nKey.HOME$FAILED_TO_LOAD_REPOSITORIES)}
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {repositoryItems.map((repository) => (
                <li
                  key={repository.id}
                  className="rounded-md border border-border bg-canvas-base px-3 py-2 text-sm text-contrast"
                >
                  {repository.full_name}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
