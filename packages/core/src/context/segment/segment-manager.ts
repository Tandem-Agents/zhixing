/**
 * SegmentManager —— 段切换编排主类。
 *
 * 编排流程：
 *   1. 估算与决策对有无 conversationId 行为一致——窗口保护对一切运行体生效
 *      （ephemeral 定时任务同样会超注意力上限）；仅持久化副作用（segmentMeta）
 *      按对话身份差分
 *   2. 估算 currentTokens = system + messages + tools
 *   3. 读 task_list in-progress 状态（cli 装配层注入 reader）
 *   4. 纯函数决策 → SegmentDecision
 *   5. emit segment:evaluation（pass / defer / trigger 全 fire，可观测全覆盖）
 *   6. 非 trigger 直接返回（pass / defer 在此终结）
 *   7. trigger 路径：
 *      a. emit transition_start
 *      b. beforeSummarize hooks（失败 → 中止：还没花 LLM 钱，安全回滚）
 *      c. 压缩 LLM call（含 retry，指数退避；末尾追加压缩指令保 cache prefix byte-equal）
 *      d. parseSummary（XML 三段）→ 全空视为失败
 *      e. emit summarize_complete
 *      f. afterSummarize hooks（失败 → 降级 warning + 继续：压缩成本不浪费）
 *      g. beforeNewSegmentStart hooks（失败 → 降级 warning + 继续：压缩成本不浪费）
 *      h. splitMessagesPairAware → toSummarize / toPreserve
 *      i. composeNewSegmentMessages → 新段首条 user message
 *      j. 构造窗口重构指令（含 segmentId + structuredSummary + 平文本 summary 副本）
 *      k. persistence.appendSegment（segmentMetadata 累积；失败 emit warning 但仍成功）
 *      l. emit new_started 携带 marker → 返回 modified=true
 *   8. trigger 关键失败（压缩失败 / 解析空 / beforeSummarize hook 失败） → emit
 *      transition_failed → return modified:false（降级不切，agent-loop 拿原 messages 继续）
 *
 * 关键不变量：
 *   - 压缩请求 system + tools + messages 与上一轮 byte-equal（cache 完美命中）
 *   - 段切换失败绝不阻塞 turn（agent-loop 拿原 messages 继续，下次再评估）
 *   - **窗口折叠不由 SegmentManager 直接应用**：通过 segment:new_started
 *     事件携带 windowCompact 流向 orchestrator accumulator，随 RunResult 在
 *     run 边界由调用方交给注意力窗口折叠。与 LLMSummarize 走 context:compact_end
 *     → accumulator → RunResult.windowCompact 路径同模式，整个 run 的折叠指令
 *     收敛到唯一出口；持久化是 append-only 原文，压缩不触碰磁盘
 *   - segmentMetadata 是独立观测元数据流：写入失败不阻断段切换主流程
 *     （marker 已通过事件流转出，下次启动 transcript rebuild 仍能还原新段 LLM 视图；
 *     segmentMetadata 失败仅影响"段历史浏览"未来 UI，不影响 LLM 行为）
 *   - hook 错误分级：beforeSummarize 失败中止段切换（safe，未花成本）；
 *     after / beforeNewSegmentStart 失败 emit hook_failed 但继续段切换
 *     （压缩 LLM 已花成本，不让 hook 错误浪费）
 */

import type { IEventBus } from "../../events/types.js";
import type { SegmentMeta } from "../../conversation/types.js";
import type { AgentEventMap } from "../../types/agent-events.js";
import type { Message } from "../../types/messages.js";
import type { ToolSpec } from "../../types/tools.js";
import type { WindowCompact } from "../window/types.js";
import {
  calculateMessageTurns,
  splitMessagesPairAware,
} from "../message-turns.js";
import type { ITokenEstimator } from "../types.js";
import { buildDroppedTurnsMessage } from "../system-meta.js";
import { composeNewSegmentMessages } from "./compose.js";
import { decideSegmentAction } from "./decision.js";
import { parseSummary } from "./parser.js";
import { SEGMENT_SUMMARIZE_INSTRUCTION } from "./prompts.js";
import type {
  ParsedSummary,
  SegmentDecision,
  SegmentManagerInput,
  SegmentManagerOutput,
  SegmentPersistence,
  SegmentSummarizeLLMFn,
  SegmentSummarizeRequest,
  SegmentThresholds,
  SegmentTransitionContext,
  SegmentTransitionHook,
  TaskListReader,
} from "./types.js";

