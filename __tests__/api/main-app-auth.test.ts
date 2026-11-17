import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_CANVAS_CLIENT_VERSION } from "#/api/client-source";
import {
  _resetCanvasAuthReported,
  authenticateWithMainAppCookie,
  MAIN_APP_ANALYTICS_EVENTS_PATH,
  MAIN_APP_AUTHENTICATE_PATH,
  MAIN_APP_CURRENT_USER_PATH,
  MAIN_APP_LOGOUT_PATH,
  getCurrentMainAppUser,
  reportCanvasAuthenticated,
} from "#/api/main-app-auth";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    isAxiosError: vi.fn(),
  },
}));

const getMock = vi.mocked(axios.get);
const postMock = vi.mocked(axios.post);
const isAxiosErrorMock = vi.mocked(axios.isAxiosError);

describe("main app cookie authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCanvasAuthReported();
  });

  it("reports the Canvas version after authentication succeeds", async () => {
    postMock.mockResolvedValue({});

    await expect(authenticateWithMainAppCookie()).resolves.toBe(true);
    await vi.waitFor(() => expect(postMock).toHaveBeenCalledTimes(2));

    expect(postMock).toHaveBeenNthCalledWith(
      1,
      MAIN_APP_AUTHENTICATE_PATH,
      null,
      { withCredentials: true },
    );
    expect(postMock).toHaveBeenNthCalledWith(
      2,
      MAIN_APP_ANALYTICS_EVENTS_PATH,
      {
        event_type: "canvas_authenticated",
        client_version: AGENT_CANVAS_CLIENT_VERSION,
      },
      { withCredentials: true },
    );
  });

  it("does not report unauthenticated arrivals", async () => {
    const error = { response: { status: 401 } };
    postMock.mockRejectedValue(error);
    isAxiosErrorMock.mockReturnValue(true);

    await expect(authenticateWithMainAppCookie()).resolves.toBe(false);

    expect(postMock).toHaveBeenCalledOnce();
    expect(postMock).toHaveBeenCalledWith(MAIN_APP_AUTHENTICATE_PATH, null, {
      withCredentials: true,
    });
  });

  it("isolates analytics failures from application startup", async () => {
    postMock.mockRejectedValue(new Error("analytics unavailable"));

    await expect(reportCanvasAuthenticated()).resolves.toBeUndefined();
  });

  it("fires the analytics event at most once per page load", async () => {
    postMock.mockResolvedValue({});

    await reportCanvasAuthenticated();
    await reportCanvasAuthenticated();

    expect(postMock).toHaveBeenCalledOnce();
  });

  it("loads the current Entra user from the main app", async () => {
    const user = {
      id: "user-1",
      name: "Grace Hopper",
      username: "grace@example.com",
      tenantId: "tenant-1",
    };
    getMock.mockResolvedValue({ data: user });

    await expect(getCurrentMainAppUser()).resolves.toEqual(user);

    expect(getMock).toHaveBeenCalledWith(MAIN_APP_CURRENT_USER_PATH, {
      withCredentials: true,
    });
    expect(MAIN_APP_LOGOUT_PATH).toBe("/auth/logout");
  });
});
