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
  type AgentResult,
  type AgentYield,
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
  result?: AgentResult;
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
    ): AsyncGenerator<AgentYield, AgentResult> {
      const { abortSignal, turnContext } = unpackOptions(abortSignalOrOptions);

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

      // 启动 agent 运行（callback 风格）→ 把事件灌进队列
      agentRuntime
        .run({
          messages: [...messages],
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
              messages.push(...runResult.newMessages);
              queue.push({ kind: "done", result: runResult.agentResult });
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
            return item.result!;
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
): { abortSignal?: AbortSignal; turnContext?: TurnContext } {
  if (!arg) return {};
  // AbortSignal 有 aborted 字段且无 turnContext/abortSignal 字段
  if ("aborted" in arg && typeof (arg as AbortSignal).aborted === "boolean") {
    return { abortSignal: arg as AbortSignal };
  }
  const opts = arg as RunTurnOptions;
  return { abortSignal: opts.abortSignal, turnContext: opts.turnContext };
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
