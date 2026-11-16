import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExecutionProfileSelect } from "#/components/features/settings/execution-profiles/execution-profile-select";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("#/hooks/query/use-sandbox-specs", () => ({
  useSandboxSpecs: () => ({
    isLoading: false,
    data: {
      items: [
        {
          id: "openhands-pool",
          display_name: "Linux Standard",
          enabled: true,
          published: true,
          availability: "available",
          availability_reason: null,
          operating_system: "linux",
          resource_class: "standard",
          cpu_request: "4",
          memory_request: "8Gi",
          cpu_cores: 4,
          memory_gib: 8,
          capabilities: ["runtime_image_contract_v1"],
        },
        {
          id: "windows-build",
          display_name: "Windows Build",
          enabled: true,
          published: true,
          availability: "unavailable",
          availability_reason: "Windows node pool is scaled to zero",
          operating_system: "windows",
          resource_class: "build",
          cpu_request: "8",
          memory_request: "16Gi",
          cpu_cores: 8,
          memory_gib: 16,
          capabilities: ["native_windows_runtime_v1"],
        },
      ],
    },
  }),
}));

describe("ExecutionProfileSelect", () => {
  it("shows curated resources and prevents unavailable selection", () => {
    const onChange = vi.fn();
    render(
      <ExecutionProfileSelect
        value=""
        onChange={onChange}
        includeSavedDefault
      />,
    );

    expect(
      screen.getByRole("option", { name: /Linux Standard/ }),
    ).toHaveTextContent("4 CPU / 8 GiB");
    expect(
      screen.getByRole("option", { name: /Windows Build/ }),
    ).toBeDisabled();

    fireEvent.change(screen.getByTestId("execution-profile-select"), {
      target: { value: "openhands-pool" },
    });
    expect(onChange).toHaveBeenCalledWith("openhands-pool");
  });
});
