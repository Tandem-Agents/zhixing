import { describe, expect, it, vi } from "vitest";
import type {
  ImmediateRootReservationInspection,
  ImmediateRootResourceLease,
} from "../../contracts/index.js";
import {
  AdvancementReviewAttemptApplicationService,
  type AdvancementReviewAttemptInput,
  type AdvancementReviewAttemptMechanismPort,
  type AdvancementReviewAttemptStatePort,
  type AdvancementReviewRootLifecyclePort,
  type AdvancementReviewRootTarget,
} from "../application.js";
import type {
  AdvancementExit,
  AdvancementReviewAttempt,
  AdvancementReviewRootContract,
  AdvancementRunReview,
  AdvancementSession,
} from "../types.js";

const NOW = "2026-08-31T00:00:00.000Z";
const RUN_REF = { shardId: "000001", runIndex: 0 } as const;

describe("AdvancementReviewAttemptApplicationService", () => {
  it("owns the started -> invoking -> consumed phases and terminal root cleanup", async () => {
    const state = new ReviewAttemptState();
    const roots = new ReviewRoots();
    const reviewer = vi.fn(async () => reviewedOutcome());
    const application = createApplication(state, roots);

    await expect(
      application.reviewAcceptedRun(request(), mechanism(state, { reviewer })),
    ).resolves.toMatchObject({ kind: "reviewed" });

    expect(state.transitions.map(({ phase }) => phase)).toEqual([
      "started",
      "invoking",
      "consumed",
    ]);
    expect(state.transitions.map(({ generation }) => generation)).toEqual([
      1, 1, 1,
    ]);
    expect(reviewer).toHaveBeenCalledOnce();
    expect(roots.operations).toEqual(["acquire", "settle", "release"]);
    expect(roots.inspection().kind).toBe("reservation");
    expect(roots.inspection()).toMatchObject({ state: "released" });
  });

  it("never replays an invoking generation and merges the legacy evidence generation", async () => {
    const first = attempt(4, "invoking");
    const state = new ReviewAttemptState(session({
      reviewAttempts: [first],
      evidence: {
        pending: [],
        generations: [{
          runId: first.runId,
          reviewId: first.lineageId,
          generation: 6,
          lastAttempt: 1,
        }],
      },
    }));
    const roots = new ReviewRoots(first.root, lease(first.root), "active");
    const reviewer = vi.fn(async () => reviewedOutcome());

    await createApplication(state, roots).reviewAcceptedRun(
      request(),
      mechanism(state, { reviewer }),
    );

    expect(reviewer).toHaveBeenCalledOnce();
    expect(state.transitions).toEqual([
      expect.objectContaining({ generation: 4, phase: "deferred" }),
      expect.objectContaining({ generation: 7, phase: "started" }),
      expect.objectContaining({ generation: 7, phase: "invoking" }),
      expect.objectContaining({ generation: 7, phase: "consumed" }),
    ]);
  });

  it("expires a frozen generation when its target drifts without acquiring or invoking", async () => {
    const frozen = attempt(1, "started", { executorId: "executor-a", ownerEpoch: 1 });
    const state = new ReviewAttemptState(session({ reviewAttempts: [frozen] }));
    const roots = new ReviewRoots();
    const reviewer = vi.fn(async () => reviewedOutcome());

    await expect(
      createApplication(state, roots).reviewAcceptedRun(
        request(),
        mechanism(state, {
          reviewer,
          target: { executorId: "executor-a", ownerEpoch: 2 },
        }),
      ),
    ).resolves.toMatchObject({ kind: "review-deferred" });

    expect(state.transitions).toEqual([
      expect.objectContaining({ generation: 1, phase: "expired" }),
    ]);
    expect(reviewer).not.toHaveBeenCalled();
    expect(roots.operations).toEqual([]);
  });

  it("recovers an acquire response loss from the durable reservation without a second reviewer", async () => {
    const state = new ReviewAttemptState();
    const roots = new ReviewRoots();
    roots.loseNextAcquireResponse = true;
    const reviewer = vi.fn(async () => reviewedOutcome());

    await createApplication(state, roots).reviewAcceptedRun(
      request(),
      mechanism(state, { reviewer }),
    );

    expect(roots.acquireCalls).toBe(1);
    expect(reviewer).toHaveBeenCalledOnce();
    expect(state.transitions.at(-1)).toMatchObject({ phase: "consumed" });
  });

  it("rechecks the business owner after acquire and releases the root without invoking", async () => {
    const state = new ReviewAttemptState();
    const roots = new ReviewRoots();
    roots.afterAcquire = () => state.replace(session({
      status: "cancelled",
      exit: {
        reason: "user-cancelled",
        message: "cancelled",
        occurredAt: NOW,
      },
      reviewAttempts: state.current.reviewAttempts,
    }));
    const reviewer = vi.fn(async () => reviewedOutcome());

    await expect(
      createApplication(state, roots).reviewAcceptedRun(
        request(),
        mechanism(state, { reviewer }),
      ),
    ).resolves.toMatchObject({ kind: "review-deferred" });

    expect(reviewer).not.toHaveBeenCalled();
    expect(roots.operations).toEqual(["acquire", "settle", "release"]);
  });

  it("keeps the first terminal winner and retries terminal cleanup during reconciliation", async () => {
    const active = attempt(1, "invoking");
    const winner = { ...active, phase: "expired" as const, detail: "cancel won" };
    const state = new ReviewAttemptState(session({ reviewAttempts: [active] }));
    state.onTransition = (proposed) => {
      if (proposed.phase === "deferred") {
        state.replace(session({ reviewAttempts: [winner] }));
        throw new Error("terminal conflict");
      }
    };
    const activeLease = lease(active.root);
    const roots = new ReviewRoots(active.root, activeLease, "active");
    roots.failNextSettle = true;
    const application = createApplication(state, roots);

    await expect(
      application.reviewAcceptedRun(
        request(),
        mechanism(state, { reviewer: vi.fn(async () => reviewedOutcome()) }),
      ),
    ).resolves.toMatchObject({ kind: "review-deferred" });
    expect(state.current.reviewAttempts?.[0]).toMatchObject({
      phase: "expired",
      detail: "cancel won",
    });

    await application.reconcileConversation("conv-1");
    expect(roots.inspection()).toMatchObject({ state: "released" });
  });

  it("terminalizes started and invoking attempts before cancelling the session", async () => {
    const started = attempt(1, "started");
    const invoking = attempt(2, "invoking", undefined, {
      shardId: "000001",
      runIndex: 1,
    });
    const state = new ReviewAttemptState(session({
      reviewAttempts: [started, invoking],
    }));
    const roots = new ReviewRoots(started.root, lease(started.root), "active");
    roots.add(invoking.root, lease(invoking.root), "active");

    const cancelled = await createApplication(state, roots).cancelSession({
      conversationId: "conv-1",
      advancementSessionId: "adv-1",
      reason: "user-cancelled",
      message: "stop",
    });

    expect(cancelled.status).toBe("cancelled");
    expect(state.transitions).toEqual([
      expect.objectContaining({ generation: 1, phase: "expired" }),
      expect.objectContaining({ generation: 2, phase: "deferred" }),
    ]);
    expect(roots.operations.filter((operation) => operation === "release")).toHaveLength(2);
  });
});

