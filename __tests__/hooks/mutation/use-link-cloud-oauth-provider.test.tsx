import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkCloudOAuthProvider } from "#/api/cloud/oauth-service.api";
import { useLinkCloudOAuthProvider } from "#/hooks/mutation/use-link-cloud-oauth-provider";

vi.mock("#/api/cloud/oauth-service.api", () => ({
  linkCloudOAuthProvider: vi.fn(),
}));

const originalLocation = window.location;

beforeEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, assign: vi.fn() },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
});

describe("useLinkCloudOAuthProvider", () => {
  function renderMutation() {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return renderHook(() => useLinkCloudOAuthProvider(), { wrapper });
  }

  it("navigates the current window to the backend-provided start URL", async () => {
    // Arrange
    vi.mocked(linkCloudOAuthProvider).mockResolvedValue(
      "https://github.example.com/login/oauth/authorize",
    );
    const { result } = renderMutation();

    // Act
    await act(async () => {
      await result.current.mutateAsync(41);
    });

    // Assert
    expect(linkCloudOAuthProvider).toHaveBeenCalledWith(41);
    expect(window.location.assign).toHaveBeenCalledWith(
      "https://github.example.com/login/oauth/authorize",
    );
  });

  it.each([
    "javascript:alert(1)",
    "http://github.example.com/login/oauth/authorize",
    "/relative/oauth/start",
    "not a url",
  ])("rejects unsafe OAuth start URL %s", async (startUrl) => {
    // Arrange
    vi.mocked(linkCloudOAuthProvider).mockResolvedValue(startUrl);
    const { result } = renderMutation();

    // Act / Assert
    await expect(
      act(async () => result.current.mutateAsync(41)),
    ).rejects.toThrow("Expected an absolute HTTPS URL.");
    expect(window.location.assign).not.toHaveBeenCalled();
  });
});
