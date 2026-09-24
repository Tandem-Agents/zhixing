/**
 * AgentRuntime → SessionRuntime 适配器
 *
 * @zhixing/owner-kernel 定义抽象接口 SessionRuntime（AsyncGenerator 风格），
 * AgentRuntime 是 callback 风格（KernelRunEvent + Promise<KernelRunCompletion>）。
 * 此适配器在两者之间架桥——纯协议适配:会话状态(注意力窗口 / turnCount /
 * 接受协议)归 ConversationManager,adapter 不持有任何会话状态。
 *
 * 关键设计：
 * - 显式投影 KernelRunEvent，再由 queue + waiter 转为 AsyncGenerator AgentYield
 * - 每个 turn 创建独立的 InterruptController(`createInterruptController({ parent })`),
 *   把 controller.signal 透传给 agentRuntime.run 让 LLM call / 工具执行链路真正受控
 * - abort 通过 `abortWithReason(currentController, reason)` 立即触发,主模块 cleanup
 *   路径在 ≤200ms 内自然完成 partial yield + aborted Kernel terminal,
 *   adapter 让事件流自然走完 Kernel Event/.then 不与之竞速
 */

import {
  AgentError,
  type Message,
} from "@zhixing/core/types";
import {
  abortWithReason,
  createInterruptController,
  type AbortReason,
} from "@zhixing/core/interrupt";
import type {
  AgentResult,
  AgentYield,
  RunResult,
} from "@zhixing/core/loop";
import type {
  RunTurnOptions,
  RuntimeDisposeReason,
  SessionRuntime,
} from "@zhixing/owner-kernel/types";
import {
  assertKernelRunEvent,
  assertKernelTerminal,
  type AgentRuntime,
  type KernelRunEvent,
  type KernelRunCompletion,
  type KernelTerminal,
} from "@zhixing/orchestrator/runtime";

// ─── 适配器 ───

type QueueItem =
  | { readonly kind: "yield"; value: AgentYield; acknowledge?: () => void }
  | { readonly kind: "done"; readonly result: RunResult }
  | { readonly kind: "error"; readonly error: unknown };

const MAX_QUEUED_TEXT_CHARS = 4_096;
const MAX_QUEUED_EVENTS = 16;

function deltaLength(value: AgentYield): number {
  return value.type === "text_delta" ? value.text.length
    : value.type === "thinking_delta" ? value.thinking.length : 0;
}

function unhandledConversationKernelEvent(event: never): never {
  throw new TypeError(`Unhandled conversation Kernel event: ${String(event)}`);
}

/** Kernel → Conversation runtime projection. */
function projectKernelEventToConversationYield(
  event: KernelRunEvent,
): AgentYield {
  assertKernelRunEvent(event);
  switch (event.type) {
    case "text_delta":
      return { type: "text_delta", text: event.text };
    case "thinking_block_start":
      return { type: "thinking_block_start" };
    case "thinking_delta":
      return { type: "thinking_delta", thinking: event.thinking };
    case "thinking_block_end":
      return { type: "thinking_block_end" };
    case "assistant_message":
      return {
        type: "assistant_message",
        message: structuredClone(event.message),
      };
    case "tool_start":
      return {
        type: "tool_start",
        id: event.id,
        name: event.name,
        input: structuredClone(event.input),
      };
    case "tool_end":
      return {
        type: "tool_end",
        id: event.id,
        name: event.name,
        result: structuredClone(event.result),
        duration: event.duration,
      };
    case "turn_complete":
      return {
        type: "turn_complete",
        turnCount: event.turnCount,
        usage: structuredClone(event.usage),
      };
    default:
      return unhandledConversationKernelEvent(event);
  }
}

function unhandledConversationKernelTerminal(terminal: never): never {
  throw new TypeError(
    `Unhandled conversation Kernel terminal: ${String(terminal)}`,
  );
}

