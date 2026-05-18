import { describe, it, expect } from "vitest";
import { MemoryStore } from "@zhixing/core";
import { createTempDir } from "@zhixing/test-utils";
import { BUILTIN_TOOL_FACTORIES } from "../factories.js";

/**
 * 工厂装配契约测试 —— 重点：memory 工具的 store 注入与 fail-fast。
 *
 * by-construction 隔离的关键：memory 工具绝不自建默认 MemoryStore；缺注入
 * 即装配契约破坏，必须 fail-fast 而非静默写穿个人记忆域。
 */
describe("BUILTIN_TOOL_FACTORIES · memory store 注入", () => {
  it("缺 ctx.memoryStore → fail-fast 抛错（不静默兜底）", () => {
    expect(() => BUILTIN_TOOL_FACTORIES.memory!({})).toThrow(
      /memoryStore/,
    );
  });

  it("注入 ctx.memoryStore → 构造出 memory 工具", async () => {
    const store = new MemoryStore(await createTempDir("factory-mem"));
    const tool = BUILTIN_TOOL_FACTORIES.memory!({ memoryStore: store });
    expect(tool.name).toBe("memory");
  });

  it("非 memory 工厂不受 memoryStore 缺失影响（其他工具零回归）", () => {
    expect(BUILTIN_TOOL_FACTORIES.read!({}).name).toBe("read");
    expect(BUILTIN_TOOL_FACTORIES.glob!({}).name).toBe("glob");
  });
});
