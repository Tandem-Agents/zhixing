/**
 * 子 agent loop 薄封装 —— 直接驱动 core agent-loop,不走 createAgentRuntime 重型装配
 *
 * 职责边界(只做 4 件事):
 *   1. wallClockTimeoutMs / maxTokens 两路软上限通过外置 AbortController.signal 注入,
 *      与 parentSignal 一起作为 loop 的多路独立中断源(loop 内部 abort 后,本层用
 *      单一 first-wins 槽位记录触发来源,折成结构化 budgetExceededKind 字段)
 *   2. 子工具用 createSecureExecuteTool 包装,走共享 SecurityPipeline + 子 broker;
 *      与主 agent secure-executor 装配方式一致,审计 / 权限规则共用
 *   3. 用 trackMessages 把 agent yields 累积成完整 messages 数组,折叠成
 *      SubAgentLoopResult 返回给 runChildAgent
 *   4. 软上限触发归类:三类 budget 触发(max_turns / max_tokens / wall_clock)统一用
 *      budgetExceededKind 表达,classifier / deriveErrorMeta 据此折成 status="failed" +
 *      对应 error.type;真正的 abort(idle-timeout / parent-abort / user-cancel)仍走
 *      reason="aborted" 通道,classifier 折成 status="aborted"
 *
 * 不做的事:
 *   - 不创建 EventBus / Broker(由 runChildAgent 注入)
 *   - 不构建 system prompt(由 runChildAgent 调 buildSystemPrompt 后透传)
 *   - 不分类结果(三态 status 由 runChildAgent + result-classifier 折叠)
 *   - 不拼装初始 user message(由 runChildAgent 注入)
 *
 * 异常约定:
 *   - 不主动 throw —— LLM/tool 异常走 AgentResult.reason="error";
 *     parent abort / wallClock / maxTokens 走 reason="aborted" + 对应 abortReason.kind
 *   - 仅 setTimeout / pipeline 装配等基础设施异常会泡出去,由 runChildAgent
 *     的 try/catch 兜底转 status="failed"
 *
 * 资源契约(finally 硬约束 —— 任一漏清理都会跨 dispatch 累积):
 *   - clearTimeout(wallClockTimer):防止句柄阻止进程退出
 *   - eventBus.off("llm:request_end", usageListener):防止 listener 跨 dispatch 累积
 *
 * maxTokens 软上限触发协议(graceful,不 mid-call kill):
 *   1. eventBus 监听 llm:request_end,每次 LLM call 完成后累加 usage.inputTokens +
 *      outputTokens(cache 字段不计 —— budget 监控的是"实际消耗",cache hit 不算)
 *   2. 累计超 maxTokens 阈值时,first-wins 写入 abortBudgetKind 槽位 + abortWithReason
 *      on maxTokensController(已被前序 budget 抢占则 abort 仍幂等触发,但不覆盖槽位)
 *   3. abort 在当前 LLM call 完成后、下一次 call 启动前的微任务序列中 set
 *      (EventBus emit 同步串行 await listener,listener 设 abort 同步完成),loop 内
 *      下一次 turn 顶 abort guard 立即停
 *   4. drain 后由 abortBudgetKind 槽位直接给出 kind —— 槽位的 first-wins 语义与
 *      AbortController first-wins 完全对齐,跨模块边界无字符串解析债务
 *
 * first-wins 槽位语义(abortBudgetKind):
 *   - 单一槽位,容纳 abort 通道触发的两类 budget kind(max_tokens / wall_clock)
 *   - 触发现场用 `if (slot === null) slot = kind` 表达"先到先得",与 abort signal
 *     first-wins 同款语义(理论 race 中两路同时触发以"先入槽"为准,无后置静态优先级歧义)
 *   - max_turns 不走 abort 通道(loop 内置 reason="max_turns"),不占用本槽位
 */

