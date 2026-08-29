import {
  userMessage,
  type AbortReason,
  type AgentYield,
  type IConfirmationBroker,
  type ToolSideEffectObserver,
} from "@zhixing/core";
import { createExecutorRole, createInProcessAssignmentRuntimeFactory } from "@zhixing/executor";
import type {
  AgentRuntime,
  KernelRunCompletion,
  KernelRunEnvelope,
  KernelRunEvent,
  KernelTerminal,
} from "@zhixing/orchestrator/runtime";
import type { SessionRuntime } from "@zhixing/owner-kernel";
import { createOwnerRuntimeAdapter } from "@zhixing/runtime-host/session-adapter";
import { describe, expect, it, vi } from "vitest";
import { createAgentJobRuntimePort } from "../agent-job-runtime.js";
import { runEphemeralTurn } from "../ephemeral-executor.js";

const EVENTS: readonly KernelRunEvent[] = [
  { type: "text_delta", text: "first" },
  { type: "text_delta", text: "second" },
  {
    type: "turn_complete",
    turnCount: 1,
    usage: { inputTokens: 2, outputTokens: 3 },
  },
];
const USAGE = { inputTokens: 2, outputTokens: 3 } as const;
const ABORT_REASON: AbortReason = {
  kind: "external",
  origin: "kernel-conformance",
};
const REPLACEMENT_ABORT_REASON: AbortReason = {
  kind: "external",
  origin: "must-not-replace-first-reason",
};
const KERNEL_FAILURE = new Error("kernel conformance failure");

type ConformanceStatus = "completed" | "aborted" | "failed";

interface BindingObservation {
  readonly status: ConformanceStatus;
  readonly events: readonly AgentYield[];
}

interface KernelBinding {
  readonly confirmationBroker: IConfirmationBroker;
  run(prompt: "complete" | "cancel" | "fail"): Promise<BindingObservation>;
  cancel(reason: AbortReason): boolean;
  dispose(): Promise<void>;
}

interface KernelProbe {
  readonly runtime: AgentRuntime;
  readonly confirmationBroker: IConfirmationBroker;
  readonly envelopes: KernelRunEnvelope[];
  readonly terminals: KernelTerminal[];
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly firstEvent: Promise<void>;
}

interface ConformanceCase {
  readonly name: string;
  create(probe: KernelProbe, identity: string): Promise<KernelBinding>;
  assertEnvelope(envelope: KernelRunEnvelope, identity: string): void;
  readonly expectedDisposeReason:
    | "session-dispose"
    | "assignment-dispose";
}

function promptFrom(envelope: KernelRunEnvelope): string {
  const first = envelope.modelInput.messages[0]?.content[0];
  if (!first || first.type !== "text") {
    throw new TypeError("Kernel conformance requires one text prompt");
  }
  return first.text;
}

function completion(terminal: KernelTerminal): KernelRunCompletion {
  return {
    terminal,
    artifacts: {
      runRecord: {
        timestamp: "2026-08-29T00:00:00.000Z",
        messages: [],
        usage: USAGE,
      },
      newMessages: [],
      durationMs: 7,
    },
  };
}

function createKernelProbe(): KernelProbe {
  const confirmationBroker = {} as IConfirmationBroker;
  const envelopes: KernelRunEnvelope[] = [];
  const terminals: KernelTerminal[] = [];
  const dispose = vi.fn(async () => undefined);
  let resolveFirstEvent!: () => void;
  const firstEvent = new Promise<void>((resolve) => {
    resolveFirstEvent = resolve;
  });

  const runtime = Object.assign({} as AgentRuntime, {
    confirmationBroker,
    dispose,
    async run(envelope: KernelRunEnvelope): Promise<KernelRunCompletion> {
      envelopes.push(envelope);
      const prompt = promptFrom(envelope);
      if (prompt === "fail") throw KERNEL_FAILURE;

      await envelope.observation.onEvent?.(EVENTS[0]!);
      resolveFirstEvent();
      if (prompt === "cancel") {
        const signal = envelope.control.abortSignal;
        if (!signal) throw new Error("Cancellation binding omitted abortSignal");
        if (!signal.aborted) {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        const terminal: KernelTerminal = {
          reason: "aborted",
          usage: USAGE,
          abortReason: signal.reason as AbortReason,
        };
        terminals.push(terminal);
        return completion(terminal);
      }

      await envelope.observation.onEvent?.(EVENTS[1]!);
      await envelope.observation.onEvent?.(EVENTS[2]!);
      const terminal: KernelTerminal = {
        reason: "completed",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "complete" }],
        },
        usage: USAGE,
      };
      terminals.push(terminal);
      return completion(terminal);
    },
  });
  return {
    runtime,
    confirmationBroker,
    envelopes,
    terminals,
    dispose,
    firstEvent,
  };
}

