/**
 * AgentSession → ServerSession 适配器
 *
 * @zhixing/server 定义了抽象接口 ServerSession（AsyncGenerator 风格），
 * @zhixing/cli 的 AgentSession 是 callback 风格（onYield + Promise<RunResult>）。
 * 此适配器在两者之间架桥。
 *
 * 关键设计：
 * - 一个 AgentSession 实例对应一个 ServerSession（持久化对话历史）
 * - 用 queue + waiter 模式把 onYield 回调转为 AsyncGenerator yield
 * - abort 通过 AbortController 联动到 SecurityPipeline 等环节
 *
 * 注意：CLI 的 AgentSession 没有 abort 入口（design choice），所以 abort
 * 只能在适配器层标记中断，让下次 run 立即返回错误。
 */

import {
  userMessage,
  type Message,
  type AgentResult,
  type AgentYield,
} from "@zhixing/core";
import type { ServerSession, SessionFactory } from "@zhixing/server";
import type { AgentSession } from "../run-agent.js";

// ─── 适配器 ───

interface QueueItem {
  kind: "yield" | "done" | "error";
  value?: AgentYield;
  result?: AgentResult;
  error?: unknown;
}

export function createServerSessionAdapter(
  sessionId: string,
  agentSession: AgentSession,
): ServerSession {
  let messages: Message[] = [];
  let aborted = false;

  return {
    sessionId,

    async *run(text): AsyncGenerator<AgentYield, AgentResult> {
      if (aborted) {
        // 上一次 abort 后立即报错（避免泄漏到 LLM 调用）
        aborted = false; // 重置，允许下次 run
        throw new Error("Session aborted");
      }

      messages.push(userMessage(text));

      const queue: QueueItem[] = [];
      const waiters: Array<() => void> = [];
      const wakeOne = () => {
        const w = waiters.shift();
        if (w) w();
      };

      // 启动 agent 运行（callback 风格）→ 把事件灌进队列
      const runPromise = agentSession
        .run({
          messages: [...messages],
          onYield: (event) => {
            queue.push({ kind: "yield", value: event });
            wakeOne();
          },
        })
        .then(
          (runResult) => {
            messages.push(...runResult.newMessages);
            queue.push({ kind: "done", result: runResult.agentResult });
            wakeOne();
          },
          (err) => {
            queue.push({ kind: "error", error: err });
            wakeOne();
          },
        );

      // 消费循环：从队列拉事件并 yield/return/throw
      while (true) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
        const item = queue.shift()!;
        if (item.kind === "yield") {
          yield item.value!;
        } else if (item.kind === "done") {
          // 等 runPromise 完全 settle，避免 unhandled rejection
          await runPromise;
          return item.result!;
        } else {
          await runPromise.catch(() => {});
          throw item.error;
        }
      }
    },

    getHistory(limit) {
      return limit ? messages.slice(-limit) : [...messages];
    },

    abort() {
      aborted = true;
      // CLI 的 AgentSession 当前不暴露 abort signal——只能通过 flag 影响下次 run
      // S2.5 AgentOrchestrator 阶段会引入更深的 abort 链路
    },

    dispose() {
      messages = [];
    },
  };
}

// ─── SessionFactory 实现 ───

export interface SessionFactoryOptions {
  /** 创建 AgentSession 的工厂方法（注入避免对 createSession 的硬依赖） */
  createAgentSession: () => Promise<AgentSession>;
}

/**
 * 给 @zhixing/server 用的 SessionFactory。
 * 每次 create 都新建一个 AgentSession（独立 provider 连接、独立工具集）。
 */
export function createCliSessionFactory(opts: SessionFactoryOptions): SessionFactory {
  return {
    async create(sessionId) {
      const agentSession = await opts.createAgentSession();
      return createServerSessionAdapter(sessionId, agentSession);
    },
  };
}