/** Kernel terminal → Conversation product terminal projection. */
function projectKernelTerminalToConversationAgentResult(
  terminal: KernelTerminal,
): AgentResult {
  assertKernelTerminal(terminal);
  switch (terminal.reason) {
    case "completed":
      return {
        reason: "completed",
        message: terminal.message,
        usage: terminal.usage,
      };
    case "max_turns":
      return {
        reason: "max_turns",
        maxTurns: terminal.maxTurns,
        usage: terminal.usage,
      };
    case "aborted":
      return {
        reason: "aborted",
        usage: terminal.usage,
        ...(terminal.abortReason
          ? { abortReason: terminal.abortReason }
          : {}),
        ...(terminal.exitDelayMs === undefined
          ? {}
          : { exitDelayMs: terminal.exitDelayMs }),
      };
    case "error":
      return {
        reason: "error",
        error: new AgentError(
          terminal.error.message,
          terminal.error.type,
          terminal.error.recoverable,
        ),
        usage: terminal.usage,
      };
    default:
      return unhandledConversationKernelTerminal(terminal);
  }
}

/** Kernel completion → existing Conversation persistence/result contract. */
function projectKernelCompletionToConversationRunResult(
  completion: KernelRunCompletion,
  continuation?: import("@zhixing/core").TurnOrigin["worksceneContinuation"],
): RunResult {
  const artifacts = completion.artifacts;
  return {
    agentResult: projectKernelTerminalToConversationAgentResult(
      completion.terminal,
    ),
    runRecord: {
      ...artifacts.runRecord,
      ...(continuation ? { worksceneContinuation: continuation } : {}),
      ...(completion.terminal.reason === "completed" && artifacts.pendingPostTurnControl
        ? { postTurnControl: artifacts.pendingPostTurnControl }
        : {}),
    },
    // Conversation's legacy RunResult exposes a mutable array. Transfer the
    // Kernel-owned messages by reference and copy only this small container;
    // message/tool/image payloads remain the single artifact object graph.
    newMessages: [...artifacts.newMessages],
    durationMs: artifacts.durationMs,
    ...(artifacts.windowCompact
      ? { windowCompact: artifacts.windowCompact }
      : {}),
    ...(artifacts.pendingPostTurnControl
      ? {
          pendingPostTurnControl: artifacts.pendingPostTurnControl,
        }
      : {}),
  };
}
export function createOwnerRuntimeAdapter(
  sessionId: string,
  agentRuntime: AgentRuntime,
  defaultDisposeReason: RuntimeDisposeReason = "session-dispose",
): SessionRuntime {
  let currentController: AbortController | null = null;
  const activeRuns = new Set<() => Promise<void>>();

  return {
    sessionId,

    // 透传 AgentRuntime 的 broker——让 ConversationManager.attachToHub 能
    // 把 broker 挂到 ConfirmationHub，远程确认链路才完整。broker 是
    // per-AgentRuntime 单例；adapter 只是协议适配，不包装/不复制 broker 身份。
    confirmationBroker: agentRuntime.confirmationBroker,
    drainLifecycleDiagnostics() {
      return agentRuntime.drainLifecycleDiagnostics();
    },

    async *run(
      messages: readonly Message[],
      options?: RunTurnOptions,
    ): AsyncGenerator<AgentYield, RunResult> {
      // 本 turn 专属 controller。caller 传入的 abortSignal(RPC connection close /
      // 上游 abort)作为 parent —— controller 内部用 forkController 实现 parent abort
      // 传播,触发时携带 typed parent reason。已 aborted 的 parent 让子 controller
      // 在创建时就处于 aborted 态,agent loop pre-flight 会自然产 AgentResult.aborted。
      const controller = createInterruptController({
        parent: options?.abortSignal,
      });
      currentController = controller;

      const queue: QueueItem[] = [];
      let queuedChars = 0;
      let closed = false;
      let settled = false;
      let currentAcknowledgement: (() => void) | undefined;
      const waiters: Array<() => void> = [];
      const wakeOne = () => {
        const w = waiters.shift();
        if (w) w();
      };

      // 启动 agent 运行(callback 风格)→ 把事件灌进队列。
      //
      // controller.signal 作为 abortSignal 透传 —— abort 触发后,主模块 cleanup 路径
      // 在 ≤200ms 内自然完成:yield partial assistant_message + turn_complete +
      // 最终 completion 携带 aborted terminal 与 abortReason。
      //
      // adapter 不在 controller.signal 上挂 abort listener 主动 push error 终结
      // consumer loop —— 那样会与主模块 cleanup 路径竞速,抢在 cleanup 完成前抛出,
      // 导致 partial 内容丢失 + abortReason 拿不到 channel 渲染层。
      const producer = Promise.resolve().then(() => agentRuntime.run({
          modelInput: { messages },
          identity: {
            turnIndex: options?.turnIndex ?? 0,
            source: options?.source,
            advancement: options?.advancement,
            turnContext: options?.turnContext,
            // sessionId 即 conversationId（ConversationManager 中是同一标识），
            // 透传到 RunContext 让按需取 conversationId 的工具可用（持久化会话上下文）。
            conversationId: sessionId,
            runId: options?.runId,
            assignmentId: options?.assignmentId,
          },
          control: {
            abortSignal: controller.signal,
            modelCallResourceMeter: options?.modelCallResourceMeter,
          },
          correctness: {
            inputPort: options?.inputPort,
            toolSideEffectObserver: options?.toolSideEffectObserver,
            authorizeToolExecution: options?.authorizeToolExecution,
            assignmentMutations: options?.assignmentMutations,
            globalQuery: options?.globalQuery,
            assignmentIssuedAt: options?.assignmentIssuedAt,
            resourceReservation: options?.resourceReservation,
          },
          observation: {
            onEvent: (event) => {
              if (closed) return;
              const value = projectKernelEventToConversationYield(event);
              const previous = queue.at(-1);
              let item: Extract<QueueItem, { kind: "yield" }>;
              // Only queued, adjacent deltas may merge. A yielded object is
              // already owned by the durable consumer and never changes.
              if (previous?.kind === "yield" && previous.value.type === "text_delta" && value.type === "text_delta") {
                previous.value = { type: "text_delta", text: previous.value.text + value.text };
                item = previous;
              } else if (previous?.kind === "yield" && previous.value.type === "thinking_delta" && value.type === "thinking_delta") {
                previous.value = { type: "thinking_delta", thinking: previous.value.thinking + value.thinking };
                item = previous;
              } else {
                item = { kind: "yield", value };
                queue.push(item);
              }
              queuedChars += deltaLength(value);
              wakeOne();
              if ((value.type !== "text_delta" && value.type !== "thinking_delta") ||
                  queuedChars >= MAX_QUEUED_TEXT_CHARS || queue.length >= MAX_QUEUED_EVENTS) {
                return new Promise<void>((resolve) => {
                  const previousAcknowledgement = item.acknowledge;
                  item.acknowledge = () => { previousAcknowledgement?.(); resolve(); };
                });
              }
            },
            onProtocolEvent: options?.onProtocolEvent,
          },
        }))
        .then(
          (completion) => {
            settled = true;
            try {
              queue.push({
                kind: "done",
                result: projectKernelCompletionToConversationRunResult(completion, options?.turnContext?.turnOrigin?.worksceneContinuation),
              });
            } catch (error) { queue.push({ kind: "error", error }); }
            wakeOne();
          },
          // throw 分支兜底:provider 网络错 / 编程错等。abort 不走此分支 ——
          // run-agent.ts 把 abortSignal 触发统一包成 AgentResult.aborted with
          // abortReason 通过 .then(success) 返回。
          (err) => {
            settled = true;
            queue.push({ kind: "error", error: err });
            wakeOne();
          },
        );

      let closing: Promise<void> | undefined;
      const closeRun = (): Promise<void> => {
        if (closing) return closing;
        closed = true;
        if (!settled && !controller.signal.aborted) {
          abortWithReason(controller, { kind: "external", origin: "session-runtime-consumer-closed" });
        }
        currentAcknowledgement?.();
        for (const item of queue) if (item.kind === "yield") item.acknowledge?.();
        // dispose may arrive after the producer settled but before its terminal
        // was consumed. It will not enqueue another terminal to wake next().
        const terminal = queue.find((item) => item.kind !== "yield");
        queue.length = 0;
        if (terminal) { queue.push(terminal); wakeOne(); }
        queuedChars = 0;
        closing = producer.finally(() => {
          activeRuns.delete(closeRun);
          if (currentController === controller) currentController = null;
        });
        return closing;
      };
      activeRuns.add(closeRun);

      try {
        // 消费循环：从队列拉事件并 yield/return/throw
        while (true) {
          // A wake does not reserve an item: dispose can clear queued yields
          // before this continuation runs. Wait again for the real terminal.
          while (queue.length === 0) {
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
          const item = queue.shift()!;
          if (item.kind === "yield") {
            queuedChars -= deltaLength(item.value);
            currentAcknowledgement = item.acknowledge;
            try { yield item.value; }
            finally { currentAcknowledgement?.(); currentAcknowledgement = undefined; }
          } else if (item.kind === "done") {
            return item.result;
          } else {
            throw item.error;
          }
        }
      } finally {
        // Closing the generator also closes the callback producer. Release
        // consumer acknowledgements before joining its asynchronous cleanup.
        await closeRun();
      }
    },

    abort(reason?: AbortReason): boolean {
      const ctrl = currentController;
      if (!ctrl || ctrl.signal.aborted) return false;
      abortWithReason(
        ctrl,
        reason ?? { kind: "external", origin: "session-runtime-abort" },
      );
      return true;
    },

    // ─── 会话命令执行体能力透传(/clear /compact 与 turn 后维护) ───
    // 适配器只做协议适配:窗口操作的应用归 ConversationManager,此处原样透出
    // 底层运行体的能力,返回结构与 owner-kernel 的结构形声明天然兼容。

    async forceCompact(messages, turnCount) {
      const result = await agentRuntime.forceCompact([...messages], turnCount);
      return {
        modified: result.modified,
        windowCompact: result.windowCompact,
        emergencyFloor: result.emergencyFloor,
      };
    },

    onAttentionWindowChange(reason) {
      return agentRuntime.onAttentionWindowChange(reason);
    },

    withRunObservation(identity, work) {
      return agentRuntime.withRunObservation ? agentRuntime.withRunObservation(identity, work) : work();
    },

    callText(prompt, role, opts) {
      return agentRuntime.callText(prompt, role, opts);
    },

    callTextWithUsage(prompt, role, opts) {
      return agentRuntime.callTextWithUsage(prompt, role, opts);
    },

    runOrchestrationV1(params) {
      return agentRuntime.runOrchestrationV1(params);
    },

    estimateConversationRequestBudget(messages) {
      return agentRuntime.estimateConversationRequestBudget(messages);
    },

    estimateMessagesTokens(messages) {
      return agentRuntime.estimateMessagesTokens(messages);
    },

    subAgentUsages(messages) {
      return agentRuntime.subAgentUsages(messages);
    },

    securitySnapshot() {
      return agentRuntime.securitySnapshot();
    },

    executionPermissionRules() {
      return agentRuntime.executionPermissionRules();
    },

    executionProfile() {
      return agentRuntime.executionProfile();
    },

    get calibrationFactor() {
      return agentRuntime.calibrationFactor;
    },

    async dispose(reason = defaultDisposeReason) {
      // 透传底层运行体末窗 onWindowClose —— 每个会话经 createAgentRuntime
      // 建 main runtime（首窗 onWindowOpen 已触发）,销毁须触发其末窗。
      await Promise.all([...activeRuns].map((close) => close()));
      await agentRuntime.dispose(reason);
    },
  };
}

/** Adapter for a runtime whose lifetime is exactly one durable assignment. */
export function createAssignmentRuntimeAdapter(
  sessionId: string,
  agentRuntime: AgentRuntime,
): SessionRuntime {
  return createOwnerRuntimeAdapter(
    sessionId,
    agentRuntime,
    "assignment-dispose",
  );
}
