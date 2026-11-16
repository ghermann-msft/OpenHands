import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetActiveStoreForTests,
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import type { Backend } from "#/api/backend-registry/types";
import {
  getSandboxSpecAdminCapabilities,
  searchAdminSandboxSpecs,
  searchSandboxSpecs,
  updateSandboxSpec,
} from "#/api/cloud/sandbox-spec-service.api";
import {
  getFetchCall,
  getJsonBody,
  mockJsonResponse,
} from "./fetch-test-utils";

const cloudBackend: Backend = {
  id: "ppe",
  name: "PPE",
  host: "https://halo.example.com",
  apiKey: "token",
  kind: "cloud",
};

const originalFetch = global.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
  __resetActiveStoreForTests();
  setRegisteredBackends([cloudBackend]);
  setActiveSelection({ backendId: cloudBackend.id });
  fetchMock.mockReset();
  global.fetch = fetchMock as typeof fetch;
});

afterEach(() => {
  __resetActiveStoreForTests();
  global.fetch = originalFetch;
});

describe("sandbox execution profile API", () => {
  it("uses the public discovery endpoint", async () => {
    fetchMock.mockResolvedValue(
      mockJsonResponse({ items: [], next_page_id: null }),
    );

    await searchSandboxSpecs();

    const [url, init] = getFetchCall(fetchMock);
    expect(url).toBe(`${cloudBackend.host}/api/v1/sandbox-specs/search`);
    expect(init).toMatchObject({ method: "GET" });
  });

  it("uses server-owned admin capability and search endpoints", async () => {
    fetchMock
      .mockResolvedValueOnce(mockJsonResponse({ can_manage: true }))
      .mockResolvedValueOnce(
        mockJsonResponse({ items: [], next_page_id: null }),
      );

    await expect(getSandboxSpecAdminCapabilities()).resolves.toEqual({
      can_manage: true,
    });
    await searchAdminSandboxSpecs();

    expect(getFetchCall(fetchMock, 0)[0]).toBe(
      `${cloudBackend.host}/api/v1/sandbox-specs/admin/capabilities`,
    );
    expect(getFetchCall(fetchMock, 1)[0]).toBe(
      `${cloudBackend.host}/api/v1/sandbox-specs/admin/search`,
    );
  });

  it("updates the selected server-owned profile by id", async () => {
    const profile = {
      id: "windows-build",
      display_name: "Windows Build",
    };
    fetchMock.mockResolvedValue(mockJsonResponse(profile));

    await updateSandboxSpec(
      profile.id,
      { display_name: profile.display_name },
      cloudBackend,
    );

    const [url, init] = getFetchCall(fetchMock);
    expect(url).toBe(
      `${cloudBackend.host}/api/v1/sandbox-specs/admin/windows-build`,
    );
    expect(init).toMatchObject({ method: "PUT" });
    expect(getJsonBody(init)).toEqual({ display_name: profile.display_name });
  });
});
