/**
 * runChildAgent —— 子 agent dispatch 主入口
 *
 * 单一不变量:无论装配 / 运行 / 分类哪一阶段出问题,本函数**绝不抛异常**,
 * 始终返回 ChildAgentResult 三态之一(completed / failed / aborted)。
 * Task 工具据此把结果转成 ToolResult,主 LLM 永远看到结构化 tool_result
 * 而非 unhandled exception。
 *
 * 阶段化执行(每阶段独立 try/catch):
 *   1. 装配子原语:lineage 派生 / EventBus 派生 / Broker 创建 /
 *      tools 过滤 / system prompt 装配
 *   2. 跑子 loop:用 ALS 注入 child run context,再调 runSubAgentLoop
 *   3. cleanup discipline:无论 happy / failed,finally 块清理 bus listener
 *      与 broker pending(防 listener 跨 dispatch 累积 / pending 永远悬挂)
 *   4. 折叠 ChildAgentResult:把 SubAgentLoopResult / caughtError 用
 *      classifyResult / extractFinalAssistantText 折成三态
 *
 * 顶层兜底 try/catch:任何阶段意外漏掉的 throw,最外层捕获转 failed —
 * defense-in-depth,理论上不触发,但保证 INV 在编译期可被静态推理。
 */

import { randomUUID } from "node:crypto";
import {
  ConfirmationBroker,
  createEventBus,
  emptyUsage,
  type AbortReason,
  type AgentErrorType,
  type AgentEventMap,
  type EventBus,
  type IConfirmationBroker,
  type LLMProvider,
  type LLMRoles,
  type Message,
  type ResolvedRoleThinking,
  type SecurityPipeline,
  type TokenUsage,
  type ToolDefinition,
} from "@zhixing/core";
import { buildSystemPrompt, SUB_AGENT_SEGMENTS } from "../runtime/system-prompt.js";
import { runContextStorage } from "../runtime/run-context.js";
import { subAgentProfile } from "../profile/default-profiles.js";
import { resolveSubAgentResolver } from "../confirmation/child-broker.js";
import { deriveChildLineage } from "./lineage.js";
import { resolveSubAgentBudget, type SubAgentBudget } from "./budget.js";
import {
  classifyResult,
  extractFinalAssistantText,
  extractPartialText,
} from "./result-classifier.js";
import { runSubAgentLoop, type SubAgentLoopResult } from "./loop-runner.js";

// ─── 公共类型 ───

/**
 * 子 agent 失败的结构化错误类型。
 *
 * 两类来源合并为单一联合,让 ChildAgentResult.error.type 字段编译期可枚举,
 * 避免散落字符串字面量(添加新 type 时编译器强制更新所有匹配点):
 *
 *   1. **透传 AgentErrorType**:sub-agent 内部 LLM / tool 错误经 agent-loop
 *      转成 AgentError, loop-runner 透传 type+message 字段, factory 在 reason="error"
 *      时直接采用——例如 "provider_error" / "context_overflow" / "rate_limit"
 *
 *   2. **sub-agent 路径专属 type**:budget 软上限触发 + loop 基础设施崩 + 装配阶段
 *      失败 + 永不抛兜底,这些不来自 AgentError 而是 factory 自己生成的:
 *        - max_turns_exceeded / max_tokens_exceeded / wall_clock_timeout:三类
 *          budget 软上限触发(factory.deriveErrorMeta 从 budgetExceededKind 映射)
 *        - sub_agent_context_overflow:单次 inputTokens 注意力风险阈值触发
 *        - loop_error:runSubAgentLoop 基础设施崩(catchError 路径,极少见)
 *        - assembly_error:子原语装配阶段失败(EventBus / Broker / SystemPrompt
 *          构造抛错)
 *        - unexpected_error:runChildAgentInner 顶层兜底 catch(理论不可达)
 *        - unknown_error:reason="error" 但 runResult.error 透传缺失(Layer 1
 *          字段透传 bug 的 last-resort 占位,理论不可达)
 *
 * 主 LLM 收到该 type 后据此自主决策:rate_limit → 重试 / 等待;context_overflow →
 * 切片子任务;max_turns_exceeded → 调高 budget 或拆任务;auth → 提示用户检查配置等。
 */
