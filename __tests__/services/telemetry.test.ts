import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTelemetryData,
  getTelemetryConsent,
  getTelemetryDistinctId,
  initializePostHogClient,
  isTelemetryEnabled,
  setTelemetryConsent,
  trackEvent,
  trackInstall,
  trackSessionStart,
} from "#/services/telemetry";

describe("Telemetry Service", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("permanently reports telemetry as denied and disabled", async () => {
    await setTelemetryConsent("granted");

    expect(getTelemetryConsent()).toBe("denied");
    expect(isTelemetryEnabled()).toBe(false);
    expect(localStorage.getItem("openhands_telemetry_consent")).toBe("denied");
  });

  it("never initializes a telemetry client or exposes an identity", async () => {
    expect(await initializePostHogClient()).toBeNull();
    expect(await getTelemetryDistinctId()).toBeNull();
  });

  it("keeps all tracking entry points as no-ops", async () => {
    await expect(trackInstall()).resolves.toBeUndefined();
    await expect(trackSessionStart()).resolves.toBeUndefined();
    await expect(trackEvent("attempted_event")).resolves.toBeUndefined();
  });

  it("removes legacy telemetry storage and preserves denied consent", async () => {
    localStorage.setItem("posthog_device_id", "legacy");
    localStorage.setItem("ph_client", "legacy");
    localStorage.setItem("unrelated", "keep");

    await clearTelemetryData();

    expect(localStorage.getItem("posthog_device_id")).toBeNull();
    expect(localStorage.getItem("ph_client")).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep");
    expect(localStorage.getItem("openhands_telemetry_consent")).toBe("denied");
  });
});