import {
  abortWithReason,
  drainAgentLoop,
  type AbortReason,
  type AgentErrorType,
  type AgentEventMap,
  type AgentResult,
  type EventBus,
  type IConfirmationBroker,
  type LLMProvider,
  type LLMRoles,
  type Message,
  type ResolvedRoleThinking,
  type SecurityPipeline,
  type TokenUsage,
  type ToolDefinition,
  type ToolResultBlock,
  type WatchdogPolicy,
} from "@zhixing/core";
import { createSecureExecuteTool } from "../security/secure-executor.js";
import { trackMessages } from "../runtime/track-messages.js";
import type { BudgetExceededKind } from "./budget.js";

// ─── 公共类型 ───

export interface SubAgentLoopResult {
  /** 完整 conversation messages —— 含初始注入消息 + 所有 LLM/tool 累积 */
  messages: Message[];
  /** 累计 token usage(来自 AgentResult.usage) */
  usage: TokenUsage;
  /**
   * 软上限触发种类 —— 四类触发统一建模(max_turns / max_tokens / wall_clock /
   * context_overflow);触发时填对应 kind,否则 undefined;classifier 据此折成
   * status="failed"。
   *
   * 与 reason 字段的关系:
   *   - reason="max_turns" → budgetExceededKind="max_turns"(loop 内置,不走 abort 通道)
   *   - reason="aborted" + first-wins 槽位 abortBudgetKind="max_tokens" → budgetExceededKind="max_tokens"
   *   - reason="aborted" + first-wins 槽位 abortBudgetKind="wall_clock" → budgetExceededKind="wall_clock"
   *   - reason="aborted" + first-wins 槽位 abortBudgetKind="context_overflow" → budgetExceededKind="context_overflow"
   *   - 其他(completed / error / 真正的 abort 如 parent-abort/idle-timeout) → undefined
   */
  budgetExceededKind?: BudgetExceededKind;
  /** tool 调用次数(由 yields 中 tool_end 计数) */
  toolUseCount: number;
  /** AgentResult 终止原因 —— completed / max_turns / aborted / error */
  reason: AgentResult["reason"];
  /** abort 透传(reason="aborted" 时由 AgentResult.aborted.abortReason 取) */
  abortReason?: AbortReason;
  /**
   * AgentError 透传(仅 reason="error" 时填充) —— 携带 AgentError.type 与
   * AgentError.message,让上层 ChildAgentResult.error 暴露真实诊断信息(如
   * "provider_error: 400 invalid_request_error: ..."),而非"agent_error"占位。
   *
   * 扁平 dict 形态(非 AgentError 实例):跨模块边界 plain object 更清洁,
   * 与 ChildAgentResult.error 形态对称,且持久化(transcript jsonl)无 Error.stack
   * 噪声。recoverable / cause 字段子 agent 路径不消费,故不透传。
   */
  error?: { type: AgentErrorType; message: string };
}

