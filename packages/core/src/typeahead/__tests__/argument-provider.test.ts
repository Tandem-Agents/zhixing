/**
 * Step 8 单元测试 —— parseCommandDraft + progressiveHint + ArgumentProvider + Broker 集成
 *
 * 覆盖点：
 *   - parseCommandDraft: 命令解析 / 参数分词 / cursor 位置 / 边界情况
 *   - renderProgressiveHint: enum / text / boolean / number / async-enum
 *   - renderFullHintLine: 多参数 hint 行
 *   - ArgumentProvider.matchTrigger: 命令参数区触发 / 命令名区不触发 / 无 args 不触发
 *   - ArgumentProvider.query: 静态 enum 补全 + 前缀过滤
 *   - Broker 集成: argumentHint 填充
 */

import { describe, expect, it } from "vitest";
import { DefaultTypeaheadBroker } from "../broker.js";
import { parseCommandDraft } from "../parse-command-draft.js";
import {
  renderFullHintLine,
  renderProgressiveHint,
} from "../progressive-hint.js";
import { ArgumentProvider } from "../providers/argument-provider.js";
import { CommandProvider } from "../providers/command-provider.js";
import { DefaultCommandRegistry } from "../registry.js";
import type {
  ArgSchema,
  CommandDef,
  RuntimeContext,
  TriggerContext,
} from "../types.js";

// ─── 辅助 ───

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

function makeCtx(
  draft: string,
  cursor = draft.length,
): TriggerContext {
  return { draft, cursor, mode: "prompt", runtime: makeRuntime() };
}

function makeTestCommands(): CommandDef[] {
  return [
    {
      id: "elevated:test",
      name: "elevated",
      aliases: ["elev"],
      description: "切换高权限模式",
      category: "config",
      execution: "hybrid",
      tag: "builtin",
      args: [
        {
          kind: "enum" as const,
          name: "level",
          description: "elevated 等级",
          required: true,
          choices: [
            { value: "off", label: "off", description: "关闭高权限" },
            { value: "on", label: "on", description: "开启高权限" },
            { value: "ask", label: "ask", description: "每次单独确认" },
            { value: "full", label: "full", description: "完全绕过确认" },
          ],
        },
      ],
    },
    {
      id: "fast:test",
      name: "fast",
      description: "切换 fast 模式",
      category: "config",
      execution: "local",
      tag: "builtin",
      args: [
        {
          kind: "enum" as const,
          name: "mode",
          description: "fast 状态",
          required: false,
          choices: [
            { value: "status", label: "status" },
            { value: "on", label: "on" },
            { value: "off", label: "off" },
          ],
        },
      ],
    },
    {
      id: "help:test",
      name: "help",
      description: "显示帮助",
      category: "info",
      execution: "local",
      tag: "builtin",
      // 无 args
    },
  ];
}

function makeRegistry(): DefaultCommandRegistry {
  const reg = new DefaultCommandRegistry();
  for (const cmd of makeTestCommands()) reg.register(cmd);
  return reg;
}

// ─── parseCommandDraft ───

describe("parseCommandDraft", () => {
  it("基本解析：/elevated on", () => {
    const r = parseCommandDraft("/elevated on", 12);
    expect(r).not.toBeNull();
    expect(r!.commandName).toBe("elevated");
    expect(r!.argIndex).toBe(0);
    expect(r!.currentArgValue).toBe("on");
    expect(r!.args).toEqual(["on"]);
  });

  it("命令后空格，参数未开始：/elevated |", () => {
    const r = parseCommandDraft("/elevated ", 10);
    expect(r).not.toBeNull();
    expect(r!.commandName).toBe("elevated");
    expect(r!.argIndex).toBe(0);
    expect(r!.currentArgValue).toBe("");
  });

  it("多参数：/cmd arg0 arg1", () => {
    const r = parseCommandDraft("/cmd arg0 arg1", 14);
    expect(r).not.toBeNull();
    expect(r!.args).toEqual(["arg0", "arg1"]);
    expect(r!.argIndex).toBe(1);
    expect(r!.currentArgValue).toBe("arg1");
  });

  it("命令名未完成（无空格分隔）→ null", () => {
    const r = parseCommandDraft("/elev", 5);
    expect(r).toBeNull();
  });

  it("cursor 还在命令名上 → null", () => {
    const r = parseCommandDraft("/elevated on", 5);
    expect(r).toBeNull();
  });

  it("无 / 前缀 → null", () => {
    const r = parseCommandDraft("hello world", 11);
    expect(r).toBeNull();
  });

  it("空 draft → null", () => {
    const r = parseCommandDraft("", 0);
    expect(r).toBeNull();
  });

  it("前导空白后 /cmd → 正常解析", () => {
    const r = parseCommandDraft("  /cmd arg", 10);
    expect(r).not.toBeNull();
    expect(r!.commandName).toBe("cmd");
    expect(r!.currentArgValue).toBe("arg");
  });

  it("currentArgStart / currentArgEnd 定位正确", () => {
    // "/elevated on" → "on" 从位置 10 到 12
    const r = parseCommandDraft("/elevated on", 12);
    expect(r!.currentArgStart).toBe(10);
    expect(r!.currentArgEnd).toBe(12);
  });

  it("第二个参数的空值：/cmd val1 |", () => {
    const r = parseCommandDraft("/cmd val1 ", 10);
    expect(r).not.toBeNull();
    expect(r!.argIndex).toBe(1);
    expect(r!.currentArgValue).toBe("");
    expect(r!.currentArgStart).toBe(10);
    expect(r!.currentArgEnd).toBe(10);
  });
});

