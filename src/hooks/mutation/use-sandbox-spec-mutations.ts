import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createSandboxSpec,
  deleteSandboxSpec,
  type SandboxSpecInfo,
  updateSandboxSpec,
} from "#/api/cloud/sandbox-spec-service.api";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { SANDBOX_SPEC_QUERY_KEYS } from "#/hooks/query/query-keys";

export function useSandboxSpecMutations() {
  const { backend } = useActiveBackend();
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: SANDBOX_SPEC_QUERY_KEYS.all,
    });
  };

  const create = useMutation({
    mutationFn: (profile: SandboxSpecInfo) =>
      createSandboxSpec({ profile }, backend),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: (profile: SandboxSpecInfo) => {
      const {
        id,
        operating_system: _operatingSystem,
        source: _source,
        immutable: _immutable,
        bootstrap_revision: _bootstrapRevision,
        created_at: _createdAt,
        updated_at: _updatedAt,
        ...changes
      } = profile;
      return updateSandboxSpec(id, changes, backend);
    },
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (sandboxSpecId: string) =>
      deleteSandboxSpec(sandboxSpecId, backend),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}