export interface RunSubAgentLoopOptions {
  /** 由 runChildAgent 调 buildSystemPrompt 装配好的 system prompt 文本 */
  systemPrompt: string;
  /**
   * 初始消息列表(通常是 runChildAgent 注入的单条 "Begin..." user message);
   * 该数组**不被本函数修改**,新累积的消息走返回值 messages
   */
  messages: Message[];
  /** 已按 sub-agent profile.enabledTools 过滤后的子工具列表 */
  tools: readonly ToolDefinition[];
  /** 共享父 LLMProvider 实例(连接池 / 限速 / 缓存共用) */
  provider: LLMProvider;
  /** 共享父 model id */
  model: string;
  /**
   * 各角色生效思考控制（装配期已校验兜底）—— 子整体继承父：子 loop 复用父
   * main provider+model 故用 roleThinking.main 作 loop 参数，子工具调
   * light/power 时由 ctx.roleThinking 取对应角色。缺省 = 不发思考参数。
   */
  roleThinking?: ResolvedRoleThinking;
  /** 共享父 LLMRoles —— 工具调 light/power 角色时透传 */
  llmRoles: LLMRoles;
  /** 共享父 SecurityPipeline 实例(权限规则 / boundary registry 跨 agent 共用) */
  securityPipeline: SecurityPipeline;
  /** 子 confirmation broker —— 与父 broker 隔离,默认 fail-deny resolver */
  confirmationBroker: IConfirmationBroker;
  /**
   * 子 EventBus —— 由 runChildAgent 调 createEventBus({ parent, lineage })
   * 派生,本函数仅作为透传 slot 给 runAgentLoop;
   * 与 parentBus 同型(EventBus 类),保证子内若再嵌套孙子时类型链一致。
   */
  eventBus: EventBus<AgentEventMap>;
  /**
   * 父级 abort signal —— runAgentLoop 内部 createInterruptController({ parent })
   * 派生 child controller 并自动注入 parent-abort kind,无需本函数手工 fork。
   */
  parentSignal: AbortSignal;
  /** loop 最大交互轮次,达到后 reason="max_turns" */
  maxTurns: number;
  /**
   * 累计 token 软上限 —— 每次 llm:request_end 累加 inputTokens+outputTokens,
   * 超阈则 abort with origin="subagent-max-tokens-exceeded"(graceful,不 mid-call kill);
   * cache 字段不计入(budget 监控的是实际消耗,prompt cache 命中不算钱)
   */
  maxTokens: number;
  /**
   * 单次 input tokens 注意力风险阈值 —— 从 ModelCapability.riskMaxTokens 解析。
   *
   * 与 maxTokens 的区别:
   *   - maxTokens 累加 input+output 监控**总成本**(用户配置 budget)
   *   - riskMaxTokens 检查**单次 inputTokens**监控**注意力质量**(模型固有阈值)
   *
   * 触发时机:每次 llm:request_end 后,若 payload.usage.inputTokens > riskMaxTokens
   * 则 first-wins 写槽位 "context_overflow" + abort with origin。下次 turn 不启动。
   * 主 LLM 收到 ChildAgentResult { status:"failed", error.type:"sub_agent_context_overflow" }
   * 后自主决策切分子任务。
   */
  riskMaxTokens: number;
  /** stream 看门狗策略,缺省时 runAgentLoop 内部走 DEFAULT_WATCHDOG_POLICY */
  watchdog: WatchdogPolicy;
  /** wall-clock 总超时(ms) —— 触发后 abort with origin="subagent-wall-clock-timeout" */
  wallClockTimeoutMs: number;
  /** 工具执行的工作目录,缺省 process.cwd() */
  workingDirectory?: string;
}

// ─── 实现 ───