// ─── renderProgressiveHint ───

describe("renderProgressiveHint", () => {
  it("enum（required）", () => {
    const schema: ArgSchema = {
      kind: "enum",
      name: "level",
      description: "",
      required: true,
      choices: ["on", "off", "ask"],
    };
    expect(renderProgressiveHint(schema)).toBe("[level: on|off|ask]");
  });

  it("enum（optional → 名后加 ?）", () => {
    const schema: ArgSchema = {
      kind: "enum",
      name: "mode",
      description: "",
      required: false,
      choices: [
        { value: "on", label: "on" },
        { value: "off", label: "off" },
      ],
    };
    expect(renderProgressiveHint(schema)).toBe("[mode?: on|off]");
  });

  it("text", () => {
    const schema: ArgSchema = {
      kind: "text",
      name: "prompt",
      description: "",
      required: true,
      placeholder: "your prompt here",
    };
    expect(renderProgressiveHint(schema)).toBe(
      "[prompt: your prompt here]",
    );
  });

  it("boolean", () => {
    const schema: ArgSchema = {
      kind: "boolean",
      name: "enabled",
      description: "",
      required: true,
    };
    expect(renderProgressiveHint(schema)).toBe("[enabled: true|false]");
  });

  it("number with range", () => {
    const schema: ArgSchema = {
      kind: "number",
      name: "depth",
      description: "",
      required: true,
      min: 1,
      max: 10,
    };
    expect(renderProgressiveHint(schema)).toBe("[depth: number (1-10)]");
  });

  it("async-enum", () => {
    const schema: ArgSchema = {
      kind: "async-enum",
      name: "model",
      description: "",
      required: true,
      provider: { list: async () => [] },
    };
    expect(renderProgressiveHint(schema)).toBe("[model: …]");
  });
});

// ─── renderFullHintLine ───

describe("renderFullHintLine", () => {
  it("第一个参数高亮，后续参数也显示", () => {
    const schemas: ArgSchema[] = [
      { kind: "enum", name: "level", description: "", required: true, choices: ["on", "off"] },
      { kind: "text", name: "note", description: "", required: false },
    ];
    const line = renderFullHintLine(schemas, 0);
    expect(line).toBe("[level: on|off] · [note?: text]");
  });

  it("第一个参数已填充（✓），第二个高亮", () => {
    const schemas: ArgSchema[] = [
      { kind: "enum", name: "level", description: "", required: true, choices: ["on", "off"] },
      { kind: "text", name: "note", description: "", required: false },
    ];
    const line = renderFullHintLine(schemas, 1);
    expect(line).toBe("✓ level · [note?: text]");
  });
});

// ─── ArgumentProvider.matchTrigger ───

describe("ArgumentProvider.matchTrigger", () => {
  const registry = makeRegistry();
  const provider = new ArgumentProvider({ registry });

  it("命令参数区触发：/elevated on", () => {
    const m = provider.matchTrigger(makeCtx("/elevated on"));
    expect(m).not.toBeNull();
    expect(m!.providerId).toBe("argument");
    expect(m!.query).toBe("on");
  });

  it("命令参数区空值触发：/elevated |", () => {
    const m = provider.matchTrigger(makeCtx("/elevated "));
    expect(m).not.toBeNull();
    expect(m!.query).toBe("");
  });

  it("命令名区不触发（让 CommandProvider 处理）", () => {
    const m = provider.matchTrigger(makeCtx("/elev"));
    expect(m).toBeNull();
  });

  it("无 args 的命令不触发", () => {
    const m = provider.matchTrigger(makeCtx("/help "));
    expect(m).toBeNull();
  });

  it("不存在的命令不触发", () => {
    const m = provider.matchTrigger(makeCtx("/nonexistent "));
    expect(m).toBeNull();
  });

  it("argIndex 超出 schema 范围不触发", () => {
    // elevated 只有 1 个 arg，输入第二个 → 不触发
    const m = provider.matchTrigger(makeCtx("/elevated on extra"));
    expect(m).toBeNull();
  });
});