export type SubAgentErrorType =
  | AgentErrorType
  | "max_turns_exceeded"
  | "max_tokens_exceeded"
  | "wall_clock_timeout"
  | "sub_agent_context_overflow"
  | "loop_error"
  | "assembly_error"
  | "unexpected_error"
  | "unknown_error";

export interface RunChildAgentOptions {
  /** 共享父 LLMProvider 实例(连接池 / 限速 / 缓存共用,避免每次重建) */
  provider: LLMProvider;
  /** 共享父 model id —— 子复用父模型,不支持单独 override */
  model: string;
  /**
   * 各角色生效思考控制 —— 子整体继承父：子 loop 复用父 main provider+model
   * 用 roleThinking.main，子工具调对应角色用对应配置。缺省 = 不发思考参数。
   */
  roleThinking?: ResolvedRoleThinking;
  /** 共享父 LLMRoles —— 工具调 light/power 角色时透传 */
  llmRoles: LLMRoles;
  /** 共享父 SecurityPipeline 实例 —— 权限规则 / boundary registry 跨 agent 共用 */
  securityPipeline: SecurityPipeline;
  /** 工作区路径(透传 buildSystemPrompt;null 表示无工作区) */
  workspace: string | null;
  /** 工作区来源标识(cli / directory-config / global-config / cwd-fallback) */
  workspaceSource?: string;
  /** 全局配置文件路径(可选,用于 environment 段渲染) */
  globalConfigPath?: string;
  /**
   * 父级 EventBus —— 子 bus 通过 createEventBus({ parent, lineage }) 派生,
   * 父订阅者按 meta.lineage 过滤可看到全部子事件。EventBus 类(不是
   * IEventBus 接口):createEventBus 的 parent 字段在实现层依赖类内部
   * emitFromChild 私有通道,接口类型无法承载该契约。
   */
  parentBus: EventBus<AgentEventMap>;
  /** 父级 lineage 路径(主 root 为 "main"),子 lineage 在此基础上 derive */
  parentLineage: string;
  /**
   * 父级 ConfirmationBroker —— 用于审计血缘(透传 parentBroker.id 给 child broker
   * 作为 parentBrokerId 元信息),让审计层按 parent/child id 重建调用链。
   *
   * 子 broker 不读父 broker 的实际状态(无 listener 透传 / 无 pending 共享),
   * 只引用其 id 字段。父 broker 装配方式(eventBus / resolver 等)对子 broker 行为零影响。
   */
  parentBroker: IConfirmationBroker;
  /** 父级工具集 —— 子工具按 sub-agent profile.enabledTools 过滤后从此派生 */
  parentTools: readonly ToolDefinition[];
  /**
   * 父级 abort signal —— 父打断时 runAgentLoop 内部 createInterruptController
   * 派生 child controller 自动注入 parent-abort kind,无需本函数手工 fork
   */
  parentSignal: AbortSignal;
  /** 任务文本(进 system prompt 的 "Your Role" 段,不进 user message) */
  task: string;
  /** 资源预算(可选,缺省走 resolveSubAgentBudget 默认值) */
  budget?: SubAgentBudget;
  /**
   * 单次 input tokens 注意力风险阈值 —— 从 ModelCapability.riskMaxTokens 解析。
   *
   * sub-task prompt 累积超阈说明任务过大,继续执行会触发 attention 稀释致 LLM
   * 响应质量下降。loop-runner 在每次 llm:request_end 后检查 usage.inputTokens,
   * 超阈则 graceful 中止,主 LLM 收到 ChildAgentResult.error.type
   * = "sub_agent_context_overflow" 后自主决策切分子任务。
   *
   * 与 budget.maxTokens 的区别:本字段监控**单次质量**(模型固有阈值),
   * maxTokens 监控**累计成本**(用户配置 budget)—— 数值不同,语义不同,触发互不抢占。
   */
  riskMaxTokens: number;
}