export async function runSubAgentLoop(
  opts: RunSubAgentLoopOptions,
): Promise<SubAgentLoopResult> {
  // wall-clock + maxTokens + context_overflow 三路软上限通过独立 AbortController 注入,
  // 用单一 first-wins 槽位 abortBudgetKind 记录"哪个 budget kind 先触发"—— 与 AbortController
  // first-wins 语义对齐(任一 controller 先 abort 即决定 abortReason),槽位"先入为主"决定
  // budgetExceededKind,无后置静态优先级歧义,跨模块边界无字符串解析债务。
  // 三个 controller 用 AbortSignal.any 合成单一 signal 透传给 loop 的 abortSignal 入参
  // (loop 视为 external kind)。
  //
  // 选择独立 controller(不复用 maxTokensController)是为了 origin 字符串清晰对应
  // 触发源 —— observability 路径(audit log / event 重放)按 origin 反查触发原因
  // 不需要交叉解析 budgetExceededKind 槽位。
  const wallClockController = new AbortController();
  const maxTokensController = new AbortController();
  const contextOverflowController = new AbortController();
  // abort 通道触发的 budget kind 槽位 —— 容纳 max_tokens / wall_clock / context_overflow
  // 三类(max_turns 不走 abort 通道,由 loop 内置 reason 直给)。null 表示"abort 通道
  // 无 budget 触发"(例如 parent-abort / idle-timeout / completed 路径)。
  let abortBudgetKind:
    | "max_tokens"
    | "wall_clock"
    | "context_overflow"
    | null = null;

  const wallClockTimer = setTimeout(() => {
    if (abortBudgetKind === null) abortBudgetKind = "wall_clock";
    abortWithReason(wallClockController, {
      kind: "external",
      origin: "subagent-wall-clock-timeout",
    });
  }, opts.wallClockTimeoutMs);

  // usageListener 监听 llm:request_end 同步检查两类软上限:
  //
  //   1. maxTokens(成本): 累加 inputTokens+outputTokens 监控总消耗
  //      —— cache 字段不计入(prompt cache 命中是节省的部分,把它算进 budget 会让
  //      "用户对成本的直觉"和"实际触发软上限的时机"错配)
  //
  //   2. context_overflow(质量): 检查单次 inputTokens 监控注意力风险阈值
  //      —— sub-task prompt 累积超 riskMaxTokens 说明任务过大,继续执行会触发 attention
  //      稀释致 LLM 响应质量下降; graceful 中止,主 LLM 收到 error.type 后自主决策切片
  //
  // EventBus emit 串行 await listener,listener 是 sync 函数 await 立即 resolve,
  // emit 完成时 abort 已 set,loop 下一次 turn 顶 abort guard 立即停。
  //
  // 检查顺序:成本类先于质量类 —— 历史不变量(成本类触发原本独占槽位)。两路条件可同时
  // 满足时按 first-wins 槽位写入决定 kind,无后置仲裁歧义。
  let cumulativeTokens = 0;
  // listener payload 直接 deref AgentEventMap —— 与 EventBus 契约同步演进,
  // event 形状变化(新增 usage 子字段等)由 TypeScript 强制检查可见。
  const usageListener = (
    payload: AgentEventMap["llm:request_end"],
  ): void => {
    cumulativeTokens += payload.usage.inputTokens + payload.usage.outputTokens;
    if (cumulativeTokens > opts.maxTokens) {
      // first-wins:仅当槽位为空才占位 —— 若已被其他 budget 抢占,本路 abort 仍幂等触发
      // (但 budgetExceededKind 维持已写入值,反映真正的首发触发源)
      if (abortBudgetKind === null) abortBudgetKind = "max_tokens";
      abortWithReason(maxTokensController, {
        kind: "external",
        origin: "subagent-max-tokens-exceeded",
      });
    }
    if (payload.usage.inputTokens > opts.riskMaxTokens) {
      if (abortBudgetKind === null) abortBudgetKind = "context_overflow";
      abortWithReason(contextOverflowController, {
        kind: "external",
        origin: "subagent-context-overflow",
      });
    }
  };
  opts.eventBus.on("llm:request_end", usageListener);

  // AbortSignal.any 合并三路信号 —— Node ≥22 稳定,本仓库 engines.node:">=22.0.0";
  // 子 loop 拿到的 abortSignal 是合并 signal,任一软上限触发都让它 aborted。
  const externalAbortSignal = AbortSignal.any([
    wallClockController.signal,
    maxTokensController.signal,
    contextOverflowController.signal,
  ]);

  try {
    // 子工具走共享 pipeline + 子 broker —— 与主 agent secure-executor 装配
    // 模式一致;sessionType 子默认 "ci"(无 listener 自动 fail-deny,与子
    // broker 默认 resolver 语义对齐;主路径仍按 stdin TTY 检测)
    const secureExecuteTool = createSecureExecuteTool({
      pipeline: opts.securityPipeline,
      originalExecute: (tool, input, ctx) => tool.call(input, ctx),
      broker: opts.confirmationBroker,
      sessionType: "ci",
    });

    // drain yields + 终止 result —— drainAgentLoop 收集所有 yield 直到 done
    const { yields, result } = await drainAgentLoop({
      provider: opts.provider,
      model: opts.model,
      // 子 loop 走 roles.main 单 model → loop 思考参数取 roleThinking.main；
      // roleThinking 整体下传供子工具按所用角色取（如 WebFetch 蒸馏走 light）。
      thinking: opts.roleThinking?.main,
      roleThinking: opts.roleThinking,
      tools: [...opts.tools],
      messages: opts.messages,
      systemPrompt: opts.systemPrompt,
      eventBus: opts.eventBus,
      parentSignal: opts.parentSignal,
      abortSignal: externalAbortSignal,
      watchdog: opts.watchdog,
      maxTurns: opts.maxTurns,
      llmRoles: opts.llmRoles,
      workingDirectory: opts.workingDirectory,
      deps: {
        executeTool: secureExecuteTool,
      },
    });

    // 用 trackMessages 累积 yields → newMessages,与主 agent run() 同语义,
    // 保证子 transcript 与主 transcript 形状一致(主子未来若复用同一 sink 时不漂移)
    const newMessages: Message[] = [];
    const pendingToolResults: ToolResultBlock[] = [];
    let toolUseCount = 0;
    for (const evt of yields) {
      if (evt.type === "tool_end") toolUseCount++;
      trackMessages(evt, newMessages, pendingToolResults);
    }

    return {
      messages: [...opts.messages, ...newMessages],
      usage: result.usage,
      toolUseCount,
      reason: result.reason,
      budgetExceededKind: deriveBudgetExceededKind(result.reason, abortBudgetKind),
      abortReason:
        result.reason === "aborted" ? result.abortReason : undefined,
      error:
        result.reason === "error"
          ? { type: result.error.type, message: result.error.message }
          : undefined,
    };
  } finally {
    // listener 与 timer 双清理 —— 任一漏掉都会跨 dispatch 累积资源:
    //   - usageListener 不解绑:listener Map 仍持有 closure 引用(cumulativeTokens /
    //     abortBudgetKind / maxTokensController 等子状态),阻止 GC 回收子 dispatch
    //     的整个状态闭包;若 opts.eventBus 是被复用的引用,后续事件还会驱动废弃 closure
    //   - wallClockTimer 不 clear:active timer 句柄阻止进程退出 + callback 在子 dispatch
    //     结束后仍可能 fire,操作已无意义的 controller
    opts.eventBus.off("llm:request_end", usageListener);
    clearTimeout(wallClockTimer);
  }
}

