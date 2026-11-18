import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Backend } from "../backend-registry/types";

const { callCloudProxyMock, getActiveBackendMock } = vi.hoisted(() => ({
  callCloudProxyMock: vi.fn(),
  getActiveBackendMock: vi.fn(),
}));

vi.mock("./proxy", () => ({
  callCloudProxy: callCloudProxyMock,
}));

vi.mock("../backend-registry/active-store", () => ({
  getActiveBackend: getActiveBackendMock,
}));

import {
  activateCloudAgentProfile,
  deleteCloudAgentProfile,
  getCloudAgentProfile,
  listCloudAgentProfiles,
  renameCloudAgentProfile,
  saveCloudAgentProfile,
} from "./agent-profiles-service.api";

const cloudBackend: Backend = {
  id: "cloud",
  name: "Cloud",
  host: "https://cloud.example.test",
  apiKey: "",
  kind: "cloud",
  authMode: "cookie",
};

describe("cloud agent profiles", () => {
  beforeEach(() => {
    callCloudProxyMock.mockReset();
    callCloudProxyMock.mockResolvedValue({});
    getActiveBackendMock.mockReturnValue({ backend: cloudBackend });
  });

  it("uses the cloud control-plane route for the full profile lifecycle", async () => {
    await listCloudAgentProfiles();
    await getCloudAgentProfile("copilot profile");
    await saveCloudAgentProfile("copilot profile", {
      agent_kind: "acp",
      acp_server: "copilot-cli",
    });
    await renameCloudAgentProfile("copilot profile", "copilot renamed");
    await activateCloudAgentProfile("profile/id");
    await deleteCloudAgentProfile("copilot profile");

    expect(callCloudProxyMock.mock.calls).toEqual([
      [
        {
          backend: cloudBackend,
          method: "GET",
          path: "/api/v1/agent-profiles",
        },
      ],
      [
        {
          backend: cloudBackend,
          method: "GET",
          path: "/api/v1/agent-profiles/copilot%20profile",
        },
      ],
      [
        {
          backend: cloudBackend,
          method: "POST",
          path: "/api/v1/agent-profiles/copilot%20profile",
          body: { agent_kind: "acp", acp_server: "copilot-cli" },
        },
      ],
      [
        {
          backend: cloudBackend,
          method: "POST",
          path: "/api/v1/agent-profiles/copilot%20profile/rename",
          body: { new_name: "copilot renamed" },
        },
      ],
      [
        {
          backend: cloudBackend,
          method: "POST",
          path: "/api/v1/agent-profiles/profile%2Fid/activate",
          body: {},
        },
      ],
      [
        {
          backend: cloudBackend,
          method: "DELETE",
          path: "/api/v1/agent-profiles/copilot%20profile",
        },
      ],
    ]);
  });
});