export interface ChildAgentResult {
  status: "completed" | "failed" | "aborted";
  subAgentId: string;
  /** 子 agent 最后 assistant 文本(空字符串若没有) */
  finalAssistantText: string;
  /** 子 LLM 累计用量 */
  usage: TokenUsage;
  /** 子工具调用次数 */
  toolUses: number;
  /** 子 dispatch 总耗时(ms) */
  durationMs: number;
  /** status="aborted" 才有 */
  abortReason?: AbortReason;
  /**
   * status="failed" 才有。
   *
   * `type` 是结构化 SubAgentErrorType 联合(详见类型定义注释),主 LLM 据此自主决策。
   * `message` 是人类可读文本——sub-agent 内部 LLM 错误透传 AgentError.message
   * (如 "400 invalid_request_error: ..."),budget 触发 / 基础设施崩等用固定文案。
   */
  error?: { message: string; type: SubAgentErrorType };
  /** failed/aborted 时尝试抓取 partial 输出(主 LLM 仍可据此判断) */
  partial?: string;
}

// ─── 实现 ───

export async function runChildAgent(
  opts: RunChildAgentOptions,
): Promise<ChildAgentResult> {
  const subAgentId = randomUUID();
  const startTime = Date.now();

  // 顶层兜底 —— 任何意外 throw 转 failed,保证函数永不抛
  try {
    return await runChildAgentInner(opts, subAgentId, startTime);
  } catch (unexpectedError) {
    return buildFailedResult({
      subAgentId,
      startTime,
      error: unexpectedError,
      errorType: "unexpected_error",
    });
  }
}

// ─── 内部实现:阶段化,每阶段失败均落入对应分支 ───

