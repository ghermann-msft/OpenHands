import React from "react";
import { AxiosError } from "axios";
import { useTranslation } from "react-i18next";
import { INTEGRATION_CATALOG } from "@openhands/extensions/integrations";
import { McpLogoBadge } from "#/components/features/mcp-logo-badge";
import { InstallServerModal } from "#/components/features/mcp-page";
import { BrandButton } from "#/components/features/settings/brand-button";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { useDeleteMcpServer } from "#/hooks/mutation/use-delete-mcp-server";
import {
  useDeleteCloudOrganizationConnection,
  useUpsertCloudOrganizationConnection,
} from "#/hooks/mutation/use-cloud-organization-connection";
import { useCloudIntegrationsConfig } from "#/hooks/query/use-cloud-integrations-config";
import { useCloudOrganizationConnections } from "#/hooks/query/use-cloud-organization-connections";
import { useSettings } from "#/hooks/query/use-settings";
import { I18nKey } from "#/i18n/declaration";
import { displayErrorToast } from "#/utils/custom-toast-handlers";
import { flattenMcpConfig } from "#/utils/mcp-installed-servers";
import {
  findInstalledEntryMatch,
  getMarketplaceEntryById,
  getMcpMarketplaceCatalog,
} from "#/utils/mcp-marketplace-utils";
import { parseMcpConfig } from "#/utils/mcp-config";
import { retrieveAxiosErrorMessage } from "#/utils/retrieve-axios-error-message";

const ATLASSIAN_ROVO_ENTRY_ID = "atlassian-rovo";

export function AtlassianIntegrationSettings() {
  const { t } = useTranslation("openhands");
  const { backend, orgId } = useActiveBackend();
  const cloudConfig = useCloudIntegrationsConfig();
  const { data: settings, isLoading: isLoadingSettings } = useSettings();
  const { mutate: deleteMcpServer, isPending: isDeleting } =
    useDeleteMcpServer();
  const organizationConnections = useCloudOrganizationConnections();
  const { mutateAsync: upsertOrganizationConnection } =
    useUpsertCloudOrganizationConnection("atlassian");
  const {
    mutate: deleteOrganizationConnection,
    isPending: isDeletingOrganizationConnection,
  } = useDeleteCloudOrganizationConnection();
  const [showInstall, setShowInstall] = React.useState(false);
  const [showEdit, setShowEdit] = React.useState(false);

  const entry = getMarketplaceEntryById(
    ATLASSIAN_ROVO_ENTRY_ID,
    getMcpMarketplaceCatalog(INTEGRATION_CATALOG),
  );
  const mcpConfig =
    settings?.mcp_config ??
    parseMcpConfig(settings?.agent_settings?.mcp_config);
  const servers = flattenMcpConfig(mcpConfig);
  const installed = entry ? findInstalledEntryMatch(entry, servers) : null;
  const isOrganizationConnection = backend.kind === "cloud" && !!orgId;
  const organizationConnection = organizationConnections.data?.find(
    (connection) => connection.kind === "atlassian",
  );
  const isConnected = isOrganizationConnection
    ? organizationConnection?.connected === true
    : !!installed;
  const isEditable =
    !isOrganizationConnection || organizationConnection?.editable === true;
  const connectedEmail =
    organizationConnection?.display_name ??
    (installed?.auth?.strategy === "basic"
      ? installed.auth.username
      : undefined);
  const cloudEnabled =
    backend.kind !== "cloud" ||
    cloudConfig.data?.isCanvasIntegrationsEnabled === true;

  if (
    !entry ||
    !cloudEnabled ||
    isLoadingSettings ||
    (isOrganizationConnection && organizationConnections.isPending) ||
    (backend.kind === "cloud" && cloudConfig.isPending)
  ) {
    return null;
  }

  const handleDisconnect = () => {
    if (isOrganizationConnection) {
      deleteOrganizationConnection("atlassian", {
        onError: (error) => {
          const message = retrieveAxiosErrorMessage(error as AxiosError);
          displayErrorToast(message || t(I18nKey.ERROR$GENERIC));
        },
      });
      return;
    }
    if (!installed) return;
    deleteMcpServer(installed, {
      onError: (error) => {
        const message = retrieveAxiosErrorMessage(error as AxiosError);
        displayErrorToast(message || t(I18nKey.ERROR$GENERIC));
      },
    });
  };

  return (
    <section
      data-testid="atlassian-integration-settings"
      className="border-t border-border pt-6"
    >
      <div className="flex max-w-2xl flex-col gap-4">
        <div className="flex items-start gap-3">
          <McpLogoBadge entry={entry} />
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-medium">{entry.name}</h3>
            <p className="mt-1 text-sm text-tertiary-light">
              {entry.description}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border p-4">
          <div className="min-w-0 text-sm">
            <p>
              {isConnected
                ? t(I18nKey.STATUS$CONNECTED)
                : t(I18nKey.ONBOARDING$BACKEND_STATUS_DISCONNECTED)}
            </p>
            {connectedEmail && (
              <p
                data-testid="atlassian-connected-email"
                className="truncate text-tertiary-light"
              >
                {connectedEmail}
              </p>
            )}
          </div>

          {isConnected ? (
            <div className="flex flex-wrap gap-2">
              {isEditable && (
                <>
                  <BrandButton
                    testId="atlassian-edit"
                    type="button"
                    variant="secondary"
                    isDisabled={isDeleting || isDeletingOrganizationConnection}
                    onClick={() => setShowEdit(true)}
                  >
                    {t(I18nKey.BUTTON$EDIT)}
                  </BrandButton>
                  <BrandButton
                    testId="atlassian-disconnect"
                    type="button"
                    variant="secondary"
                    isDisabled={isDeleting || isDeletingOrganizationConnection}
                    onClick={handleDisconnect}
                  >
                    {t(I18nKey.BUTTON$DISCONNECT)}
                  </BrandButton>
                </>
              )}
            </div>
          ) : isEditable ? (
            <BrandButton
              testId="atlassian-connect"
              type="button"
              variant="primary"
              onClick={() => setShowInstall(true)}
            >
              {t(I18nKey.BACKEND$CONNECT)}
            </BrandButton>
          ) : null}
        </div>
      </div>

      {showInstall && (
        <InstallServerModal
          entry={entry}
          existingServers={servers}
          mcpOnly
          onPersistServer={
            isOrganizationConnection ? upsertOrganizationConnection : undefined
          }
          persistSelectedSecrets={!isOrganizationConnection}
          onSuccess={() => setShowInstall(false)}
          onClose={() => setShowInstall(false)}
        />
      )}

      {showEdit && (
        <InstallServerModal
          entry={entry}
          existingServers={servers}
          serverToReplace={installed ?? undefined}
          mcpOnly
          onPersistServer={
            isOrganizationConnection ? upsertOrganizationConnection : undefined
          }
          persistSelectedSecrets={!isOrganizationConnection}
          onSuccess={() => setShowEdit(false)}
          onClose={() => setShowEdit(false)}
        />
      )}
    </section>
  );
}
