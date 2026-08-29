import type {
  AgentYield,
  IConfirmationBroker,
  ToolSideEffectObserver,
} from "@zhixing/core";
import type {
  AgentRuntime,
  KernelRunEnvelope,
} from "@zhixing/orchestrator/runtime";
import { describe, expect, it, vi } from "vitest";
import { createAgentJobRuntimePort } from "../agent-job-runtime.js";

const instruction = {
  kind: "agent-turn",
  prompt: "perform scheduled work",
} as const;

function completedRunResult() {
  return {
    agentResult: {
      reason: "completed" as const,
      message: {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "done" }],
      },
      usage: { inputTokens: 1, outputTokens: 2 },
    },
    newMessages: [],
    durationMs: 1,
  };
}

function runOptions(signal = new AbortController().signal) {
  return {
    abortSignal: signal,
    onProtocolEvent: vi.fn(async () => undefined),
    authorizeToolExecution: vi.fn(async () => []),
    toolSideEffectObserver: {} as ToolSideEffectObserver,
    stageScheduleMutation: {} as never,
    assignmentMutations: {} as never,
    globalQuery: {} as never,
    assignmentIssuedAt: "2026-08-29T00:00:00.000Z",
    modelCallResourceMeter: {} as never,
    resourceReservation: {
      port: {} as never,
      parentLease: {} as never,
      contextFor: () => ({}) as never,
    },
  };
}

async function createHandle(runtime: AgentRuntime) {
  return createAgentJobRuntimePort({
    create: vi.fn(async () => runtime),
  }).create({
    taskId: "task-1",
    jobRunId: "job-run-1",
    confirmationBroker: {} as IConfirmationBroker,
  });
}