async function collectSession(
  runtime: SessionRuntime,
  prompt: string,
): Promise<BindingObservation> {
  const events: AgentYield[] = [];
  try {
    const iterator = runtime.run([userMessage(prompt)], {
      turnIndex: 4,
      source: "interactive",
    });
    while (true) {
      const next = await iterator.next();
      if (next.done) {
        const reason = next.value.agentResult.reason;
        return {
          status:
            reason === "completed"
              ? "completed"
              : reason === "aborted"
                ? "aborted"
                : "failed",
          events,
        };
      }
      events.push(next.value);
    }
  } catch (error) {
    expect(error).toBe(KERNEL_FAILURE);
    return { status: "failed", events };
  }
}

function sessionBinding(runtime: SessionRuntime): KernelBinding {
  return {
    confirmationBroker: runtime.confirmationBroker!,
    run: (prompt) => collectSession(runtime, prompt),
    cancel: (reason) => runtime.abort(reason),
    dispose: () => runtime.dispose(),
  } satisfies KernelBinding;
}

const CASES: readonly ConformanceCase[] = [
  {
    name: "conversation",
    async create(probe, identity) {
      return sessionBinding(createOwnerRuntimeAdapter(identity, probe.runtime));
    },
    assertEnvelope(envelope, identity) {
      expect(envelope.identity).toMatchObject({
        conversationId: identity,
        turnIndex: 4,
        source: "interactive",
      });
    },
    expectedDisposeReason: "session-dispose",
  },
  {
    name: "scheduled ephemeral",
    async create(probe, identity) {
      let active: AbortController | undefined;
      return {
        confirmationBroker: probe.confirmationBroker,
        async run(prompt) {
          const events: AgentYield[] = [];
          active = new AbortController();
          const result = await runEphemeralTurn({
            runtime: probe.runtime,
            prompt,
            abortSignal: active.signal,
            turnContext: {
              turnId: identity,
              turnOrigin: { channel: "scheduler", triggeredBy: identity },
            },
            onYield: (event) => events.push(event),
          });
          const status: ConformanceStatus =
            prompt === "fail"
              ? "failed"
              : prompt === "cancel"
                ? "aborted"
                : result.status === "ok"
                  ? "completed"
                  : "failed";
          return { status, events };
        },
        cancel(reason) {
          if (!active || active.signal.aborted) return false;
          active.abort(reason);
          return true;
        },
        dispose: () => probe.runtime.dispose("session-dispose"),
      } satisfies KernelBinding;
    },
    assertEnvelope(envelope, identity) {
      expect(envelope.identity).toMatchObject({
        turnIndex: 0,
        turnContext: {
          turnId: identity,
          turnOrigin: { channel: "scheduler", triggeredBy: identity },
        },
      });
    },
    expectedDisposeReason: "session-dispose",
  },
  {
    name: "local durable job",
    async create(probe, identity) {
      let active: AbortController | undefined;
      let receivedBroker: IConfirmationBroker | undefined;
      const handle = await createAgentJobRuntimePort({
        async create(_instruction, broker) {
          receivedBroker = broker;
          return probe.runtime;
        },
      }).create({
        taskId: identity,
        jobRunId: `job-${identity}`,
        confirmationBroker: probe.confirmationBroker,
      });
      return {
        get confirmationBroker() {
          return receivedBroker ?? probe.confirmationBroker;
        },
        async run(prompt) {
          const events: AgentYield[] = [];
          active = new AbortController();
          try {
            const iterator = handle.run(
              { kind: "agent-turn", prompt },
              {
                abortSignal: active.signal,
                onProtocolEvent: async () => undefined,
                authorizeToolExecution: async () => [],
                toolSideEffectObserver: {} as ToolSideEffectObserver,
                stageScheduleMutation: {} as never,
                assignmentMutations: {} as never,
                assignmentIssuedAt: "2026-08-29T00:00:00.000Z",
              },
            );
            while (true) {
              const next = await iterator.next();
              if (next.done) {
                return {
                  status:
                    prompt === "cancel"
                      ? "aborted"
                      : next.value.status === "completed"
                        ? "completed"
                        : "failed",
                  events,
                };
              }
              events.push(next.value);
            }
          } catch (error) {
            expect(error).toBe(KERNEL_FAILURE);
            return { status: "failed", events };
          }
        },
        cancel(reason) {
          if (!active || active.signal.aborted) return false;
          active.abort(reason);
          return true;
        },
        dispose: () => handle.dispose(),
      } satisfies KernelBinding;
    },
    assertEnvelope(envelope) {
      expect(envelope.identity).toMatchObject({
        turnIndex: 0,
        source: "scheduler",
      });
      expect(envelope.correctness).toHaveProperty("assignmentIssuedAt");
    },
    expectedDisposeReason: "session-dispose",
  },
  {
    name: "remote Executor assignment",
    async create(probe, identity) {
      const role = createExecutorRole({
        createAgentRuntime: async () => probe.runtime,
      });
      const factory = createInProcessAssignmentRuntimeFactory(role);
      const runtime = await factory.create(identity, { workspaceRoot: null });
      return sessionBinding(runtime);
    },
    assertEnvelope(envelope, identity) {
      expect(envelope.identity).toMatchObject({
        conversationId: identity,
        turnIndex: 4,
        source: "interactive",
      });
    },
    expectedDisposeReason: "assignment-dispose",
  },
];

