export type BackendKind = "local" | "cloud";
export type BackendAuthMode = "api-key" | "cookie";
export type CloudOrganizationMode = "required" | "none";

export interface Backend {
  id: string;
  name: string;
  host: string;
  apiKey: string;
  kind: BackendKind;
  authMode?: BackendAuthMode;
  /**
   * Whether this Cloud control plane implements the organization contract.
   * Defaults to `required`; self-hosted Sandbox Server deployments use `none`.
   */
  organizationMode?: CloudOrganizationMode;
  /** Changes whenever connection credentials change, invalidating keyed data. */
  connectionRevision?: number;
  /**
   * Set when `host` reaches a DigitalOcean MARS session — the loopback end
   * of a port-forward tunnel (or the web server's proxy for it). The far end is an
   * ordinary agent-server, so the backend stays `kind: "local"`; this only
   * lets the Managed Agents screen and connection lifecycle recognise it.
   */
  marsSessionId?: string;
  /** The MARS agent config the session was launched from, when known. */
  marsConfigId?: string;
}

export interface BackendSelection {
  backendId: string;
  orgId?: string | null;
}

export interface ResolvedActiveBackend {
  backend: Backend;
  orgId: string | null;
}

export function backendRequiresOrganizations(backend: Backend): boolean {
  return backend.kind === "cloud" && backend.organizationMode !== "none";
}
