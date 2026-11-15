import { getActiveBackend } from "#/api/backend-registry/active-store";
import { callCloudProxy } from "./proxy";

export interface CloudOAuthProvider {
  id: number;
  provider_type: string;
  connected: boolean;
  needs_reconnect: boolean;
}

function getActiveCloudBackend() {
  const { backend } = getActiveBackend();
  if (backend.kind !== "cloud") {
    throw new Error("Cloud OAuth call requires a cloud backend.");
  }
  return backend;
}

export async function fetchCloudOAuthProviders(): Promise<
  CloudOAuthProvider[]
> {
  return callCloudProxy<CloudOAuthProvider[]>({
    backend: getActiveCloudBackend(),
    method: "GET",
    path: "/oauth/git-providers",
  });
}

export async function linkCloudOAuthProvider(
  providerId: number,
): Promise<string> {
  const response = await callCloudProxy<{ start_url?: string }>({
    backend: getActiveCloudBackend(),
    method: "POST",
    path: `/oauth/${providerId}/link`,
  });
  if (!response.start_url) {
    throw new Error("OAuth provider link response is missing start_url.");
  }
  return response.start_url;
}

export async function unlinkCloudOAuthProvider(
  providerId: number,
): Promise<void> {
  await callCloudProxy<{ connected: false }>({
    backend: getActiveCloudBackend(),
    method: "DELETE",
    path: `/oauth/${providerId}/link`,
  });
}