async function runChildAgentInner(
  opts: RunChildAgentOptions,
  subAgentId: string,
  startTime: number,
): Promise<ChildAgentResult> {
  const budget = resolveSubAgentBudget(opts.budget);

  // 阶段 1:装配子原语 —— 失败 → 直接 failed (childBus / childBroker 未完整,无 cleanup)
  let childBus: EventBus<AgentEventMap>;
  let childBroker: ConfirmationBroker;
  let childLineage: string;
  let childTools: ToolDefinition[];
  let systemPrompt: string;
  let initialMessages: Message[];

  try {
    childLineage = deriveChildLineage(opts.parentLineage, subAgentId);
    childBus = createEventBus<AgentEventMap>({
      parent: opts.parentBus,
      lineage: childLineage,
    });
    // 子 broker 装配:
    //   - parentBrokerId / sourceAgentId 是审计血缘元信息,broker 在 emit 事件 /
    //     snapshot() 时透传,不影响 broker 任何行为
    //   - nonInteractiveResolver 由 budget.confirmationPolicy 决定(从 resolved
    //     budget 取,而非 opts.budget?.confirmationPolicy —— 后者绕过单一真相源,
    //     默认值同步将断裂):
    //       inherit-or-deny / auto-deny → fail-to-deny(默认安全姿态)
    //   - 共享父 PermissionStore 走 SecurityPipeline 而非 broker,
    //     父 alwaysAllow 规则自动命中,根本不进 broker
    childBroker = new ConfirmationBroker({
      parentBrokerId: opts.parentBroker.id,
      sourceAgentId: subAgentId,
      nonInteractiveResolver: resolveSubAgentResolver(budget.confirmationPolicy),
    });

    const profile = subAgentProfile({ subAgentId, task: opts.task });

    // 子工具集：按 profile.enabledTools 过滤 parent tools —— profile 是工具
    // 装配的唯一权威源（与主 agent 装配同机制）。声明在 enabledTools 但 parent
    // 未提供的工具自然不进子集；声明在 parent 但不在 enabledTools 的工具被排除。
    const enabledSet = new Set(profile.enabledTools);
    childTools = opts.parentTools.filter((t) => enabledSet.has(t.name));

    // 子 system prompt:注意不传 project context / 用户记忆 / 父反思 —— 子任务专注,
    // 跨 spawn 的静态前缀 byte-identical 利于 prompt cache
    //
    // ⚠ Prompt cache 死线:此处是 sub-agent systemPrompt 的**唯一构造点**,
    // 子 agent 生命周期内 byte-equal 不变。loop-runner 透传后 agent-loop 不得
    // 重建。同一 (profile, childTools, workspace) 跨 spawn 应得到字面一致的
    // systemPrompt —— 这是同角色子 agent 跨 spawn 命中 prompt cache 的前提。
    // 详见 buildSystemPrompt 的"调用契约"注释。
    systemPrompt = buildSystemPrompt({
      profile,
      segments: SUB_AGENT_SEGMENTS,
      tools: childTools,
      cwd: process.cwd(),
      workspace: opts.workspace,
      workspaceSource: opts.workspaceSource,
      globalConfigPath: opts.globalConfigPath,
    });

    // 极短初始 user message —— 任务全文已在 system prompt 的 "Your Role" 段;
    // 主 LLM "Begin." 充当唤醒信号,告知子 loop 可以开始
    initialMessages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: 'Begin. Your task is in the system prompt under "Your Role".',
          },
        ],
      },
    ];
  } catch (assemblyError) {
    return buildFailedResult({
      subAgentId,
      startTime,
      error: assemblyError,
      errorType: "assembly_error",
    });
  }

  // 阶段 2 + 3:跑 loop + cleanup discipline
  let runResult: SubAgentLoopResult | null = null;
  let caughtError: unknown = null;

  try {
    runResult = await runContextStorage.run(
      { bus: childBus, lineage: childLineage },
      () =>
        runSubAgentLoop({
          systemPrompt,
          messages: initialMessages,
          tools: childTools,
          provider: opts.provider,
          model: opts.model,
          roleThinking: opts.roleThinking,
          llmRoles: opts.llmRoles,
          securityPipeline: opts.securityPipeline,
          confirmationBroker: childBroker,
          eventBus: childBus,
          parentSignal: opts.parentSignal,
          maxTurns: budget.maxTurns,
          maxTokens: budget.maxTokens,
          riskMaxTokens: opts.riskMaxTokens,
          watchdog: { idleTimeoutMs: budget.llmIdleTimeoutMs, warnThresholdRatio: 0.5 },
          wallClockTimeoutMs: budget.wallClockTimeoutMs,
          // 子 agent 与父 agent 共享同一 workspace —— 工具执行目录与
          // system prompt "Working directory" 字段对齐
          workingDirectory: opts.workspace ?? process.cwd(),
        }),
    );
  } catch (loopError) {
    // 仅 runSubAgentLoop 基础设施崩才到这里(LLM/tool 异常已被 loop 内部 catch 转 reason="error")
    caughtError = loopError;
  } finally {
    // cleanup discipline —— 永远执行,与 happy/failed/abort 路径无关:
    //   - childBus.removeAllListeners 防止子 bus 的 listener 跨 dispatch 累积
    //   - childBroker.cancelAll 把任何还在排队的 confirmation request 干净地拒绝,
    //     避免主 agent 拿到 partial result 后子里仍有悬挂 promise
    safeCleanup(childBus, childBroker);
  }

  // 阶段 4:折叠 ChildAgentResult
  return foldResult({
    subAgentId,
    startTime,
    runResult,
    caughtError,
  });
}

// ─── 折叠辅助 ───

interface FoldArgs {
  subAgentId: string;
  startTime: number;
  runResult: SubAgentLoopResult | null;
  caughtError: unknown;
}

function foldResult(args: FoldArgs): ChildAgentResult {
  const { subAgentId, startTime, runResult, caughtError } = args;
  const kind = classifyResult(runResult, caughtError);
  const messages = runResult?.messages ?? [];
  const finalAssistantText = extractFinalAssistantText(messages);
  const durationMs = Date.now() - startTime;
  const usage = runResult?.usage ?? emptyUsage();
  const toolUses = runResult?.toolUseCount ?? 0;

  if (kind === "completed") {
    return {
      status: "completed",
      subAgentId,
      finalAssistantText,
      usage,
      toolUses,
      durationMs,
    };
  }

  // failed / aborted 共享 partial 抓取 —— 优先取最后 assistant 文本,
  // 没有则拼所有历史 assistant text 块,仍空则保留 undefined
  const partial = finalAssistantText || extractPartialText(messages) || undefined;

  if (kind === "aborted") {
    return {
      status: "aborted",
      subAgentId,
      finalAssistantText,
      usage,
      toolUses,
      durationMs,
      abortReason: runResult?.abortReason,
      partial,
    };
  }

  // failed —— error 字段优先级:caughtError > loopResult.reason 衍生
  return {
    status: "failed",
    subAgentId,
    finalAssistantText,
    usage,
    toolUses,
    durationMs,
    error: deriveErrorMeta(runResult, caughtError),
    partial,
  };
}