class ReviewAttemptState implements AdvancementReviewAttemptStatePort {
  current: AdvancementSession;
  readonly transitions: AdvancementReviewAttempt[] = [];
  onTransition?: (attempt: AdvancementReviewAttempt) => void;

  constructor(initial = session()) {
    this.current = initial;
  }

  replace(next: AdvancementSession): void {
    this.current = next;
  }

  async loadActiveSession(conversationId: string): Promise<AdvancementSession | null> {
    return this.current.conversationId === conversationId &&
      (this.current.status === "active" ||
        this.current.status === "awaiting-rubric-confirmation")
      ? this.current
      : null;
  }

  async loadSession(
    conversationId: string,
    sessionId: string,
  ): Promise<AdvancementSession | null> {
    return this.current.conversationId === conversationId &&
      this.current.id === sessionId
      ? this.current
      : null;
  }

  async loadConversationSessions(conversationId: string): Promise<readonly AdvancementSession[]> {
    return this.current.conversationId === conversationId ? [this.current] : [];
  }

  async transitionReviewAttempt(
    _conversationId: string,
    _sessionId: string,
    proposed: AdvancementReviewAttempt,
  ): Promise<AdvancementSession> {
    this.onTransition?.(proposed);
    this.transitions.push(proposed);
    const attempts = [...(this.current.reviewAttempts ?? [])];
    const index = attempts.findIndex((candidate) =>
      candidate.runRecordRef.shardId === proposed.runRecordRef.shardId &&
      candidate.runRecordRef.runIndex === proposed.runRecordRef.runIndex
    );
    if (index >= 0) attempts[index] = proposed;
    else attempts.push(proposed);
    this.current = { ...this.current, reviewAttempts: attempts, updatedAt: NOW };
    return this.current;
  }

