/**
 * Agent Loop — 知行智能体核心循环
 *
 * 这是整个系统的心脏：一个 AsyncGenerator 驱动的 while(true) 循环，
 * 交替执行 LLM 调用和工具执行，直到达成终止条件。
 *
 * 架构决策（详见 research/_private/questions/q02-agent-loop-design.md）：
 * - AsyncGenerator：背压控制、类型安全的 return 值、yield* 可组合
 * - while(true) + 不可变状态：每轮重建 LoopState，不累积副作用
 * - 子生成器拆分：streamLLMCall / executeToolCalls 各司其职
 * - EventBus 一等公民：所有关键节点发射事件，支持完全解耦的观测
 *
 * 中断架构（详见 research/design/specifications/interruptible-agent-loop-execution.md）：
 *
 * - **入口包装 createInterruptController**：把外部 abortSignal 当作"一个可能的 abort 源"
 *   汇入 controller，loop 内部一律走 controller.signal。后续里程碑的看门狗 / fork 子 agent
 *   都通过 controller 触发 abort，全链路统一抽象。
 *
 * - **abort listener 同步记 abortFiredAt**：不在 listener 内调 emit——避免 fire-and-forget
 *   时序错乱；emit fired 由 finalizeRun 在退出路径上统一调用，严格保证 fired 在 run_end 之前。
 *
 * - **finalizeRun 是终止流程的单一退出点**：内联 closure 形式让所有 abort 优先逻辑、emit 顺序、
 *   exitDelayMs 计算、abortReason 补提收敛在一处。任何 caller 调用 finalizeRun(任意 result) 都
 *   自动获益：
 *     1. **abort 优先转换**：controller 已 aborted 但 result 不是 aborted → 自动覆盖为 aborted。
 *        覆盖 LLM error / completed / max_turns 等所有可能在 abort 期间触发的非 abort result，
 *        与 termination.ts "abort 优先于 context_overflow" 哲学对称。新加退出分支零风险——
 *        不会忘检查 abort。
 *     2. **exitDelayMs 单点计算**：AgentResult.exitDelayMs 与 InterruptFiredEvent.exitDelayMs
 *        由同一 const 派生，保证一致。
 *     3. **emit 顺序保证**：fired (仅 abort 路径) 严格在 run_end 之前。
 *
 * - **try / catch / finally 完整状态机**：
 *     - runEndEmitted 标记位让 finally 区分"主路径已发"vs"需要补发"
 *     - caughtError 区分"内部抛错"vs"消费者 generator.return() 中途打断"
 *     - finally 兜底补发防止订阅方 spinner 永不结束（违反"已 emit 的 fired 必有对应 run_end"）
 *
 * 终止条件：
 * - aborted：controller.signal 触发 / 主路径非 abort result 在 abort 期间被 finalizeRun 覆盖 /
 *   消费者 generator.return() 中途打断。携带 abortReason / exitDelayMs。
 * - max_turns：达到 maxTurns 限制（与 abort 平行体系，不携带 abortReason）。
 * - completed：LLM 返回纯文本（无工具调用），正常结束。
 * - error：LLM 调用出错 / contextManager 不可恢复错误 / agent-loop 内部抛错（finally 兜底捕获）。
 */

import { buildCleanup } from "../interrupt/cleanup.js";
import { createInterruptController, getAbortReason } from "../interrupt/controller.js";
import { toAgentError } from "../types/errors.js";
import { emptyUsage, mergeUsage } from "../types/llm.js";
import { extractText, extractToolCalls, toolResultMessage } from "../types/messages.js";
import type { Message } from "../types/messages.js";
import { toToolSpec } from "../types/tools.js";
import { streamLLMCall } from "./llm-call.js";
import { executeToolCalls } from "./tool-executor.js";
import { runTurnEnd } from "./turn-end.js";
import { logDiagnostic } from "../diagnostics.js";
import type {
  AgentLoopDeps,
  AgentLoopParams,
  AgentResult,
  AgentYield,
  LoopState,
} from "./types.js";

/**
 * 运行智能体循环。
 *
 * 消费方式：
 * ```ts
 * const gen = runAgentLoop(params);
 * // 方式 1：手动迭代（推荐，可获取 return 值）
 * while (true) {
 *   const { value, done } = await gen.next();
 *   if (done) { const result = value; break; }
 *   handleEvent(value);
 * }
 * // 方式 2：使用 drainAgentLoop 便捷函数
 * const { yields, result } = await drainAgentLoop(params);
 * ```
 */
