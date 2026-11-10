import React from "react";
import type { TelemetryConfiguration } from "#/services/telemetry";

export function TelemetryProvider({
  children,
}: {
  children: React.ReactNode;
  config?: TelemetryConfiguration;
}) {
  return children;
}
