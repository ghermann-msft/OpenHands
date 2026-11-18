import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateCloudOrganizationMemberRole } from "#/api/cloud/organization-service.api";
import type { CloudOrganizationRole } from "#/api/cloud/types";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { CLOUD_ORGANIZATION_QUERY_KEYS } from "#/hooks/query/query-keys";

export function useUpdateCloudOrganizationMemberRole() {
  const { backend, orgId } = useActiveBackend();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      userId,
      role,
    }: {
      userId: string;
      role: CloudOrganizationRole;
    }) => updateCloudOrganizationMemberRole(orgId!, userId, role, backend),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: CLOUD_ORGANIZATION_QUERY_KEYS.members(
          backend.id,
          orgId ?? "",
          backend.connectionRevision ?? 0,
        ),
      });
    },
    meta: { disableToast: true },
  });
}
