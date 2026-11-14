import { getActiveBackend } from "#/api/backend-registry/active-store";
import type { Backend } from "#/api/backend-registry/types";
import { callCloudProxy } from "#/api/cloud/proxy";

function getActiveCloudBackend(): Backend {
  const active = getActiveBackend().backend;
  if (active.kind !== "cloud") {
    throw new Error("Cloud OAuth call requires a cloud backend.");
  }
  return active;
}

export interface CloudOAuthProvider {
  id: number;
  provider_type: string;
  connected: boolean;
  needs_reconnect: boolean;
}

export async function fetchCloudOAuthProviders(): Promise<
  CloudOAuthProvider[]
> {
  const backend = getActiveCloudBackend();
  return callCloudProxy<CloudOAuthProvider[]>({
    backend,
    method: "GET",
    path: "/oauth/git-providers",
  });
}

export async function linkCloudOAuthProvider(
  providerId: number,
): Promise<string> {
  const backend = getActiveCloudBackend();
  const response = await callCloudProxy<{ start_url: string }>({
    backend,
    method: "POST",
    path: `/oauth/${providerId}/link`,
  });
  if (!response.start_url) {
    throw new Error("OAuth provider link response is missing start_url.");
  }
  return response.start_url;
}
