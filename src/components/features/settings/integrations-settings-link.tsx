import { useTranslation } from "react-i18next";
import { ExternalLink, Puzzle } from "lucide-react";
import { I18nKey } from "#/i18n/declaration";
import { useActiveBackendContext } from "#/contexts/active-backend-context";
import { isNoBackend } from "#/api/backend-registry/active-store";
import {
  CANVAS_INTEGRATIONS_SETTINGS_PATH,
  cloudIntegrationsUrl,
} from "#/utils/cloud-integrations-url";
import { cn } from "#/utils/utils";
import { NavigationLink } from "#/components/shared/navigation-link";
import { useCloudIntegrationsConfig } from "#/hooks/query/use-cloud-integrations-config";
import {
  SIDEBAR_ICON_SLOT_CLASS,
  SIDEBAR_ROW_INTERACTIVE_CLASS,
  sidebarNavLabelClassName,
  sidebarNavRowClassName,
} from "#/components/features/sidebar/sidebar-layout";

/**
 * Renders only for cloud backends — local backends have no equivalent hosted
 * integrations settings page. In locked-to-Cloud deployments this sits beside
 * "All Cloud Settings" as a direct shortcut to the Cloud integrations page.
 */
export function IntegrationsSettingsLink() {
  const { t } = useTranslation("openhands");
  const { active } = useActiveBackendContext();
  const { backend, orgId } = active;
  const config = useCloudIntegrationsConfig({
    enabled: !isNoBackend(backend) && backend.kind === "cloud",
  });

  if (isNoBackend(backend) || backend.kind !== "cloud") return null;
  if (config.isLoading) return null;

  const className = cn(
    sidebarNavRowClassName({ collapsed: false }),
    SIDEBAR_ROW_INTERACTIVE_CLASS.idle,
  );
  const content = (
    <>
      <span className={SIDEBAR_ICON_SLOT_CLASS}>
        <Puzzle className="size-4 shrink-0" aria-hidden />
      </span>
      <span className={cn(sidebarNavLabelClassName(false), "flex-1")}>
        {t(I18nKey.SETTINGS$INTEGRATIONS_SETTINGS_LINK)}
      </span>
    </>
  );

  if (config.data?.isCanvasIntegrationsEnabled) {
    return (
      <NavigationLink
        data-testid="settings-integrations-link"
        to={CANVAS_INTEGRATIONS_SETTINGS_PATH}
        className={className}
      >
        {content}
      </NavigationLink>
    );
  }

  return (
    <a
      data-testid="settings-integrations-link"
      href={cloudIntegrationsUrl(backend, orgId)}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {content}
      <ExternalLink className="size-4 shrink-0 text-muted" aria-hidden />
    </a>
  );
}
