/**
 * CommandDispatcher — slash 命令的执行分派
 *
 * 解决"用户接受了一个 typeahead 候选 → 真正去执行它"这一段。spec §9.2 把命令
 * 分成三档：
 *
 *   - **local**：纯本地动作，不产生 agent turn。e.g. /clear, /help, /status, /exit
 *     → handler 同步/异步执行，dispatcher 返回 `{ kind: "local-handled" }`，
 *       REPL 主循环跳过本次 agent 调用，继续读下一行
 *
 *   - **agent**：把整条 draft 当 user message 直接丢给 agent loop。e.g. /background
 *     → dispatcher 不调 handler，返回 `{ kind: "agent-message", text: rawDraft }`
 *
 *   - **hybrid**：先做本地副作用（清历史 / 切模型），再给 agent 发一条
 *     "用户刚刚做了 X" 的 system message。e.g. /new, /model
 *     → handler 返回 `CommandHandlerResult`，dispatcher 把 systemMessage 包装成
 *       `{ kind: "hybrid", systemMessage }`
 *
 * Handler 不在 CommandDef 里 —— 那是纯元数据。Handler 由本 dispatcher 持有
 * 一份 `Map<commandId, CommandHandler>`，REPL 在 bootstrap 时一次性注册。
 *
 * 设计原则：
 *   1. **dispatcher 不认识 readline / chalk** —— 上层 REPL 注入 handler 时再带 UI
 *   2. **未知命令** 返回 `{ kind: "unknown" }`，让上层决定提示文案
 *   3. **handler 抛异常** 被捕获并转成 `{ kind: "error", error }`，不传染主循环
 *   4. **rawInput 解析** 简化版：按空格切分，第一个 token 是命令名，剩余作为
 *      `rest` 字段。后续 Phase 2 Step 8 引入 ArgSchema 解析时再增强
 */

import type {
  CommandDef,
  CommandHandler,
  CommandHandlerContext,
  CommandHandlerResult,
  ICommandRegistry,
  RuntimeContext,
} from "@zhixing/core";

// ─── 分派结果 ───

export type DispatchResult =
  /** 命令是 local，handler 已同步/异步执行；REPL 跳过 agent 调用 */
  | { readonly kind: "local-handled"; readonly summary?: string }
  /** 命令是 agent —— 把 rawInput 作为 user message 发给 agent loop */
  | { readonly kind: "agent-message"; readonly text: string }
  /** 命令是 hybrid —— 本地副作用已发生，把 systemMessage 发给 agent */
  | { readonly kind: "hybrid"; readonly systemMessage: string; readonly summary?: string }
  /** 未找到命令名（builtin + 已注册 plugin 都没有） */
  | { readonly kind: "unknown"; readonly commandName: string }
  /** Handler 抛异常 —— 已捕获 */
  | { readonly kind: "error"; readonly error: Error; readonly commandId: string }
  /** 命令存在但缺 handler（spec 漏配置；rare） */
  | { readonly kind: "missing-handler"; readonly commandId: string };

// ─── Dispatcher 选项 ───

export interface CommandDispatcherOptions {
  readonly registry: ICommandRegistry;
  /** 可选的初始 handler 表 */
  readonly handlers?: ReadonlyMap<string, CommandHandler>;
}

// ─── 实现 ───

export class CommandDispatcher {
  private readonly registry: ICommandRegistry;
  private readonly handlers = new Map<string, CommandHandler>();

  constructor(options: CommandDispatcherOptions) {
    this.registry = options.registry;
    if (options.handlers) {
      for (const [id, h] of options.handlers) {
        this.handlers.set(id, h);
      }
    }
  }

  /** 注册或覆盖一个命令的 handler */
  registerHandler(commandId: string, handler: CommandHandler): void {
    this.handlers.set(commandId, handler);
  }

  /** 测试用：当前注册的 handler 数量 */
  get handlerCount(): number {
    return this.handlers.size;
  }

  /**
   * 主入口：分派一条 raw draft（含前导 `/`）。
   *
   * 流程：
   *   1. 解析命令名（去掉 `/`，按空白切第一个 token）
   *   2. 在 registry 里**精确按名字**找命令（包括 hidden —— 名字能召唤）
   *   3. 没找到 → `{ kind: "unknown" }`
   *   4. 找到但 execution 是 "agent" → 直接返回 agent-message
   *   5. 找到但缺 handler → `{ kind: "missing-handler" }`
   *   6. 跑 handler；catch 包成 error result
   *   7. 按 execution 包装最终结果
   */
  async dispatch(
    rawDraft: string,
    runtime: RuntimeContext,
  ): Promise<DispatchResult> {
    const trimmed = rawDraft.trimStart();
    if (!trimmed.startsWith("/")) {
      // 不是命令 —— 调用方不应该把非 / 行喂进来，但保险一下
      return { kind: "agent-message", text: rawDraft };
    }

    const parsed = parseCommandDraft(trimmed);
    const def = findCommandDef(this.registry, parsed.name);
    if (!def) {
      return { kind: "unknown", commandName: parsed.name };
    }

    // execution=agent：不调 handler
    if (def.execution === "agent") {
      return { kind: "agent-message", text: rawDraft };
    }

    const handler = this.handlers.get(def.id);
    if (!handler) {
      return { kind: "missing-handler", commandId: def.id };
    }

    let result: CommandHandlerResult;
    try {
      const ctx: CommandHandlerContext = {
        args: parsed.argMap,
        rawInput: rawDraft,
        runtime,
      };
      result = await Promise.resolve(handler(ctx));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return { kind: "error", error, commandId: def.id };
    }

    if (def.execution === "local") {
      return {
        kind: "local-handled",
        summary: result.summary,
      };
    }

    // hybrid：必须返回 systemMessage
    return {
      kind: "hybrid",
      systemMessage:
        result.systemMessage ?? `用户执行了 /${def.name}`,
      summary: result.summary,
    };
  }
}

// ─── 解析 ───

interface ParsedDraft {
  readonly name: string;
  readonly rest: string;
  /**
   * 简化版 args map —— Phase 1 只把所有剩余文本放到 `_rest` 字段。
   * Phase 2 Step 8 引入 ArgSchema 时会按位置/名称解析为 typed values。
   */
  readonly argMap: Readonly<Record<string, unknown>>;
}

/**
 * 把 `/cmd arg0 arg1 ...` 解析成 `{ name: "cmd", rest: "arg0 arg1" }`。
 * 别名 / hidden 命令的查找留给 `findCommandDef`。
 */
export function parseCommandDraft(rawDraft: string): ParsedDraft {
  const trimmed = rawDraft.trimStart();
  if (!trimmed.startsWith("/")) {
    return { name: "", rest: trimmed, argMap: { _rest: trimmed } };
  }
  // 去掉前导 "/"
  const body = trimmed.slice(1);
  const firstSpace = body.search(/\s/);
  let name: string;
  let rest: string;
  if (firstSpace === -1) {
    name = body;
    rest = "";
  } else {
    name = body.slice(0, firstSpace);
    rest = body.slice(firstSpace + 1).trim();
  }
  return {
    name,
    rest,
    argMap: { _rest: rest },
  };
}

/**
 * 在 registry 里按 name/alias 找命令。`findByName` 内部已经处理 alias +
 * hidden（escape hatch），我们只做一层 null safety。
 */
function findCommandDef(
  registry: ICommandRegistry,
  name: string,
): CommandDef | null {
  if (!name) return null;
  return registry.findByName(name);
}
