import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  fetchCloudOAuthProviders,
  linkCloudOAuthProvider,
  unlinkCloudOAuthProvider,
} from "#/api/cloud/oauth-service.api";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { useCloudIntegrationsConfig } from "#/hooks/query/use-cloud-integrations-config";
import { SETTINGS_QUERY_KEYS } from "#/hooks/query/query-keys";
import { I18nKey } from "#/i18n/declaration";
import { BrandButton } from "../brand-button";

function requireAbsoluteHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("OAuth provider link URL must use HTTPS.");
  }
  return url.href;
}

export function GitHubIntegrationSettings() {
  const { t } = useTranslation("openhands");
  const { backend } = useActiveBackend();
  const queryClient = useQueryClient();
  const config = useCloudIntegrationsConfig();
  const enabled =
    backend.kind === "cloud" &&
    config.data?.isCanvasIntegrationsEnabled === true &&
    config.data?.isOauthV2LoginEnabled === true &&
    config.data.providersConfigured.includes("github");
  const providers = useQuery({
    queryKey: [
      "cloud-oauth-providers",
      backend.id,
      backend.connectionRevision ?? 0,
    ],
    queryFn: fetchCloudOAuthProviders,
    enabled,
    retry: false,
    meta: { disableToast: true },
  });
  const github = providers.data?.find(
    (provider) => provider.provider_type === "github",
  );
  const link = useMutation({
    mutationFn: async () =>
      requireAbsoluteHttpsUrl(await linkCloudOAuthProvider(github!.id)),
    onSuccess: (startUrl) => window.location.assign(startUrl),
    meta: { disableToast: true },
  });
  const unlink = useMutation({
    mutationFn: () => unlinkCloudOAuthProvider(github!.id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["cloud-oauth-providers", backend.id],
        }),
        queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEYS.all }),
      ]);
    },
    meta: { disableToast: true },
  });

  if (!enabled || !github) return null;

  const connected = github.connected && !github.needs_reconnect;
  const pending = link.isPending || unlink.isPending;
  const githubAppInstallUrl = config.data?.githubAppInstallUrl;

  return (
    <section
      data-testid="github-integration-settings"
      className="border-t border-border pt-6 mt-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-medium">{t(I18nKey.SETTINGS$GITHUB)}</h3>
          <p className="mt-1 text-sm text-tertiary-light">
            {connected
              ? t(I18nKey.STATUS$CONNECTED)
              : t(I18nKey.CHAT_INTERFACE$DISCONNECTED)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {connected ? (
            <BrandButton
              testId="github-oauth-disconnect"
              type="button"
              variant="secondary"
              isDisabled={pending}
              onClick={() => unlink.mutate()}
            >
              {t(I18nKey.BUTTON$DISCONNECT)}
            </BrandButton>
          ) : (
            <BrandButton
              testId="github-oauth-connect"
              type="button"
              variant="primary"
              isDisabled={pending}
              onClick={() => link.mutate()}
            >
              {t(I18nKey.BACKEND$CONNECT)}
            </BrandButton>
          )}
          {githubAppInstallUrl && (
            <a
              data-testid="github-app-install-link"
              href={githubAppInstallUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-border bg-base-secondary px-4 py-2 text-sm font-medium text-contrast hover:bg-surface-raised"
            >
              {t(I18nKey.SETTINGS$GITHUB)}
              <ExternalLink className="size-4" aria-hidden />
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
