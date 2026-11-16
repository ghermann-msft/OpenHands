import { getActiveBackend } from "#/api/backend-registry/active-store";
import type { Backend } from "#/api/backend-registry/types";
import { callCloudProxy } from "#/api/cloud/proxy";

export type SandboxOperatingSystem = "linux" | "windows";
export type SandboxResourceClass = "standard" | "high-memory" | "build";
export type SandboxSpecAvailability = "available" | "unavailable" | "disabled";
export const DEFAULT_SANDBOX_SPEC_ID = "openhands-pool";

export interface SandboxToleration {
  key: string;
  operator?: string | null;
  value?: string | null;
  effect?: string | null;
}

export interface SandboxSpecInfo {
  id: string;
  display_name: string;
  description?: string | null;
  enabled: boolean;
  published: boolean;
  availability: SandboxSpecAvailability;
  availability_reason?: string | null;
  operating_system: SandboxOperatingSystem;
  platform: string;
  resource_class: SandboxResourceClass;
  image: string | null;
  shell: string[];
  workspace_mount_path?: string | null;
  durable_state_dir: string;
  durable_mount_path?: string | null;
  template_name: string;
  warm_pool_name: string;
  warm_pool_replicas?: number | null;
  cpu_request: string;
  cpu_limit: string;
  cpu_cores: number;
  memory_request: string;
  memory_limit: string;
  memory_gib: number;
  storage_class: string;
  storage_size: string;
  workspace_storage_class: string;
  workspace_storage_size: string;
  durable_storage_class: string;
  durable_storage_size: string;
  durable_volume_claim_name: string;
  durable_sub_path_template: string;
  node_selector: Record<string, string>;
  tolerations: SandboxToleration[];
  capabilities: string[];
  max_concurrent_sandboxes?: number | null;
  max_concurrent_per_user?: number | null;
  startup_timeout_seconds?: number | null;
  initial_env?: Record<string, string> | null;
  working_dir?: string | null;
  command?: string[] | null;
  source?: string | null;
  immutable?: boolean;
  bootstrap_revision?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface SandboxSpecInfoPage {
  items: SandboxSpecInfo[];
  next_page_id: string | null;
}

export interface SandboxSpecAdminCapabilities {
  can_manage: boolean;
}

export interface SandboxSpecCreate {
  profile: SandboxSpecInfo;
}

type SandboxSpecMutableFields = Omit<
  SandboxSpecInfo,
  | "id"
  | "operating_system"
  | "source"
  | "immutable"
  | "bootstrap_revision"
  | "created_at"
  | "updated_at"
>;

export type SandboxSpecUpdate = {
  [Key in keyof SandboxSpecMutableFields]?:
    SandboxSpecMutableFields[Key] | null;
};

function getCloudBackend(backendOverride?: Backend): Backend {
  const backend = backendOverride ?? getActiveBackend().backend;
  if (backend.kind !== "cloud") {
    throw new Error("Sandbox execution profiles require a cloud backend.");
  }
  return backend;
}

export async function searchSandboxSpecs(
  backendOverride?: Backend,
): Promise<SandboxSpecInfoPage> {
  const backend = getCloudBackend(backendOverride);
  return callCloudProxy<SandboxSpecInfoPage>({
    backend,
    method: "GET",
    path: "/api/v1/sandbox-specs/search",
  });
}

export async function getSandboxSpec(
  sandboxSpecId: string,
  backendOverride?: Backend,
): Promise<SandboxSpecInfo | null> {
  const backend = getCloudBackend(backendOverride);
  const params = new URLSearchParams({ id: sandboxSpecId });
  const data = await callCloudProxy<(SandboxSpecInfo | null)[]>({
    backend,
    method: "GET",
    path: `/api/v1/sandbox-specs?${params.toString()}`,
  });
  return data?.[0] ?? null;
}

export async function getSandboxSpecAdminCapabilities(
  backendOverride?: Backend,
): Promise<SandboxSpecAdminCapabilities> {
  const backend = getCloudBackend(backendOverride);
  return callCloudProxy<SandboxSpecAdminCapabilities>({
    backend,
    method: "GET",
    path: "/api/v1/sandbox-specs/admin/capabilities",
  });
}

export async function searchAdminSandboxSpecs(
  backendOverride?: Backend,
): Promise<SandboxSpecInfoPage> {
  const backend = getCloudBackend(backendOverride);
  return callCloudProxy<SandboxSpecInfoPage>({
    backend,
    method: "GET",
    path: "/api/v1/sandbox-specs/admin/search",
  });
}

export async function createSandboxSpec(
  request: SandboxSpecCreate,
  backendOverride?: Backend,
): Promise<SandboxSpecInfo> {
  const backend = getCloudBackend(backendOverride);
  return callCloudProxy<SandboxSpecInfo>({
    backend,
    method: "POST",
    path: "/api/v1/sandbox-specs/admin",
    body: request as unknown as Record<string, unknown>,
  });
}

export async function updateSandboxSpec(
  sandboxSpecId: string,
  request: SandboxSpecUpdate,
  backendOverride?: Backend,
): Promise<SandboxSpecInfo> {
  const backend = getCloudBackend(backendOverride);
  return callCloudProxy<SandboxSpecInfo>({
    backend,
    method: "PUT",
    path: `/api/v1/sandbox-specs/admin/${encodeURIComponent(sandboxSpecId)}`,
    body: request as unknown as Record<string, unknown>,
  });
}

export async function deleteSandboxSpec(
  sandboxSpecId: string,
  backendOverride?: Backend,
): Promise<void> {
  const backend = getCloudBackend(backendOverride);
  await callCloudProxy<unknown>({
    backend,
    method: "DELETE",
    path: `/api/v1/sandbox-specs/admin/${encodeURIComponent(sandboxSpecId)}`,
  });
}
