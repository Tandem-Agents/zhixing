import { describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "@zhixing/core";
import {
  createRequestCapabilitiesTool,
  type RequestCapabilitiesPromoteResult,
} from "../request-capabilities.js";

const ctx: ToolExecutionContext = { workingDirectory: "/tmp" };

function makeDeps(map: Record<string, RequestCapabilitiesPromoteResult>) {
  const calls: string[] = [];
  return {
    deps: {
      promote: (toolName: string) => {
        calls.push(toolName);
        return (
          map[toolName] ?? {
            layer: "unknown" as const,
            promoted: false,
          }
        );
      },
    },
    calls,
  };
}

// ─── 输入校验 ───

describe("request_capabilities · 输入校验", () => {
  it("缺 tools 字段 → isError + 提示", async () => {
    const tool = createRequestCapabilitiesTool({
      promote: () => ({ layer: "unknown", promoted: false }),
    });
    const r = await tool.call({}, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/tools.*array/);
  });

  it("tools 不是 array → isError", async () => {
    const tool = createRequestCapabilitiesTool({
      promote: () => ({ layer: "unknown", promoted: false }),
    });
    const r = await tool.call({ tools: "read" } as unknown as Record<string, unknown>, ctx);
    expect(r.isError).toBe(true);
  });

  it("tools 空数组 → isError", async () => {
    const tool = createRequestCapabilitiesTool({
      promote: () => ({ layer: "unknown", promoted: false }),
    });
    const r = await tool.call({ tools: [] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/must not be empty/);
  });

  it("tools 含非字符串 → isError", async () => {
    const tool = createRequestCapabilitiesTool({
      promote: () => ({ layer: "unknown", promoted: false }),
    });
    const r = await tool.call(
      { tools: ["read", 123] } as unknown as Record<string, unknown>,
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/non-empty string/);
  });

  it("tools 含空字符串 → isError", async () => {
    const tool = createRequestCapabilitiesTool({
      promote: () => ({ layer: "unknown", promoted: false }),
    });
    const r = await tool.call({ tools: ["read", ""] }, ctx);
    expect(r.isError).toBe(true);
  });
});

// ─── 升级行为分类 ───

describe("request_capabilities · 升级结果分类", () => {
  it("纯激活：discoverable → hot 全部成功", async () => {
    const { deps, calls } = makeDeps({
      read: { layer: "hot", promoted: true },
      grep: { layer: "hot", promoted: true },
    });
    const tool = createRequestCapabilitiesTool(deps);
    const r = await tool.call({ tools: ["read", "grep"] }, ctx);

    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Activated: read, grep");
    expect(calls).toEqual(["read", "grep"]);
  });

  it("已激活：already always 或已 hot", async () => {
    const { deps } = makeDeps({
      memory: { layer: "always", promoted: false },
      read: { layer: "hot", promoted: false },
    });
    const tool = createRequestCapabilitiesTool(deps);
    const r = await tool.call({ tools: ["memory", "read"] }, ctx);

    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Already active: memory, read");
    expect(r.content).not.toContain("Activated:");
  });

  it("未注册：layer === unknown", async () => {
    const { deps } = makeDeps({}); // 全空，全部走默认 unknown
    const tool = createRequestCapabilitiesTool(deps);
    const r = await tool.call({ tools: ["foo", "bar"] }, ctx);

    // 全部 unknown → isError
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Unknown");
    expect(r.content).toContain("foo, bar");
  });

  it("cold 工具：标记为 blocked", async () => {
    const { deps } = makeDeps({
      legacy: { layer: "cold", promoted: false },
    });
    const tool = createRequestCapabilitiesTool(deps);
    const r = await tool.call({ tools: ["legacy"] }, ctx);

    // 全部 blocked → isError（与 unknown 同列"无任何激活动作"）
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Blocked");
    expect(r.content).toContain("legacy");
  });

  it("混合：activated + already-active + unknown + blocked → 各自分类", async () => {
    const { deps } = makeDeps({
      read: { layer: "hot", promoted: true },
      memory: { layer: "always", promoted: false },
      legacy: { layer: "cold", promoted: false },
      // foo 走默认 unknown
    });
    const tool = createRequestCapabilitiesTool(deps);
    const r = await tool.call(
      { tools: ["read", "memory", "legacy", "foo"] },
      ctx,
    );

    // 至少有一项被激活 → 整体不算 error
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Activated: read");
    expect(r.content).toContain("Already active: memory");
    expect(r.content).toContain("Unknown (not registered): foo");
    expect(r.content).toContain("Blocked (disabled or unavailable): legacy");
  });
});

// ─── isError 判定语义 ───

describe("request_capabilities · isError 判定", () => {
  it("有任意 activated 或 already-active → 不是 error", async () => {
    const { deps } = makeDeps({
      read: { layer: "hot", promoted: true },
      // foo unknown
    });
    const tool = createRequestCapabilitiesTool(deps);
    const r = await tool.call({ tools: ["read", "foo"] }, ctx);
    expect(r.isError).toBeUndefined();
  });

  it("全部 unknown / blocked（无任何激活）→ isError", async () => {
    const { deps } = makeDeps({
      legacy: { layer: "cold", promoted: false },
    });
    const tool = createRequestCapabilitiesTool(deps);
    const r = await tool.call({ tools: ["foo", "legacy"] }, ctx);
    expect(r.isError).toBe(true);
  });
});
