import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import {
  AgentServerUnavailableError,
  AgentServerUnknownVersionError,
  AgentServerUnsupportedVersionError,
  clearCachedAgentServerInfo,
  MINIMUM_COMPATIBLE_AGENT_SERVER_VERSION,
} from "#/api/agent-server-compatibility";
import OptionService from "#/api/option-service/option-service.api";
import {
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import type { Backend } from "#/api/backend-registry/types";
import { callCloudProxy } from "#/api/cloud/proxy";
import { server } from "#/mocks/node";

vi.mock("#/api/cloud/proxy", () => ({
  callCloudProxy: vi.fn(),
}));

const localBackend: Backend = {
  id: "test-local",
  name: "Test Local",
  host: "http://localhost:8001",
  apiKey: "test-key",
  kind: "local",
};

describe("OptionService", () => {
  beforeEach(() => {
    clearCachedAgentServerInfo();
    setRegisteredBackends([localBackend]);
    setActiveSelection({ backendId: localBackend.id });
    vi.mocked(callCloudProxy).mockReset();
  });

  it("returns config in mock mode without a live backend", async () => {
    const config = await OptionService.getConfig();

    expect(config.feature_flags.hide_llm_settings).toBe(false);
    expect(config.feature_flags.hide_users_page).toBe(true);
    expect(config.updated_at).toBeTruthy();
  });

  it("loads config when the agent server is compatible", async () => {
    server.use(
      http.get("*/server_info", () =>
        HttpResponse.json({
          uptime: 0,
          idle_time: 0,
          version: MINIMUM_COMPATIBLE_AGENT_SERVER_VERSION,
        }),
      ),
    );

    await expect(OptionService.getConfig()).resolves.toMatchObject({
      feature_flags: expect.objectContaining({ hide_llm_settings: false }),
    });
    expect(callCloudProxy).not.toHaveBeenCalled();
  });

  it("loads the configured cloud backend's web client config", async () => {
    const cloudBackend: Backend = {
      id: "test-cloud",
      name: "Test Cloud",
      host: "https://halo.example.com",
      apiKey: "cloud-token",
      kind: "cloud",
      organizationMode: "none",
    };
    const cloudConfig = {
      feature_flags: {
        hide_llm_settings: true,
        hide_users_page: true,
      },
      providers_configured: [],
      maintenance_start_time: null,
      recaptcha_site_key: null,
      faulty_models: [],
      error_message: null,
      updated_at: "2026-11-13T00:00:00.000Z",
    };
    setRegisteredBackends([cloudBackend]);
    setActiveSelection({ backendId: cloudBackend.id });
    vi.mocked(callCloudProxy).mockResolvedValue(cloudConfig);

    await expect(OptionService.getConfig()).resolves.toEqual(cloudConfig);
    expect(callCloudProxy).toHaveBeenCalledWith({
      backend: cloudBackend,
      method: "GET",
      path: "/api/v1/web-client/config",
    });
  });

  it("throws when the agent server is too old", async () => {
    server.use(
      http.get("*/server_info", () =>
        HttpResponse.json({ uptime: 0, idle_time: 0, version: "1.27.1" }),
      ),
    );

    await expect(OptionService.getConfig()).rejects.toMatchObject({
      name: AgentServerUnsupportedVersionError.name,
      actualVersion: "1.27.1",
      requiredVersion: MINIMUM_COMPATIBLE_AGENT_SERVER_VERSION,
    });
  });

  it("throws when the server does not advertise a version", async () => {
    server.use(
      http.get("*/server_info", () =>
        HttpResponse.json({ uptime: 0, idle_time: 0 }),
      ),
    );

    await expect(OptionService.getConfig()).rejects.toMatchObject({
      name: AgentServerUnknownVersionError.name,
      actualVersion: null,
    });
  });

  it("throws an unavailable error when the agent server cannot be reached", async () => {
    server.use(http.get("*/server_info", () => HttpResponse.error()));

    await expect(OptionService.getConfig()).rejects.toMatchObject({
      name: AgentServerUnavailableError.name,
      message: expect.stringContaining(
        "Could not connect to the configured agent server",
      ),
      details: expect.stringContaining("Request failed"),
    });
  });
});
