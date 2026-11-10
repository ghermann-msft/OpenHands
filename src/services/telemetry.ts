export interface TelemetryConfig {
  apiKey?: string;
  apiHost?: string;
  uiHost?: string;
}

export type WebsiteHandoffAttribution = Partial<{
  distinctId: string;
  sessionId: string;
  deviceId: string;
}>;

export type TelemetryConfiguration = TelemetryConfig | false;
export type TelemetryConsent = "granted" | "denied" | "pending";
export type ResolvedTelemetryConsent = Exclude<TelemetryConsent, "pending">;

export interface SetTelemetryConsentOptions {
  persist?: boolean;
  syncToCloud?: boolean;
}

const TELEMETRY_CONSENT_KEY = "openhands_telemetry_consent";
const TELEMETRY_STORAGE_PREFIXES = ["ph_", "phc_", "posthog"];
const consentListeners = new Set<() => void>();

function notifyTelemetryConsentListeners(): void {
  consentListeners.forEach((listener) => listener());
}

function persistDeniedConsent(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(TELEMETRY_CONSENT_KEY, "denied");
  } catch {
    // Storage is optional; telemetry remains disabled without it.
  }
}

export function setTelemetryWebsiteAttribution(
  _attribution?: WebsiteHandoffAttribution,
): void {}

export function setTelemetryBackendContext(_context?: unknown): void {}

export function setTelemetryCloudContext(_context?: unknown): void {}

export function configureTelemetry(_config: TelemetryConfiguration): void {}

export function configurePostHogBootstrap(_bootstrap?: unknown): void {}

export async function initializePostHogClient(): Promise<null> {
  return null;
}

export function getTelemetryConsent(): TelemetryConsent {
  return "denied";
}

export function getPendingCloudTelemetryConsent(): ResolvedTelemetryConsent | null {
  return null;
}

export function getPendingLocalTelemetryRevocationId(): string | null {
  return null;
}

export function subscribeTelemetryConsent(listener: () => void): () => void {
  consentListeners.add(listener);
  return () => consentListeners.delete(listener);
}

export function clearPendingLocalTelemetryRevocation(
  _distinctId?: string,
): void {}

export function clearPendingCloudTelemetryConsent(
  _consent?: ResolvedTelemetryConsent,
): void {}

export async function setTelemetryConsent(
  _consent: ResolvedTelemetryConsent,
  options: SetTelemetryConsentOptions = {},
): Promise<void> {
  if (options.persist !== false) persistDeniedConsent();
  notifyTelemetryConsentListeners();
}

export async function setTelemetryIdentity(
  _identity?: unknown,
  _properties?: Record<string, unknown>,
): Promise<void> {}

export function isTelemetryEnabled(): boolean {
  return false;
}

export async function trackInstall(): Promise<void> {}

export async function trackSessionStart(): Promise<void> {}

export async function getTelemetryDistinctId(): Promise<string | null> {
  return null;
}

export async function getTelemetryDistinctIdForConsentSync(): Promise<
  string | null
> {
  return null;
}

export async function trackEvent(
  _eventName: string,
  _properties?: Record<string, unknown>,
): Promise<void> {}

export async function clearTelemetryData(): Promise<void> {
  if (typeof localStorage === "undefined") return;

  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (
        key &&
        (key === TELEMETRY_CONSENT_KEY ||
          TELEMETRY_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix)))
      ) {
        localStorage.removeItem(key);
      }
    }
    persistDeniedConsent();
  } catch {
    // Storage is optional; telemetry remains disabled without it.
  }

  notifyTelemetryConsentListeners();
}
