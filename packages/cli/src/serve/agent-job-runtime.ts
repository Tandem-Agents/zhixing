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
      let activeJoin: (() => Promise<void>) | undefined;
      let activeUnlinkAbort: (() => void) | undefined;
      let disposeTask: Promise<void> | undefined;
      let handleDisposed = false;

      const disposeOnce = (): Promise<void> => {
        if (!runtime) return Promise.resolve();
        disposeTask ??= runtime.dispose("session-dispose");
        return disposeTask;
      };

      return {
        async *run(
          instruction: JobExecutionInstruction,
          options: JobRuntimeRunOptions,
        ): AsyncGenerator<AgentYield, JobRunOutcome> {
          if (handleDisposed) {
            throw new Error("A disposed job runtime handle cannot execute");
          }
          if (runtime) {
            throw new Error("A job runtime handle may execute only one instruction");
          }
          runtime = await factory.create(instruction, confirmationBroker);
          if (handleDisposed) {
            await disposeOnce();
            throw new Error("A disposed job runtime handle cannot execute");
          }
          const yields = new AsyncYieldQueue();
          const stop = new AbortController();
          const unlinkAbort = forwardAbort(options.abortSignal, stop);
          activeUnlinkAbort = unlinkAbort;
          const settled = Promise.resolve()
            .then(() =>
              runtime!.run({
                modelInput: {
                  messages: [userMessage(instruction.prompt)],
                },
                identity: { turnIndex: 0, source: "scheduler" },
                control: {
                  abortSignal: stop.signal,
                  modelCallResourceMeter: options.modelCallResourceMeter,
                },
                correctness: {
                  authorizeToolExecution: options.authorizeToolExecution,
                  toolSideEffectObserver: options.toolSideEffectObserver,
                  stageScheduleMutation: options.stageScheduleMutation,
                  assignmentMutations: options.assignmentMutations,
                  globalQuery: options.globalQuery,
                  assignmentIssuedAt: options.assignmentIssuedAt,
                  resourceReservation: options.resourceReservation,
                },
                observation: {
                  onYield: (event) => yields.push(event),
                  onProtocolEvent: (event) => options.onProtocolEvent(event),
                },
              }),
            )
            .then(
              (result) => ({ ok: true as const, result }),
              (error: unknown) => ({ ok: false as const, error }),
            );
          void settled.then(() => yields.close());
          const join = async (): Promise<void> => {
            if (!stop.signal.aborted) {
              stop.abort(new Error("Job runtime consumer stopped before completion"));
            }
            await settled;
          };
          activeJoin = join;

          let completed = false;
          let primaryFailure = false;
          try {
            while (true) {
              const next = await yields.next();
              if (next.done) break;
              yield next.value;
            }
            const outcome = await settled;
            if (!outcome.ok) throw outcome.error;
            const agentResult = outcome.result.agentResult;
            const usage = agentResult.usage;
            completed = true;
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
          } catch (error) {
            primaryFailure = true;
            throw error;
          } finally {
            unlinkAbort();
            activeUnlinkAbort = undefined;
            if (!completed) await join();
            try {
              await disposeOnce();
            } catch (error) {
              if (!primaryFailure) throw error;
            }
          }
        },
        async dispose() {
          handleDisposed = true;
          activeUnlinkAbort?.();
          activeUnlinkAbort = undefined;
          await activeJoin?.();
          await disposeOnce();
        },
      };
    },
  };
}

class AsyncYieldQueue {
  readonly #items: AgentYield[] = [];
  #waiter: (() => void) | undefined;
  #closed = false;

  push(item: AgentYield): void {
    if (this.#closed) throw new Error("Job yield queue is closed");
    this.#items.push(item);
    this.#wake();
  }

  close(): void {
    if (this.#closed) return;
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
    return { done: true, value: undefined };
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.();
  }
}

function forwardAbort(
  source: AbortSignal,
  target: AbortController,
): () => void {
  const abort = () => target.abort(source.reason);
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}
