/**
 * BoundaryRegistry 单元测试
 *
 * 覆盖：
 * - fromTools 从 ToolDefinition 列表正确提取 boundaries
 * - 未声明 / 空数组的工具不进入 registry
 * - 工具名按小写归一化（与 PermissionStore.match / CompositeClassifier 行为一致）
 * - 返回数组与内部存储独立（修改不污染下次查询）
 * - 现实场景：现有 8 个 builtin 工具均不声明 → registry 全为空（forward-looking 政策）
 * - 动态 register / unregister API（未来 MCP 接入路径的 forward-looking 验证）
 */

import { describe, expect, it } from "vitest";

import { BoundaryRegistry } from "../boundary-registry.js";
import { SecurityPipeline } from "../security-pipeline.js";
import type {
  BoundaryCrossing,
  MutableToolBoundaryRegistry,
} from "../types.js";
import type { ToolDefinition } from "../../types/tools.js";

// ─── 测试辅助 ───

function makeTool(
  name: string,
  boundaries?: BoundaryCrossing[],
): ToolDefinition {
  return {
    name,
    description: `mock tool ${name}`,
    inputSchema: { type: "object" },
    boundaries,
    async call() {
      return { content: "" };
    },
  };
}

const NETWORK_EGRESS: BoundaryCrossing = {
  boundaryType: "network",
  access: "egress",
  dynamic: false,
};

const FS_READ: BoundaryCrossing = {
  boundaryType: "filesystem",
  access: "read",
  dynamic: false,
};

// ─── fromTools 静态工厂 ───

describe("BoundaryRegistry.fromTools (启动时 snapshot 模式)", () => {
  it("从工具定义提取声明的 boundaries", () => {
    const registry = BoundaryRegistry.fromTools([
      makeTool("web_fetch", [NETWORK_EGRESS]),
    ]);

    expect(registry.getBoundaries("web_fetch")).toEqual([NETWORK_EGRESS]);
  });

  it("未声明 boundaries 的工具返回 undefined", () => {
    const registry = BoundaryRegistry.fromTools([
      makeTool("read", undefined),
    ]);
    expect(registry.getBoundaries("read")).toBeUndefined();
  });

  it("声明为空数组的工具不进入 registry（视同未声明）", () => {
    const registry = BoundaryRegistry.fromTools([makeTool("read", [])]);
    expect(registry.getBoundaries("read")).toBeUndefined();
  });

  it("工具名查询大小写不敏感（按小写归一化）", () => {
    const registry = BoundaryRegistry.fromTools([
      makeTool("WebFetch", [NETWORK_EGRESS]),
    ]);

    expect(registry.getBoundaries("webfetch")).toEqual([NETWORK_EGRESS]);
    expect(registry.getBoundaries("WEBFETCH")).toEqual([NETWORK_EGRESS]);
    expect(registry.getBoundaries("WebFetch")).toEqual([NETWORK_EGRESS]);
  });

  it("多工具混合：声明者进入 registry，未声明者不进入", () => {
    const registry = BoundaryRegistry.fromTools([
      makeTool("web_fetch", [NETWORK_EGRESS]),
      makeTool("read", undefined),
      makeTool("web_search", [NETWORK_EGRESS]),
    ]);

    expect(registry.getBoundaries("web_fetch")).toEqual([NETWORK_EGRESS]);
    expect(registry.getBoundaries("web_search")).toEqual([NETWORK_EGRESS]);
    expect(registry.getBoundaries("read")).toBeUndefined();
  });

  it("多 boundary 声明完整保留", () => {
    const registry = BoundaryRegistry.fromTools([
      makeTool("multi_boundary_tool", [NETWORK_EGRESS, FS_READ]),
    ]);

    expect(registry.getBoundaries("multi_boundary_tool")).toEqual([
      NETWORK_EGRESS,
      FS_READ,
    ]);
  });

  it("空工具列表产生空 registry", () => {
    const registry = BoundaryRegistry.fromTools([]);
    expect(registry.getBoundaries("anything")).toBeUndefined();
  });

  it("走 context classifier 的工具不声明 boundaries → registry 全为空", () => {
    const builtinNames = [
      "read",
      "write",
      "edit",
      "glob",
      "grep",
      "bash",
    ];
    const tools = builtinNames.map((name) => makeTool(name, undefined));

    const registry = BoundaryRegistry.fromTools(tools);
    expect(registry.list()).toEqual([]);
    for (const name of builtinNames) {
      expect(registry.getBoundaries(name)).toBeUndefined();
    }
  });
});

