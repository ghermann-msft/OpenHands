import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import toast from "react-hot-toast";
import type { SandboxSpecInfo } from "#/api/cloud/sandbox-spec-service.api";
import {
  useAdminSandboxSpecs,
  useSandboxSpecAdminCapabilities,
} from "#/hooks/query/use-sandbox-specs";
import { useSandboxSpecMutations } from "#/hooks/mutation/use-sandbox-spec-mutations";
import { I18nKey } from "#/i18n/declaration";

function editableProfile(profile: SandboxSpecInfo) {
  const { created_at, updated_at, source, immutable, ...editable } = profile;
  return editable;
}

function newProfileTemplate(): SandboxSpecInfo {
  return {
    id: "",
    display_name: "",
    description: null,
    enabled: false,
    published: false,
    availability: "disabled",
    availability_reason: null,
    operating_system: "linux",
    platform: "linux/amd64",
    resource_class: "standard",
    image: "",
    shell: ["bash"],
    durable_state_dir: "/openhands",
    template_name: "",
    warm_pool_name: "",
    warm_pool_replicas: 0,
    cpu_request: "2",
    cpu_limit: "4",
    cpu_cores: 4,
    memory_request: "4Gi",
    memory_limit: "8Gi",
    memory_gib: 8,
    storage_class: "",
    storage_size: "64Gi",
    workspace_storage_class: "",
    workspace_storage_size: "64Gi",
    durable_storage_class: "",
    durable_storage_size: "",
    durable_volume_claim_name: "",
    durable_sub_path_template: "{sandbox_id}",
    node_selector: {},
    tolerations: [],
    capabilities: [],
    max_concurrent_sandboxes: null,
    max_concurrent_per_user: null,
    initial_env: {},
    working_dir: "/workspace/project",
    command: null,
  };
}

export default function ExecutionProfilesSettingsScreen() {
  const { t } = useTranslation();
  const { data: capabilities, isLoading: isLoadingCapabilities } =
    useSandboxSpecAdminCapabilities();
  const canManage = capabilities?.can_manage === true;
  const { data, isLoading } = useAdminSandboxSpecs(canManage);
  const { create, update, remove } = useSandboxSpecMutations();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = data?.items.find((profile) => profile.id === selectedId);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (selected) {
      setDraft(JSON.stringify(editableProfile(selected), null, 2));
    }
  }, [selected]);

  if (isLoadingCapabilities) {
    return <p>{t(I18nKey.HOME$LOADING)}</p>;
  }

  if (!canManage) {
    return (
      <p role="alert" data-testid="execution-profiles-unauthorized">
        {t(I18nKey.SETTINGS$EXECUTION_PROFILES_UNAUTHORIZED)}
      </p>
    );
  }

  const saveDraft = async () => {
    try {
      const profile = JSON.parse(draft) as SandboxSpecInfo;
      if (!profile.id || !profile.display_name) {
        throw new Error(t(I18nKey.SETTINGS$EXECUTION_PROFILE_INVALID));
      }
      if (selected) {
        await update.mutateAsync(profile);
      } else {
        await create.mutateAsync(profile);
      }
      setSelectedId(profile.id);
      toast.success(t(I18nKey.SETTINGS$EXECUTION_PROFILE_SAVED));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t(I18nKey.SETTINGS$EXECUTION_PROFILE_INVALID),
      );
    }
  };

  return (
    <div className="flex flex-col gap-6" data-testid="execution-profiles-admin">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">
          {t(I18nKey.SETTINGS$EXECUTION_PROFILES_ADMIN_DESCRIPTION)}
        </p>
        <button
          type="button"
          className="rounded bg-primary px-3 py-2 text-sm text-white"
          onClick={() => {
            setSelectedId(null);
            setDraft(JSON.stringify(newProfileTemplate(), null, 2));
          }}
        >
          {t(I18nKey.SETTINGS$EXECUTION_PROFILE_CREATE)}
        </button>
      </div>

      {isLoading ? (
        <p>{t(I18nKey.HOME$LOADING)}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {data?.items.map((profile) => (
            <div
              key={profile.id}
              className="flex items-start justify-between gap-3 rounded border border-border bg-base-secondary p-4"
            >
              <button
                type="button"
                onClick={() => setSelectedId(profile.id)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="font-medium">{profile.display_name}</span>
                <span className="mt-1 block text-xs text-text-secondary">
                  {profile.operating_system} / {profile.resource_class} /{" "}
                  {`${profile.cpu_cores} CPU / ${profile.memory_gib} GiB`}
                </span>
                <span className="mt-1 block text-xs text-text-secondary">
                  {profile.availability === "available"
                    ? t(I18nKey.SETTINGS$EXECUTION_PROFILE_AVAILABLE)
                    : (profile.availability_reason ??
                      t(I18nKey.SETTINGS$EXECUTION_PROFILE_UNAVAILABLE))}
                  {profile.immutable
                    ? ` / ${t(I18nKey.SETTINGS$EXECUTION_PROFILE_IMMUTABLE)}`
                    : ""}
                </span>
              </button>
              {!profile.immutable && (
                <button
                  type="button"
                  className="rounded border border-border px-2 py-1 text-xs"
                  onClick={() =>
                    update.mutate({ ...profile, enabled: !profile.enabled })
                  }
                  disabled={update.isPending}
                >
                  {profile.enabled
                    ? t(I18nKey.SETTINGS$EXECUTION_PROFILE_DISABLE)
                    : t(I18nKey.SETTINGS$EXECUTION_PROFILE_ENABLE)}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {draft && (
        <div className="flex flex-col gap-3">
          <label htmlFor="execution-profile-json" className="font-medium">
            {selected?.display_name ??
              t(I18nKey.SETTINGS$EXECUTION_PROFILE_CREATE)}
          </label>
          <textarea
            id="execution-profile-json"
            className="min-h-96 rounded border border-border bg-background p-3 font-mono text-xs"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={selected?.immutable}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded bg-primary px-3 py-2 text-sm text-white disabled:opacity-50"
              onClick={saveDraft}
              disabled={
                selected?.immutable || create.isPending || update.isPending
              }
            >
              {t(I18nKey.BUTTON$SAVE)}
            </button>
            {selected && !selected.immutable && (
              <button
                type="button"
                className="rounded border border-danger px-3 py-2 text-sm text-danger"
                onClick={async () => {
                  await remove.mutateAsync(selected.id);
                  setSelectedId(null);
                  setDraft("");
                }}
                disabled={remove.isPending}
              >
                {t(I18nKey.BUTTON$DELETE)}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
