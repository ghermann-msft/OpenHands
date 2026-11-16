import { useQuery } from "@tanstack/react-query";
import {
  getSandboxSpecAdminCapabilities,
  searchAdminSandboxSpecs,
  searchSandboxSpecs,
} from "#/api/cloud/sandbox-spec-service.api";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { SANDBOX_SPEC_QUERY_KEYS } from "#/hooks/query/query-keys";

export function useSandboxSpecs() {
  const { backend, orgId } = useActiveBackend();
  return useQuery({
    queryKey: [...SANDBOX_SPEC_QUERY_KEYS.all, backend.id, orgId, backend],
    queryFn: () => searchSandboxSpecs(backend),
    enabled: backend.kind === "cloud",
    retry: false,
  });
}

export function useSandboxSpecAdminCapabilities() {
  const { backend, orgId } = useActiveBackend();
  return useQuery({
    queryKey: [
      ...SANDBOX_SPEC_QUERY_KEYS.capabilities,
      backend.id,
      orgId,
      backend,
    ],
    queryFn: () => getSandboxSpecAdminCapabilities(backend),
    enabled: backend.kind === "cloud",
    retry: false,
    meta: { disableToast: true },
  });
}

export function useAdminSandboxSpecs(enabled: boolean) {
  const { backend, orgId } = useActiveBackend();
  return useQuery({
    queryKey: [...SANDBOX_SPEC_QUERY_KEYS.admin, backend.id, orgId, backend],
    queryFn: () => searchAdminSandboxSpecs(backend),
    enabled: backend.kind === "cloud" && enabled,
    retry: false,
  });
}
