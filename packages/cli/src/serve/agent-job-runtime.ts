import {
  extractText,
  userMessage,
  type AgentYield,
  type IConfirmationBroker,
} from "@zhixing/core";
import type { JobExecutionInstruction } from "@zhixing/core/contracts";
import type { AgentRuntime } from "@zhixing/orchestrator/runtime";
import type {
  JobRunOutcome,
  JobRuntimePort,
  JobRuntimeRunOptions,
} from "./job-assignment-worker.js";

export interface AgentJobRuntimeFactory {
  create(
    instruction: JobExecutionInstruction,
    confirmationBroker: IConfirmationBroker,
  ): Promise<AgentRuntime>;
}

/** Bridges the canonical AgentRuntime into the executor-owned job runtime contract. */
export function createAgentJobRuntimePort(
  factory: AgentJobRuntimeFactory,
): JobRuntimePort {
  return {
    async create({ confirmationBroker }) {
      let runtime: AgentRuntime | undefined;
      return {
        async *run(
          instruction: JobExecutionInstruction,
          options: JobRuntimeRunOptions,
        ): AsyncGenerator<AgentYield, JobRunOutcome> {
          if (runtime) {
            throw new Error("A job runtime handle may execute only one instruction");
          }
          runtime = await factory.create(instruction, confirmationBroker);
          const yields = new AsyncYieldQueue();
          const running = runtime
            .run({
              messages: [userMessage(instruction.prompt)],
              turnIndex: 0,
              source: "scheduler",
              abortSignal: options.abortSignal,
              onYield: (event) => yields.push(event),
              onProtocolEvent: (event) => options.onProtocolEvent(event),
              authorizeToolExecution: options.authorizeToolExecution,
              toolSideEffectObserver: options.toolSideEffectObserver,
            })
            .then(
              (result) => {
                yields.close();
                return result;
              },
              (error) => {
                yields.fail(error);
                throw error;
              },
            );

          while (true) {
            const next = await yields.next();
            if (next.done) break;
            yield next.value;
          }
          const result = await running;
          const agentResult = result.agentResult;
          const usage = agentResult.usage;
          if (agentResult.reason === "completed") {
            return {
              status: "completed",
              summary: extractText(agentResult.message),
              contentAssets: [],
              usage,
            };
          }
          return {
            status: "failed",
            summary:
              agentResult.reason === "error"
                ? agentResult.error.message
                : agentResult.reason === "aborted"
                  ? "Job execution was aborted"
                  : `Job execution reached ${agentResult.maxTurns} turns`,
            contentAssets: [],
            usage,
          };
        },
        async dispose() {
          await runtime?.dispose("session-dispose");
        },
      };
    },
  };
}

class AsyncYieldQueue {
  readonly #items: AgentYield[] = [];
  #waiter: (() => void) | undefined;
  #closed = false;
  #error: unknown;

  push(item: AgentYield): void {
    if (this.#closed) throw new Error("Job yield queue is closed");
    this.#items.push(item);
    this.#wake();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  fail(error: unknown): void {
    this.#error = error;
    this.#closed = true;
    this.#wake();
  }

  async next(): Promise<IteratorResult<AgentYield>> {
    while (this.#items.length === 0 && !this.#closed) {
      await new Promise<void>((resolve) => {
        this.#waiter = resolve;
      });
    }
    const item = this.#items.shift();
    if (item) return { done: false, value: item };
    if (this.#error) throw this.#error;
    return { done: true, value: undefined };
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.();
  }
}
