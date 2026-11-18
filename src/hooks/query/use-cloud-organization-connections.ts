import { useQuery } from "@tanstack/react-query";
import { listCloudOrganizationConnections } from "#/api/cloud/organization-service.api";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { CLOUD_ORGANIZATION_QUERY_KEYS } from "./query-keys";

export function useCloudOrganizationConnections(enabled = true) {
  const { backend, orgId } = useActiveBackend();

  // The key carries the backend identity and credential revision.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return useQuery({
    queryKey: CLOUD_ORGANIZATION_QUERY_KEYS.connections(
      backend.id,
      orgId ?? "",
      backend.connectionRevision ?? 0,
    ),
    queryFn: () => listCloudOrganizationConnections(orgId!, backend),
    enabled: enabled && backend.kind === "cloud" && !!orgId,
    retry: false,
    meta: { disableToast: true },
  });
}