  async cancelSession(
    _conversationId: string,
    _sessionId: string,
    exit: AdvancementExit,
  ): Promise<AdvancementSession> {
    this.current = { ...this.current, status: "cancelled", exit, updatedAt: NOW };
    return this.current;
  }
}

class ReviewRoots implements AdvancementReviewRootLifecyclePort {
  readonly operations: string[] = [];
  acquireCalls = 0;
  loseNextAcquireResponse = false;
  failNextSettle = false;
  afterAcquire?: () => void;
  readonly #entries = new Map<string, ImmediateRootReservationInspection>();

  constructor(
    root?: AdvancementReviewRootContract,
    rootLease?: ImmediateRootResourceLease,
    state: "active" | "settled" | "released" | "reclaimed" = "active",
  ) {
    if (root && rootLease) this.add(root, rootLease, state);
  }

  add(
    root: AdvancementReviewRootContract,
    rootLease: ImmediateRootResourceLease,
    state: "active" | "settled" | "released" | "reclaimed",
  ): void {
    this.#entries.set(root.workload.id, { kind: "reservation", state, lease: rootLease });
  }

  inspection(): ImmediateRootReservationInspection {
    return [...this.#entries.values()].at(-1) ?? { kind: "absent" };
  }

  async inspect(root: AdvancementReviewRootContract): Promise<ImmediateRootReservationInspection> {
    return this.#entries.get(root.workload.id) ?? { kind: "absent" };
  }

  async acquire(root: AdvancementReviewRootContract): Promise<ImmediateRootResourceLease> {
    this.acquireCalls += 1;
    this.operations.push("acquire");
    const current = this.#entries.get(root.workload.id);
    const rootLease = current?.kind === "reservation" ? current.lease : lease(root);
    this.add(root, rootLease, "active");
    this.afterAcquire?.();
    if (this.loseNextAcquireResponse) {
      this.loseNextAcquireResponse = false;
      throw new Error("acquire response lost");
    }
    return rootLease;
  }

  async settle(
    root: AdvancementReviewRootContract,
    rootLease: ImmediateRootResourceLease,
  ): Promise<void> {
    this.operations.push("settle");
    if (this.failNextSettle) {
      this.failNextSettle = false;
      throw new Error("settle failed");
    }
    this.add(root, rootLease, "settled");
  }

  async release(
    root: AdvancementReviewRootContract,
    rootLease: ImmediateRootResourceLease,
  ): Promise<void> {
    this.operations.push("release");
    this.add(root, rootLease, "released");
  }
}

function createApplication(
  state: AdvancementReviewAttemptStatePort,
  roots: AdvancementReviewRootLifecyclePort,
): AdvancementReviewAttemptApplicationService {
  return new AdvancementReviewAttemptApplicationService({
    state,
    roots,
    now: () => NOW,
  });
}

function mechanism(
  state: ReviewAttemptState,
  options: Readonly<{
    reviewer: AdvancementReviewAttemptMechanismPort["invokeReviewer"];
    target?: AdvancementReviewRootTarget;
  }>,
): AdvancementReviewAttemptMechanismPort {
  return {
    prepareEligibility: async (current) => ({
      kind: "ready",
      session: current,
      rubric: current.confirmedRubric!,
    }),
    commitMissingDurableRun: async () => {
      throw new Error("unexpected missing durable run");
    },
    resolveRootTarget: async () => options.target,
    prepareEvidence: async () => ({ kind: "ready" }),
    invokeReviewer: options.reviewer,
    commitConsumed: async ({ attempt: consumed, outcome }) => {
      const current = await state.transitionReviewAttempt(
        state.current.conversationId,
        state.current.id,
        consumed,
        NOW,
      );
      return {
        kind: "reviewed",
        session: current,
        review: outcome.review,
      };
    },
  };
}

function request(): AdvancementReviewAttemptInput {
  return {
    conversationId: "conv-1",
    runId: "run-1",
    runIndex: 0,
    runRecord: { timestamp: NOW, messages: [] },
    runRecordRef: RUN_REF,
  };
}

function reviewedOutcome() {
  return { kind: "reviewed" as const, review: review() };
}

function review(): AdvancementRunReview {
  return {
    id: "review-1",
    runIndex: 0,
    reviewedAt: NOW,
    decision: "failed",
    evidence: [],
    attribution: { criteria: [] },
    unmetCriteria: ["not done"],
  };
}

function session(overrides: Partial<AdvancementSession> = {}): AdvancementSession {
  return {
    id: "adv-1",
    conversationId: "conv-1",
    status: "active",
    originalUserTask: { parts: [{ type: "text", text: "finish" }] },
    createdAt: NOW,
    updatedAt: NOW,
    rubricDraftVersion: 1,
    confirmedRubric: {
      source: { kind: "library", rubricId: "rubric-1", rubricVersion: "v1" },
      title: "done",
      description: "done",
      content: { passCriteria: [], evidenceRequirements: [], failureHandling: [] },
      confirmedAt: NOW,
      confirmedBy: "user",
    },
    runs: [],
    proxyMessages: [],
    ...overrides,
  };
}

function attempt(
  generation: number,
  phase: AdvancementReviewAttempt["phase"],
  target?: AdvancementReviewRootTarget,
  runRecordRef = RUN_REF,
): AdvancementReviewAttempt {
  const lineageId = `advancement-review:adv-1:${runRecordRef.shardId}:${runRecordRef.runIndex}`;
  const id = `${lineageId}:generation:${generation}`;
  const root: AdvancementReviewRootContract = {
    workload: { kind: "control", id, attempt: 1 },
    budget: { maxCalls: 8, maxTokens: 300_000 },
    requestId: `${id}:root`,
    ...(target
      ? {
          audience: { executorId: target.executorId },
          scopeBinding: {
            kind: "conversation" as const,
            conversationId: "conv-1",
            ownerEpoch: target.ownerEpoch,
          },
        }
      : {}),
  };
  const rootLease = phase === "invoking" ? lease(root) : undefined;
  return {
    lineageId,
    generation,
    runId: "run-1",
    runIndex: runRecordRef.runIndex,
    runRecordRef,
    phase,
    root,
    ...(rootLease ? { rootLease } : {}),
  };
}

function lease(root: AdvancementReviewRootContract): ImmediateRootResourceLease {
  return {
    v: 1,
    reservationId: `reservation:${root.workload.id}`,
    admissionClass: "advancement",
    workload: root.workload,
    scopeBinding: root.scopeBinding ?? { kind: "control", subject: root.workload.id },
    audience: root.audience ?? { executorId: "executor-local" },
    budget: root.budget,
    domain: { kind: "local", localDomainId: "device-1", localGovernorEpoch: 1 },
    issuedAt: NOW,
    expiry: "2026-08-31T01:00:00.000Z",
    digest: "sha256:test",
    signature: { alg: "test", keyId: "test", sig: "test" },
  } as ImmediateRootResourceLease;
}
