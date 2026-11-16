import { useTranslation } from "react-i18next";
import {
  SdkSectionPage,
  type SettingsSourceConfig,
} from "#/components/features/settings/sdk-settings/sdk-section-page";
import { useConversationWorkspace } from "#/hooks/query/use-conversation-workspace";
import { useSettings } from "#/hooks/query/use-settings";
import { useSaveSettings } from "#/hooks/mutation/use-save-settings";
import { I18nKey } from "#/i18n/declaration";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { ExecutionProfileSelect } from "#/components/features/settings/execution-profiles/execution-profile-select";
import { DEFAULT_SANDBOX_SPEC_ID } from "#/api/cloud/sandbox-spec-service.api";

const CONTAINER_FIELD_KEYS = new Set([
  "container_memory",
  "container_cpus",
  "container_browser",
]);

function RuntimeSettingsScreen() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const { backend } = useActiveBackend();
  const { mutate: saveSettings, isPending: isSavingProfile } =
    useSaveSettings();
  const { dockerSelectable, serverInfoLoading } = useConversationWorkspace();
  const dockerUnavailable = !serverInfoLoading && !dockerSelectable;
  const savedDocker =
    settings?.conversation_settings?.default_runtime === "docker";

  const source: SettingsSourceConfig = {
    settingsSource: "conversation_settings",
    sectionKeys: ["runtime"],
  };
  if (dockerUnavailable) {
    source.excludeKeys = CONTAINER_FIELD_KEYS;
    // A saved Docker default stays selectable so the field shows what is saved.
    if (!savedDocker) source.excludeChoices = { default_runtime: ["docker"] };
  }

  return (
    <SdkSectionPage
      settingsSources={[source]}
      header={
        backend.kind === "cloud" || (dockerUnavailable && savedDocker)
          ? () => (
              <div className="flex flex-col gap-3">
                {backend.kind === "cloud" && (
                  <ExecutionProfileSelect
                    value={
                      settings?.default_sandbox_spec_id ??
                      DEFAULT_SANDBOX_SPEC_ID
                    }
                    onChange={(defaultSandboxSpecId) =>
                      saveSettings({
                        default_sandbox_spec_id: defaultSandboxSpecId || null,
                      })
                    }
                    disabled={isSavingProfile}
                  />
                )}
                {dockerUnavailable && savedDocker && (
                  <p
                    data-testid="runtime-docker-unavailable"
                    className="text-sm text-muted"
                  >
                    {t(I18nKey.SETTINGS$RUNTIME_DOCKER_UNAVAILABLE)}
                  </p>
                )}
              </div>
            )
          : undefined
      }
      testId="runtime-settings-screen"
    />
  );
}

export default RuntimeSettingsScreen;
