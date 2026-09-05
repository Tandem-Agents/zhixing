import type { DeferredGlobalIntent } from "@zhixing/core/contracts";
import { ConfirmationHub } from "@zhixing/owner-kernel/confirmation-hub";
import { describe, expect, it, vi } from "vitest";
import {
  AnchorSchedulerHostLifecycle,
  type AnchorScheduleLifecycleMechanism,
  type AnchorSchedulerRuntime,
} from "./anchor-scheduler-runtime.js";

describe("AnchorSchedulerHostLifecycle", () => {
  it("recovers the same physical generation without replacing its mechanism", async () => {
    const lifecycle = generationOwner();
    const { application } = lifecycle;
    const current = mechanism(7, [{ id: "run-1", revision: "revision-1" }]);
    await installInitial(lifecycle, current.runtime);

    await lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 7,
      create: vi.fn(async () => mechanism(7).runtime),
      prepare: vi.fn(async () => undefined),
      bind: releaseLease(),
      publish: releaseLease(),
      activate: vi.fn(() => undefined),
      resume: vi.fn(async () => undefined),
    });

    expect(current.recoverInstalledAuthority).toHaveBeenCalledOnce();
    expect(current.stop).not.toHaveBeenCalled();
    await expect(application.captureAcceptedWork()).resolves.toEqual([
      { id: "run-1", revision: "revision-1" },
    ]);
  });

  it("prepares and publishes a replacement before switching and closing the old generation", async () => {
    const order: string[] = [];
    const lifecycle = generationOwner();
    const { application } = lifecycle;
    const previous = mechanism(7, [], order, "previous");
    const replacement = mechanism(
      8,
      [{ id: "run-2", revision: "revision-2" }],
      order,
      "replacement",
    );
    await installInitial(lifecycle, previous.runtime);

    await lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => {
        order.push("create:replacement");
        return replacement.runtime;
      },
      prepare: async () => {
        order.push("prepare:replacement");
      },
      bind: () => {
        order.push("bind:replacement");
        return vi.fn();
      },
      publish: () => {
        order.push("publish:replacement");
        return vi.fn();
      },
      activate: () => {
        order.push("activate:replacement");
      },
      resume: vi.fn(async () => undefined),
    });

    expect(order).toEqual([
      "create:replacement",
      "prepare:replacement",
      "bind:replacement",
      "publish:replacement",
      "activate:replacement",
      "stop:previous",
    ]);
    await expect(application.captureAcceptedWork()).resolves.toEqual([
      { id: "run-2", revision: "revision-2" },
    ]);

    await lifecycle.stopAndRelease();
    expect(replacement.stop).toHaveBeenCalledOnce();
    await expect(application.captureAcceptedWork()).resolves.toEqual([]);
  });

  it("keeps one stable product surface across generations and a stale release cannot clear its successor", async () => {
    const lifecycle = generationOwner();
    const stableApplication = lifecycle.application;
    const stableManagement = lifecycle.management;
    const stableFacade = lifecycle.facade;
    const previous = mechanism(7);
    const replacement = mechanism(8);
    const edges = generationEdges();

    expect(() => stableApplication.readStatus()).toThrow(
      "Anchor Schedule product generation is unavailable",
    );
    await installInitial(lifecycle, previous.runtime, edges);
    const staleRelease = vi.mocked(edges.publish).mock.results[0]!.value;
    expect(stableApplication.readStatus().activeRunCount).toBe(7);
    await expect(stableFacade.list()).resolves.toEqual([]);
    expect(previous.productList).toHaveBeenCalledOnce();

    await lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => replacement.runtime,
      prepare: vi.fn(async () => undefined),
      bind: edges.bind,
      publish: edges.publish,
      activate: vi.fn(() => undefined),
      resume: vi.fn(async () => undefined),
    });
    staleRelease();

    expect(lifecycle.application).toBe(stableApplication);
    expect(lifecycle.management).toBe(stableManagement);
    expect(lifecycle.facade).toBe(stableFacade);
    expect(stableApplication.readStatus().activeRunCount).toBe(8);
    await expect(stableFacade.list()).resolves.toEqual([]);
    expect(replacement.productList).toHaveBeenCalledOnce();
    expect(edges.published()).toBe(replacement.runtime);
  });

  it("starts replacement activation work only after every shared edge and stable boundary switched", async () => {
    const lifecycle = generationOwner();
    const { application } = lifecycle;
    const previous = mechanism(7, [{ id: "old", revision: "r1" }]);
    const replacement = mechanism(8, [{ id: "new", revision: "r2" }]);
    const edges = generationEdges();
    await installInitial(lifecycle, previous.runtime, edges);

    let observed!: Promise<void>;
    let resolveObserved!: () => void;
    let rejectObserved!: (error: unknown) => void;
    observed = new Promise((resolve, reject) => {
      resolveObserved = resolve;
      rejectObserved = reject;
    });
    let acceptedAtFirstWork: readonly { readonly id: string; readonly revision: string }[] = [];
    await lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => replacement.runtime,
      prepare: vi.fn(async () => undefined),
      bind: edges.bind,
      publish: edges.publish,
      activate: () => {
        queueMicrotask(() => {
          void (async () => {
            expect(edges.bound()).toBe(replacement.runtime);
            expect(edges.published()).toBe(replacement.runtime);
            acceptedAtFirstWork = await application.captureAcceptedWork();
            await lifecycle.postAdoptionReview.reviewAfterAdoption(
              "local-12345678-01K1ZZZZZZ0000000000000000",
            );
            resolveObserved();
          })().catch(rejectObserved);
        });
      },
      resume: () => observed,
    });

    expect(acceptedAtFirstWork).toEqual([{ id: "new", revision: "r2" }]);
    expect(replacement.reviewList).toHaveBeenCalled();
    expect(previous.reviewList).not.toHaveBeenCalled();
    expect(previous.stop).toHaveBeenCalledOnce();
  });

  it("preserves the current generation when replacement creation fails", async () => {
    const lifecycle = generationOwner();
    const { application } = lifecycle;
    const previous = mechanism(7, [{ id: "old", revision: "r1" }]);
    const edges = generationEdges();
    await installInitial(lifecycle, previous.runtime, edges);

    await expect(lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => {
        throw new Error("replacement creation failed");
      },
      prepare: vi.fn(async () => undefined),
      bind: releaseLease(),
      publish: releaseLease(),
      activate: vi.fn(() => undefined),
      resume: vi.fn(async () => undefined),
    })).rejects.toThrow("replacement creation failed");

    expect(previous.stop).not.toHaveBeenCalled();
    expect(edges.bound()).toBe(previous.runtime);
    expect(edges.published()).toBe(previous.runtime);
    await expect(application.captureAcceptedWork()).resolves.toEqual([
      { id: "old", revision: "r1" },
    ]);
  });

  it("rejects and closes a wrong replacement without disturbing the current generation", async () => {
    const lifecycle = generationOwner();
    const { application } = lifecycle;
    const previous = mechanism(7, [{ id: "old", revision: "r1" }]);
    const wrong = mechanism(9);
    await installInitial(lifecycle, previous.runtime);

    await expect(lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => wrong.runtime,
      prepare: vi.fn(async () => undefined),
      bind: releaseLease(),
      publish: releaseLease(),
      activate: vi.fn(() => undefined),
      resume: vi.fn(async () => undefined),
    })).rejects.toThrow(
      "Anchor Schedule runtime generation does not match current Authority",
    );

    expect(wrong.stop).toHaveBeenCalledOnce();
    expect(previous.stop).not.toHaveBeenCalled();
    await expect(application.captureAcceptedWork()).resolves.toEqual([
      { id: "old", revision: "r1" },
    ]);
  });

  it("preserves the current generation when replacement preparation fails", async () => {
    const lifecycle = generationOwner();
    const { application } = lifecycle;
    const previous = mechanism(7, [{ id: "old", revision: "r1" }]);
    const replacement = mechanism(8);
    const edges = generationEdges();
    await installInitial(lifecycle, previous.runtime, edges);

    await expect(lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => replacement.runtime,
      prepare: async () => {
        throw new Error("generation preparation failed");
      },
      bind: edges.bind,
      publish: edges.publish,
      activate: vi.fn(() => undefined),
      resume: vi.fn(async () => undefined),
    })).rejects.toThrow("generation preparation failed");

    expect(replacement.stop).toHaveBeenCalledOnce();
    expect(previous.stop).not.toHaveBeenCalled();
    expect(edges.bound()).toBe(previous.runtime);
    expect(edges.published()).toBe(previous.runtime);
    await expect(application.captureAcceptedWork()).resolves.toEqual([
      { id: "old", revision: "r1" },
    ]);
  });

  it("preserves the current product when replacement product construction fails", async () => {
    const lifecycle = generationOwner();
    const { application, facade } = lifecycle;
    const previous = mechanism(7, [{ id: "old", revision: "r1" }]);
    const replacement = mechanism(8);
    const edges = generationEdges();
    await installInitial(lifecycle, previous.runtime, edges);
    vi.spyOn(replacement.runtime, "createProductBoundary").mockImplementation(() => {
      throw new Error("generation product construction failed");
    });

    await expect(lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => replacement.runtime,
      prepare: vi.fn(async () => undefined),
      bind: edges.bind,
      publish: edges.publish,
      activate: vi.fn(() => undefined),
      resume: vi.fn(async () => undefined),
    })).rejects.toThrow("generation product construction failed");

    expect(replacement.stop).toHaveBeenCalledOnce();
    expect(previous.stop).not.toHaveBeenCalled();
    expect(edges.bound()).toBe(previous.runtime);
    expect(edges.published()).toBe(previous.runtime);
    expect(application.readStatus().activeRunCount).toBe(7);
    await expect(facade.list()).resolves.toEqual([]);
    expect(previous.productList).toHaveBeenCalledOnce();
  });

  it("rolls a failed replacement binding back to the complete old generation and retries", async () => {
    const confirmationHub = new ConfirmationHub();
    const lifecycle = generationOwner(confirmationHub);
    const { application } = lifecycle;
    const previous = mechanism(7, [{ id: "old", revision: "r1" }]);
    const failed = mechanism(8);
    const replacement = mechanism(8, [{ id: "new", revision: "r2" }]);
    const edges = generationEdges();
    const stableReview = lifecycle.postAdoptionReview;
    await installInitial(lifecycle, previous.runtime, edges);
    previous.reviewList.mockResolvedValue([pendingScheduleIntent()]);
    await stableReview.reviewForSurface({
      conversationId: "local-12345678-01K1ZZZZZZ0000000000000000",
      surfacePrincipal: "rpc:zhixing-cli:test",
      connectionId: "connection-1",
    });
    expect(confirmationHub.listAllPending()).toHaveLength(1);

    const rejectFailedBinding = vi.fn((runtime: AnchorSchedulerRuntime) => {
      if (runtime === failed.runtime) throw new Error("generation binding failed");
      return edges.bind(runtime);
    });
    await expect(lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => failed.runtime,
      prepare: vi.fn(async () => undefined),
      bind: rejectFailedBinding,
      publish: edges.publish,
      activate: vi.fn(() => undefined),
      resume: vi.fn(async () => undefined),
    })).rejects.toThrow("generation binding failed");

    expect(edges.bound()).toBe(previous.runtime);
    expect(edges.published()).toBe(previous.runtime);
    expect(failed.stop).toHaveBeenCalledOnce();
    await expect(application.captureAcceptedWork()).resolves.toEqual([
      { id: "old", revision: "r1" },
    ]);
    await stableReview.reviewAfterAdoption(
      "local-12345678-01K1ZZZZZZ0000000000000000",
    );
    expect(previous.reviewList).toHaveBeenCalled();
    expect(failed.reviewList).not.toHaveBeenCalled();
    expect(confirmationHub.listAllPending()).toHaveLength(1);

    await lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => replacement.runtime,
      prepare: vi.fn(async () => undefined),
      bind: edges.bind,
      publish: edges.publish,
      activate: vi.fn(() => undefined),
      resume: vi.fn(async () => undefined),
    });
    expect(edges.bound()).toBe(replacement.runtime);
    expect(edges.published()).toBe(replacement.runtime);
    expect(previous.stop).toHaveBeenCalledOnce();
    await expect(application.captureAcceptedWork()).resolves.toEqual([
      { id: "new", revision: "r2" },
    ]);
  });

  it.each(["activate", "resume"] as const)(
    "rolls a failed replacement %s back without resetting the stable review generation",
    async (failedStage) => {
    const confirmationHub = new ConfirmationHub();
    const lifecycle = generationOwner(confirmationHub);
    const { application } = lifecycle;
    const previous = mechanism(7, [{ id: "old", revision: "r1" }]);
    const failed = mechanism(8);
    const replacement = mechanism(8, [{ id: "new", revision: "r2" }]);
    const edges = generationEdges();
    const stableReview = lifecycle.postAdoptionReview;
    await installInitial(lifecycle, previous.runtime, edges);
    previous.reviewList.mockResolvedValue([pendingScheduleIntent()]);
    await stableReview.reviewForSurface({
      conversationId: "local-12345678-01K1ZZZZZZ0000000000000000",
      surfacePrincipal: "rpc:zhixing-cli:test",
      connectionId: "connection-1",
    });
    expect(confirmationHub.listAllPending()).toHaveLength(1);

    await expect(lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => failed.runtime,
      prepare: vi.fn(async () => undefined),
      bind: edges.bind,
      publish: edges.publish,
      activate: () => {
        if (failedStage === "activate") {
          throw new Error("generation activate failed");
        }
      },
      resume: async () => {
        if (failedStage === "resume") {
          throw new Error("generation resume failed");
        }
      },
    })).rejects.toThrow(`generation ${failedStage} failed`);

    expect(edges.bound()).toBe(previous.runtime);
    expect(edges.published()).toBe(previous.runtime);
    expect(failed.stop).toHaveBeenCalledOnce();
    await expect(application.captureAcceptedWork()).resolves.toEqual([
      { id: "old", revision: "r1" },
    ]);
    await stableReview.reviewAfterAdoption(
      "local-12345678-01K1ZZZZZZ0000000000000000",
    );
    expect(previous.reviewList).toHaveBeenCalled();
    expect(failed.reviewList).not.toHaveBeenCalled();
    expect(confirmationHub.listAllPending()).toHaveLength(1);

    await lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => replacement.runtime,
      prepare: vi.fn(async () => undefined),
      bind: edges.bind,
      publish: edges.publish,
      activate: vi.fn(() => undefined),
      resume: vi.fn(async () => undefined),
    });
    expect(edges.bound()).toBe(replacement.runtime);
    expect(edges.published()).toBe(replacement.runtime);
    expect(previous.stop).toHaveBeenCalledOnce();
    expect(lifecycle.postAdoptionReview).toBe(stableReview);
    expect(confirmationHub.listAllPending()).toHaveLength(0);
    },
  );

  it("rolls back to the current generation when replacement installation fails", async () => {
    const lifecycle = generationOwner();
    const { application } = lifecycle;
    const previous = mechanism(7, [{ id: "old", revision: "r1" }]);
    const replacement = mechanism(8);
    await installInitial(lifecycle, previous.runtime);
    vi.spyOn(application, "install").mockImplementationOnce(() => {
      throw new Error("generation installation failed");
    });

    await expect(lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => replacement.runtime,
      prepare: vi.fn(async () => undefined),
      bind: releaseLease(),
      publish: releaseLease(),
      activate: vi.fn(() => undefined),
      resume: vi.fn(async () => undefined),
    })).rejects.toThrow("generation installation failed");

    expect(replacement.stop).toHaveBeenCalledOnce();
    expect(previous.stop).not.toHaveBeenCalled();
    expect(application.readStatus().activeRunCount).toBe(7);
    await expect(application.captureAcceptedWork()).resolves.toEqual([
      { id: "old", revision: "r1" },
    ]);
  });

  it("rolls back to the current generation when replacement publication fails", async () => {
    const lifecycle = generationOwner();
    const { application } = lifecycle;
    const previous = mechanism(7, [{ id: "old", revision: "r1" }]);
    const replacement = mechanism(8);
    await installInitial(lifecycle, previous.runtime);

    await expect(lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => replacement.runtime,
      prepare: vi.fn(async () => undefined),
      bind: releaseLease(),
      publish: (runtime) => {
        if (runtime === replacement.runtime) {
          throw new Error("generation publication failed");
        }
        return vi.fn();
      },
      activate: vi.fn(() => undefined),
      resume: vi.fn(async () => undefined),
    })).rejects.toThrow("generation publication failed");

    expect(replacement.stop).toHaveBeenCalledOnce();
    expect(previous.stop).not.toHaveBeenCalled();
    await expect(application.captureAcceptedWork()).resolves.toEqual([
      { id: "old", revision: "r1" },
    ]);
  });

  it.each(["bind", "activate", "publish"] as const)(
    "cleans an initial %s failure without leaving shared generation edges",
    async (failedStage) => {
      const lifecycle = generationOwner();
      const { application } = lifecycle;
      const initial = mechanism(7);
      const edges = generationEdges();
      const failureName = failedStage === "bind"
        ? "binding"
        : failedStage === "activate"
          ? "activation"
          : "publication";

      await expect(lifecycle.installInitial({
        mechanism: initial.runtime,
        prepare: vi.fn(async () => undefined),
        bind: (runtime) => {
          if (failedStage === "bind") throw new Error("initial binding failed");
          return edges.bind(runtime);
        },
        publish: (runtime) => {
          if (failedStage === "publish") {
            throw new Error("initial publication failed");
          }
          return edges.publish(runtime);
        },
        activate: () => {
          if (failedStage === "activate") {
            throw new Error("initial activation failed");
          }
        },
        resume: vi.fn(async () => undefined),
      })).rejects.toThrow(`initial ${failureName} failed`);

      expect(edges.bound()).toBeUndefined();
      expect(edges.published()).toBeUndefined();
      expect(initial.stop).toHaveBeenCalledOnce();
      await expect(application.captureAcceptedWork()).resolves.toEqual([]);
      await expect(lifecycle.postAdoptionReview.reviewAfterAdoption(
        "local-12345678-01K1ZZZZZZ0000000000000000",
      )).resolves.toMatchObject({ status: "retry" });
    },
  );

  it("keeps one stable review port across replacement and closes the owner once", async () => {
    const lifecycle = generationOwner();
    const { application } = lifecycle;
    const previous = mechanism(7);
    const replacement = mechanism(8);
    const stablePort = lifecycle.postAdoptionReview;
    await installInitial(lifecycle, previous.runtime);

    await stablePort.reviewAfterAdoption(
      "local-12345678-01K1ZZZZZZ0000000000000000",
    );
    expect(previous.reviewList).toHaveBeenCalled();
    await lifecycle.recoverInstalledAuthority({
      currentAnchorEpoch: 8,
      create: async () => replacement.runtime,
      prepare: vi.fn(async () => undefined),
      bind: releaseLease(),
      publish: releaseLease(),
      activate: vi.fn(() => undefined),
      resume: vi.fn(async () => undefined),
    });
    expect(lifecycle.postAdoptionReview).toBe(stablePort);
    previous.reviewList.mockClear();

    await stablePort.reviewAfterAdoption(
      "local-12345678-01K1ZZZZZZ0000000000000000",
    );
    expect(previous.reviewList).not.toHaveBeenCalled();
    expect(replacement.reviewList).toHaveBeenCalled();
    await lifecycle.stopAndRelease();
    await lifecycle.stopAndRelease();
    expect(replacement.stop).toHaveBeenCalledOnce();
  });
});