describe.each(CASES)("Kernel conformance · $name", (spec) => {
  it("isolates runtime instances, identities and confirmation brokers", async () => {
    const firstProbe = createKernelProbe();
    const secondProbe = createKernelProbe();
    const first = await spec.create(firstProbe, `first-${spec.name}`);
    const second = await spec.create(secondProbe, `second-${spec.name}`);

    expect(first.confirmationBroker).toBe(firstProbe.confirmationBroker);
    expect(second.confirmationBroker).toBe(secondProbe.confirmationBroker);
    expect(first.confirmationBroker).not.toBe(second.confirmationBroker);
    await Promise.all([first.run("complete"), second.run("complete")]);
    expect(firstProbe.envelopes).toHaveLength(1);
    expect(secondProbe.envelopes).toHaveLength(1);
    spec.assertEnvelope(firstProbe.envelopes[0]!, `first-${spec.name}`);
    spec.assertEnvelope(secondProbe.envelopes[0]!, `second-${spec.name}`);
    expect(firstProbe.envelopes[0]).not.toBe(secondProbe.envelopes[0]);

    await first.dispose();
    await second.dispose();
    expect(firstProbe.dispose).toHaveBeenCalledTimes(1);
    expect(secondProbe.dispose).toHaveBeenCalledTimes(1);
  });

  it("captures one Envelope, preserves ordered Events and projects completion", async () => {
    const probe = createKernelProbe();
    const binding = await spec.create(probe, `identity-${spec.name}`);

    const observation = await binding.run("complete");

    expect(binding.confirmationBroker).toBe(probe.confirmationBroker);
    expect(observation).toEqual({ status: "completed", events: EVENTS });
    expect(probe.envelopes).toHaveLength(1);
    spec.assertEnvelope(probe.envelopes[0]!, `identity-${spec.name}`);
    expect(probe.terminals.map(({ reason }) => reason)).toEqual(["completed"]);
    await binding.dispose();
    expect(probe.dispose).toHaveBeenCalledTimes(1);
    expect(probe.dispose).toHaveBeenCalledWith(spec.expectedDisposeReason);
  });

  it("keeps cancellation first-wins and reaches the aborted Terminal", async () => {
    const probe = createKernelProbe();
    const binding = await spec.create(probe, `cancel-${spec.name}`);
    const running = binding.run("cancel");
    await probe.firstEvent;

    expect(binding.cancel(ABORT_REASON)).toBe(true);
    expect(binding.cancel(REPLACEMENT_ABORT_REASON)).toBe(false);
    await expect(running).resolves.toMatchObject({
      status: "aborted",
      events: [EVENTS[0]],
    });
    expect(probe.terminals).toHaveLength(1);
    expect(probe.terminals[0]).toMatchObject({
      reason: "aborted",
      abortReason: ABORT_REASON,
    });
    await binding.dispose();
    expect(probe.dispose).toHaveBeenCalledTimes(1);
  });

  it("isolates rejection from Terminal state and still releases resources", async () => {
    const probe = createKernelProbe();
    const binding = await spec.create(probe, `failure-${spec.name}`);

    await expect(binding.run("fail")).resolves.toEqual({
      status: "failed",
      events: [],
    });
    expect(probe.terminals).toEqual([]);
    await binding.dispose();
    expect(probe.dispose).toHaveBeenCalledTimes(1);
  });
});
