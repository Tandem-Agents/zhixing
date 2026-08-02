import { describe, expect, it, vi } from "vitest";
import { ManualJobSurfaceLifecycle } from "./manual-job-surface-lifecycle.js";

describe("ManualJobSurfaceLifecycle", () => {
  it("singleflights ready and recovery registration for one assignment", async () => {
    let finishOpen!: (session: { close: ReturnType<typeof vi.fn> }) => void;
    const close = vi.fn(async () => {});
    const open = vi.fn(
      () =>
        new Promise<{ close: typeof close }>((resolve) => {
          finishOpen = resolve;
        }),
    );
    const lifecycle = new ManualJobSurfaceLifecycle();
    const registration = {
      assignmentId: "assignment-1",
      jobRunId: "job-1",
      open,
    };
    lifecycle.register(registration);
    const resumed = lifecycle.resume();
    lifecycle.register(registration);
    await Promise.resolve();
    expect(open).toHaveBeenCalledOnce();

    finishOpen({ close });
    await resumed;
    await lifecycle.resume();
    expect(open).toHaveBeenCalledOnce();

    await lifecycle.stop();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps a failed opening pending and redrives it", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn(async () => {});
      const open = vi
        .fn()
        .mockRejectedValueOnce(new Error("surface temporarily unavailable"))
        .mockResolvedValue({ close });
      const onError = vi.fn();
      const lifecycle = new ManualJobSurfaceLifecycle({
        retryMs: 10,
        onError,
      });
      lifecycle.register({
        assignmentId: "assignment-1",
        jobRunId: "job-1",
        open,
      });

      await lifecycle.resume();
      expect(open).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "surface temporarily unavailable" }),
      );

      await vi.advanceTimersByTimeAsync(10);
      expect(open).toHaveBeenCalledTimes(2);
      await lifecycle.stop();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a terminal state win over an in-flight opening and retirement", async () => {
    let finishOpen!: (session: { close: ReturnType<typeof vi.fn> }) => void;
    const close = vi.fn(async () => {});
    const open = vi.fn(
      () =>
        new Promise<{ close: typeof close }>((resolve) => {
          finishOpen = resolve;
        }),
    );
    const lifecycle = new ManualJobSurfaceLifecycle();
    lifecycle.register({
      assignmentId: "assignment-1",
      jobRunId: "job-1",
      open,
    });
    const resumed = lifecycle.resume();
    await Promise.resolve();
    await lifecycle.markJobTerminal("job-1");

    finishOpen({ close });
    await resumed;
    expect(close).toHaveBeenCalledOnce();
    await lifecycle.resume();
    expect(open).toHaveBeenCalledOnce();

    await lifecycle.retire("assignment-1", "job-1");
    await lifecycle.retire("assignment-1", "job-1");
    expect(close).toHaveBeenCalledOnce();
  });
});
