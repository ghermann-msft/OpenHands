import { useQuery } from "@tanstack/react-query";
import { fetchCloudOAuthProviders } from "#/api/cloud/oauth-service.api";
import { useActiveBackend } from "#/contexts/active-backend-context";

export function useCloudOAuthProviders({ enabled }: { enabled: boolean }) {
  const { backend, orgId } = useActiveBackend();

  return useQuery({
    queryKey: [
      "cloud-oauth-providers",
      backend.id,
      orgId,
      backend.connectionRevision ?? 0,
    ],
    queryFn: fetchCloudOAuthProviders,
    enabled: enabled && backend.kind === "cloud",
    staleTime: 1000 * 60 * 5,
    retry: false,
    meta: { disableToast: true },
  });
}