// ─── 默认配置 ───

const DEFAULT_BUFFER_TURNS = 2;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 200;

// ─── 配置接口 ───

export interface SegmentManagerConfig {
  readonly estimator: ITokenEstimator;
  readonly capability: SegmentThresholds;
  readonly callLLM: SegmentSummarizeLLMFn;
  readonly persistence: SegmentPersistence;
  readonly taskListReader: TaskListReader;
  readonly eventBus?: IEventBus<AgentEventMap>;
  readonly hooks?: readonly SegmentTransitionHook[];
  /** 缓冲带 turn 数，默认 2 */
  readonly bufferTurns?: number;
  /** 压缩 LLM 重试次数（不含首次尝试），默认 3 */
  readonly retries?: number;
  /** 重试基准延迟，第 N 次重试等 baseMs * 2^N ms，默认 200 */
  readonly retryBaseMs?: number;
  /** segmentId 生成器，测试注入 */
  readonly generateSegmentId?: () => string;
  /** 时钟，测试注入 */
  readonly clock?: () => Date;
}

interface NormalizedConfig {
  readonly estimator: ITokenEstimator;
  readonly capability: SegmentThresholds;
  readonly callLLM: SegmentSummarizeLLMFn;
  readonly persistence: SegmentPersistence;
  readonly taskListReader: TaskListReader;
  readonly eventBus: IEventBus<AgentEventMap> | undefined;
  readonly hooks: readonly SegmentTransitionHook[];
  readonly bufferTurns: number;
  readonly retries: number;
  readonly retryBaseMs: number;
  readonly generateSegmentId: () => string;
  readonly clock: () => Date;
}

function normalizeConfig(raw: SegmentManagerConfig): NormalizedConfig {
  return {
    estimator: raw.estimator,
    capability: raw.capability,
    callLLM: raw.callLLM,
    persistence: raw.persistence,
    taskListReader: raw.taskListReader,
    eventBus: raw.eventBus,
    hooks: raw.hooks ?? [],
    bufferTurns: raw.bufferTurns ?? DEFAULT_BUFFER_TURNS,
    retries: raw.retries ?? DEFAULT_RETRIES,
    retryBaseMs: raw.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    generateSegmentId: raw.generateSegmentId ?? defaultSegmentId,
    clock: raw.clock ?? (() => new Date()),
  };
}

function defaultSegmentId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `seg-${stamp}-${rand}`;
}

// ─── 主类 ───

export class SegmentManager {
  private readonly cfg: NormalizedConfig;

  constructor(config: SegmentManagerConfig) {
    this.cfg = normalizeConfig(config);
  }

  /**
   * 评估当前对话状态并按需切段。
   *
   * 调用方：agent-loop 在 turn 边界（assistant 输出完成、newMessages 重建后）
   * 调用一次。返回 modified=true 时替换 state.messages 为 newSegmentMessages。
   */
  async evaluate(input: SegmentManagerInput): Promise<SegmentManagerOutput> {
    const currentTokens = this.estimateTotalTokens(input);
    // ephemeral（无 conversationId）照常评估与切段；任务进行中守卫依赖任务
    // 清单，ephemeral 无清单 → 视为无进行中任务
    const hasInProgressTask = input.conversationId
      ? this.cfg.taskListReader.hasInProgress(input.conversationId)
      : false;
    const decision = decideSegmentAction({
      currentTokens,
      capability: this.cfg.capability,
      hasInProgressTask,
    });

    await this.cfg.eventBus?.emit("segment:evaluation", {
      decision,
      currentTokens,
    });

    if (decision.kind !== "trigger") {
      return { decision, modified: false };
    }

    return await this.performTransition(input, decision, currentTokens);
  }

