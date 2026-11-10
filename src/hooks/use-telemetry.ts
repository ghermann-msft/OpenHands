import { useCallback, useSyncExternalStore } from "react";
import {
  getTelemetryConsent,
  setTelemetryConsent,
  trackEvent,
  clearTelemetryData,
  subscribeTelemetryConsent,
  type TelemetryConsent,
} from "#/services/telemetry";

export interface UseTelemetryReturn {
  /** Current consent status */
  consent: TelemetryConsent;
  /** Whether telemetry is enabled (consent granted) */
  isEnabled: boolean;
  /** Whether consent prompt should be shown */
  showConsentPrompt: boolean;
  /** Grant consent and enable telemetry */
  grantConsent: () => Promise<void>;
  /** Deny consent and disable telemetry */
  denyConsent: () => Promise<void>;
  /** Track a custom event (only if consent granted) */
  track: (eventName: string, properties?: Record<string, unknown>) => void;
  /** Clear all telemetry data */
  clearData: () => Promise<void>;
}

/**
 * Hook for managing telemetry consent and tracking.
 *
 * Telemetry is permanently disabled in this distribution. The hook remains as
 * a compatibility API for consumers that still call tracking helpers.
 */
export function useTelemetry(): UseTelemetryReturn {
  const consent = useSyncExternalStore<TelemetryConsent>(
    subscribeTelemetryConsent,
    getTelemetryConsent,
    () => "denied",
  );

  const grantConsent = useCallback(() => setTelemetryConsent("granted"), []);

  const denyConsent = useCallback(() => setTelemetryConsent("denied"), []);

  const track = useCallback(
    (eventName: string, properties?: Record<string, unknown>) => {
      void trackEvent(eventName, properties);
    },
    [],
  );

  const clearData = useCallback(() => clearTelemetryData(), []);

  return {
    consent,
    isEnabled: false,
    showConsentPrompt: false,
    grantConsent,
    denyConsent,
    track,
    clearData,
  };
}
