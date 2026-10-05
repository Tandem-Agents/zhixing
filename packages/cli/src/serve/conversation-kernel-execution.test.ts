import { describe, expect, it, vi } from "vitest";
import type { SessionRuntime } from "@zhixing/owner-kernel/types";
import { ConversationKernelExecution } from "./conversation-kernel-execution.js";

describe("assignment kernel quiescence", () => {
  it('discards a value returned after cancellation and waits for the real kernel cleanup', async () => {
    const started = Promise.withResolvers<void>(), produce = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>(), cleaned = Promise.withResolvers<void>();
    const runtime = { async *run() {
      started.resolve();
      try { await produce.promise; yield { type: 'text_delta', text: 'late cancelled output' }; }
      finally { cleaning.resolve(); await cleaned.promise; }
    }, abort: vi.fn() } as unknown as SessionRuntime;
    const execution = new ConversationKernelExecution(runtime), stream = execution.run([]);
    const pending = stream.next(); void pending.catch(() => {});
    await started.promise; expect(execution.stop()).toBe(false); produce.resolve();
    await cleaning.promise; expect(execution.stop()).toBe(false);
    cleaned.resolve(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(execution.stop()).toBe(true); expect(runtime.abort).toHaveBeenCalledOnce();
  });

  it('does not resume another kernel step after cancellation between yields', async () => {
    let resumed = false, cleaned = false;
    const runtime = { async *run() {
      try { yield { type: 'text_delta', text: 'accepted prefix' }; resumed = true; }
      finally { cleaned = true; }
    }, abort: vi.fn() } as unknown as SessionRuntime;
    const execution = new ConversationKernelExecution(runtime), stream = execution.run([]);
    await stream.next(); expect(execution.stop()).toBe(false);
    await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(resumed).toBe(false); expect(cleaned).toBe(true); expect(execution.stop()).toBe(true);
  });
  it("does not finalize cancellation while a stopped kernel still has cleanup", async () => {
    const cleanup = Promise.withResolvers<void>();
    const runtime = { async *run() {
      try { yield { type: "text_delta", text: "partial" }; }
      finally { await cleanup.promise; }
    }, abort: vi.fn() } as unknown as SessionRuntime;
    const execution = new ConversationKernelExecution(runtime);
    const stream = execution.run([]);
    await stream.next();
    expect(execution.stop()).toBe(false);
    const closing = stream.return(undefined as never);
    expect(execution.stop()).toBe(false);
    cleanup.resolve();
    await closing;
    expect(execution.stop()).toBe(true);
    expect(runtime.abort).toHaveBeenCalledOnce();
  });

  it("never starts a model after cancellation during preparation", async () => {
    const run = vi.fn();
    const execution = new ConversationKernelExecution({ run } as unknown as SessionRuntime);
    expect(execution.stop()).toBe(true);
    await expect(execution.run([]).next()).rejects.toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
  });
});