  // ─── 切段流程 ───

  private async performTransition(
    input: SegmentManagerInput,
    decision: SegmentDecision & { kind: "trigger" },
    tokensBefore: number,
  ): Promise<SegmentManagerOutput> {
    const conversationId = input.conversationId;
    const segmentId = this.cfg.generateSegmentId();
    const startedAt = this.cfg.clock();
    // 切分提前到 ctx 构造（纯函数，与摘要 LLM 调用无序依赖）——被摘段原文
    // 作为 hook 输入随 ctx 交付（记忆提取等消费）
    const { toSummarize, toPreserve } = splitMessagesPairAware(
      input.messages,
      this.cfg.bufferTurns,
    );
    // 无可摘内容（全部消息都在保留 buffer 内）→ 切段无意义，静默不切。
    // 强制触发（阈值置零的手动压缩）在小窗口上会落到这里。
    if (toSummarize.length === 0) {
      return { decision, modified: false };
    }
    const ctx: SegmentTransitionContext = {
      conversationId,
      segmentId,
      tokensBefore,
      messages: toSummarize,
      abortSignal: input.abortSignal,
    };

    await this.cfg.eventBus?.emit("segment:transition_start", {
      conversationId,
      segmentId,
      reason: decision.reason,
      currentTokens: tokensBefore,
    });

    // hook: beforeSummarize —— 失败中止段切换（安全回滚，未花 LLM 成本）
    const beforeHookErr = await this.runHooksCatch((h) =>
      h.beforeSummarize?.(ctx),
    );
    if (beforeHookErr) {
      await this.cfg.eventBus?.emit("segment:hook_failed", {
        segmentId,
        hookPhase: "beforeSummarize",
        error: errorMessage(beforeHookErr),
        abortedTransition: true,
      });
      await this.cfg.eventBus?.emit("segment:transition_failed", {
        segmentId,
        error: `beforeSummarize hook aborted: ${errorMessage(beforeHookErr)}`,
        retriesExhausted: false,
      });
      return { decision, modified: false };
    }

    // ── 压缩 LLM call ──
    let summary: ParsedSummary;
    try {
      const summaryText = await this.callSummarizeWithRetry(
        input.systemPrompt,
        input.tools,
        input.messages,
        input.abortSignal,
      );
      summary = parseSummary(summaryText);
      if (isEmptySummary(summary)) {
        throw new Error("summary parser returned empty triplet");
      }
    } catch (e) {
      await this.cfg.eventBus?.emit("segment:transition_failed", {
        segmentId,
        error: errorMessage(e),
        retriesExhausted: true,
      });
      // 应急地板：风险阈值已破（再不切就逼近物理窗口）而摘要 LLM 不可用 →
      // 机械保尾截断兜底（无 LLM、不落盘）。optimal 档失败则等下轮再试——
      // 还有余量，不值得有损降级。abort 是用户意图而非 LLM 不可用，
      // 同样不降级（下轮照常评估）。
      if (decision.reason === "risk-exceeded" && !input.abortSignal?.aborted) {
        return this.applyEmergencyFloor(
          decision,
          segmentId,
          tokensBefore,
          toSummarize,
          toPreserve,
        );
      }
      return { decision, modified: false };
    }

    const summarizeEndAt = this.cfg.clock();
    const summaryTokens = this.cfg.estimator.estimateText(
      summary.facts + summary.state + summary.active,
    );
    await this.cfg.eventBus?.emit("segment:summarize_complete", {
      segmentId,
      summaryTokens,
      latencyMs: summarizeEndAt.getTime() - startedAt.getTime(),
    });

    // hook: afterSummarize —— 失败降级 warning 不中止主流程
    // （压缩 LLM 已花成本，不让 hook 错误浪费已支付的代价）
    const afterHookErr = await this.runHooksCatch((h) =>
      h.afterSummarize?.(ctx, summary),
    );
    if (afterHookErr) {
      await this.cfg.eventBus?.emit("segment:hook_failed", {
        segmentId,
        hookPhase: "afterSummarize",
        error: errorMessage(afterHookErr),
        abortedTransition: false,
      });
    }

    // hook: beforeNewSegmentStart —— 同样降级 warning 不中止
    const newSegHookErr = await this.runHooksCatch((h) =>
      h.beforeNewSegmentStart?.(ctx),
    );
    if (newSegHookErr) {
      await this.cfg.eventBus?.emit("segment:hook_failed", {
        segmentId,
        hookPhase: "beforeNewSegmentStart",
        error: errorMessage(newSegHookErr),
        abortedTransition: false,
      });
    }

    // ── 拼新段 ──
    const newSegmentMessages = composeNewSegmentMessages({
      summary,
      recentTurns: toPreserve,
    });
    const tokensAfter = this.cfg.estimator.estimateMessages(newSegmentMessages);
    const turnsCompacted = computeTurnsCompacted(toSummarize);

    const windowCompact: WindowCompact = {
      summary: flattenSummary(summary),
      structuredSummary: summary,
      segmentId,
      pairsCompacted: turnsCompacted,
      tokensBefore,
      tokensAfter,
    };

    // segmentMetadata 累积写入 —— 失败走专属 warning 事件，**不**复用 transition_failed
    // （避免"成功 + 失败"事件并存的语义矛盾）。
    //
    // 设计原因：窗口重构指令经 segment:new_started 事件流向 orchestrator
    // accumulator、随 RunResult 带出，由会话层在接受协议中折叠窗口——压缩是
    // 窗口的视图操作，原文持久化 append-only 不参与。
    // segmentMetadata 是独立观测元数据流（仅服务于段历史 UI），缺失不影响
    // 段切换语义完成度。
    // ephemeral 运行体无对话身份 → 跳过 segmentMeta 持久化（唯一的副作用差分）
    if (conversationId) {
      const meta: SegmentMeta = {
        segmentId,
        timestamp: startedAt.toISOString(),
        tokensBefore,
        tokensAfter,
      };
      try {
        await this.cfg.persistence.appendSegment(conversationId, meta);
      } catch (e) {
        await this.cfg.eventBus?.emit("segment:metadata_persist_failed", {
          segmentId,
          error: errorMessage(e),
        });
        // 不 return —— 段切换主流程已完成（指令即将通过 segment:new_started 流出）
      }
    }

    await this.cfg.eventBus?.emit("segment:new_started", {
      segmentId,
      bufferTurns: this.cfg.bufferTurns,
      tokensBefore,
      tokensAfter,
      windowCompact,
    });

    return {
      decision,
      modified: true,
      newSegmentMessages,
      windowCompact,
    };
  }

