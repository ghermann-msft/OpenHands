import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  deleteCloudOrganizationConnection,
  upsertCloudOrganizationConnection,
} from "#/api/cloud/organization-service.api";
import type { CloudOrganizationConnectionKind } from "#/api/cloud/types";
import { useActiveBackend } from "#/contexts/active-backend-context";
import {
  CLOUD_ORGANIZATION_QUERY_KEYS,
  SETTINGS_QUERY_KEYS,
} from "#/hooks/query/query-keys";
import type { MCPServerConfig } from "#/types/mcp-server";
import { toCanonicalMcpServer } from "#/utils/mcp-config";

type McpOrganizationConnectionKind = Exclude<
  CloudOrganizationConnectionKind,
  "github"
>;

export function useUpsertCloudOrganizationConnection(
  kind: McpOrganizationConnectionKind,
) {
  const { backend, orgId } = useActiveBackend();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (server: MCPServerConfig) => {
      const displayName =
        kind === "atlassian" && server.auth?.strategy === "basic"
          ? server.auth.username
          : (server.name ?? null);
      return upsertCloudOrganizationConnection(
        orgId!,
        kind,
        toCanonicalMcpServer(server),
        displayName,
        backend,
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: CLOUD_ORGANIZATION_QUERY_KEYS.connections(
          backend.id,
          orgId ?? "",
          backend.connectionRevision ?? 0,
        ),
      });
      await queryClient.invalidateQueries({
        queryKey: SETTINGS_QUERY_KEYS.personal(),
      });
    },
    meta: { disableToast: true },
  });
}

export function useDeleteCloudOrganizationConnection() {
  const { backend, orgId } = useActiveBackend();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (kind: CloudOrganizationConnectionKind) =>
      deleteCloudOrganizationConnection(orgId!, kind, backend),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: CLOUD_ORGANIZATION_QUERY_KEYS.connections(
          backend.id,
          orgId ?? "",
          backend.connectionRevision ?? 0,
        ),
      });
      await queryClient.invalidateQueries({
        queryKey: SETTINGS_QUERY_KEYS.personal(),
      });
    },
    meta: { disableToast: true },
  });
}