describe("agent job runtime structured lifecycle", () => {
  it("constructs the durable job Envelope with one identity and all Correctness ports", async () => {
    let captured: KernelRunEnvelope | undefined;
    const runtime = Object.assign({} as AgentRuntime, {
      run: vi.fn(async (envelope: KernelRunEnvelope) => {
        captured = envelope;
        return completedRunResult();
      }),
      dispose: vi.fn(async () => undefined),
    });
    const handle = await createHandle(runtime);
    const options = runOptions();
    const generator = handle.run(instruction, options);
    await expect(generator.next()).resolves.toMatchObject({ done: true });

    expect(captured!.modelInput.messages).toHaveLength(1);
    expect(captured!.identity).toMatchObject({
      turnIndex: 0,
      source: "scheduler",
    });
    expect(captured!.control).toMatchObject({
      modelCallResourceMeter: options.modelCallResourceMeter,
    });
    expect(captured!.correctness).toMatchObject({
      authorizeToolExecution: options.authorizeToolExecution,
      toolSideEffectObserver: options.toolSideEffectObserver,
      stageScheduleMutation: options.stageScheduleMutation,
      assignmentMutations: options.assignmentMutations,
      globalQuery: options.globalQuery,
      assignmentIssuedAt: options.assignmentIssuedAt,
      resourceReservation: options.resourceReservation,
    });
    expect(captured!.observation.onProtocolEvent).toBeTypeOf("function");
    expect(captured!.observation.onYield).toBeTypeOf("function");
  });

  it("streams yields and joins one runtime task before returning", async () => {
    const dispose = vi.fn(async () => undefined);
    const runtime = Object.assign({} as AgentRuntime, {
      run: vi.fn(async (envelope: KernelRunEnvelope) => {
        envelope.observation.onYield?.({ type: "text_delta", text: "hello" });
        return completedRunResult();
      }),
      dispose,
    });
    const handle = await createHandle(runtime);
    const generator = handle.run(instruction, runOptions());

    await expect(generator.next()).resolves.toEqual({
      done: false,
      value: { type: "text_delta", text: "hello" },
    });
    await expect(generator.next()).resolves.toMatchObject({
      done: true,
      value: {
        status: "completed",
        summary: "done",
      },
    });
    await handle.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("propagates a runtime rejection once and consumes its promise", async () => {
    const runtimeFailure = new Error("runtime failed");
    const disposeFailure = new Error("dispose failed");
    const runtime = Object.assign({} as AgentRuntime, {
      run: vi.fn(async () => {
        throw runtimeFailure;
      }),
      dispose: vi.fn(async () => {
        throw disposeFailure;
      }),
    });
    const handle = await createHandle(runtime);
    const generator = handle.run(instruction, runOptions());

    await expect(generator.next()).rejects.toBe(runtimeFailure);
    await expect(handle.dispose()).rejects.toBe(disposeFailure);
  });

  it("routes a synchronous runtime failure through the same joined cleanup", async () => {
    const runtimeFailure = new Error("runtime failed synchronously");
    const dispose = vi.fn(async () => undefined);
    const runtime = Object.assign({} as AgentRuntime, {
      run: vi.fn(() => {
        throw runtimeFailure;
      }),
      dispose,
    });
    const handle = await createHandle(runtime);

    await expect(
      handle.run(instruction, runOptions()).next(),
    ).rejects.toBe(runtimeFailure);
    await expect(handle.dispose()).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("aborts, joins and disposes when the consumer returns early", async () => {
    const dispose = vi.fn(async () => undefined);
    const runtime = Object.assign({} as AgentRuntime, {
      run: vi.fn(
        (envelope: KernelRunEnvelope) =>
          new Promise<ReturnType<typeof completedRunResult>>((_, reject) => {
            envelope.observation.onYield?.({ type: "text_delta", text: "first" });
            envelope.control.abortSignal!.addEventListener(
              "abort",
              () => reject(envelope.control.abortSignal!.reason),
              { once: true },
            );
          }),
      ),
      dispose,
    });
    const handle = await createHandle(runtime);
    const generator = handle.run(instruction, runOptions());

    await expect(generator.next()).resolves.toMatchObject({ done: false });
    await expect(generator.return(completedRunResult() as never)).resolves.toMatchObject({
      done: true,
    });
    await handle.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("handle disposal joins a suspended generator without an unhandled rejection", async () => {
    const dispose = vi.fn(async () => undefined);
    const runtime = Object.assign({} as AgentRuntime, {
      run: vi.fn(
        (envelope: KernelRunEnvelope) =>
          new Promise<ReturnType<typeof completedRunResult>>((_, reject) => {
            envelope.observation.onYield?.({ type: "text_delta", text: "first" });
            envelope.control.abortSignal!.addEventListener(
              "abort",
              () => reject(envelope.control.abortSignal!.reason),
              { once: true },
            );
          }),
      ),
      dispose,
    });
    const handle = await createHandle(runtime);
    const generator = handle.run(instruction, runOptions());
    await generator.next();

    await expect(handle.dispose()).resolves.toBeUndefined();
    await expect(generator.next()).rejects.toThrow(
      "Job runtime consumer stopped before completion",
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("forwards caller abort and still releases the runtime exactly once", async () => {
    const caller = new AbortController();
    const dispose = vi.fn(async () => undefined);
    const runtime = Object.assign({} as AgentRuntime, {
      run: vi.fn(
        (envelope: KernelRunEnvelope) =>
          new Promise<ReturnType<typeof completedRunResult>>((_, reject) => {
            if (envelope.control.abortSignal!.aborted) {
              reject(envelope.control.abortSignal!.reason);
              return;
            }
            envelope.control.abortSignal!.addEventListener(
              "abort",
              () => reject(envelope.control.abortSignal!.reason),
              { once: true },
            );
          }),
      ),
      dispose,
    });
    const handle = await createHandle(runtime);
    const generator = handle.run(instruction, runOptions(caller.signal));
    const next = generator.next();
    caller.abort(new Error("caller aborted"));

    await expect(next).rejects.toThrow("caller aborted");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("cannot start work after the handle has been disposed", async () => {
    const runtime = Object.assign({} as AgentRuntime, {
      run: vi.fn(async () => completedRunResult()),
      dispose: vi.fn(async () => undefined),
    });
    const create = vi.fn(async () => runtime);
    const handle = await createAgentJobRuntimePort({ create }).create({
      taskId: "task-1",
      jobRunId: "job-run-1",
      confirmationBroker: {} as IConfirmationBroker,
    });

    await handle.dispose();
    await expect(
      handle.run(instruction, runOptions()).next(),
    ).rejects.toThrow("disposed");
    expect(create).not.toHaveBeenCalled();
  });
});
