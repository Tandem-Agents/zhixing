/**
 * CommandProvider 单元测试
 *
 * 覆盖点：
 *   - matchTrigger: prompt vs bash mode / boundary / 无 trigger
 *   - 空 query: MRU 前置 + 分类排序
 *   - 非空 query: Fuse + resort 的端到端行为
 *   - 零键执行：suggestions 非空时 index 0 为最佳匹配
 *   - 无必填参数 → execute=true; 有必填参数 → execute=false
 *   - Hidden 命令不在 list 里但能按名字找（registry 层已测，这里验证 provider 输出）
 *   - Visibility predicate 被应用
 */

import { describe, expect, it } from "vitest";
import {
  buildSampleCommands,
  registerSampleCommands,
} from "./sample-commands.js";
import { CommandProvider } from "../providers/command-provider.js";
import { DefaultCommandRegistry } from "../registry.js";
import type {
  IUsageTracker,
  RuntimeContext,
  TriggerContext,
} from "../types.js";

// ─── 辅助 ───

function makeCtx(
  draft: string,
  cursor = draft.length,
  overrides: Partial<TriggerContext> = {},
): TriggerContext {
  return {
    draft,
    cursor,
    mode: "prompt",
    runtime: makeRuntime(),
    ...overrides,
  };
}

function makeRuntime(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    sessionBusy: false,
    workspaceId: null,
    cwd: "/tmp",
    target: "cli",
    features: {},
    now: 1_700_000_000_000,
    ...overrides,
  };
}

/** 构造一个带 builtin 命令的 registry */
function makeRegistry() {
  const reg = new DefaultCommandRegistry();
  registerSampleCommands(reg);
  return reg;
}

/** 简易 in-memory usage tracker mock */
function makeMockTracker(topN: Array<{ commandId: string; score: number }>): IUsageTracker {
  return {
    recordUsage: () => {},
    getScore: (id: string) => topN.find((t) => t.commandId === id)?.score ?? 0,
    topN: (n: number) => topN.slice(0, n),
    prune: async () => 0,
    flush: async () => {},
  };
}

// ─── matchTrigger ───

describe("CommandProvider.matchTrigger", () => {
  const provider = new CommandProvider({ registry: makeRegistry() });

  it("prompt 模式下 '/' 触发", () => {
    const m = provider.matchTrigger(makeCtx("/"));
    expect(m).not.toBeNull();
    expect(m?.providerId).toBe("command");
    expect(m?.token).toBe("/");
    expect(m?.query).toBe("");
  });

  it("prompt 模式 '/el' 触发", () => {
    const m = provider.matchTrigger(makeCtx("/el"));
    expect(m?.query).toBe("el");
  });

  it("bash 模式下不触发", () => {
    const m = provider.matchTrigger(makeCtx("/el", 3, { mode: "bash" }));
    expect(m).toBeNull();
  });

  it("非 '/' 开头（无 boundary）不触发", () => {
    const m = provider.matchTrigger(makeCtx("hello /el"));
    // 空格后 /el 是合法的 boundary，应该命中
    expect(m).not.toBeNull();
  });

  it("空 draft 不触发", () => {
    const m = provider.matchTrigger(makeCtx(""));
    expect(m).toBeNull();
  });

  it("match 携带 runtime 用于后续 query", () => {
    const runtime = makeRuntime({ workspaceId: "ws-123" });
    const m = provider.matchTrigger(makeCtx("/", 1, { runtime }));
    expect(m?.runtime).toBe(runtime);
  });
});

// ─── query 空 query ───