  // ─── 私有 helpers ───

  private estimateTotalTokens(input: SegmentManagerInput): number {
    return (
      this.cfg.estimator.estimateText(input.systemPrompt) +
      this.cfg.estimator.estimateMessages(input.messages) +
      this.cfg.estimator.estimateTools(input.tools)
    );
  }

  /**
   * 压缩 LLM call 含 retry。
   *
   * 请求构造：完整 system + tools + (原 messages + 末尾追加压缩指令 user message)。
   * 末尾追加是缓存安全分叉的物理实现 —— 前 N-1 个 messages 与上一轮 byte-equal，
   * 最后一条新增 message 是唯一新 token。
   */
  private async callSummarizeWithRetry(
    systemPrompt: string,
    tools: readonly ToolSpec[],
    messages: readonly Message[],
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const request: SegmentSummarizeRequest = {
      systemPrompt,
      tools,
      messages: [
        ...messages,
        {
          role: "user",
          content: [{ type: "text", text: SEGMENT_SUMMARIZE_INSTRUCTION }],
        },
      ],
      abortSignal,
    };

    let lastError: unknown;
    const total = this.cfg.retries + 1;
    for (let attempt = 0; attempt < total; attempt++) {
      if (abortSignal?.aborted) {
        throw new Error("aborted");
      }
      try {
        return await this.cfg.callLLM(request);
      } catch (e) {
        lastError = e;
        if (attempt === total - 1) break;
        const delay = this.cfg.retryBaseMs * Math.pow(2, attempt);
        await sleepWithAbort(delay, abortSignal);
      }
    }
    throw lastError;
  }

