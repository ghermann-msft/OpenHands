import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetActiveStoreForTests,
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import type { Backend } from "#/api/backend-registry/types";
import {
  getCloudMcpOAuthStatus,
  startCloudMcpOAuth,
  testCloudMcpServer,
} from "#/api/cloud/mcp-service.api";
import {
  getFetchCall,
  getJsonBody,
  mockJsonResponse,
} from "./fetch-test-utils";

const cloudBackend: Backend = {
  id: "prod",
  name: "Production",
  host: "https://app.all-hands.dev",
  apiKey: "bearer-token",
  kind: "cloud",
};

const selfHostedBackend: Backend = {
  id: "self-hosted",
  name: "Self-hosted",
  host: "https://openhands.example.com",
  apiKey: "",
  kind: "cloud",
  authMode: "cookie",
  organizationMode: "required",
  mcpApiMode: "agent-server",
};

const originalFetch = global.fetch;
const fetchMock = vi.fn();

function activateSelfHostedAgentServerMcp() {
  setRegisteredBackends([selfHostedBackend]);
  setActiveSelection({ backendId: selfHostedBackend.id });
}

beforeEach(() => {
  window.localStorage.clear();
  __resetActiveStoreForTests();
  setRegisteredBackends([cloudBackend]);
  setActiveSelection({ backendId: cloudBackend.id });
  fetchMock.mockReset();
  global.fetch = fetchMock as typeof fetch;
});

afterEach(() => {
  window.localStorage.clear();
  __resetActiveStoreForTests();
  fetchMock.mockReset();
  global.fetch = originalFetch;
});

describe("testCloudMcpServer", () => {
  it("posts the probe request to /api/v1/mcp/test on the active cloud backend", async () => {
    // Arrange
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        ok: false,
        error: "refused",
        error_kind: "connection",
      }),
    );
    const request = {
      name: "jira",
      server: {
        type: "http" as const,
        url: "https://mcp-jira.example.com/mcp",
      },
      timeout: 15,
    };

    // Act
    const result = await testCloudMcpServer(request);

    // Assert
    const [url, init] = getFetchCall(fetchMock);
    expect(url).toBe(`${cloudBackend.host}/api/v1/mcp/test`);
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer bearer-token" },
    });
    expect(getJsonBody(init)).toEqual(request);
    expect(result).toEqual({
      ok: false,
      error: "refused",
      error_kind: "connection",
    });
  });

  it("uses the Agent Server MCP route for organization-enabled self-hosted cloud backends", async () => {
    activateSelfHostedAgentServerMcp();
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        ok: false,
        error: "refused",
        error_kind: "connection",
      }),
    );

    await testCloudMcpServer({
      name: "atlassian-rovo",
      server: {
        type: "http",
        url: "https://mcp.atlassian.com/v2/mcp",
      },
    });

    const [url, init] = getFetchCall(fetchMock);
    expect(url).toBe(`${selfHostedBackend.host}/api/mcp/test`);
    expect(init).toMatchObject({ method: "POST" });
    expect(init.headers).not.toHaveProperty("Authorization");
  });
});

describe("startCloudMcpOAuth", () => {
  it("posts the OAuth start request to /api/v1/mcp/oauth/start", async () => {
    // Arrange
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        ok: true,
        job_id: "job-1",
        authorization_url: "https://auth.example/authorize",
      }),
    );
    const request: Parameters<typeof startCloudMcpOAuth>[0] = {
      name: "atlassian",
      server: {
        type: "http",
        url: "https://mcp.atlassian.com/v1/mcp/authv2",
        auth: {
          strategy: "oauth2",
          authentication: { type: "oauth", client_auth_method: "none" },
        },
      },
      timeout: 120,
    };

    // Act
    const result = await startCloudMcpOAuth(request);

    // Assert
    const [url, init] = getFetchCall(fetchMock);
    expect(url).toBe(`${cloudBackend.host}/api/v1/mcp/oauth/start`);
    expect(init).toMatchObject({ method: "POST" });
    expect(getJsonBody(init)).toEqual(request);
    expect(result).toEqual({
      ok: true,
      job_id: "job-1",
      authorization_url: "https://auth.example/authorize",
    });
  });

  it("uses the Agent Server OAuth route for organization-enabled self-hosted cloud backends", async () => {
    activateSelfHostedAgentServerMcp();
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        ok: true,
        job_id: "job-1",
        authorization_url: "https://auth.example/authorize",
      }),
    );

    await startCloudMcpOAuth({
      name: "atlassian-rovo",
      server: {
        type: "http",
        url: "https://mcp.atlassian.com/v2/mcp",
        auth: {
          strategy: "oauth2",
          authentication: { type: "oauth", client_auth_method: "none" },
        },
      },
    });

    const [url] = getFetchCall(fetchMock);
    expect(url).toBe(`${selfHostedBackend.host}/api/mcp/oauth/start`);
  });
});

describe("getCloudMcpOAuthStatus", () => {
  it("reads the job from /api/v1/mcp/oauth/status/{job_id}", async () => {
    // Arrange
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        ok: true,
        status: "authorizing",
        job_id: "job/1",
        callback_ready: true,
      }),
    );

    // Act
    const result = await getCloudMcpOAuthStatus("job/1");

    // Assert
    const [url, init] = getFetchCall(fetchMock);
    expect(url).toBe(`${cloudBackend.host}/api/v1/mcp/oauth/status/job%2F1`);
    expect(init).toMatchObject({ method: "GET" });
    expect(result).toMatchObject({
      status: "authorizing",
      callback_ready: true,
    });
  });

  it("uses the Agent Server status route for organization-enabled self-hosted cloud backends", async () => {
    activateSelfHostedAgentServerMcp();
    fetchMock.mockResolvedValue(
      mockJsonResponse({
        ok: true,
        status: "authorizing",
        job_id: "job/1",
        callback_ready: true,
      }),
    );

    await getCloudMcpOAuthStatus("job/1");

    const [url] = getFetchCall(fetchMock);
    expect(url).toBe(`${selfHostedBackend.host}/api/mcp/oauth/status/job%2F1`);
  });
});