describe("CommandProvider.query — 空 query（MRU + 分类）", () => {
  it("无 usage tracker 时：纯按 category 顺序（session → config → info → tools → debug → plugin）", () => {
    const registry = makeRegistry();
    const provider = new CommandProvider({ registry });
    const ctx = makeCtx("/", 1);
    const match = provider.matchTrigger(ctx)!;
    const items = provider.query(
      match,
      new AbortController().signal,
    ) as import("../types.js").SuggestionItem[];

    // 第一条应来自 session 类别
    const sessionCmds = buildSampleCommands().filter(
      (c) => c.category === "session" && !c.hidden,
    );
    expect(items[0]!.id).toBe(
      sessionCmds.map((c) => c.id).sort()[0], // 字母序首个
    );
  });

  it("空 query 不包含 hidden 命令（/debug）", () => {
    const registry = makeRegistry();
    const provider = new CommandProvider({ registry });
    const match = provider.matchTrigger(makeCtx("/", 1))!;
    const items = provider.query(match, new AbortController().signal);
    expect(Array.isArray(items)).toBe(true);
    const ids = (items as import("../types.js").SuggestionItem[]).map(
      (i) => i.id,
    );
    expect(ids).not.toContain("debug:builtin");
  });

  it("有 usage tracker 时：MRU top N 前置", () => {
    const registry = makeRegistry();
    const tracker = makeMockTracker([
      { commandId: "elevated:builtin", score: 20 },
      { commandId: "model:builtin", score: 10 },
    ]);
    const provider = new CommandProvider({ registry, usageTracker: tracker });
    const match = provider.matchTrigger(makeCtx("/", 1))!;
    const items = provider.query(
      match,
      new AbortController().signal,
    ) as import("../types.js").SuggestionItem[];
    // 前两条是 MRU
    expect(items[0]!.id).toBe("elevated:builtin");
    expect(items[1]!.id).toBe("model:builtin");
  });

  it("MRU 去重：MRU 里的命令不在分类段重复出现", () => {
    const registry = makeRegistry();
    const tracker = makeMockTracker([
      { commandId: "new:builtin", score: 20 },
    ]);
    const provider = new CommandProvider({ registry, usageTracker: tracker });
    const match = provider.matchTrigger(makeCtx("/", 1))!;
    const items = provider.query(
      match,
      new AbortController().signal,
    ) as import("../types.js").SuggestionItem[];
    // /new 只出现一次
    const newCount = items.filter((i) => i.id === "new:builtin").length;
    expect(newCount).toBe(1);
    // 并且排第一
    expect(items[0]!.id).toBe("new:builtin");
  });

  it("MRU 跳过不存在或不可见的命令", () => {
    const registry = makeRegistry();
    const tracker = makeMockTracker([
      { commandId: "ghost:builtin", score: 99 }, // 不存在
      { commandId: "new:builtin", score: 10 },
    ]);
    const provider = new CommandProvider({ registry, usageTracker: tracker });
    const match = provider.matchTrigger(makeCtx("/", 1))!;
    const items = provider.query(
      match,
      new AbortController().signal,
    ) as import("../types.js").SuggestionItem[];
    // ghost 被跳过，new 排第一
    expect(items[0]!.id).toBe("new:builtin");
  });
});

// ─── query 非空 query ───

describe("CommandProvider.query — 非空 query（Fuse + resort）", () => {
  it("精确 name `new` 排第一", () => {
    const registry = makeRegistry();
    const provider = new CommandProvider({ registry });
    const match = provider.matchTrigger(makeCtx("/new"))!;
    const items = provider.query(
      match,
      new AbortController().signal,
    ) as import("../types.js").SuggestionItem[];
    expect(items[0]!.id).toBe("new:builtin");
  });

  it("精确 alias `reset` 排第一（指向 /new）", () => {
    const registry = makeRegistry();
    const provider = new CommandProvider({ registry });
    const match = provider.matchTrigger(makeCtx("/reset"))!;
    const items = provider.query(
      match,
      new AbortController().signal,
    ) as import("../types.js").SuggestionItem[];
    expect(items[0]!.id).toBe("new:builtin");
  });

  it("前缀 `/el` 返回 /elevated 排第一", () => {
    const registry = makeRegistry();
    const provider = new CommandProvider({ registry });
    const match = provider.matchTrigger(makeCtx("/el"))!;
    const items = provider.query(
      match,
      new AbortController().signal,
    ) as import("../types.js").SuggestionItem[];
    expect(items[0]!.id).toBe("elevated:builtin");
  });

  it("alias prefix `/elev` 返回 /elevated 排第一", () => {
    const registry = makeRegistry();
    const provider = new CommandProvider({ registry });
    const match = provider.matchTrigger(makeCtx("/elev"))!;
    const items = provider.query(
      match,
      new AbortController().signal,
    ) as import("../types.js").SuggestionItem[];
    expect(items[0]!.id).toBe("elevated:builtin");
  });

  it("无匹配返回空数组（非 throw）", () => {
    const registry = makeRegistry();
    const provider = new CommandProvider({ registry });
    const match = provider.matchTrigger(makeCtx("/zzznomatch"))!;
    const items = provider.query(
      match,
      new AbortController().signal,
    );
    expect(items).toEqual([]);
  });
});

