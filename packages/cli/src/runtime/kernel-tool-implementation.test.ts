import { describe, expect, it, vi } from "vitest";
import { skillNameToId } from "@zhixing/core/skills/id";
import { createHostKernelToolImplementation } from "./kernel-tool-implementation.js";

describe("Host Kernel Tool implementation", () => {
  it("selects the concrete exact-set in request order and creates fresh tools", () => {
    const implementation = createHostKernelToolImplementation(Object.freeze({
      kind: "builtin-only",
      mode: "work",
    }));
    const request = Object.freeze({
      requestedToolNames: Object.freeze(["read", "load_skill", "web_fetch"]),
      networkProxy: "http://127.0.0.1:7890",
      callText: vi.fn(async () => "text"),
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
    expect(request).not.toHaveProperty("skillMode");
    expect(request).not.toHaveProperty("artifactStore");
    expect(request).not.toHaveProperty("skillCatalogLoad");
  });

  it("fails closed for an unknown profile tool", () => {
    const implementation = createHostKernelToolImplementation(Object.freeze({
      kind: "builtin-only",
      mode: "main",
    }));
    expect(() => implementation.create(Object.freeze({
      requestedToolNames: Object.freeze(["memory"]),
      callText: vi.fn(async () => "text"),
    }))).toThrow('does not provide "memory"');
  });

  it("keeps builtin-only fallback distinct from a missing durable assignment", async () => {
    const request = Object.freeze({
      requestedToolNames: Object.freeze(["load_skill"]),
      callText: vi.fn(async () => "text"),
    });
    const builtin = createHostKernelToolImplementation(Object.freeze({
      kind: "builtin-only",
      mode: "main",
    })).create(request).tools[0]!;
    const assignment = createHostKernelToolImplementation(Object.freeze({
      kind: "assignment",
      mode: "main",
      artifacts: {} as never,
    })).create(request).tools[0]!;
    const id = skillNameToId("提炼技能");

    await expect(builtin.call({ id }, { workingDirectory: process.cwd() }))
      .resolves.toMatchObject({ isError: false });
    await expect(assignment.call({ id }, { workingDirectory: process.cwd() }))
      .resolves.toMatchObject({
        isError: true,
        content: expect.stringContaining(
          "Skill access requires an active durable assignment",
        ),
      });
  });
});
