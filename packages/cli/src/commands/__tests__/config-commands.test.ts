/**
 * registerConfigCommands 测试 —— 真实 DefaultCommandRegistry + CommandDispatcher。
 *
 * 重点:注册形态、config/mcp 的 chrome 可见性过滤、以及 /trust 选择器经
 * 管理面 RPC 实时拉取(语境随当前对话派生)。config/mcp 的 handler 体委托给
 * handleConfigCommand / handleMcpCommand,各有自身测试,这里不重复 dispatch。
 */

import { describe, it, expect, vi } from "vitest";
import {
  CommandDispatcher,
  DefaultCommandRegistry,
  type RuntimeContext,
} from "@zhixing/core";
import {
  registerConfigCommands,
  type ConfigCommandsDeps,
} from "../config-commands.js";
import { FEATURE_CHROME } from "../command-visibility.js";

function runtime(chrome: boolean): RuntimeContext {
  return {
    sessionBusy: false,
    workspaceId: null,
    cwd: ".",
    target: "cli",
    features: { [FEATURE_CHROME]: chrome },
    now: 0,
  };
}

function rule(id: string) {
  return {
    id,
    scope: "global",
    pattern: { tool: "bash", argument: id },
    contributors: [{ origin: "user" }],
    matchCount: 0,
  };
}

function setup() {
  const registry = new DefaultCommandRegistry();
  const dispatcher = new CommandDispatcher({ registry });
  const trustList = vi.fn(async () => [rule("r-a")] as never[]);
  const securityStatus = vi.fn(async () => ({
    contextId: { kind: "main" },
    workspacePath: null,
    permissionRules: [],
    builtinRules: [],
    rateLimits: [],
    confirmations: [],
  }));
  const lines: string[] = [];
  const deps = {
    registry,
    dispatcher,
    writer: { line: (text: string) => lines.push(text) },
    rl: {},
    renderer: { stop: () => {} },
    screen: null,
    getActiveTurnPromise: () => null,
    management: { trustList, securityStatus },
    getConversationId: () => "conv-1",
    requestHostReload: async () => {},
  } as unknown as ConfigCommandsDeps;
  registerConfigCommands(deps);
  return { registry, dispatcher, trustList, securityStatus, lines };
}

describe("registerConfigCommands · 注册", () => {
  it("4 条命令注册为 local（config/mcp/trust/security）", () => {
    const { registry } = setup();
    for (const name of ["config", "mcp", "trust", "security"]) {
      expect(registry.findByName(name)?.execution).toBe("local");
    }
  });

  it("config/mcp 挂 chrome visibility —— no-chrome 下 list 不返回；trust/security 任何模式都在", () => {
    const { registry } = setup();
    const withChrome = registry.list(runtime(true)).map((c) => c.name);
    expect(withChrome).toEqual(
      expect.arrayContaining(["config", "mcp", "trust", "security"]),
    );
    const noChrome = registry.list(runtime(false)).map((c) => c.name);
    expect(noChrome).not.toContain("config");
    expect(noChrome).not.toContain("mcp");
    expect(noChrome).toContain("trust");
    expect(noChrome).toContain("security");
  });

  it("trust 带 rule 选择器 arg", () => {
    const { registry } = setup();
    const trust = registry.findByName("trust");
    expect(trust?.args?.[0]?.name).toBe("rule");
    expect(trust?.args?.[0]?.kind).toBe("async-enum");
  });
});

describe("registerConfigCommands · /trust 选择器", () => {
  it("list() 每次调用经管理面 RPC 实时拉取并携带当前对话语境", async () => {
    const { registry, trustList } = setup();
    const trust = registry.findByName("trust");
    const schema = trust?.args?.[0];
    if (!schema || schema.kind !== "async-enum") throw new Error("缺 rule arg");
    const provider = schema.provider;
    const ctx = { query: "" } as never;
    const signal = new AbortController().signal;

    const first = await provider.list(ctx, signal);
    expect(first.map((c) => (typeof c === "string" ? c : c.value))).toEqual([
      "r-a",
    ]);
    expect(trustList).toHaveBeenCalledWith("conv-1");

    // 宿主侧规则变化(撤销 / 新沉淀)——下次打开面板即最新,无本地快照
    trustList.mockResolvedValueOnce([rule("r-b")] as never[]);
    const second = await provider.list(ctx, signal);
    expect(second.map((c) => (typeof c === "string" ? c : c.value))).toEqual([
      "r-b",
    ]);
  });
});

describe("registerConfigCommands · /security", () => {
  it("状态查询经管理面 RPC 读取当前对话语境", async () => {
    const { dispatcher, securityStatus, lines } = setup();

    await dispatcher.dispatch("/security", runtime(false));

    expect(securityStatus).toHaveBeenCalledWith("conv-1");
    expect(lines.join("\n")).toContain("安全状态");
  });
});