function generationOwner(
  confirmationHub = new ConfirmationHub(),
): AnchorSchedulerHostLifecycle {
  return new AnchorSchedulerHostLifecycle({
    confirmationHub,
    workingDirectory: "C:/workspace",
  });
}

function pendingScheduleIntent(): DeferredGlobalIntent {
  return {
    intentId: "intent-schedule",
    localDomainId: "local:12345678",
    conversationId: "local-12345678-01K1ZZZZZZ0000000000000000",
    mutation: {
      kind: "schedule-create",
      spec: {
        name: "每日整理",
        enabled: true,
        priority: "normal",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
        action: { kind: "agent-turn", prompt: "整理今天的工作" },
      },
    },
    recordedAt: "2026-08-07T11:00:00.000Z",
    timeSensitive: true,
    status: "pending",
  };
}

async function installInitial(
  lifecycle: AnchorSchedulerHostLifecycle,
  runtime: AnchorSchedulerRuntime,
  edges = generationEdges(),
): Promise<void> {
  await lifecycle.installInitial({
    mechanism: runtime,
    prepare: vi.fn(async () => undefined),
    bind: edges.bind,
    publish: edges.publish,
    activate: vi.fn(() => undefined),
    resume: vi.fn(async () => undefined),
  });
}

function releaseLease(): ReturnType<typeof vi.fn> {
  return vi.fn(() => vi.fn());
}

