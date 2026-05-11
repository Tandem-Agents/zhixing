/**
 * AgentRuntime → SessionRuntime 适配器
 *
 * @zhixing/server 定义了抽象接口 SessionRuntime（AsyncGenerator 风格），
 * @zhixing/cli 的 AgentRuntime 是 callback 风格（onYield + Promise<RunResult>）。
 * 此适配器在两者之间架桥。
 *
 * 关键设计：
 * - 一个 AgentRuntime 实例对应一个 SessionRuntime（持久化对话历史）
 * - queue + waiter 模式把 onYield 回调转为 AsyncGenerator yield
 * - 每个 turn 创建独立的 InterruptController(`createInterruptController({ parent })`),
 *   把 controller.signal 透传给 agentRuntime.run 让 LLM call / 工具执行链路真正受控
 * - abort 通过 `abortWithReason(currentController, reason)` 立即触发,主模块 cleanup
 *   路径在 ≤200ms 内自然完成 partial yield + RunResult.aborted with abortReason,
 *   adapter 让事件流自然走完 onYield/.then 不与之竞速
 */

import {
  abortWithReason,
  createInterruptController,
  userMessage,
  type AbortReason,
  type Message,
  type AgentYield,
  type RunResult,
  type TurnSource,
} from "@zhixing/core";
import type {
  RunTurnOptions,
  RuntimeFactory,
  SessionRuntime,
  TurnContext,
} from "@zhixing/server";
import type { AgentRuntime } from "@zhixing/orchestrator/runtime";

// ─── 适配器 ───

interface QueueItem {
  kind: "yield" | "done" | "error";
  value?: AgentYield;
  result?: RunResult;
  error?: unknown;
}

