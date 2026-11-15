import { getActiveBackend } from "../backend-registry/active-store";
import { callCloudProxy } from "./proxy";

const ATLASSIAN_INTEGRATION_PATH = "/api/v1/integrations/atlassian";

export type AtlassianProduct = "jira" | "confluence";

export interface AtlassianProductStatus {
  connected: boolean;
  site_url: string | null;
  email: string | null;
}

export interface AtlassianIntegrationStatus {
  jira: AtlassianProductStatus;
  confluence: AtlassianProductStatus;
}

export interface AtlassianIntegrationCredentials {
  site_url: string;
  email: string;
  api_token: string;
}

function getActiveCloudBackend() {
  const active = getActiveBackend().backend;
  if (active.kind !== "cloud") {
    throw new Error("Atlassian integration requires a cloud backend.");
  }
  return active;
}

export async function fetchAtlassianIntegration(): Promise<AtlassianIntegrationStatus> {
  return callCloudProxy<AtlassianIntegrationStatus>({
    backend: getActiveCloudBackend(),
    method: "GET",
    path: ATLASSIAN_INTEGRATION_PATH,
  });
}

export async function connectAtlassianIntegration(
  product: AtlassianProduct,
  credentials: AtlassianIntegrationCredentials,
): Promise<AtlassianProductStatus> {
  return callCloudProxy<AtlassianProductStatus>({
    backend: getActiveCloudBackend(),
    method: "PUT",
    path: `${ATLASSIAN_INTEGRATION_PATH}/${product}`,
    body: credentials,
  });
}

export async function disconnectAtlassianIntegration(
  product: AtlassianProduct,
): Promise<void> {
  await callCloudProxy({
    backend: getActiveCloudBackend(),
    method: "DELETE",
    path: `${ATLASSIAN_INTEGRATION_PATH}/${product}`,
  });
}
