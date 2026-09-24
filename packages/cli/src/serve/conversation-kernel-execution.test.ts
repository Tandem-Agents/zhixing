import { describe, expect, it, vi } from "vitest";
import type { SessionRuntime } from "@zhixing/owner-kernel/types";
import { ConversationKernelExecution } from "./conversation-kernel-execution.js";

describe("assignment kernel quiescence", () => {
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
