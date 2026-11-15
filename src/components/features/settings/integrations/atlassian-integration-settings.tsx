import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  connectAtlassianIntegration,
  disconnectAtlassianIntegration,
  fetchAtlassianIntegration,
  type AtlassianIntegrationCredentials,
  type AtlassianProduct,
  type AtlassianProductStatus,
} from "#/api/cloud/atlassian-integration-service.api";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { useCloudIntegrationsConfig } from "#/hooks/query/use-cloud-integrations-config";
import { ATLASSIAN_INTEGRATION_QUERY_KEYS } from "#/hooks/query/query-keys";
import { I18nKey } from "#/i18n/declaration";
import { BrandButton } from "../brand-button";
import { SettingsInput } from "../settings-input";

interface ProductConnectionProps {
  product: AtlassianProduct;
  status: AtlassianProductStatus;
  queryKey: readonly unknown[];
}

function ProductConnection({
  product,
  status,
  queryKey,
}: ProductConnectionProps) {
  const { t } = useTranslation("openhands");
  const queryClient = useQueryClient();
  const {
    connected,
    site_url: connectedSiteUrl,
    email: connectedEmail,
  } = status;
  const [editing, setEditing] = React.useState(false);
  const [siteUrl, setSiteUrl] = React.useState(connectedSiteUrl ?? "");
  const [email, setEmail] = React.useState(connectedEmail ?? "");
  const [apiToken, setApiToken] = React.useState("");
  const title =
    product === "jira"
      ? t(I18nKey.SETTINGS$ATLASSIAN_JIRA)
      : t(I18nKey.SETTINGS$ATLASSIAN_CONFLUENCE);

  React.useEffect(() => {
    if (!connected || editing) return;
    setSiteUrl(connectedSiteUrl ?? "");
    setEmail(connectedEmail ?? "");
    setApiToken("");
  }, [connected, connectedEmail, connectedSiteUrl, editing]);

  const connect = useMutation({
    mutationFn: (credentials: AtlassianIntegrationCredentials) =>
      connectAtlassianIntegration(product, credentials),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      setApiToken("");
      setEditing(false);
    },
    meta: { disableToast: true },
  });
  const disconnect = useMutation({
    mutationFn: () => disconnectAtlassianIntegration(product),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      setSiteUrl("");
      setEmail("");
      setApiToken("");
      setEditing(false);
    },
    meta: { disableToast: true },
  });
  const showForm = !connected || editing;
  const pending = connect.isPending || disconnect.isPending;
  const error = connect.error ?? disconnect.error;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    connect.mutate({
      site_url: siteUrl.trim(),
      email: email.trim(),
      api_token: apiToken.trim(),
    });
  };

  return (
    <div
      data-testid={`atlassian-${product}-connection`}
      className="flex flex-col gap-4 rounded-lg border border-border p-4"
    >
      <h4 className="font-medium">{title}</h4>
      {connected && !editing && (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="text-sm">
            <p>{t(I18nKey.STATUS$CONNECTED)}</p>
            <p className="text-tertiary-light">{connectedSiteUrl}</p>
            <p className="text-tertiary-light">{connectedEmail}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <BrandButton
              testId={`atlassian-${product}-edit`}
              type="button"
              variant="secondary"
              isDisabled={pending}
              onClick={() => setEditing(true)}
            >
              {t(I18nKey.BUTTON$EDIT)}
            </BrandButton>
            <BrandButton
              testId={`atlassian-${product}-disconnect`}
              type="button"
              variant="secondary"
              isDisabled={pending}
              onClick={() => disconnect.mutate()}
            >
              {t(I18nKey.BUTTON$DISCONNECT)}
            </BrandButton>
          </div>
        </div>
      )}

      {showForm && (
        <form
          data-testid={`atlassian-${product}-credentials-form`}
          onSubmit={handleSubmit}
          className="flex flex-col gap-4"
        >
          <SettingsInput
            testId={`atlassian-${product}-site-url`}
            name={`atlassian-${product}-site-url`}
            type="url"
            label={t(I18nKey.SETTINGS$ATLASSIAN_SITE_URL)}
            value={siteUrl}
            onChange={setSiteUrl}
            required
          />
          <SettingsInput
            testId={`atlassian-${product}-email`}
            name={`atlassian-${product}-email`}
            type="email"
            label={t(I18nKey.SETTINGS$ATLASSIAN_ACCOUNT_EMAIL)}
            value={email}
            onChange={setEmail}
            required
          />
          <SettingsInput
            testId={`atlassian-${product}-api-token`}
            name={`atlassian-${product}-api-token`}
            type="password"
            label={t(I18nKey.SETTINGS$ATLASSIAN_API_TOKEN)}
            value={apiToken}
            onChange={setApiToken}
            required
          />
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error instanceof Error
                ? error.message
                : t(I18nKey.ERROR$GENERIC)}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <BrandButton
              testId={`atlassian-${product}-connect`}
              type="submit"
              variant="primary"
              isDisabled={
                pending || !siteUrl.trim() || !email.trim() || !apiToken.trim()
              }
            >
              {connected
                ? t(I18nKey.SETTINGS$SAVE_CHANGES)
                : t(I18nKey.BACKEND$CONNECT)}
            </BrandButton>
            {connected && (
              <BrandButton
                testId={`atlassian-${product}-cancel-edit`}
                type="button"
                variant="secondary"
                isDisabled={pending}
                onClick={() => setEditing(false)}
              >
                {t(I18nKey.BUTTON$CANCEL)}
              </BrandButton>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

export function AtlassianIntegrationSettings() {
  const { t } = useTranslation("openhands");
  const { backend, orgId } = useActiveBackend();
  const config = useCloudIntegrationsConfig();
  const enabled =
    backend.kind === "cloud" &&
    config.data?.isCanvasIntegrationsEnabled === true &&
    config.data?.isAtlassianApiTokenEnabled === true;
  const queryKey = ATLASSIAN_INTEGRATION_QUERY_KEYS.status(
    backend.id,
    orgId ?? null,
    backend.connectionRevision ?? 0,
  );
  const status = useQuery({
    queryKey,
    queryFn: fetchAtlassianIntegration,
    enabled,
    retry: false,
    meta: { disableToast: true },
  });

  if (!enabled || status.isPending) return null;

  if (status.error || !status.data) {
    return (
      <section
        data-testid="atlassian-integration-settings"
        className="border-t border-border pt-6"
      >
        <h3 className="text-lg font-medium">
          {t(I18nKey.SETTINGS$ATLASSIAN_CLOUD)}
        </h3>
        <p role="alert" className="mt-2 text-sm text-danger">
          {status.error instanceof Error
            ? status.error.message
            : t(I18nKey.ERROR$GENERIC)}
        </p>
      </section>
    );
  }

  return (
    <section
      data-testid="atlassian-integration-settings"
      className="border-t border-border pt-6"
    >
      <div className="flex max-w-2xl flex-col gap-4">
        <div>
          <h3 className="text-lg font-medium">
            {t(I18nKey.SETTINGS$ATLASSIAN_CLOUD)}
          </h3>
          <p className="mt-1 text-sm text-tertiary-light">
            {t(I18nKey.SETTINGS$ATLASSIAN_DESCRIPTION)}
          </p>
        </div>
        <ProductConnection
          product="jira"
          status={status.data.jira}
          queryKey={queryKey}
        />
        <ProductConnection
          product="confluence"
          status={status.data.confluence}
          queryKey={queryKey}
        />
      </div>
    </section>
  );
}
