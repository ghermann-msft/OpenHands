import { useQuery } from "@tanstack/react-query";
import {
  getCloudOrganizationMe,
  listCloudOrganizationMembers,
} from "#/api/cloud/organization-service.api";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { CLOUD_ORGANIZATION_QUERY_KEYS } from "./query-keys";

export function useCloudOrganizationMe() {
  const { backend, orgId } = useActiveBackend();
  // The key carries the backend identity and credential revision.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return useQuery({
    queryKey: CLOUD_ORGANIZATION_QUERY_KEYS.me(
      backend.id,
      orgId,
      backend.connectionRevision ?? 0,
    ),
    queryFn: () => getCloudOrganizationMe(orgId!, backend),
    enabled: backend.kind === "cloud" && !!orgId,
    staleTime: 1000 * 60 * 5,
    retry: false,
    meta: { disableToast: true },
  });
}

export function useCloudOrganizationMembers(enabled = true) {
  const { backend, orgId } = useActiveBackend();
  // The key carries the backend identity and credential revision.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return useQuery({
    queryKey: CLOUD_ORGANIZATION_QUERY_KEYS.members(
      backend.id,
      orgId ?? "",
      backend.connectionRevision ?? 0,
    ),
    queryFn: () => listCloudOrganizationMembers(orgId!, backend),
    enabled: enabled && backend.kind === "cloud" && !!orgId,
    retry: false,
    meta: { disableToast: true },
  });
}
