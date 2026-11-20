import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import SettingsService from "#/api/settings-service/settings-service.api";
import { isNoBackend } from "#/api/backend-registry/active-store";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { SETTINGS_QUERY_KEYS } from "#/hooks/query/query-keys";
import { useSettings } from "#/hooks/query/use-settings";
import { buildMcpCommandMigration } from "#/utils/mcp-command-migrations";

export function useMigrateMcpCommands(): void {
  const { backend, orgId } = useActiveBackend();
  const { data: settings, isLoading, isError } = useSettings();
  const queryClient = useQueryClient();
  const targetKey = `${backend.id}:${orgId ?? ""}`;
  const migratedTargetRef = useRef<string | null>(null);

  useEffect(() => {
    migratedTargetRef.current = null;
  }, [targetKey]);

  useEffect(() => {
    if (
      isNoBackend(backend) ||
      isLoading ||
      isError ||
      !settings ||
      migratedTargetRef.current === targetKey
    ) {
      return;
    }

    const patch = buildMcpCommandMigration(settings.mcp_config ?? {});
    if (!patch) return;

    migratedTargetRef.current = targetKey;
    void SettingsService.patchMcpConfig(patch)
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: SETTINGS_QUERY_KEYS.all,
        }),
      )
      .catch((error: unknown) => {
        migratedTargetRef.current = null;
        console.error("Failed to migrate legacy MCP commands.", error);
      });
  }, [backend, isError, isLoading, queryClient, settings, targetKey]);
}
