import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TelemetryProvider } from "#/components/providers/telemetry-provider";

describe("TelemetryProvider", () => {
  it("renders children without enabling telemetry configuration", () => {
    render(
      <TelemetryProvider
        config={{
          apiKey: "ignored",
          apiHost: "https://telemetry.example",
        }}
      >
        <div>Telemetry-free content</div>
      </TelemetryProvider>,
    );

    expect(screen.getByText("Telemetry-free content")).toBeInTheDocument();
  });
});