function generationEdges(): {
  readonly bind: (runtime: AnchorSchedulerRuntime) => () => void;
  readonly publish: (runtime: AnchorSchedulerRuntime) => () => void;
  readonly bound: () => AnchorSchedulerRuntime | undefined;
  readonly published: () => AnchorSchedulerRuntime | undefined;
} {
  let bound: AnchorSchedulerRuntime | undefined;
  let published: AnchorSchedulerRuntime | undefined;
  return {
    bind: vi.fn((runtime: AnchorSchedulerRuntime) => {
      if (bound) throw new Error("generation binding already exists");
      bound = runtime;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (bound === runtime) bound = undefined;
      };
    }),
    publish: vi.fn((runtime: AnchorSchedulerRuntime) => {
      if (published) throw new Error("generation publication already exists");
      published = runtime;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (published === runtime) published = undefined;
      };
    }),
    bound: () => bound,
    published: () => published,
  };
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
  readonly reviewList: ReturnType<typeof vi.fn>;
  readonly productList: ReturnType<typeof vi.fn>;
} {
  const stop = vi.fn(async () => {
    order.push(`stop:${name}`);
  });
  const recoverInstalledAuthority = vi.fn(async () => undefined);
  const reviewList = vi.fn(async () => []);
  const productList = vi.fn(async () => []);
  const product = {
    snapshot: () => ({ tasks: [], activeRunCount: installedAnchorEpoch }),
    onSignal: () => () => undefined,
    list: productList,
    find: vi.fn(async () => undefined),
    commitCreate: vi.fn(async () => {
      throw new Error("not implemented by lifecycle test product");
    }),
    commitUpdate: vi.fn(async () => {
      throw new Error("not implemented by lifecycle test product");
    }),
    commitDelete: vi.fn(async () => undefined),
    run: vi.fn(async () => {
      throw new Error("not implemented by lifecycle test product");
    }),
    abort: vi.fn(async () => undefined),
  };
  const value: AnchorScheduleLifecycleMechanism & {
    readonly deferredIntents: {
      readonly list: typeof reviewList;
      readonly decide: ReturnType<typeof vi.fn>;
    };
  } = {
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
    createProductBoundary: () => ({
      globalState: {} as never,
      product: product as never,
    }),
    deferredIntents: {
      list: reviewList,
      decide: vi.fn(async () => ({ status: "discarded" })),
    },
  };
  return {
    runtime: value as AnchorSchedulerRuntime,
    stop,
    recoverInstalledAuthority,
    reviewList,
    productList,
  };
}
