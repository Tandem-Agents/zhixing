import { describe, it, expect } from "vitest";
import {
  BUILTIN_TOOL_CAPABILITIES,
  BUILTIN_TOOL_FACTORIES,
  BUILTIN_TOOL_NAMES,
} from "../factories.js";

describe("BUILTIN_TOOL_FACTORIES · 公开集合", () => {
  const expected = [
    "admit_skill",
    "bash",
    "edit",
    "glob",
    "grep",
    "load_skill",
    "read",
    "save_skill",
    "web_fetch",
    "write",
  ];

  it("工厂、名称集合与能力表保持同一 exact-set", () => {
    expect(Object.keys(BUILTIN_TOOL_FACTORIES).sort()).toEqual(expected);
    expect([...BUILTIN_TOOL_NAMES].sort()).toEqual(expected);
    expect(Object.keys(BUILTIN_TOOL_CAPABILITIES).sort()).toEqual(expected);
  });

  it("存活工厂仍可从空上下文装配不需要依赖的工具", () => {
    expect(BUILTIN_TOOL_FACTORIES.read!({}).name).toBe("read");
    expect(BUILTIN_TOOL_FACTORIES.glob!({}).name).toBe("glob");
  });
});
