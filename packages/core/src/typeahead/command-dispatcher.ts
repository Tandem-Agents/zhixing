/**
 * CommandDispatcher — slash 命令的执行分派器
 *
 * 收口"用户接受了一个命令 draft → 真正执行它"这一段。命令按 execution 分三档：
 *
 *   - local：纯本地动作，不产生 agent turn（如 /clear /help /status /exit）
 *     → handler 同步/异步执行，dispatcher 返回 `{ kind: "local-handled" }`，
 *       上层跳过本次 agent 调用、继续读下一行
 *   - agent：把整条 draft 当 user message 直接交给 agent loop（如动态技能）
 *     → dispatcher 不调 handler，返回 `{ kind: "agent-message", text: rawDraft }`
 *   - hybrid：先做本地副作用，再给 agent 发一条"用户刚刚做了 X"的 system message
 *     → handler 返回 `CommandHandlerResult`，dispatcher 包装成 `{ kind: "hybrid", systemMessage }`
 *
 * Handler 不进 `CommandDef`（那是可序列化的纯元数据，跨 target 共享）。Handler 由
 * dispatcher 持有一份 `Map<commandId, CommandHandler>`，各装配方（CLI / 未来渠道）在
 * bootstrap 时注册——命令元数据跨 target 共享、handler 在各 target 本地注入。
 *
 * 设计约束：
 *   1. dispatcher 不认识 readline / chalk / 任何渲染设施 —— UI 副作用由注册方在 handler 闭包里带
 *   2. 未知命令返回 `{ kind: "unknown" }`，提示文案由上层决定
 *   3. handler 抛异常被捕获并转成 `{ kind: "error" }`，不传染上层循环
 */

import type {
  CommandDef,
  CommandHandler,
  CommandHandlerContext,
  CommandHandlerResult,
  ICommandRegistry,
  RuntimeContext,
} from "./types.js";

// ─── 分派结果 ───

export type DispatchResult =
  /** 命令是 local，handler 已同步/异步执行；上层跳过 agent 调用 */
  | { readonly kind: "local-handled"; readonly summary?: string }
  /** 命令是 agent —— 把 rawInput 作为 user message 发给 agent loop */
  | { readonly kind: "agent-message"; readonly text: string }
  /** 命令是 hybrid —— 本地副作用已发生，把 systemMessage 发给 agent */
  | { readonly kind: "hybrid"; readonly systemMessage: string; readonly summary?: string }
  /** 未找到命令名（registry 里没有） */
  | { readonly kind: "unknown"; readonly commandName: string }
  /** Handler 抛异常 —— 已捕获 */
  | { readonly kind: "error"; readonly error: Error; readonly commandId: string }
  /** 命令存在但缺 handler（声明了却没注册执行体） */
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
   *   1. 解析命令名（去 `/`，按首个空白切第一个 token）
   *   2. 在 registry 里**精确按名字**找命令（包括 hidden —— 名字能召唤）
   *   3. 没找到 → `{ kind: "unknown" }`
   *   4. execution 是 "agent" → 直接返回 agent-message，不调 handler
   *   5. 缺 handler → `{ kind: "missing-handler" }`
   *   6. 跑 handler；catch 包成 error result
   *   7. 按 execution 包装最终结果
   */
  async dispatch(
    rawDraft: string,
    runtime: RuntimeContext,
  ): Promise<DispatchResult> {
    const trimmed = rawDraft.trimStart();
    if (!trimmed.startsWith("/")) {
      // 不是命令 —— 调用方不应把非 / 行喂进来，但保险一下
      return { kind: "agent-message", text: rawDraft };
    }

    const parsed = parseCommandInvocation(trimmed);
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
      systemMessage: result.systemMessage ?? `用户执行了 /${def.name}`,
      summary: result.summary,
    };
  }
}

// ─── 命令调用解析 ───

interface ParsedInvocation {
  readonly name: string;
  readonly rest: string;
  /** 剩余文本整体作为单个参数值放在 `_rest`，供 handler 自取 */
  readonly argMap: Readonly<Record<string, unknown>>;
}

/**
 * 把执行期的命令调用 `/cmd arg0 arg1 ...` 拆成命令名 + 剩余文本。
 *
 * 与同目录 `parse-command-draft.ts` 的 `parseCommandDraft` 职责不同、不可互换：
 *   - 本函数服务**执行分派** —— 按首个空白切命令名、剩余文本整体作参数，
 *     不感知光标，对任意输入都返回结果（非 / 行返回空 name）。
 *   - `parseCommandDraft` 服务**补全期** —— cursor-aware，定位"光标落在第几个参数"
 *     供 ArgumentProvider 用，命令名后无空白时返回 null。
 */
export function parseCommandInvocation(rawDraft: string): ParsedInvocation {
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
 * 在 registry 里按 name/alias 找命令。`findByName` 内部已处理 alias + hidden
 * （escape hatch：隐藏命令能通过名字被召唤），这里只做一层 null safety。
 */
function findCommandDef(
  registry: ICommandRegistry,
  name: string,
): CommandDef | null {
  if (!name) return null;
  return registry.findByName(name);
}