// ─── 不变性 / 独立性 ───

describe("BoundaryRegistry: 内部状态保护（深拷贝）", () => {
  it("修改返回数组（push/splice）不影响 registry 内部状态", () => {
    const registry = BoundaryRegistry.fromTools([
      makeTool("web_fetch", [NETWORK_EGRESS]),
    ]);

    const first = registry.getBoundaries("web_fetch")!;
    first.push(FS_READ); // 数组级 mutate

    const second = registry.getBoundaries("web_fetch")!;
    expect(second).toEqual([NETWORK_EGRESS]);
    expect(second).toHaveLength(1);
  });

  it("修改返回的单 BoundaryCrossing 字段不影响 registry（R2 出站深拷贝）", () => {
    // 防御场景：caller 拿到 getBoundaries 返回值后修改单个 crossing 字段
    // （如 `crossings[0].access = "MUTATED"`），不应污染 registry 内部状态
    const registry = BoundaryRegistry.fromTools([
      makeTool("web_fetch", [{ ...NETWORK_EGRESS }]),
    ]);

    const first = registry.getBoundaries("web_fetch")!;
    first[0]!.access = "MUTATED_ACCESS";
    first[0]!.dynamic = true;

    const second = registry.getBoundaries("web_fetch")!;
    expect(second[0]!.access).toBe("egress");
    expect(second[0]!.dynamic).toBe(false);
  });

  it("修改源 tools 数组的 boundaries 不影响 registry（fromTools 入站深拷贝）", () => {
    const sharedBoundaries: BoundaryCrossing[] = [{ ...NETWORK_EGRESS }];
    const registry = BoundaryRegistry.fromTools([
      makeTool("web_fetch", sharedBoundaries),
    ]);

    sharedBoundaries.push(FS_READ);
    sharedBoundaries[0]!.access = "MUTATED_ACCESS";

    const result = registry.getBoundaries("web_fetch")!;
    expect(result).toHaveLength(1);
    expect(result[0]!.access).toBe("egress");
  });

  it("修改 register 入参的单 BoundaryCrossing 字段不影响 registry（R2 入站深拷贝）", () => {
    const registry = new BoundaryRegistry();
    const crossingRef: BoundaryCrossing = { ...NETWORK_EGRESS };
    registry.register("tool", [crossingRef]);

    crossingRef.access = "MUTATED_ACCESS";
    crossingRef.dynamic = true;

    const result = registry.getBoundaries("tool")!;
    expect(result[0]!.access).toBe("egress");
    expect(result[0]!.dynamic).toBe(false);
  });
});

// ─── 动态 register / unregister（forward-looking for MCP / 插件接入）───

describe("BoundaryRegistry: 动态 register / unregister", () => {
  it("register 注册新工具，getBoundaries 立即可见", () => {
    const registry = new BoundaryRegistry();
    expect(registry.getBoundaries("mcp_tool")).toBeUndefined();

    registry.register("mcp_tool", [NETWORK_EGRESS]);
    expect(registry.getBoundaries("mcp_tool")).toEqual([NETWORK_EGRESS]);
  });

  it("register 同一 toolName 覆盖旧声明", () => {
    const registry = new BoundaryRegistry();
    registry.register("tool", [NETWORK_EGRESS]);
    registry.register("tool", [FS_READ]);

    expect(registry.getBoundaries("tool")).toEqual([FS_READ]);
  });

  it("register 拒空数组 throw（fail-fast，不混入 unregister 语义）", () => {
    const registry = new BoundaryRegistry();
    registry.register("tool", [NETWORK_EGRESS]);

    expect(() => registry.register("tool", [])).toThrow(
      /boundaries 不能为空数组/,
    );

    // 原注册保持不变（throw 不改 store 状态）
    expect(registry.getBoundaries("tool")).toEqual([NETWORK_EGRESS]);
  });

  it("list 返回所有已注册的工具名（小写）", () => {
    const registry = new BoundaryRegistry();
    registry.register("web_fetch", [NETWORK_EGRESS]);
    registry.register("WEB_SEARCH", [NETWORK_EGRESS]);

    const list = registry.list();
    expect(list).toContain("web_fetch");
    expect(list).toContain("web_search");
    expect(list).toHaveLength(2);
  });

  it("装配期补注册场景：fromTools snapshot + 后续 register（如 Task 工具晚于 snapshot）", () => {
    const registry = BoundaryRegistry.fromTools([
      makeTool("read", undefined), // 走 context classifier 的工具不声明
    ]);
    expect(registry.list()).toEqual([]);

    // 装配晚于 fromTools 的工具（如 Task）补注册
    registry.register("task", [NETWORK_EGRESS]);
    expect(registry.getBoundaries("task")).toEqual([NETWORK_EGRESS]);
  });
});

