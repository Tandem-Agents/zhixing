import { describe, it, expect } from "vitest";
import { BUILTIN_TOOL_FACTORIES } from "../factories.js";
import type { MemoryToolPort } from "../memory.js";

/**
 * 工厂装配契约测试 —— 重点：memory 工具的 store 注入与 fail-fast。
 *
 * by-construction 隔离的关键：memory 工具绝不自建默认 MemoryStore；缺注入
 * 即装配契约破坏，必须 fail-fast 而非静默写穿个人记忆域。
 */
describe("BUILTIN_TOOL_FACTORIES · assignment memory port 注入", () => {
  it("缺 ctx.memoryPort → fail-fast 抛错（不静默兜底）", () => {
    expect(() => BUILTIN_TOOL_FACTORIES.memory!({})).toThrow(
      /assignment memory port/,
    );
  });

  it("注入 ctx.memoryPort → 构造出 memory 工具", () => {
    const memoryPort: MemoryToolPort = {
      async save() {},
      async search() { return []; },
      async list() { return []; },
      async delete() { return false; },
    };
    const tool = BUILTIN_TOOL_FACTORIES.memory!({ memoryPort });
    expect(tool.name).toBe("memory");
  });

  it("非 memory 工厂不受 memoryPort 缺失影响（其他工具零回归）", () => {
    expect(BUILTIN_TOOL_FACTORIES.read!({}).name).toBe("read");
    expect(BUILTIN_TOOL_FACTORIES.glob!({}).name).toBe("glob");
  });
});
