import React from "react";
import { AxiosError } from "axios";
import { useTranslation } from "react-i18next";
import { INTEGRATION_CATALOG } from "@openhands/extensions/integrations";
import { McpLogoBadge } from "#/components/features/mcp-logo-badge";
import { InstallServerModal } from "#/components/features/mcp-page";
import { BrandButton } from "#/components/features/settings/brand-button";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { useDeleteMcpServer } from "#/hooks/mutation/use-delete-mcp-server";
import { useCloudIntegrationsConfig } from "#/hooks/query/use-cloud-integrations-config";
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
  const { backend } = useActiveBackend();
  const cloudConfig = useCloudIntegrationsConfig();
  const { data: settings, isLoading: isLoadingSettings } = useSettings();
  const { mutate: deleteMcpServer, isPending: isDeleting } =
    useDeleteMcpServer();
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
  const cloudEnabled =
    backend.kind !== "cloud" ||
    cloudConfig.data?.isCanvasIntegrationsEnabled === true;

  if (
    !entry ||
    !cloudEnabled ||
    isLoadingSettings ||
    (backend.kind === "cloud" && cloudConfig.isPending)
  ) {
    return null;
  }

  const handleDisconnect = (server: MCPServerConfig) => {
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
          <BrandButton
            testId="perforce-add"
            type="button"
            variant="primary"
            onClick={() => setShowInstall(true)}
          >
            {t(I18nKey.BUTTON$ADD)}
          </BrandButton>
        </div>

        {installed.map((server) => {
          const port = server.env?.[P4PORT_ENV_KEY];
          const user = server.env?.[P4USER_ENV_KEY];
          return (
            <div
              key={server.id}
              data-testid={`perforce-connection-${server.id}`}
              className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border p-4"
            >
              <div className="min-w-0 text-sm">
                <p>{server.name ?? server.id}</p>
                <p className="text-tertiary-light">
                  {t(I18nKey.STATUS$CONNECTED)}
                </p>
                {port && <p className="truncate text-tertiary-light">{port}</p>}
                {user && <p className="truncate text-tertiary-light">{user}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <BrandButton
                  testId={`perforce-edit-${server.id}`}
                  type="button"
                  variant="secondary"
                  isDisabled={isDeleting}
                  onClick={() => setServerToEdit(server)}
                >
                  {t(I18nKey.BUTTON$EDIT)}
                </BrandButton>
                <BrandButton
                  testId={`perforce-disconnect-${server.id}`}
                  type="button"
                  variant="secondary"
                  isDisabled={isDeleting}
                  onClick={() => handleDisconnect(server)}
                >
                  {t(I18nKey.BUTTON$DISCONNECT)}
                </BrandButton>
              </div>
            </div>
          );
        })}
      </div>

      {showInstall && (
        <InstallServerModal
          entry={entry}
          existingServers={servers}
          mcpOnly
          onSuccess={() => setShowInstall(false)}
          onClose={() => setShowInstall(false)}
        />
      )}

      {serverToEdit && (
        <InstallServerModal
          entry={entry}
          existingServers={servers}
          serverToReplace={serverToEdit}
          mcpOnly
          onSuccess={() => setServerToEdit(null)}
          onClose={() => setServerToEdit(null)}
        />
      )}
    </section>
  );
}
