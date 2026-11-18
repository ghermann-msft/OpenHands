import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@openhands/typescript-client";
import {
  __resetActiveStoreForTests,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import {
  getCloudOrganizationMember,
  getCloudOrganizations,
  getCurrentCloudApiKey,
  deleteCloudOrganizationConnection,
  listCloudOrganizationMembers,
  listCloudOrganizationConnections,
  listCloudServiceAccounts,
  upsertCloudOrganizationConnection,
  updateCloudOrganizationMemberRole,
} from "#/api/cloud/organization-service.api";
import type { Backend } from "#/api/backend-registry/types";

const cloudBackend: Backend = {
  id: "prod",
  name: "Production",
  host: "https://app.all-hands.dev",
  apiKey: "bearer-token",
  kind: "cloud",
};

const originalFetch = global.fetch;
const fetchMock = vi.fn();

function mockJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  __resetActiveStoreForTests();
  setRegisteredBackends([]);
  fetchMock.mockReset();
  global.fetch = fetchMock as typeof fetch;
});

afterEach(() => {
  window.localStorage.clear();
  __resetActiveStoreForTests();
  fetchMock.mockReset();
  global.fetch = originalFetch;
});

describe("cloud organization-service", () => {
  it("getCloudOrganizations calls the cloud API directly and returns normalized data", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        items: [{ id: "org-1", name: "Personal" }],
        current_org_id: "org-1",
      }),
    );

    const result = await getCloudOrganizations(cloudBackend);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;

    expect(url).toBe(`${cloudBackend.host}/api/organizations`);
    expect(init).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer bearer-token" },
    });

    expect(result).toEqual({
      items: [{ id: "org-1", name: "Personal" }],
      currentOrgId: "org-1",
    });
  });

  it("getCurrentCloudApiKey hits /api/keys/current and returns the bound orgId", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({
        id: "key-1",
        name: "k",
        org_id: "org-bound",
        user_id: "user-1",
        auth_type: "bearer",
      }),
    );

    const result = await getCurrentCloudApiKey(cloudBackend);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${cloudBackend.host}/api/keys/current`);
    expect(init).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer bearer-token" },
    });
    expect(result).toEqual({ orgId: "org-bound", isLegacyKey: false });
  });

  it("getCurrentCloudApiKey treats an upstream 400 as a legacy key (no binding)", async () => {
    fetchMock.mockResolvedValueOnce(mockJsonResponse({ detail: "bad" }, 400));

    const result = await getCurrentCloudApiKey(cloudBackend);

    expect(result).toEqual({ orgId: null, isLegacyKey: true });
  });

  it("getCurrentCloudApiKey rethrows non-400 upstream errors (e.g. revoked key)", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse({ detail: "unauthorized" }, 401),
    );

    await expect(getCurrentCloudApiKey(cloudBackend)).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it("getCloudOrganizationMember hits /api/organizations/{orgId}/members/{userId} and returns the member", async () => {
    // Arrange
    const member = {
      org_id: "org-1",
      user_id: "user-1",
      email: "jdoe@acme.com",
      role: "member",
      status: "active",
    };
    fetchMock.mockResolvedValueOnce(mockJsonResponse(member));

    // Act
    const result = await getCloudOrganizationMember(
      "org-1",
      "user-1",
      cloudBackend,
    );

    // Assert
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `${cloudBackend.host}/api/organizations/org-1/members/user-1`,
    );
    expect(init).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer bearer-token" },
    });
    expect(result).toEqual(member);
  });

  it("listCloudOrganizationMembers returns immutable identities and roles", async () => {
    const response = {
      items: [
        {
          user_id: "user-1",
          identity: {
            provider: "entra",
            tenant_id: "tenant-1",
            subject_id: "subject-1",
          },
          role: "owner",
        },
      ],
    };
    fetchMock.mockResolvedValueOnce(mockJsonResponse(response));

    await expect(
      listCloudOrganizationMembers("org-1", cloudBackend),
    ).resolves.toEqual(response.items);

    expect(fetchMock.mock.calls[0]![0]).toBe(
      `${cloudBackend.host}/api/organizations/org-1/members`,
    );
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer bearer-token" },
    });
  });

  it("updateCloudOrganizationMemberRole patches the selected member role", async () => {
    const updated = {
      user_id: "user-2",
      identity: {
        provider: "entra",
        tenant_id: null,
        subject_id: "subject-2",
      },
      role: "admin",
    };
    fetchMock.mockResolvedValueOnce(mockJsonResponse(updated));

    await expect(
      updateCloudOrganizationMemberRole(
        "org-1",
        "user-2",
        "admin",
        cloudBackend,
      ),
    ).resolves.toEqual(updated);

    expect(fetchMock.mock.calls[0]![0]).toBe(
      `${cloudBackend.host}/api/organizations/org-1/members/user-2`,
    );
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: "PATCH",
      headers: { Authorization: "Bearer bearer-token" },
      body: JSON.stringify({ role: "admin" }),
    });
  });

  it("manages organization-owned connections without exposing secrets", async () => {
    const connection = {
      kind: "atlassian",
      connected: true,
      editable: true,
      scope: "shared",
      display_name: "user@example.com",
    };
    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse({
          organization_id: "org-1",
          items: [connection],
        }),
      )
      .mockResolvedValueOnce(mockJsonResponse(connection))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      listCloudOrganizationConnections("org-1", cloudBackend),
    ).resolves.toEqual([connection]);
    await expect(
      upsertCloudOrganizationConnection(
        "org-1",
        "atlassian",
        {
          transport: "streamable-http",
          url: "https://mcp.atlassian.com/v2/mcp",
        },
        "user@example.com",
        cloudBackend,
      ),
    ).resolves.toEqual(connection);
    await expect(
      deleteCloudOrganizationConnection("org-1", "atlassian", cloudBackend),
    ).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[0]![0]).toBe(
      `${cloudBackend.host}/api/organizations/org-1/connections`,
    );
    expect(fetchMock.mock.calls[1]![0]).toBe(
      `${cloudBackend.host}/api/organizations/org-1/connections/atlassian`,
    );
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({
        server: {
          transport: "streamable-http",
          url: "https://mcp.atlassian.com/v2/mcp",
        },
        display_name: "user@example.com",
      }),
    });
    expect(fetchMock.mock.calls[2]![1]).toMatchObject({ method: "DELETE" });
  });

  it("listCloudServiceAccounts follows next_page_id across pages", async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse({
          items: [
            { id: "sa-1", org_id: "org-1", name: "a", is_disabled: false },
          ],
          next_page_id: "100",
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          items: [
            { id: "sa-2", org_id: "org-1", name: "b", is_disabled: true },
          ],
          next_page_id: null,
        }),
      );

    const result = await listCloudServiceAccounts("org-1", cloudBackend);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `${cloudBackend.host}/api/organizations/org-1/service-accounts?limit=100`,
    );
    expect(fetchMock.mock.calls[1]![0]).toBe(
      `${cloudBackend.host}/api/organizations/org-1/service-accounts?limit=100&page_id=100`,
    );
    expect(result.map((account) => account.id)).toEqual(["sa-1", "sa-2"]);
  });
});