/**
 * 折叠三类 budget 触发为 BudgetExceededKind —— 用 first-wins 槽位(而非解析
 * abortReason.origin 字符串)区分 abort 来源,让上层 classifier / deriveErrorMeta
 * 拿到结构化字段做映射,跨模块边界不依赖字符串契约。
 *
 * 折叠规则(纯函数,无优先级歧义):
 *   - reason="max_turns"       → "max_turns"(loop 内置,不走 abort 通道,优先于槽位)
 *   - reason="aborted" + 槽位非 null → 槽位值(first-wins 已由触发现场决定)
 *   - 其他 → undefined(completed / error / 真正的 abort 如 parent-abort/idle-timeout,
 *           槽位仍为 null)
 *
 * 关键:本函数不做"哪个 budget kind 优先"的判断 —— 决定权在 trigger 现场的
 * `if (abortBudgetKind === null) abortBudgetKind = kind` 语句,与 AbortController
 * 的 first-wins 完全对齐。
 *
 * @internal 暴露用于纯函数 unit test —— first-wins race 集成测试在物理时序上
 * 难以稳定构造(stream race abort 让 emit usage 接近 0,wallClock fire 与 emit
 * 都在 ms 量级),纯函数真值表测试是更可靠的契约锁。
 */
export function deriveBudgetExceededKind(
  reason: AgentResult["reason"],
  abortBudgetKind:
    | "max_tokens"
    | "wall_clock"
    | "context_overflow"
    | null,
): BudgetExceededKind | undefined {
  if (reason === "max_turns") return "max_turns";
  if (reason === "aborted" && abortBudgetKind !== null) return abortBudgetKind;
  return undefined;
}
