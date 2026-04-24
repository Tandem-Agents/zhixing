/**
 * AgentRuntime → SessionRuntime 适配器
 *
 * @zhixing/server 定义了抽象接口 SessionRuntime（AsyncGenerator 风格），
 * @zhixing/cli 的 AgentRuntime 是 callback 风格（onYield + Promise<RunResult>）。
 * 此适配器在两者之间架桥。
 *
 * 关键设计：
 * - 一个 AgentRuntime 实例对应一个 SessionRuntime（持久化对话历史）
 * - 用 queue + waiter 模式把 onYield 回调转为 AsyncGenerator yield
 * - abort 通过 AbortController 联动到 SecurityPipeline 等环节
 */

import {
  userMessage,
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
import type { AgentRuntime } from "../run-agent.js";

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
  let aborted = false;

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

      if (aborted) {
        aborted = false;
        throw new Error("Session aborted");
      }
      if (abortSignal?.aborted) {
        throw new Error("Aborted");
      }

      messages.push(userMessage(text));
      let turnAborted = false;

      const queue: QueueItem[] = [];
      const waiters: Array<() => void> = [];
      const wakeOne = () => {
        const w = waiters.shift();
        if (w) w();
      };

      const onAbort = () => {
        turnAborted = true;
        queue.push({ kind: "error", error: new Error("Aborted") });
        wakeOne();
      };
      abortSignal?.addEventListener("abort", onAbort, { once: true });

      // 启动 agent 运行（callback 风格）→ 把事件灌进队列。
      // done 队列项携带完整 RunResult—— 调用方据此走 commitTurn 单一持久化入口。
      // 注意：adapter 内部 messages 在 run 成功后 **不再** 自动 push newMessages；
      // 调用方应在 recordTurn 后用 updateMessages(canonical) 回喂（单向数据流）。
      // 失败分支仍 pop 掉 userMessage 做回滚（避免连续 user 消息破坏下一次 run）。
      agentRuntime
        .run({
          messages: [...messages],
          turnIndex: turnIndex ?? 0,
          source,
          turnContext,
          onYield: (event) => {
            if (turnAborted) return;
            queue.push({ kind: "yield", value: event });
            wakeOne();
          },
        })
        .then(
          (runResult) => {
            if (!turnAborted) {
              queue.push({ kind: "done", result: runResult });
              wakeOne();
            }
          },
          (err) => {
            if (!turnAborted) {
              queue.push({ kind: "error", error: err });
              wakeOne();
            }
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
            // 非 completed 路径自修：
            //
            //   agent-loop 返回 reason ∈ {error, max_turns, aborted} 时，caller
            //   按约定不调 recordTurn → updateMessages 永不执行 → 入口 push 的
            //   userMsg 变成"孤儿 user 消息"（无对应 assistant）。下一轮 run 的
            //   LLM 输入会出现两个连续 user 块 —— Anthropic / OpenAI 协议违反。
            //
            //   adapter 是 userMsg 的 push 者，也应是"owner not taken"时的回滚者。
            //   此处 pop 和 runtime.updateMessages(canonical) 互斥：completed 路径
            //   保留 userMsg 让 caller 覆盖；non-completed 路径由 adapter 自行回滚。
            //
            //   abortSignal 触发的场景走下面的 error 分支（turnAborted=true 那条），
            //   和此处 non-completed 的 reason="aborted"（agent-loop 内部 abort 检查）
            //   是两条不同路径，都需要 pop。
            const runResult = item.result!;
            if (runResult.agentResult.reason !== "completed") {
              messages.pop();
            }
            return runResult;
          } else {
            if (turnAborted) {
              messages.pop();
            }
            throw item.error;
          }
        }
      } finally {
        abortSignal?.removeEventListener("abort", onAbort);
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

    abort() {
      aborted = true;
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