// ─── ArgumentProvider.query ───

describe("ArgumentProvider.query", () => {
  const registry = makeRegistry();
  const provider = new ArgumentProvider({ registry });
  const noAbort = () => new AbortController().signal;

  it("enum 全部候选（空 query）", () => {
    const match = provider.matchTrigger(makeCtx("/elevated "))!;
    const items = provider.query(match, noAbort()) as import("../types.js").SuggestionItem[];

    expect(items.length).toBe(4);
    expect(items.map((i) => i.displayText)).toEqual([
      "off",
      "on",
      "ask",
      "full",
    ]);
  });

  it("enum 前缀过滤", () => {
    const match = provider.matchTrigger(makeCtx("/elevated o"))!;
    const items = provider.query(match, noAbort()) as import("../types.js").SuggestionItem[];

    expect(items.length).toBe(2);
    expect(items.map((i) => i.displayText)).toEqual(["off", "on"]);
  });

  it("最后一个参数 → execute=true", () => {
    const match = provider.matchTrigger(makeCtx("/elevated "))!;
    const items = provider.query(match, noAbort()) as import("../types.js").SuggestionItem[];

    expect(items[0]!.acceptPayload.execute).toBe(true);
  });

  it("无候选（text 参数）→ 空列表", () => {
    // 构造一个有 text 参数的命令
    const reg2 = new DefaultCommandRegistry();
    reg2.register({
      id: "bg:test",
      name: "background",
      description: "后台运行",
      category: "tools",
      execution: "agent",
      tag: "builtin",
      args: [
        {
          kind: "text",
          name: "prompt",
          description: "提示词",
          required: true,
        },
      ],
    });
    const prov2 = new ArgumentProvider({ registry: reg2 });

    const match = prov2.matchTrigger(makeCtx("/background hello"))!;
    expect(match).not.toBeNull();
    const items = prov2.query(match, noAbort()) as import("../types.js").SuggestionItem[];
    expect(items.length).toBe(0);
  });

  it("acceptPayload.metadata 包含命令和参数信息", () => {
    const match = provider.matchTrigger(makeCtx("/elevated o"))!;
    const items = provider.query(match, noAbort()) as import("../types.js").SuggestionItem[];

    const meta = items[0]!.acceptPayload.metadata as Record<string, unknown>;
    expect(meta.commandId).toBe("elevated:test");
    expect(meta.argName).toBe("level");
    expect(meta.argValue).toBe("off");
  });
});

// ─── ArgumentProvider.computeArgumentHint ───

describe("ArgumentProvider.computeArgumentHint", () => {
  const registry = makeRegistry();
  const provider = new ArgumentProvider({ registry });

  it("返回 progressive hint", () => {
    const match = provider.matchTrigger(makeCtx("/elevated "))!;
    const hint = provider.computeArgumentHint(match);
    expect(hint).not.toBeNull();
    expect(hint!.argIndex).toBe(0);
    expect(hint!.renderedHint).toContain("level");
    expect(hint!.renderedHint).toContain("off|on|ask|full");
  });
});

// ─── Broker 集成 ───

describe("Broker + ArgumentProvider 集成", () => {
  it("命令参数区 → argumentHint 被填充", () => {
    const registry = makeRegistry();
    const broker = new DefaultTypeaheadBroker();
    broker.register(new CommandProvider({ registry }));
    broker.register(new ArgumentProvider({ registry }));

    const session = broker.beginSession(makeCtx("/elevated "));
    const state = broker.getState(session.id);

    expect(state).not.toBeNull();
    expect(state!.activeProvider?.id).toBe("argument");
    expect(state!.argumentHint).not.toBeNull();
    expect(state!.argumentHint!.renderedHint).toContain("level");
    expect(state!.suggestions.length).toBe(4);
  });

  it("命令名区 → CommandProvider 处理，无 argumentHint", () => {
    const registry = makeRegistry();
    const broker = new DefaultTypeaheadBroker();
    broker.register(new CommandProvider({ registry }));
    broker.register(new ArgumentProvider({ registry }));

    const session = broker.beginSession(makeCtx("/elev"));
    const state = broker.getState(session.id);

    expect(state!.activeProvider?.id).toBe("command");
    expect(state!.argumentHint).toBeNull();
  });

  it("accept 参数后 draft 更新正确", () => {
    const registry = makeRegistry();
    const broker = new DefaultTypeaheadBroker();
    broker.register(new CommandProvider({ registry }));
    broker.register(new ArgumentProvider({ registry }));

    const session = broker.beginSession(makeCtx("/elevated "));
    const state = broker.getState(session.id)!;
    const item = state.suggestions[1]!; // "on"

    const result = broker.accept(session.id, item);
    expect(result).not.toBeNull();
    expect(result!.newDraft).toBe("/elevated on");
    expect(result!.execute).toBe(true);
  });
});
