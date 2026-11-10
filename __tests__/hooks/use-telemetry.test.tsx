import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useTelemetry } from "#/hooks/use-telemetry";

describe("useTelemetry", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("always exposes a disabled telemetry state", () => {
    const { result } = renderHook(() => useTelemetry());

    expect(result.current.consent).toBe("denied");
    expect(result.current.isEnabled).toBe(false);
    expect(result.current.showConsentPrompt).toBe(false);
  });

  it("cannot be enabled through the compatibility API", async () => {
    const { result } = renderHook(() => useTelemetry());

    await act(() => result.current.grantConsent());

    expect(result.current.consent).toBe("denied");
    expect(result.current.isEnabled).toBe(false);
  });
});
