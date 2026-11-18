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
import type { MCPServerConfig } from "#/types/mcp-server";
import { displayErrorToast } from "#/utils/custom-toast-handlers";
import { flattenMcpConfig } from "#/utils/mcp-installed-servers";
import {
  findInstalledEntryMatches,
  getMarketplaceEntryById,
  getMcpMarketplaceCatalog,
} from "#/utils/mcp-marketplace-utils";
import { parseMcpConfig } from "#/utils/mcp-config";
import { retrieveAxiosErrorMessage } from "#/utils/retrieve-axios-error-message";

const PERFORCE_ENTRY_ID = "perforce";
const P4PORT_ENV_KEY = "P4PORT";
const P4USER_ENV_KEY = "P4USER";

export function PerforceIntegrationSettings() {
  const { t } = useTranslation("openhands");
  const { backend, orgId } = useActiveBackend();
  const cloudConfig = useCloudIntegrationsConfig();
  const { data: settings, isLoading: isLoadingSettings } = useSettings();
  const { mutate: deleteMcpServer, isPending: isDeleting } =
    useDeleteMcpServer();
  const organizationConnections = useCloudOrganizationConnections();
  const { mutateAsync: upsertOrganizationConnection } =
    useUpsertCloudOrganizationConnection("perforce");
  const {
    mutate: deleteOrganizationConnection,
    isPending: isDeletingOrganizationConnection,
  } = useDeleteCloudOrganizationConnection();
  const [showInstall, setShowInstall] = React.useState(false);
  const [serverToEdit, setServerToEdit] =
    React.useState<MCPServerConfig | null>(null);

  const entry = getMarketplaceEntryById(
    PERFORCE_ENTRY_ID,
    getMcpMarketplaceCatalog(INTEGRATION_CATALOG),
  );
  const mcpConfig =
    settings?.mcp_config ??
    parseMcpConfig(settings?.agent_settings?.mcp_config);
  const servers = flattenMcpConfig(mcpConfig);
  const installed = entry ? findInstalledEntryMatches(entry, servers) : [];
  const isOrganizationConnection = backend.kind === "cloud" && !!orgId;
  const organizationConnection = organizationConnections.data?.find(
    (connection) => connection.kind === "perforce",
  );
  const organizationServer: MCPServerConfig =
    installed[0] ??
    ({
      id: "perforce",
      type: "stdio",
      name: organizationConnection?.display_name ?? "perforce",
      command: organizationConnection?.endpoint ?? "",
      args: [],
    } satisfies MCPServerConfig);
  const visibleConnections = isOrganizationConnection
    ? organizationConnection?.connected
      ? [organizationServer]
      : []
    : installed;
  const isEditable =
    !isOrganizationConnection || organizationConnection?.editable === true;
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

  const handleDisconnect = (server: MCPServerConfig) => {
    if (isOrganizationConnection) {
      deleteOrganizationConnection("perforce", {
        onError: (error) => {
          const message = retrieveAxiosErrorMessage(error as AxiosError);
          displayErrorToast(message || t(I18nKey.ERROR$GENERIC));
        },
      });
      return;
    }
    deleteMcpServer(server, {
      onError: (error) => {
        const message = retrieveAxiosErrorMessage(error as AxiosError);
        displayErrorToast(message || t(I18nKey.ERROR$GENERIC));
      },
    });
  };

  return (
    <section
      data-testid="perforce-integration-settings"
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
          {isEditable &&
            (!isOrganizationConnection || visibleConnections.length === 0) && (
              <BrandButton
                testId="perforce-add"
                type="button"
                variant="primary"
                onClick={() => setShowInstall(true)}
              >
                {t(I18nKey.BUTTON$ADD)}
              </BrandButton>
            )}
        </div>

        {visibleConnections.map((server) => {
          const connectionId = server.id;
          const port = server.env?.[P4PORT_ENV_KEY];
          const user = server.env?.[P4USER_ENV_KEY];
          return (
            <div
              key={connectionId}
              data-testid={`perforce-connection-${connectionId}`}
              className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border p-4"
            >
              <div className="min-w-0 text-sm">
                <p>
                  {organizationConnection?.display_name ??
                    server?.name ??
                    connectionId}
                </p>
                <p className="text-tertiary-light">
                  {t(I18nKey.STATUS$CONNECTED)}
                </p>
                {port && <p className="truncate text-tertiary-light">{port}</p>}
                {user && <p className="truncate text-tertiary-light">{user}</p>}
              </div>
              {isEditable && (
                <div className="flex flex-wrap gap-2">
                  <BrandButton
                    testId={`perforce-edit-${connectionId}`}
                    type="button"
                    variant="secondary"
                    isDisabled={isDeleting || isDeletingOrganizationConnection}
                    onClick={() => setServerToEdit(server)}
                  >
                    {t(I18nKey.BUTTON$EDIT)}
                  </BrandButton>
                  <BrandButton
                    testId={`perforce-disconnect-${connectionId}`}
                    type="button"
                    variant="secondary"
                    isDisabled={isDeleting || isDeletingOrganizationConnection}
                    onClick={() => handleDisconnect(server)}
                  >
                    {t(I18nKey.BUTTON$DISCONNECT)}
                  </BrandButton>
                </div>
              )}
            </div>
          );
        })}
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

      {serverToEdit !== null && (
        <InstallServerModal
          entry={entry}
          existingServers={servers}
          serverToReplace={serverToEdit}
          mcpOnly
          onPersistServer={
            isOrganizationConnection ? upsertOrganizationConnection : undefined
          }
          persistSelectedSecrets={!isOrganizationConnection}
          onSuccess={() => setServerToEdit(null)}
          onClose={() => setServerToEdit(null)}
        />
      )}
    </section>
  );
}
