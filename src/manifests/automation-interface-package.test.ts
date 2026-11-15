import { describe, expect, it } from "vitest";
import { hasAutomationInterface } from "./automation-interface";

describe("the pinned automation interface", () => {
  it("is admitted by this host", () => {
    expect(hasAutomationInterface()).toBe(true);
  });
});