export async function* runAgentLoop(
  params: AgentLoopParams,
): AsyncGenerator<AgentYield, AgentResult> {
  // ⚠ systemPrompt 是 prompt cache 前缀死线:由 runtime 装配阶段构造一次,
  // 这里仅解构透传,**不得**在 loop 内拼接 / 追加 / 重建。per-turn 动态信息
  // 走 turnContextInjector(注入到末尾 user message),不进 systemPrompt。
  // 详见 buildSystemPrompt 的"调用契约"注释。
  const { model, systemPrompt, eventBus } = params;
  const tools = params.tools ?? [];
  const maxTurns = params.maxTurns ?? 100;
  const workingDirectory = params.workingDirectory ?? process.cwd();
  const toolSpecs = tools.map(toToolSpec);
  const deps = resolveDeps(params);

  const startTime = Date.now();

  // 把外部 abortSignal 当作"一个可能的 abort 源"汇入 controller，loop 内部一律走
  // controller.signal：统一抽象出 abort 写权限（看门狗 / 子 agent fork 都通过 controller 触发）
  // 与读路径（下游 Provider / 工具 / contextManager 接收 controller.signal，完全透明）。
  //
  // parentSignal: 子 agent 路径用,父 abort → 子 controller 自动 abort with parent-abort kind。
  // abortSignal: 外部多源 signal (scheduler / 外部 SDK), 走 external kind。
  // 两者同时传入合理 (子 agent 同时受父和外部 scheduler 限时), 任一触发让 controller abort。
  const controller = createInterruptController({
    parent: params.parentSignal,
    externalSignals: params.abortSignal ? [params.abortSignal] : [],
  });

  // abort 触发时刻（monotonic ms），用于计算 loop 框架延迟 exitDelayMs。
  // listener 内**只**做同步操作（记时间），不调 emit——避免 fire-and-forget 时序错乱。
  // emit fired 由 finalizeRun 在退出路径上统一调用，严格保证 fired 在 run_end 之前。
  let abortFiredAt: number | null = null;
  const recordAbortTime = () => {
    if (abortFiredAt === null) abortFiredAt = performance.now();
  };
  // 防御 EventTarget 标准：已 aborted signal 上 addEventListener 不触发。
  // externalSignal 已 aborted 场景（scheduled task 超时、子 agent fork 时父已 aborted）
  // 必须同步调 recordAbortTime 才能正确记录，否则 abortFiredAt 永远为 null。
  if (controller.signal.aborted) {
    recordAbortTime();
  } else {
    controller.signal.addEventListener("abort", recordAbortTime, { once: true });
  }

  let state: LoopState = {
    messages: [...params.messages],
    turnCount: 0,
    totalUsage: emptyUsage(),
  };

  // ─── 终止流程状态机 ───
  //
  // runEndEmitted：finalizeRun 是否已被调用 —— finally 块用此判断是否需要补发。
  //   主路径正常退出 → finalizeRun 调用 → runEndEmitted=true → finally 跳过补发
  //   消费者 generator.return() 中途打断 → 主路径未走完 → runEndEmitted=false → finally 补发
  //   内部抛错 → catch 捕获 → 同样 runEndEmitted=false → finally 补发
  let runEndEmitted = false;

  // caughtError：catch 块捕获的异常 —— finally 用此区分两种补发语义：
  //   非 null → 内部抛错（provider 未捕获 / engine 异常）→ 补发 reason="error"
  //   null   → 消费者 generator.return() 中途打断 → 补发 reason="aborted" with origin="consumer-return"
  let caughtError: unknown = null;

  /**
   * 终止流程的单一退出点 —— 内联 closure 形式让 finalize 自然访问 controller / state /
   * abortFiredAt / runEndEmitted / eventBus，无需逐参数传递。
   *
   * 三步固定流程：
   *
   *   1. **abort 优先转换**：controller 已 aborted 但 result 不是 aborted → 自动覆盖为 aborted。
   *      这一处收敛"abort 优先于其他终止"哲学（与 termination.ts "abort 优先于 context_overflow"
   *      对称），覆盖 LLM error / completed / max_turns 等所有可能在 abort 期间触发的非 abort
   *      result —— 用户按 Esc 后看到"已中断"而不是"出错"或"达到上限"。已是 aborted 但
   *      abortReason 缺失 → 从 controller 补提（让 caller 不必预提取 abortReason）。
   *
   *   2. **exitDelayMs 单点计算**：abort 路径用 abortFiredAt 算出 exitDelayMs，写入 result
   *      并 emit 给订阅方。AgentResult.exitDelayMs 与 InterruptFiredEvent.exitDelayMs 由同一
   *      const 派生，**保证一致**；订阅方零依赖 RunResult 即可监控延迟。
   *
   *   3. **emit 顺序保证**：fired (仅 abort 路径) 严格在 run_end 之前。单调用点保证幂等，
   *      新增 abort 退出分支零负担。
   *
   * interruptedTurnIndex 直接读 state.turnCount（closure 捕获最新值，与"被中断 turn 0-indexed"
   * 语义对应，不取 newTurnCount 即"已完成 turn 数 1-indexed"）。
   *
   * toolGraceMs 默认 0：abort 不在工具 await 期间 (turn 边界 / LLM 阶段 / contextManager 阶段
   * 等) 时调用方省略；abort 发生在工具 await 期间时调用方按
   * `max(0, abortedDuringToolAt - abortFiredAt)` 计算后传入，反映"工具自身 abort 等待消耗"
   * 让 SLO 监控隔离 loop 框架延迟与工具自身延迟。
   */
  const finalizeRun = async (
    result: AgentResult,
    toolGraceMs = 0,
  ): Promise<AgentResult> => {
    runEndEmitted = true;

    let finalResult: AgentResult = result;

    // Step 1: abort 优先转换 + abortReason 补全
    if (controller.signal.aborted) {
      const detectedReason = getAbortReason(controller.signal) ?? undefined;
      if (result.reason !== "aborted") {
        // 非 aborted result 但系统已 aborted → 自动覆盖（LLM error / completed / max_turns 路径）
        finalResult = { reason: "aborted", abortReason: detectedReason, usage: result.usage };
      } else if (result.abortReason === undefined) {
        // 已是 aborted 但 abortReason 缺失 → 从 controller 补提（contextManager terminal 路径）
        finalResult = { ...result, abortReason: detectedReason };
      }
    }

    // Step 2: exitDelayMs 计算 + 写入 result
    if (finalResult.reason === "aborted") {
      const exitDelayMs = abortFiredAt !== null
        ? Math.round(performance.now() - abortFiredAt)
        : undefined;
      finalResult = { ...finalResult, exitDelayMs };

      // Step 3a: emit fired（仅 abort 路径）
      await eventBus?.emit("interrupt:fired", {
        reason: finalResult.abortReason ?? null,
        interruptedTurnIndex: state.turnCount,
        exitDelayMs,
        toolGraceMs,
      });
    }

    // Step 3b: emit run_end（一律发出）
    //
    // errorType 从 AgentError.type 提取，供订阅方做差异化 UX（例如 context_overflow
    // 建议用户 /clear；rate_limit 告警但不终止 session）—— 避免订阅方从 message
    // 做 substring 匹配，后者不稳定。
    await eventBus?.emit("agent:run_end", {
      reason: finalResult.reason,
      duration: Date.now() - startTime,
      usage: finalResult.usage,
      error: finalResult.reason === "error" ? finalResult.error.message : undefined,
      errorType: finalResult.reason === "error" ? finalResult.error.type : undefined,
    });

    return finalResult;
  };

  const lastMessage = state.messages[state.messages.length - 1];
  await eventBus?.emit("agent:run_start", {
    prompt: lastMessage ? extractText(lastMessage) : "",
  });

  try {
    while (true) {
      // ── Guard: abort ──
      // 早退出避免无意义的 LLM/工具调用工作。语义上"abort 优先"由 finalizeRun 内部
      // 单点保证（任何 emit 退出都自动转 aborted），但 hot-path 上仍保留显式 guard
      // 节省一次 LLM round-trip。
      if (controller.signal.aborted) {
        return await finalizeRun({
          reason: "aborted",
          abortReason: getAbortReason(controller.signal) ?? undefined,
          usage: state.totalUsage,
        });
      }

      // ── Guard: max turns ──
      if (state.turnCount >= maxTurns) {
        return await finalizeRun({
          reason: "max_turns",
          maxTurns,
          usage: state.totalUsage,
        });
      }

      // ── Step 1: 准备 LLM 输入（每次 LLM call 之前重做） ──
      //
      // 顺序：state.messages → turnContextInjector.inject → streamLLMCall。
      // turn-context 注入是可选的；缺省时 messages 直接透传。
      //
      // 为什么是 per-LLM-call：同一 run() 内 LLM 多次 call 之间 turn-context 状态可能演化
      // （任务列表、定时任务等），单 run 入口注入一次会让后续 call 看到陈旧内容；
      // 每次 LLM call 之前重 inject 让最新状态实时可见，inject 内部自动 strip 旧块防累积。
      let messagesForLLM: readonly Message[] = state.messages;
      if (params.turnContextInjector) {
        messagesForLLM = params.turnContextInjector.inject(messagesForLLM);
      }

      // ── Step 2: Call LLM ──
      // 接 controller (非 signal):看门狗触发 idle-timeout 时需要 controller.abort() 写权限,
      // controller 由 agent-loop 持有, signal 全程透传 Provider/工具/contextManager。
      // watchdog 不在本层 fallback 默认值: spec 规定默认 fallback 单点存在于 cli/run-agent.ts
      // 注入边界, 保证用户显式禁用 idle-timer (`{ idleTimeoutMs: 0 }`) 不被 agent-loop 二次覆盖。
      const llmResult = yield* streamLLMCall({
        deps,
        messages: messagesForLLM as Message[],
        model,
        systemPrompt,
        toolSpecs,
        controller,
        watchdog: params.watchdog,
        eventBus,
      });

      const usage = mergeUsage(state.totalUsage, llmResult.usage);

      // ── 估算器校准（仅成功无错路径） ──
      // 用 API 返回的真实 inputTokens 对账本次"实际送入 LLM 的 messages"
      // （即 messagesForLLM —— TurnContextInjector 注入后），让 calibration 系数与
      // LLM 实际处理的 size 对账，而非与数据层 state.messages 对账：后者会因
      // turn-context 注入产生系统性偏差，让 calibration 系数无法收敛。
      // abort / provider-error / inputTokens=0 路径全部跳过 —— 这些样本不可靠，
      // 注入会污染滑动平均。
      if (
        params.tokenEstimator &&
        !llmResult.aborted &&
        !llmResult.error &&
        llmResult.usage.inputTokens > 0
      ) {
        const estimated = params.tokenEstimator.estimateMessages(messagesForLLM);
        params.tokenEstimator.calibrate(
          estimated,
          llmResult.usage.inputTokens,
        );
      }

      // ── LLM 阶段 abort → 调 cleanup 出 partial assistant + 退出 ──
      // abort 在 stream 消费循环触发 → llm-call 返回 aborted variant + partial 数据。
      // 调 buildCleanup 用 assemblePartialMessage 注入 [interrupted] 标记构造 partial assistant,
      // yield 给消费者让 trackMessages 拼出协议合规的 newMessages
      // (partial 不含 tool_use, 无需配对 tool_result, 协议自然合规)。
      // unexecutedToolUses=[]: LLM 阶段还没到 tool 执行,没有未完成的 tool_use 需要 placeholder。
      // toolGraceMs=0: abort 不在工具 await 期间,工具自身延迟为 0。
      if (llmResult.aborted) {
        const reason = getAbortReason(controller.signal) ?? null;
        const outcome = buildCleanup({
          partial: llmResult.partial,
          unexecutedToolUses: [],
          reason,
        });
        if (outcome.kind === "data" && outcome.partialAssistant) {
          yield { type: "assistant_message", message: outcome.partialAssistant };
        }
        return await finalizeRun(
          {
            reason: "aborted",
            abortReason: reason ?? undefined,
            usage,
          },
          0,
        );
      }

      // ── LLM 错误 → 终止 ──
      // 非 abort 的真实 provider 错误 (SDK 抛错 / provider error event)。
      // abort 已在上方分流走 aborted variant,不会进此分支被掩盖为"出错"。
      // finalizeRun 内部仍有 abort 优先转换兜底 (例如 contextManager 异步触发 abort 的 race
      // window),双重保护。
      if (llmResult.error) {
        return await finalizeRun({
          reason: "error",
          error: llmResult.error,
          usage,
        });
      }

      // ── 无工具调用 → 正常完成 ──
      const toolCalls = extractToolCalls(llmResult.message);
      if (toolCalls.length > 0) {
        logDiagnostic(
          `[llm] 工具调用: ${toolCalls.map((tc) => tc.name).join(", ")}`,
        );
      }
      if (toolCalls.length === 0) {
        // ── Turn 结束钩子 —— 纯文本路径 ──
        //
        // turn 结束副作用（budget 兜底 + attention 切段 + 未来扩展）统一由 runTurnEnd
        // 编排，与工具循环路径调用同一钩子（钩子内部不感知 caller 路径）。
        //
        // 钩子返回 messages 不消费 —— 本 run 即将 finalizeRun，下一轮 LLM call 不存在；
        // 段切换 marker 走 segment:new_started 事件 → orchestrator accumulator → 下次
        // run 启动时从 transcript 重建用切段后历史，跨 run 生效。
        //
        // terminal 来源仍由 contextManager 引发（segmentManager 永不返 terminal）：
        // aborted 但 abortReason 缺失会在 finalizeRun 内部从 controller 补提，让
        // contextManager abort 与主循环 abort 在 AgentResult.abortReason 上行为一致。
        const turnEnd = await runTurnEnd({
          messages: [...state.messages, llmResult.message],
          turnCount: state.turnCount + 1,
          usage,
          abortSignal: controller.signal,
          contextManager: params.contextManager,
          segmentManager: params.segmentManager,
          systemPrompt: params.systemPrompt ?? "",
          tools: params.tools ?? [],
          conversationId: params.conversationId,
        });
        if (turnEnd.kind === "terminal") {
          return await finalizeRun(turnEnd.result);
        }
        // 正常 completed 路径 —— 若 abort 在钩子之后到达（race window），
        // finalizeRun 自动覆盖为 aborted，避免 abort 被静默丢失。
        return await finalizeRun({
          reason: "completed",
          message: llmResult.message,
          usage,
        });
      }

      // ── Step 2: Execute tools ──
      const toolExecutorResult = yield* executeToolCalls({
        toolCalls,
        tools,
        deps,
        workingDirectory,
        abortSignal: controller.signal,
        eventBus,
        llmRoles: params.llmRoles,
      });

      // ── Tool 阶段 abort → 调 cleanup 注入 placeholder + 退出 ──
      // 已完成的 tool_results 已 yield 过 tool_end (run-agent trackMessages 已收集),
      // 未执行的 tool_use 由 cleanup 注入 isError placeholder 保证每个 tool_use 配对 tool_result
      // (协议合规,下一轮 LLM 调用不会因残缺 tool_use 报 400)。
      // turn_complete 在此 yield (with llmResult.usage 反映 LLM 实际处理 tokens),让 trackMessages
      // flush pendingToolResults 进 user message。
      // toolGraceMs: abort 发生在工具 await 期间则计算工具退出延迟 (供 SLO 监控)。
      if (toolExecutorResult.unexecutedToolUses.length > 0) {
        const reason = getAbortReason(controller.signal) ?? null;
        const outcome = buildCleanup({
          partial: undefined,
          unexecutedToolUses: toolExecutorResult.unexecutedToolUses,
          reason,
        });
        if (outcome.kind === "data" && outcome.placeholderToolResults.length > 0) {
          const toolNameById = new Map(
            toolExecutorResult.unexecutedToolUses.map((t) => [t.id, t.name]),
          );
          for (const r of outcome.placeholderToolResults) {
            yield {
              type: "tool_end",
              id: r.toolUseId,
              name: toolNameById.get(r.toolUseId) ?? "unknown",
              result: { content: r.content, isError: true },
              duration: 0,
            };
          }
          yield {
            type: "turn_complete",
            turnCount: state.turnCount + 1,
            usage: llmResult.usage,
          };
        }
        const toolGraceMs =
          toolExecutorResult.abortedDuringToolAt != null && abortFiredAt != null
            ? Math.max(0, toolExecutorResult.abortedDuringToolAt - abortFiredAt)
            : 0;
        return await finalizeRun(
          {
            reason: "aborted",
            abortReason: reason ?? undefined,
            usage,
          },
          toolGraceMs,
        );
      }

      // ── Yield turn boundary ──
      const newTurnCount = state.turnCount + 1;
      yield { type: "turn_complete", turnCount: newTurnCount, usage: llmResult.usage };

      // ── Turn 结束钩子 —— 工具循环路径 ──
      //
      // turn 结束副作用（budget 兜底 + attention 切段 + 未来扩展）统一由 runTurnEnd
      // 编排，与纯文本路径调用同一钩子（钩子内部不感知 caller 路径）。
      //
      // newMessages 构造在 caller 侧完成：本路径需要把 assistant.message + 完整
      // tool_results 都拼上（spread readonly → mutable 浅拷贝匹配 toolResultMessage
      // 签名；内部不会 mutate 数组）—— 完整 turn 路径仅消费完整结果。
      //
      // 钩子返回 messages 必须消费写回 state.messages —— 下一轮 LLM call 用钩子
      // 处理后的版本，让 contextManager 的 budget summarize / segmentManager 的
      // attention 切段在本 run 内立即生效。
      const newMessages = [
        ...state.messages,
        llmResult.message,
        toolResultMessage([...toolExecutorResult.completedResults]),
      ];
      const turnEnd = await runTurnEnd({
        messages: newMessages,
        turnCount: newTurnCount,
        usage,
        abortSignal: controller.signal,
        contextManager: params.contextManager,
        segmentManager: params.segmentManager,
        systemPrompt: params.systemPrompt ?? "",
        tools: params.tools ?? [],
        conversationId: params.conversationId,
      });
      if (turnEnd.kind === "terminal") {
        return await finalizeRun(turnEnd.result);
      }

      state = {
        messages: turnEnd.messages,
        turnCount: newTurnCount,
        totalUsage: usage,
        transition: { reason: "tool_use" },
      };
    }
  } catch (e) {
    // re-throw 让 consumer 看到原 exception；finally 块据 caughtError 选择补发语义
    caughtError = e;
    throw e;
  } finally {
    // 兜底补发：主路径未走到 finalizeRun（消费者 generator.return() / 内部抛错）时
    // 保证订阅方仍收到 run_end，不让 spinner 永不结束。
    //
    // 区分两种语义：
    //   - caughtError !== null → 内部抛错（provider 未捕获 / engine 异常）→ emit error
    //   - 否则                  → 消费者主动 generator.return() → emit aborted
    //                              （abortReason.origin="consumer-return" 让订阅方区分
    //                              "用户中断"vs"消费者主动 cancel generator"）
    //
    // try-catch 包裹防御 EventBus emit 极端异常：finally 抛错会覆盖原始 exception 或
    // 破坏 generator.return() 的 promise resolve。EventBus 设计上 listener 错误隔离，
    // emit 不应抛错，此处仅作防御性兜底。
    if (!runEndEmitted) {
      try {
        if (caughtError !== null) {
          await finalizeRun({
            reason: "error",
            error: toAgentError(caughtError),
            usage: state.totalUsage,
          });
        } else {
          // 消费者 return 也是一种 abort —— 现在补记 abortFiredAt（如未记），
          // exitDelayMs ≈ 0 反映"return 触发到 finally 执行"几乎无延迟。
          if (abortFiredAt === null) abortFiredAt = performance.now();
          await finalizeRun({
            reason: "aborted",
            abortReason: { kind: "external", origin: "consumer-return" },
            usage: state.totalUsage,
          });
        }
      } catch (emitErr) {
        // emit 失败不能影响 consumer 看到原 exception/return —— 仅日志告警
        console.error("[agent-loop] finally emit failed:", emitErr);
      }
    }
  }
}

// ─── 便捷消费函数 ───

/**
 * 运行 Agent Loop 到完成，收集所有 yield 事件和最终结果。
 *
 * 解决 for-await-of 无法获取 AsyncGenerator return 值的问题。
 * 适用于测试和不需要实时流式处理的场景。
 */
export async function drainAgentLoop(
  params: AgentLoopParams,
): Promise<{ yields: AgentYield[]; result: AgentResult }> {
  const yields: AgentYield[] = [];
  const gen = runAgentLoop(params);

  while (true) {
    const iterResult = await gen.next();
    if (iterResult.done) {
      return { yields, result: iterResult.value };
    }
    yields.push(iterResult.value);
  }
}

// ─── 内部辅助 ───

/**
 * 解析依赖。用户提供的 deps 覆盖默认实现。
 */
function resolveDeps(params: AgentLoopParams): AgentLoopDeps {
  return {
    callLLM: params.deps?.callLLM ?? ((request) => params.provider.chat(request)),
    executeTool: params.deps?.executeTool ?? ((tool, input, ctx) => tool.call(input, ctx)),
  };
}