// ─── 守卫：从 SecurityPipeline 顶层观察 register 即时生效 ───
//
// ADR-TPE-009 承诺：caller 调 `registry.register(...)` 后 SecurityPipeline.evaluate
// 立即反映新分类——不需要 reconfigure pipeline（装配期 Task 工具补注册即依赖此）。
// 仅在 BoundaryImpactClassifier 不缓存 registry 查询结果时成立。
//
// 守卫这条不变：若未来 BoundaryImpactClassifier 加内部缓存做性能优化，本测试会
// 立即发现破坏。

describe("ADR-TPE-009 守卫：register 后 SecurityPipeline 即时生效", () => {
  it("空 registry 注入 pipeline → unknown 工具分类为 critical", async () => {
    const registry: MutableToolBoundaryRegistry = new BoundaryRegistry();
    const pipeline = new SecurityPipeline({
      workspace: "/tmp/test",
      toolBoundaryRegistry: registry,
    });

    const result = await pipeline.evaluate("unknown_tool", {}, "/tmp/test");
    // BoundaryImpactClassifier fail-closed：未声明 → critical
    expect(result.operationClass).toBe("critical");
  });

  it("register 后再 evaluate 同一工具 → 立即按新边界分类", async () => {
    const registry: MutableToolBoundaryRegistry = new BoundaryRegistry();
    const pipeline = new SecurityPipeline({
      workspace: "/tmp/test",
      toolBoundaryRegistry: registry,
    });

    // 先 evaluate：未注册 → critical
    const before = await pipeline.evaluate("mcp_tool", {}, "/tmp/test");
    expect(before.operationClass).toBe("critical");

    // 装配期补注册（如 Task 工具晚于 fromTools）
    registry.register("mcp_tool", [NETWORK_EGRESS]);

    // 再 evaluate：立即按 network/egress 分类（external，不再 critical）
    const after = await pipeline.evaluate("mcp_tool", {}, "/tmp/test");
    expect(after.operationClass).toBe("external");
  });

  it("更换边界声明（覆盖式 register）→ 立即按新边界分类", async () => {
    const registry: MutableToolBoundaryRegistry = new BoundaryRegistry();
    // 初始声明：network/egress（→ external）
    registry.register("dynamic_tool", [
      { boundaryType: "network", access: "egress", dynamic: false },
    ]);

    const pipeline = new SecurityPipeline({
      workspace: "/tmp/test",
      toolBoundaryRegistry: registry,
    });

    const before = await pipeline.evaluate("dynamic_tool", {}, "/tmp/test");
    expect(before.operationClass).toBe("external");

    // 替换边界为 secrets（→ critical）
    registry.register("dynamic_tool", [
      { boundaryType: "secrets", access: "read", dynamic: false },
    ]);

    const after = await pipeline.evaluate("dynamic_tool", {}, "/tmp/test");
    // secrets 即使是 read access 也是 observe（因 BOUNDARY_READ_ACCESS 含 "read"），
    // 所以这里其实是 observe——验证"即时反映新声明"即可，不验证特定 class
    expect(after.operationClass).not.toBe(before.operationClass);
  });
});
