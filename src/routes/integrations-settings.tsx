import { GitHubIntegrationSettings } from "#/components/features/settings/app-settings/github-integration-settings";
import { AtlassianIntegrationSettings } from "#/components/features/settings/integrations/atlassian-integration-settings";

export default function IntegrationsSettingsScreen() {
  return (
    <div className="flex flex-col gap-6">
      <GitHubIntegrationSettings standalone />
      <AtlassianIntegrationSettings />
    </div>
  );
}
