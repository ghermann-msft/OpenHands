import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetActiveStoreForTests,
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import type { Backend } from "#/api/backend-registry/types";
import {
  connectAtlassianIntegration,
  disconnectAtlassianIntegration,
  fetchAtlassianIntegration,
} from "#/api/cloud/atlassian-integration-service.api";
import { server } from "#/mocks/node";

const cloudBackend: Backend = {
  id: "halo",
  name: "Halo",
  host: "https://halo.example.com",
  apiKey: "bearer-token",
  kind: "cloud",
};
const baseUrl = `${cloudBackend.host}/api/v1/integrations/atlassian`;

beforeEach(() => {
  vi.spyOn(globalThis, "fetch");
  window.localStorage.clear();
  __resetActiveStoreForTests();
  setRegisteredBackends([cloudBackend]);
  setActiveSelection({ backendId: cloudBackend.id });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  __resetActiveStoreForTests();
});

describe("Atlassian integration cloud API", () => {
  it("reads redacted per-product connection status", async () => {
    const response = {
      jira: {
        connected: true,
        site_url: "https://example.atlassian.net",
        email: "jira@example.com",
      },
      confluence: {
        connected: false,
        site_url: null,
        email: null,
      },
    };
    server.use(
      http.get(baseUrl, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer bearer-token",
        );
        return HttpResponse.json(response);
      }),
    );

    await expect(fetchAtlassianIntegration()).resolves.toEqual(response);
  });

  it("validates and saves only the selected product credentials", async () => {
    const credentials = {
      site_url: "https://example.atlassian.net",
      email: "jira@example.com",
      api_token: "jira-token",
    };
    server.use(
      http.put(`${baseUrl}/jira`, async ({ request }) => {
        expect(await request.json()).toEqual(credentials);
        return HttpResponse.json({
          connected: true,
          site_url: credentials.site_url,
          email: credentials.email,
        });
      }),
    );

    await expect(
      connectAtlassianIntegration("jira", credentials),
    ).resolves.toEqual({
      connected: true,
      site_url: credentials.site_url,
      email: credentials.email,
    });
  });

  it("disconnects only the selected product", async () => {
    let confluenceCalled = false;
    server.use(
      http.delete(`${baseUrl}/jira`, () => new HttpResponse(null, { status: 204 })),
      http.delete(`${baseUrl}/confluence`, () => {
        confluenceCalled = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await disconnectAtlassianIntegration("jira");

    expect(confluenceCalled).toBe(false);
  });
});
