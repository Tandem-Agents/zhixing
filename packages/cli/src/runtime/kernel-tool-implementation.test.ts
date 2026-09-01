import { describe, expect, it } from "vitest";
import { createHostKernelToolImplementation } from "./kernel-tool-implementation.js";

const applications = {
  skillCatalogLoad: {} as never,
  skillCatalogSave: {} as never,
  skillCatalogAdmission: {} as never,
};

describe("Host Kernel Tool implementation", () => {
  it("selects the concrete exact-set in request order and creates fresh tools", () => {
    const implementation = createHostKernelToolImplementation();
    const request = Object.freeze({
      requestedToolNames: Object.freeze(["read", "load_skill", "web_fetch"]),
      networkProxy: "http://127.0.0.1:7890",
      ...applications,
      skillMode: "work" as const,
    });

    const first = implementation.create(request);
    const second = implementation.create(request);

    expect(first.tools.map(({ name }) => name)).toEqual([
      "read",
      "load_skill",
      "web_fetch",
    ]);
    expect(first.tools[0]).not.toBe(second.tools[0]);
    expect(first.permissionRuleSets.map(({ namespace }) => namespace))
      .toEqual(["web_fetch"]);
    expect(first.permissionRuleSets[0]!.rules.length).toBeGreaterThan(0);
  });

  it("fails closed for an unknown profile tool", () => {
    const implementation = createHostKernelToolImplementation();
    expect(() => implementation.create(Object.freeze({
      requestedToolNames: Object.freeze(["memory"]),
      ...applications,
      skillMode: "main" as const,
    }))).toThrow('does not provide "memory"');
  });
});
