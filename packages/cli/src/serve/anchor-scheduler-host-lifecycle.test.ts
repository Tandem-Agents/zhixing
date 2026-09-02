import { ScheduleApplicationService } from "@zhixing/core/scheduler/application";
import { describe, expect, it, vi } from "vitest";
import {
  AnchorSchedulerHostLifecycle,
  type AnchorScheduleLifecycleMechanism,
  type AnchorSchedulerRuntime,
} from "./anchor-scheduler-runtime.js";

describe("AnchorSchedulerHostLifecycle", () => {
  it("recovers the same physical generation without replacing its mechanism", async () => {
    const application = scheduleApplication();
    const lifecycle = new AnchorSchedulerHostLifecycle(application);
    const current = mechanism(7, [{ id: "run-1", revision: "revision-1" }]);
    lifecycle.install(current.runtime);

    await lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 7,
      create: vi.fn(async () => mechanism(7).runtime),
      initialize: vi.fn(async () => undefined),
    });

    expect(current.recoverInstalledAuthority).toHaveBeenCalledOnce();
    expect(current.stop).not.toHaveBeenCalled();
    await expect(application.captureAcceptedWork()).resolves.toEqual([
      { id: "run-1", revision: "revision-1" },
    ]);
  });

  it("stops and releases the old generation before installing the replacement", async () => {
    const order: string[] = [];
    const application = scheduleApplication();
    const lifecycle = new AnchorSchedulerHostLifecycle(application);
    const previous = mechanism(7, [], order, "previous");
    const replacement = mechanism(
      8,
      [{ id: "run-2", revision: "revision-2" }],
      order,
      "replacement",
    );
    lifecycle.install(previous.runtime);

    await lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => {
        order.push("create:replacement");
        return replacement.runtime;
      },
      initialize: async () => {
        order.push("initialize:replacement");
      },
    });

    expect(order).toEqual([
      "stop:previous",
      "create:replacement",
      "initialize:replacement",
    ]);
    expect(previous.recoverInstalledAuthority).not.toHaveBeenCalled();
    await expect(application.captureAcceptedWork()).resolves.toEqual([
      { id: "run-2", revision: "revision-2" },
    ]);

    await lifecycle.stopAndRelease();
    expect(replacement.stop).toHaveBeenCalledOnce();
    await expect(application.captureAcceptedWork()).resolves.toEqual([]);
  });

  it("does not release the stopped old instance again when replacement creation fails", async () => {
    const application = scheduleApplication();
    const lifecycle = new AnchorSchedulerHostLifecycle(application);
    const previous = mechanism(7);
    lifecycle.install(previous.runtime);

    await expect(lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => {
        throw new Error("replacement creation failed");
      },
      initialize: vi.fn(async () => undefined),
    })).rejects.toThrow("replacement creation failed");

    await expect(lifecycle.stopAndRelease()).resolves.toBeUndefined();
    expect(previous.stop).toHaveBeenCalledOnce();
    await expect(application.captureAcceptedWork()).resolves.toEqual([]);
  });

  it("rejects and stops a replacement for the wrong physical generation", async () => {
    const application = scheduleApplication();
    const lifecycle = new AnchorSchedulerHostLifecycle(application);
    const previous = mechanism(7);
    const wrong = mechanism(9);
    lifecycle.install(previous.runtime);

    await expect(lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => wrong.runtime,
      initialize: vi.fn(async () => undefined),
    })).rejects.toThrow(
      "Anchor Schedule runtime generation does not match current Authority",
    );

    expect(wrong.stop).toHaveBeenCalledOnce();
    await expect(lifecycle.stopAndRelease()).resolves.toBeUndefined();
    expect(previous.stop).toHaveBeenCalledOnce();
  });

  it("keeps an initialized replacement owned when later initialization fails", async () => {
    const application = scheduleApplication();
    const lifecycle = new AnchorSchedulerHostLifecycle(application);
    const previous = mechanism(7);
    const replacement = mechanism(8);
    lifecycle.install(previous.runtime);

    await expect(lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => replacement.runtime,
      initialize: async () => {
        throw new Error("generation initialization failed");
      },
    })).rejects.toThrow("generation initialization failed");

    await lifecycle.stopAndRelease();
    expect(previous.stop).toHaveBeenCalledOnce();
    expect(replacement.stop).toHaveBeenCalledOnce();
  });
});

function scheduleApplication(): ScheduleApplicationService {
  return new ScheduleApplicationService({
    readStatus: () => ({
      activeRunCount: 0,
      enabledUserTaskCount: 0,
      turnContext: { active: [], recentlyCompleted: [], recentlyFailed: [] },
    }),
    onEvent: () => () => undefined,
  });
}

function mechanism(
  installedAnchorEpoch: number,
  acceptedWork: readonly { readonly id: string; readonly revision: string }[] = [],
  order: string[] = [],
  name = `generation-${installedAnchorEpoch}`,
): {
  readonly runtime: AnchorSchedulerRuntime;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly recoverInstalledAuthority: ReturnType<typeof vi.fn>;
} {
  const stop = vi.fn(async () => {
    order.push(`stop:${name}`);
  });
  const recoverInstalledAuthority = vi.fn(async () => undefined);
  const value: AnchorScheduleLifecycleMechanism = {
    installedAnchorEpoch,
    start: vi.fn(async () => undefined),
    stop,
    activate: vi.fn(),
    closeAdmission: vi.fn(),
    listAcceptedWork: vi.fn(async () => acceptedWork),
    recoverAcceptedWork: vi.fn(async () => undefined),
    pauseAndSettle: vi.fn(async () => undefined),
    resumeAdmission: vi.fn(),
    recoverInstalledAuthority,
    resumeManualSurfaces: vi.fn(async () => undefined),
  };
  return {
    runtime: value as AnchorSchedulerRuntime,
    stop,
    recoverInstalledAuthority,
  };
}
