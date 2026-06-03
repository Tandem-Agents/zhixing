/**
 * registerConfigCommands 测试 —— 真实 DefaultCommandRegistry + CommandDispatcher。
 *
 * 重点:注册形态、config/mcp 的 chrome 可见性过滤、以及 /trust 选择器的 getter 修复
 * （securityPipeline 随 session reload swap 后，list() 跟随当前实例——值捕获会停在旧实例）。
 * config/mcp/security 的 handler 体委托给 handleConfigCommand / handleMcpCommand /
 * handleSecurityCommand，各有自身测试，这里不重复 dispatch。
 */

import { describe, it, expect } from "vitest";
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

function makePipeline(rules: ReturnType<typeof rule>[]) {
  return {
    getPermissionStore: () => ({ list: () => rules }),
    getContextId: () => ({ kind: "main" }),
  };
}

function setup() {
  const registry = new DefaultCommandRegistry();
  const dispatcher = new CommandDispatcher({ registry });
  // session 可变 —— 测 getter 跟随 securityPipeline swap
  const session = {
    runtime: { securityPipeline: makePipeline([rule("r-a")]) },
  };
  const deps = {
    registry,
    dispatcher,
    writer: { line: () => {} },
    rl: {},
    renderer: { stop: () => {} },
    screen: null,
    session,
    getActiveTurnPromise: () => null,
    mcpHub: {},
  } as unknown as ConfigCommandsDeps;
  registerConfigCommands(deps);
  return { registry, dispatcher, session };
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

describe("registerConfigCommands · /trust 选择器 getter 修复", () => {
  it("list() 按调用时读 securityPipeline —— swap 后跟随新实例（非构造期 capture）", async () => {
    const { registry, session } = setup();
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

    // 模拟 reload swap securityPipeline
    session.runtime.securityPipeline = makePipeline([rule("r-b")]);
    const second = await provider.list(ctx, signal);
    expect(second.map((c) => (typeof c === "string" ? c : c.value))).toEqual([
      "r-b",
    ]);
  });
});