export function createServerRuntimeAdapter(
  sessionId: string,
  agentRuntime: AgentRuntime,
  initialMessages?: Message[],
): SessionRuntime {
  let messages: Message[] = initialMessages ? [...initialMessages] : [];
  let currentController: AbortController | null = null;

  return {
    sessionId,

    // 透传 AgentRuntime 的 broker——让 ConversationManager.attachToHub 能
    // 把 broker 挂到 ConfirmationHub，远程确认链路才完整。broker 是
    // per-AgentRuntime 单例；adapter 只是协议适配，不包装/不复制 broker 身份。
    confirmationBroker: agentRuntime.confirmationBroker,

    async *run(
      text,
      abortSignalOrOptions?: AbortSignal | RunTurnOptions,
    ): AsyncGenerator<AgentYield, RunResult> {
      const { abortSignal, turnContext, turnIndex, source } = unpackOptions(abortSignalOrOptions);

      // 本 turn 专属 controller。caller 传入的 abortSignal(RPC connection close /
      // 上游 abort)作为 parent —— controller 内部用 forkController 实现 parent abort
      // 传播,触发时携带 typed parent reason。已 aborted 的 parent 让子 controller
      // 在创建时就处于 aborted 态,agent loop pre-flight 会自然产 AgentResult.aborted。
      const controller = createInterruptController({ parent: abortSignal });
      currentController = controller;

      // 入口必 push,non-completed / throw 分支按 reason 判断 pop —— 防孤儿 userMsg
      // 的 adapter 层第一道防线(与 runTurnWithCommit 的 updateMessages 回滚是双保险)。
      messages.push(userMessage(text));

      const queue: QueueItem[] = [];
      const waiters: Array<() => void> = [];
      const wakeOne = () => {
        const w = waiters.shift();
        if (w) w();
      };

      // 启动 agent 运行(callback 风格)→ 把事件灌进队列。
      //
      // controller.signal 作为 abortSignal 透传 —— abort 触发后,主模块 cleanup 路径
      // 在 ≤200ms 内自然完成:yield partial assistant_message + turn_complete +
      // 最终 .then(runResult) 携带 RunResult.agentResult.reason="aborted" 与 abortReason。
      //
      // adapter 不在 controller.signal 上挂 abort listener 主动 push error 终结
      // consumer loop —— 那样会与主模块 cleanup 路径竞速,抢在 cleanup 完成前抛出,
      // 导致 partial 内容丢失 + abortReason 拿不到 channel 渲染层。
      agentRuntime
        .run({
          messages: [...messages],
          turnIndex: turnIndex ?? 0,
          source,
          turnContext,
          // sessionId 即 conversationId（ConversationManager 中是同一标识，
          // RuntimeInfo.sessionId 是 conversationId 的向后兼容别名），透传到
          // RunContext 让按需取 conversationId 的工具可用（持久化会话上下文）。
          conversationId: sessionId,
          abortSignal: controller.signal,
          onYield: (event) => {
            queue.push({ kind: "yield", value: event });
            wakeOne();
          },
        })
        .then(
          (runResult) => {
            queue.push({ kind: "done", result: runResult });
            wakeOne();
          },
          // throw 分支兜底:provider 网络错 / 编程错等。abort 不走此分支 ——
          // run-agent.ts 把 abortSignal 触发统一包成 AgentResult.aborted with
          // abortReason 通过 .then(success) 返回。
          (err) => {
            queue.push({ kind: "error", error: err });
            wakeOne();
          },
        );

      try {
        // 消费循环：从队列拉事件并 yield/return/throw
        while (true) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => waiters.push(resolve));
          }
          const item = queue.shift()!;
          if (item.kind === "yield") {
            yield item.value!;
          } else if (item.kind === "done") {
            // non-completed(error / max_turns / aborted)→ pop userMsg 防孤儿。
            // aborted 路径下,partial assistant_message 已通过 yield 流出去给 channel
            // 消费,adapter.messages 里仅有本轮 userMsg(无 assistant 配对)→ 必须 pop。
            const runResult = item.result!;
            if (runResult.agentResult.reason !== "completed") {
              messages.pop();
            }
            return runResult;
          } else {
            // throw 路径(provider 网络错 / 编程错):无对应 assistant,pop userMsg 防孤儿。
            messages.pop();
            throw item.error;
          }
        }
      } finally {
        // 仅清当前 turn 的 controller 引用 —— 防止后续重入(下一个 turn 已 set 新 ctrl)
        // 误清掉新 controller。
        if (currentController === controller) currentController = null;
      }
    },

    getHistory(limit) {
      return limit ? messages.slice(-limit) : [...messages];
    },

    updateMessages(canonical) {
      // 单一事实源：调用方通过 commitTurn 拿到 canonical 后回喂，
      // adapter 内部 messages 整体替换（不是 append）—— 下次 run 的 `[...messages]`
      // 作为 agent-loop 的输入时，自带压缩效果，跨 run 状态与磁盘严格一致。
      messages = [...canonical];
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

    dispose() {
      messages = [];
    },
  };
}

// ─── 工具：兼容 legacy AbortSignal 和 RunTurnOptions 两种第二参 ───

function unpackOptions(
  arg?: AbortSignal | RunTurnOptions,
): {
  abortSignal?: AbortSignal;
  turnContext?: TurnContext;
  turnIndex?: number;
  source?: TurnSource;
} {
  if (!arg) return {};
  // AbortSignal 有 aborted 字段且无 turnContext/abortSignal 字段
  if ("aborted" in arg && typeof (arg as AbortSignal).aborted === "boolean") {
    return { abortSignal: arg as AbortSignal };
  }
  const opts = arg as RunTurnOptions;
  return {
    abortSignal: opts.abortSignal,
    turnContext: opts.turnContext,
    turnIndex: opts.turnIndex,
    source: opts.source,
  };
}

// ─── RuntimeFactory 实现 ───

export interface RuntimeFactoryOptions {
  /** 创建 AgentRuntime 的工厂方法（注入避免对 createAgentRuntime 的硬依赖） */
  createAgentRuntime: (sessionId: string) => Promise<AgentRuntime>;
}

/**
 * 给 @zhixing/server 用的 RuntimeFactory。
 * 每次 create 都新建一个 AgentRuntime（独立 provider 连接、独立工具集）。
 */
export function createCliRuntimeFactory(opts: RuntimeFactoryOptions): RuntimeFactory {
  return {
    async create(sessionId, initialMessages) {
      const agentRuntime = await opts.createAgentRuntime(sessionId);
      return createServerRuntimeAdapter(sessionId, agentRuntime, initialMessages);
    },
  };
}