function deriveErrorMeta(
  runResult: SubAgentLoopResult | null,
  caughtError: unknown,
): { message: string; type: SubAgentErrorType } {
  if (caughtError !== null && caughtError !== undefined) {
    return {
      message: errorMessage(caughtError),
      type: "loop_error",
    };
  }
  // 四类软上限触发 —— 用 budgetExceededKind 结构化字段映射,避免散落 reason 判断
  // 与 abortReason.origin 字符串解析(loop-runner 已把"abort 来源"折进 kind)。
  // message 写为 LLM 可读文本——Task 工具的 failed 渲染会把 message 直接拼入
  // ToolResult content,主 LLM 据此自主决策(切片 / 调整策略等)。
  if (runResult?.budgetExceededKind) {
    switch (runResult.budgetExceededKind) {
      case "max_turns":
        return {
          message: "sub-agent reached max turns budget",
          type: "max_turns_exceeded",
        };
      case "max_tokens":
        return {
          message: "sub-agent reached max tokens budget",
          type: "max_tokens_exceeded",
        };
      case "wall_clock":
        return {
          message: "sub-agent wall-clock timeout",
          type: "wall_clock_timeout",
        };
      case "context_overflow":
        return {
          message:
            "sub-task too large for reliable attention. Split the task into smaller, more focused sub-tasks.",
          type: "sub_agent_context_overflow",
        };
    }
  }
  // reason="error" 透传真实 AgentError —— loop-runner 在 reason="error" 时把
  // AgentError 的 type + message 通过 SubAgentLoopResult.error 字段透传上来。
  // 主 LLM 据此拿到结构化诊断信息(如 "provider_error: 400 invalid_request_error: ..."),
  // 而非历史的 "agent_error: sub-agent loop terminated with error" 占位文案。
  if (runResult?.error) {
    return {
      message: runResult.error.message,
      type: runResult.error.type,
    };
  }
  // 兜底 —— reason="error" 但 error 字段透传缺失,属于 loop-runner 透传 bug;
  // 理论不可达,保留作 last-resort 防御。message 显式 "internal" 提示这是 zhixing
  // 自身的字段透传问题而非 LLM/工具错误,便于定位。
  return {
    message: "sub-agent loop terminated with unrecoverable internal error",
    type: "unknown_error",
  };
}

interface FailedArgs {
  subAgentId: string;
  startTime: number;
  error: unknown;
  errorType: SubAgentErrorType;
}

function buildFailedResult(args: FailedArgs): ChildAgentResult {
  return {
    status: "failed",
    subAgentId: args.subAgentId,
    finalAssistantText: "",
    usage: emptyUsage(),
    toolUses: 0,
    durationMs: Date.now() - args.startTime,
    error: { message: errorMessage(args.error), type: args.errorType },
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

// ─── cleanup discipline ───

/**
 * cleanup 必须保证两个 dispose 都尝试执行 —— 任一抛错不能阻断对方,
 * 否则部分清理 + 部分残留比"完全不清"更难诊断。日志记录失败但不再 throw,
 * 与 runtime safeDispose 防御契约对齐。
 */
function safeCleanup(
  bus: EventBus<AgentEventMap>,
  broker: ConfirmationBroker,
): void {
  try {
    bus.removeAllListeners();
  } catch (error) {
    console.error("[orchestrator.runChildAgent.bus.cleanup] failed:", error);
  }
  try {
    broker.cancelAll("session-end");
  } catch (error) {
    console.error("[orchestrator.runChildAgent.broker.cleanup] failed:", error);
  }
}