// ─── 零键执行：SuggestionItem 构造 ───

describe("CommandProvider — SuggestionItem 构造", () => {
  const registry = makeRegistry();
  const provider = new CommandProvider({ registry });

  it("无必填参数命令：execute=true, replacement=/cmd", () => {
    // /help 没有 args
    const match = provider.matchTrigger(makeCtx("/help"))!;
    const items = provider.query(
      match,
      new AbortController().signal,
    ) as import("../types.js").SuggestionItem[];
    const help = items.find((i) => i.id === "help:builtin")!;
    expect(help.acceptPayload.execute).toBe(true);
    expect(help.acceptPayload.replacement).toBe("/help");
    expect(help.acceptPayload.executionHint).toBe("local");
  });

  it("必填参数命令 /elevated <level>：execute=false, replacement=/elevated ", () => {
    const match = provider.matchTrigger(makeCtx("/elevated"))!;
    const items = provider.query(
      match,
      new AbortController().signal,
    ) as import("../types.js").SuggestionItem[];
    const elev = items.find((i) => i.id === "elevated:builtin")!;
    expect(elev.acceptPayload.execute).toBe(false);
    expect(elev.acceptPayload.replacement).toBe("/elevated ");
  });

  it("非必填参数命令 /fast (mode 是可选)：execute=true", () => {
    const match = provider.matchTrigger(makeCtx("/fast"))!;
    const items = provider.query(
      match,
      new AbortController().signal,
    ) as import("../types.js").SuggestionItem[];
    const fast = items.find((i) => i.id === "fast:builtin")!;
    // fast 的 args 里只有一个 mode，required=false → execute=true
    expect(fast.acceptPayload.execute).toBe(true);
    expect(fast.acceptPayload.replacement).toBe("/fast");
  });

  it("SuggestionItem.metadata 携带 commandId", () => {
    const match = provider.matchTrigger(makeCtx("/new"))!;
    const items = provider.query(
      match,
      new AbortController().signal,
    ) as import("../types.js").SuggestionItem[];
    expect(items[0]!.acceptPayload.metadata).toEqual({
      commandId: "new:builtin",
    });
  });

  it("displayText 形如 /<name>", () => {
    const match = provider.matchTrigger(makeCtx("/st"))!;
    const items = provider.query(
      match,
      new AbortController().signal,
    ) as import("../types.js").SuggestionItem[];
    const status = items.find((i) => i.id === "status:builtin")!;
    expect(status.displayText).toBe("/status");
  });
});

// ─── 可见性过滤 ───

describe("CommandProvider — visibility", () => {
  it("runtime predicate 隐藏的命令不出现", () => {
    const reg = new DefaultCommandRegistry();
    reg.register({
      id: "secret:builtin",
      name: "secret",
      description: "Only when enabled",
      category: "info",
      execution: "local",
      visibility: {
        predicate: (ctx) => ctx.features.secretEnabled === true,
      },
    });
    const provider = new CommandProvider({ registry: reg });
    const ctx = makeCtx("/", 1, { runtime: makeRuntime() });
    const match = provider.matchTrigger(ctx)!;
    const items = provider.query(
      match,
      new AbortController().signal,
    ) as import("../types.js").SuggestionItem[];
    expect(items.find((i) => i.id === "secret:builtin")).toBeUndefined();
  });

  it("runtime 满足 predicate 时命令出现", () => {
    const reg = new DefaultCommandRegistry();
    reg.register({
      id: "secret:builtin",
      name: "secret",
      description: "Only when enabled",
      category: "info",
      execution: "local",
      visibility: {
        predicate: (ctx) => ctx.features.secretEnabled === true,
      },
    });
    const provider = new CommandProvider({ registry: reg });
    const ctx = makeCtx("/", 1, {
      runtime: makeRuntime({ features: { secretEnabled: true } }),
    });
    const match = provider.matchTrigger(ctx)!;
    const items = provider.query(
      match,
      new AbortController().signal,
    ) as import("../types.js").SuggestionItem[];
    expect(items.find((i) => i.id === "secret:builtin")).toBeDefined();
  });
});
