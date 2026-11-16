import { useConfig } from "#/hooks/query/use-config";
import {
  CANVAS_OWNED_CLOUD_SETTINGS_NAV_ITEMS,
  ADMIN_SETTINGS_NAV_ITEMS,
  LOCKED_CLOUD_SETTINGS_NAV_PATH,
  OSS_NAV_ITEMS,
  SettingsNavItem,
} from "#/constants/settings-nav";
import { isSettingsPageHidden } from "#/utils/settings-utils";
import { I18nKey } from "#/i18n/declaration";
import { useActiveBackend } from "#/contexts/active-backend-context";
import {
  getLockedCloudHost,
  hasExternalSettingsShell,
} from "#/api/agent-server-config";
import { useSandboxSpecAdminCapabilities } from "#/hooks/query/use-sandbox-specs";

export type SettingsNavRenderedItem =
  | {
      type: "item";
      item: SettingsNavItem;
    }
  | { type: "header"; text: I18nKey }
  | { type: "divider" };

// Locally each agent profile owns these settings.
const PROFILE_OWNED_SETTINGS_PATHS = new Set(["/settings/condenser"]);

export function useSettingsNavItems(): SettingsNavRenderedItem[] {
  const { data: config } = useConfig();
  const { backend } = useActiveBackend();
  const { data: sandboxSpecAdminCapabilities } =
    useSandboxSpecAdminCapabilities();
  const featureFlags = config?.feature_flags;
  // Some hosted deployments delegate settings to a same-origin shell. A
  // locked self-hosted control plane can instead keep settings in Canvas.
  const isLockedToCloud = getLockedCloudHost() !== null;
  const delegatesSettings = isLockedToCloud && hasExternalSettingsShell();
  const settingsItems =
    isLockedToCloud && !delegatesSettings
      ? [...OSS_NAV_ITEMS, ...CANVAS_OWNED_CLOUD_SETTINGS_NAV_ITEMS]
      : [...OSS_NAV_ITEMS];
  const renderedItems: SettingsNavRenderedItem[] = settingsItems
    .filter(
      (item) =>
        !isSettingsPageHidden(item.to, featureFlags) &&
        (!delegatesSettings || item.to === LOCKED_CLOUD_SETTINGS_NAV_PATH) &&
        (backend.kind === "cloud" ||
          !PROFILE_OWNED_SETTINGS_PATHS.has(item.to)),
    )
    .map((item) => {
      const renamedItem =
        item.to === "/settings"
          ? {
              ...item,
              text:
                backend.kind === "local"
                  ? I18nKey.SETTINGS$LLM_PROFILES
                  : item.text,
              subtitle:
                backend.kind === "local"
                  ? I18nKey.SETTINGS$PAGE_LLM_PROFILES_SUBLINE
                  : item.subtitle,
            }
          : item;

      return { type: "item" as const, item: renamedItem };
    });

  if (sandboxSpecAdminCapabilities?.can_manage && !delegatesSettings) {
    renderedItems.push(
      { type: "divider" },
      { type: "header", text: I18nKey.SETTINGS$ADMINISTRATION },
      ...ADMIN_SETTINGS_NAV_ITEMS.map((item) => ({
        type: "item" as const,
        item,
      })),
    );
  }

  return renderedItems;
}