  /**
   * 应急地板 —— 注意力层自己的最后兜底：被摘段整体替换为机械占位
   * （dropped-turns 标注），保留最近 buffer 原文。有损降级换可用性：
   * 细节仍完整躺在持久化原文上，窗口折叠指令不携结构化摘要（不产快照）。
   */
  private async applyEmergencyFloor(
    decision: SegmentDecision & { kind: "trigger" },
    segmentId: string,
    tokensBefore: number,
    toSummarize: readonly Message[],
    toPreserve: readonly Message[],
  ): Promise<SegmentManagerOutput> {
    const droppedTurns = computeTurnsCompacted(toSummarize);
    const newSegmentMessages = [
      buildDroppedTurnsMessage(droppedTurns),
      ...toPreserve,
    ];
    const tokensAfter = this.cfg.estimator.estimateMessages(newSegmentMessages);

    const windowCompact: WindowCompact = {
      summary: `因上下文超限且摘要生成失败，前 ${droppedTurns} 轮对话已被机械截断，完整原文保存在对话历史中`,
      pairsCompacted: droppedTurns,
      tokensBefore,
      tokensAfter,
    };

    await this.cfg.eventBus?.emit("segment:emergency_floor", {
      segmentId,
      droppedTurns,
      tokensBefore,
      tokensAfter,
    });
    // 折叠指令与成功切段共用同一出口：经 segment:new_started 流向
    // orchestrator accumulator、随 RunResult 带出，会话层窗口才会同步折叠。
    // 不发则 run 内 state 已截而跨 run 窗口持续增长——地板在自动路径失效。
    // emergency_floor 是附加诊断事件，不承担指令交付。
    await this.cfg.eventBus?.emit("segment:new_started", {
      segmentId,
      bufferTurns: this.cfg.bufferTurns,
      tokensBefore,
      tokensAfter,
      windowCompact,
    });

    return { decision, modified: true, newSegmentMessages, windowCompact };
  }

  /**
   * 顺序执行 hooks，返回第一个 throw 的错误（或 undefined）。
   *
   * 第一个 hook 抛错即返回，后续 hooks 不再执行 —— 与 hook 顺序契约一致。
   * 调用方根据返回值决定是否中止段切换。
   */

  private async runHooksCatch(
    invoker: (hook: SegmentTransitionHook) => Promise<void> | undefined,
  ): Promise<unknown> {
    for (const hook of this.cfg.hooks) {
      try {
        await invoker(hook);
      } catch (e) {
        return e;
      }
    }
    return undefined;
  }
}

export function createSegmentManager(
  config: SegmentManagerConfig,
): SegmentManager {
  return new SegmentManager(config);
}

// ─── 纯函数辅助 ───

function isEmptySummary(summary: ParsedSummary): boolean {
  return (
    summary.facts === "" &&
    summary.state === "" &&
    summary.active === ""
  );
}

function flattenSummary(summary: ParsedSummary): string {
  return [summary.facts, summary.state, summary.active]
    .filter((part) => part !== "")
    .join("\n\n");
}

function computeTurnsCompacted(toSummarize: readonly Message[]): number {
  if (toSummarize.length === 0) return 0;
  const turns = calculateMessageTurns(toSummarize);
  return turns[turns.length - 1] ?? 0;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * sleep with abort 支持。abort 发生时立即 reject —— 不等定时器自然过期。
 *
 * 边界：进入时已 aborted → 立即 reject；定时器期间 aborted → reject + 清定时器。
 */
async function sleepWithAbort(
  ms: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
