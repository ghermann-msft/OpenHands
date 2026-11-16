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
  const { backend } = useActiveBackend();
  const cloudConfig = useCloudIntegrationsConfig();
  const { data: settings, isLoading: isLoadingSettings } = useSettings();
  const { mutate: deleteMcpServer, isPending: isDeleting } =
    useDeleteMcpServer();
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
  const connectedEmail =
    installed?.auth?.strategy === "basic" ? installed.auth.username : undefined;
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

  const handleDisconnect = () => {
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
              {installed
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

          {installed ? (
            <div className="flex flex-wrap gap-2">
              <BrandButton
                testId="atlassian-edit"
                type="button"
                variant="secondary"
                isDisabled={isDeleting}
                onClick={() => setShowEdit(true)}
              >
                {t(I18nKey.BUTTON$EDIT)}
              </BrandButton>
              <BrandButton
                testId="atlassian-disconnect"
                type="button"
                variant="secondary"
                isDisabled={isDeleting}
                onClick={handleDisconnect}
              >
                {t(I18nKey.BUTTON$DISCONNECT)}
              </BrandButton>
            </div>
          ) : (
            <BrandButton
              testId="atlassian-connect"
              type="button"
              variant="primary"
              onClick={() => setShowInstall(true)}
            >
              {t(I18nKey.BACKEND$CONNECT)}
            </BrandButton>
          )}
        </div>
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

      {showEdit && installed && (
        <InstallServerModal
          entry={entry}
          existingServers={servers}
          serverToReplace={installed}
          mcpOnly
          onSuccess={() => setShowEdit(false)}
          onClose={() => setShowEdit(false)}
        />
      )}
    </section>
  );
}
