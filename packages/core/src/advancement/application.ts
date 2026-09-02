import { randomUUID } from "node:crypto";
import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiFactEvent,
  defineProductApiQuery,
  type ProductApiFact,
  type ProductApiContribution,
} from "../product-api/catalog.js";
import { canonicalize, protocolDigest } from "../protocol/canonical.js";
import type { AdvancementAdmissionDecision } from "./admission.js";
import {
  buildClosureFacts,
  renderClosureReport,
  sumAdvancementUsage,
  type AdvancementClosureFacts,
  type AdvancementClosureReport,
} from "./closure.js";
import { projectConfirmedRubricToDraftContent } from "./contract.js";
import type {
  AdvancementReviewAttempt,
  AdvancementReviewRootContract,
  AdvancementExit,
  AdvancementOriginalTaskAdmissionIntent,
  AdvancementProxyMessage,
  AdvancementRunReview,
  AdvancementSession,
  AdvancementSessionStatus,
  AdvancementWindowState,
  ConfirmedRubricSnapshot,
  FailureHandlingSpec,
  ReviewAttribution,
  ReviewEvidence,
  RubricContractDraftSnapshot,
  RubricDraftPersistenceChoice,
} from "./types.js";
import type { AdvancementReviewRunOutcome } from "./review.js";
import {
  advancementReviewAttemptId,
  advancementReviewLineageId,
  advancementReviewRootRequestId,
} from "./review-attempt-identity.js";
import { createAdvancementWindowReviewEntry } from "./window-state.js";
import type {
  ArtifactRef,
  Digest,
  ImmediateRootResourceLease,
  ImmediateRootReservationInspection,
} from "../contracts/index.js";
import type {
  RunRecordInput,
  RunRecordRef,
} from "../transcript/shard/types.js";
import {
  extractUserTurnInputText,
  isNonEmptyUserTurnInput,
  userTurnInputFromText,
  type UserTurnInput,
} from "../types/user-input.js";
import type { TurnOrigin } from "../types/tools.js";
import { renderReviewAttribution } from "./attribution.js";

export type AdvancementTurnReviewResult =
  | {
      readonly kind: "skipped";
      readonly reason: "no-active-session" | "not-active" | "already-reviewed";
    }
  | {
      readonly kind: "review-deferred";
      readonly session: AdvancementSession;
      readonly cause: "infrastructure" | "aborted";
      readonly reason: string;
    }
  | {
      readonly kind: "reviewed";
      readonly session: AdvancementSession;
      readonly review: AdvancementRunReview;
    }
  | {
      readonly kind: "proxy-enqueued";
      readonly session: AdvancementSession;
      readonly review: AdvancementRunReview;
      readonly proxyMessage: AdvancementProxyMessage;
    }
  | {
      readonly kind: "completed";
      readonly session: AdvancementSession;
      readonly review: AdvancementRunReview;
      readonly exit: AdvancementExit;
      readonly closure: AdvancementClosureReport;
    }
  | {
      readonly kind: "exited";
      readonly session: AdvancementSession;
      readonly review: AdvancementRunReview;
      readonly exit: AdvancementExit;
      readonly closure: AdvancementClosureReport;
  };

export interface AdvancementReviewRootTarget {
  readonly executorId: string;
  readonly ownerEpoch: number;
}

export interface AdvancementReviewAttemptInput {
  readonly conversationId: string;
  readonly runId?: string;
  readonly runIndex: number;
  readonly runRecord: RunRecordInput;
  readonly runRecordRef?: RunRecordRef;
  readonly abortSignal?: AbortSignal;
}

function hasDurableRunRecordRef(
  input: AdvancementReviewAttemptInput,
): input is AdvancementReviewAttemptInput & { readonly runRecordRef: RunRecordRef } {
  return input.runRecordRef !== undefined;
}

export interface AdvancementReviewAttemptStatePort {
  loadActiveSession(conversationId: string): Promise<AdvancementSession | null>;
  loadSession(
    conversationId: string,
    sessionId: string,
  ): Promise<AdvancementSession | null>;
  loadConversationSessions(
    conversationId: string,
  ): Promise<readonly AdvancementSession[]>;
  transitionReviewAttempt(
    conversationId: string,
    sessionId: string,
    attempt: AdvancementReviewAttempt,
    timestamp: string,
  ): Promise<AdvancementSession>;
  cancelSession(
    conversationId: string,
    sessionId: string,
    exit: AdvancementExit,
    timestamp: string,
  ): Promise<AdvancementSession>;
  settleProxyMessage(
    conversationId: string,
    sessionId: string,
    proxyMessageId: string,
    timestamp: string,
  ): Promise<AdvancementSession>;
  enqueueProxyMessage(
    conversationId: string,
    sessionId: string,
    proxyMessage: AdvancementProxyMessage,
    timestamp: string,
  ): Promise<AdvancementSession>;
  commitReviewOutcome(
    decision: AdvancementReviewPersistenceDecision,
  ): Promise<AdvancementSession>;
}

export type AdvancementReviewPersistenceDecision =
  | Readonly<{
      kind: "terminal";
      conversationId: string;
      sessionId: string;
      review: AdvancementRunReview;
      terminal: Readonly<{
        type: "completed" | "exited";
        exit: AdvancementExit;
        timestamp: string;
      }>;
      timestamp: string;
      advancementWindow?: AdvancementWindowState;
      evidenceRequestId?: string;
      reviewAttempt?: AdvancementReviewAttempt;
    }>
  | Readonly<{
      kind: "proxy";
      conversationId: string;
      sessionId: string;
      review: AdvancementRunReview;
      proxyMessage: AdvancementProxyMessage;
      timestamp: string;
      advancementWindow?: AdvancementWindowState;
      evidenceRequestId?: string;
      reviewAttempt?: AdvancementReviewAttempt;
    }>;

/** Generic immediate-root mechanics. Advancement owns every lifecycle decision. */
export interface AdvancementReviewRootLifecyclePort {
  inspect(
    root: AdvancementReviewRootContract,
  ): Promise<ImmediateRootReservationInspection>;
  acquire(
    root: AdvancementReviewRootContract,
    deadlineMs?: number,
  ): Promise<ImmediateRootResourceLease>;
  settle(
    root: AdvancementReviewRootContract,
    lease: ImmediateRootResourceLease,
  ): Promise<void>;
  release(
    root: AdvancementReviewRootContract,
    lease: ImmediateRootResourceLease,
  ): Promise<void>;
}

export type AdvancementReviewEvidencePreparationResult =
  | Readonly<{
      kind: "ready";
      canonicalEvidence?: readonly ReviewEvidence[];
      requestId?: string;
    }>
  | Readonly<{
      kind: "deferred";
      cause: "infrastructure" | "aborted";
      reason: string;
    }>;

/** External mechanisms fixed when the review application is assembled. */
export interface AdvancementReviewAttemptMechanismPort {
  resolveRootTarget(
    session: AdvancementSession,
    input: AdvancementReviewAttemptInput,
  ): Promise<AdvancementReviewRootTarget | undefined>;
  prepareEvidence(input: Readonly<{
    session: AdvancementSession;
    request: AdvancementReviewAttemptInput & { readonly runRecordRef: RunRecordRef };
    attempt: AdvancementReviewAttempt;
    rootLease: ImmediateRootResourceLease;
  }>): Promise<AdvancementReviewEvidencePreparationResult>;
  invokeReviewer(input: Readonly<{
    session: AdvancementSession;
    rubric: ConfirmedRubricSnapshot;
    request: AdvancementReviewAttemptInput & { readonly runRecordRef: RunRecordRef };
    attempt: AdvancementReviewAttempt;
    rootLease: ImmediateRootResourceLease;
    canonicalEvidence?: readonly ReviewEvidence[];
  }>): Promise<AdvancementReviewRunOutcome>;
}

export interface AdvancementClosureSynthesizer {
  synthesize(facts: AdvancementClosureFacts): Promise<string>;
}

export async function composeAdvancementClosureReport(
  session: AdvancementSession,
  synthesizer?: AdvancementClosureSynthesizer,
): Promise<AdvancementClosureReport> {
  const facts = buildClosureFacts(session);
  if (synthesizer) {
    try {
      const summary = (await synthesizer.synthesize(facts)).trim();
      if (summary) return { summary, synthesized: true, facts };
    } catch {
      // Optional synthesis never blocks the deterministic closure projection.
    }
  }
  return { summary: renderClosureReport(facts), synthesized: false, facts };
}

export interface AdvancementReviewAttemptApplication {
  queryActiveState(
    conversationId: string,
  ): Promise<AdvancementActiveStateProjection | null>;
  settleProxyRun(input: Readonly<{
    conversationId: string;
    proxyMessageId: string;
  }>): Promise<"settled" | "not-applicable">;
  reviewAcceptedRun(input: AdvancementReviewAttemptInput): Promise<AdvancementTurnReviewResult>;
  reconcileConversation(conversationId: string): Promise<void>;
  cancelSession(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    reason: AdvancementExit["reason"];
    message: string;
  }>): Promise<AdvancementSession>;
  rebuildMissingProxyMessage(
    session: AdvancementSession,
  ): Promise<AdvancementMissingProxyRebuildResult>;
}

export type AdvancementMissingProxyRebuildResult =
  | Readonly<{
      kind: "rebuilt";
      session: AdvancementSession;
      proxyMessage: AdvancementProxyMessage;
      review: AdvancementRunReview;
    }>
  | Readonly<{ kind: "not-applicable" }>;

export const DEFAULT_ADVANCEMENT_SESSION_TOKEN_BUDGET = 20_000_000;

/**
 * Unique durable review-attempt state machine. Persistence and resource ports
 * expose mechanics only; generation, phase, winner and root lifecycle remain
 * Advancement decisions.
 */
export class AdvancementReviewAttemptApplicationService
  implements AdvancementReviewAttemptApplication
{
  readonly #state: AdvancementReviewAttemptStatePort;
  readonly #roots: AdvancementReviewRootLifecyclePort;
  readonly #mechanism: AdvancementReviewAttemptMechanismPort;
  readonly #reviewerAvailable: boolean;
  readonly #sessionTokenBudget: number;
  readonly #closureSynthesizer?: AdvancementClosureSynthesizer;
  readonly #now: () => string;
  readonly #reviewIdGenerator: () => string;
  readonly #proxyIdGenerator: () => string;
  readonly #flights = new Map<string, Promise<AdvancementTurnReviewResult>>();

  constructor(options: Readonly<{
    state: AdvancementReviewAttemptStatePort;
    roots: AdvancementReviewRootLifecyclePort;
    mechanism: AdvancementReviewAttemptMechanismPort;
    reviewerAvailable: boolean;
    sessionTokenBudget?: number;
    closureSynthesizer?: AdvancementClosureSynthesizer;
    now?: () => string;
    reviewIdGenerator?: () => string;
    proxyIdGenerator?: () => string;
  }>) {
    this.#state = options.state;
    this.#roots = options.roots;
    this.#mechanism = options.mechanism;
    this.#reviewerAvailable = options.reviewerAvailable;
    this.#sessionTokenBudget =
      options.sessionTokenBudget ?? DEFAULT_ADVANCEMENT_SESSION_TOKEN_BUDGET;
    this.#closureSynthesizer = options.closureSynthesizer;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#reviewIdGenerator =
      options.reviewIdGenerator ?? (() => `adv_review_${randomUUID()}`);
    this.#proxyIdGenerator =
      options.proxyIdGenerator ?? (() => `adv_proxy_${randomUUID()}`);
  }

  async queryActiveState(
    conversationId: string,
  ): Promise<AdvancementActiveStateProjection | null> {
    assertConversationId(conversationId);
    const session = await this.#state.loadActiveSession(conversationId);
    return session ? projectAdvancementActiveState(session) : null;
  }

  async settleProxyRun(input: Readonly<{
    conversationId: string;
    proxyMessageId: string;
  }>): Promise<"settled" | "not-applicable"> {
    assertConversationId(input.conversationId);
    assertRubricRevisionIdentity(input.proxyMessageId, "Proxy message");
    const session = await this.#state.loadActiveSession(input.conversationId);
    if (
      session?.status !== "active" ||
      session.outstandingProxyMessageId !== input.proxyMessageId
    ) {
      return "not-applicable";
    }
    await this.#state.settleProxyMessage(
      input.conversationId,
      session.id,
      input.proxyMessageId,
      this.#now(),
    );
    return "settled";
  }

  async reviewAcceptedRun(
    input: AdvancementReviewAttemptInput,
  ): Promise<AdvancementTurnReviewResult> {
    const key = reviewAttemptFlightKey(input);
    const current = this.#flights.get(key);
    if (current) return await current;
    const flight = this.#reviewAcceptedRun(input).finally(() => {
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
    });
    this.#flights.set(key, flight);
    return await flight;
  }

  async reconcileConversation(conversationId: string): Promise<void> {
    const sessions = await this.#state.loadConversationSessions(conversationId);
    for (const session of sessions) {
      for (const attempt of session.reviewAttempts ?? []) {
        if (isTerminalReviewAttempt(attempt)) {
          await this.#cleanupTerminalRoot(attempt);
        }
      }
    }
  }

  async cancelSession(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    reason: AdvancementExit["reason"];
    message: string;
  }>): Promise<AdvancementSession> {
    let current = await this.#state.loadSession(
      input.conversationId,
      input.advancementSessionId,
    );
    if (!current) {
      throw new Error(
        `Advancement review attempt session "${input.advancementSessionId}" not found`,
      );
    }
    const terminals: AdvancementReviewAttempt[] = [];
    for (const attempt of current.reviewAttempts ?? []) {
      if (attempt.phase !== "started" && attempt.phase !== "invoking") continue;
      const terminal = terminalReviewAttempt(
        attempt,
        attempt.phase === "invoking" ? "deferred" : "expired",
        "推进会话关闭，未完成裁判尝试停止推进。",
      );
      const settled = await this.#commitTerminal(
        input.conversationId,
        input.advancementSessionId,
        terminal,
      );
      current = settled.session;
      terminals.push(settled.attempt);
    }
    const occurredAt = this.#now();
    const cancelled = await this.#state.cancelSession(
      input.conversationId,
      input.advancementSessionId,
      {
        reason: input.reason,
        message: input.message,
        occurredAt,
      },
      occurredAt,
    );
    for (const attempt of terminals) {
      await this.#cleanupTerminalRoot(attempt);
    }
    return cancelled;
  }

  async rebuildMissingProxyMessage(
    session: AdvancementSession,
  ): Promise<AdvancementMissingProxyRebuildResult> {
    if (session.status !== "active" || session.outstandingProxyMessageId) {
      return { kind: "not-applicable" };
    }
    const review = session.runs[session.runs.length - 1];
    if (!review || review.decision !== "failed" || !review.proxyMessageId) {
      return { kind: "not-applicable" };
    }
    if (session.proxyMessages.some((message) => message.id === review.proxyMessageId)) {
      return { kind: "not-applicable" };
    }
    const rubric = session.confirmedRubric;
    const handling = rubric
      ? selectFailureHandling(rubric, review.selectedFailureHandlingId)
      : undefined;
    if (!rubric || !handling) return { kind: "not-applicable" };
    const proxyMessage = buildAdvancementProxyMessage({
      id: review.proxyMessageId,
      sessionId: session.id,
      review,
      handling,
      rubric,
      createdAt: this.#now(),
    });
    const updated = await this.#state.enqueueProxyMessage(
      session.conversationId,
      session.id,
      proxyMessage,
      proxyMessage.createdAt,
    );
    return { kind: "rebuilt", session: updated, proxyMessage, review };
  }

  async #reviewAcceptedRun(
    input: AdvancementReviewAttemptInput,
  ): Promise<AdvancementTurnReviewResult> {
    let session = await this.#state.loadActiveSession(input.conversationId);
    if (!session) return { kind: "skipped", reason: "no-active-session" };
    if (session.status !== "active") {
      return { kind: "skipped", reason: "not-active" };
    }

    const existingAttempt = input.runRecordRef
      ? reviewAttemptForRun(session, input.runRecordRef)
      : undefined;
    if (
      existingAttempt &&
      isTerminalReviewAttempt(existingAttempt) &&
      !(await this.#cleanupTerminalRoot(existingAttempt))
    ) {
      return deferredReview(
        session,
        "既有裁判终态已落盘，资源仍等待保守回收。",
      );
    }
    if (session.runs.some((run) => run.runIndex === input.runIndex)) {
      return { kind: "skipped", reason: "already-reviewed" };
    }

    const eligibility = await this.#prepareEligibility(session, input);
    if (eligibility.kind === "return") return eligibility.result;
    session = eligibility.session;
    const rubric = eligibility.rubric;

    if (!hasDurableRunRecordRef(input)) {
      return await this.#persistReviewOutcome(
        session,
        this.#systemExitReview(
          input,
          "推进侧验收缺少 accepted run 的耐久位置，无法建立可恢复的裁判身份。",
        ),
      );
    }
    const request = input;
    const runId = input.runId ?? stableAcceptedRunId(input.runRecordRef);

    let attempt = reviewAttemptForRun(session, input.runRecordRef);
    if (attempt?.phase === "invoking") {
      const settled = await this.#commitTerminal(
        input.conversationId,
        session.id,
        terminalReviewAttempt(
          attempt,
          "deferred",
          "裁判调用结果不明；本代禁止重放 provider。",
        ),
      );
      session = settled.session;
      attempt = settled.attempt;
    }
    if (attempt && isTerminalReviewAttempt(attempt)) {
      const cleaned = await this.#cleanupTerminalRoot(attempt);
      if (!cleaned) {
        return deferredReview(
          session,
          "裁判资源仍在等待保守计量回收，暂不进入下一代验收。",
        );
      }
      session =
        (await this.#state.loadActiveSession(input.conversationId)) ?? session;
      if (
        session.runs.some(
          (run) =>
            run.runRecordRef !== undefined &&
            sameRunRecordRef(run.runRecordRef, request.runRecordRef),
        )
      ) {
        return { kind: "skipped", reason: "already-reviewed" };
      }
    }

    const lineageId = advancementReviewLineageId(session.id, input.runRecordRef);
    const rootTarget = await this.#mechanism.resolveRootTarget(session, input);
    attempt = reviewAttemptForRun(session, input.runRecordRef);
    if (!attempt || isTerminalReviewAttempt(attempt)) {
      const legacyGeneration =
        session.evidence?.generations?.find((entry) => entry.runId === runId)
          ?.generation ?? 0;
      const generation = Math.max(attempt?.generation ?? 0, legacyGeneration) + 1;
      attempt = {
        lineageId,
        generation,
        runId,
        runIndex: input.runIndex,
        runRecordRef: structuredClone(input.runRecordRef),
        phase: "started",
        root: createReviewRootContract({
          lineageId,
          generation,
          conversationId: input.conversationId,
          target: rootTarget,
        }),
      };
      session = await this.#state.transitionReviewAttempt(
        input.conversationId,
        session.id,
        attempt,
        this.#now(),
      );
    }

    if (attempt.phase !== "started") {
      throw new Error("Advancement review attempt is not restartable");
    }
    if (!reviewRootTargetMatches(attempt.root, rootTarget)) {
      const expired = terminalReviewAttempt(
        attempt,
        "expired",
        "取证目标在裁判调用前发生变化；冻结本代并等待下一次恢复。",
      );
      const settled = await this.#commitTerminal(
        input.conversationId,
        session.id,
        expired,
      );
      await this.#cleanupTerminalRoot(settled.attempt);
      return deferredReview(
        settled.session,
        settled.attempt.detail ?? expired.detail!,
      );
    }

    let acquired:
      | Readonly<{ kind: "active"; lease: ImmediateRootResourceLease }>
      | Readonly<{
          kind: "terminal";
          inspection: Exclude<
            ImmediateRootReservationInspection,
            { readonly kind: "absent" | "queued" }
          >;
        }>;
    try {
      acquired = await this.#acquireRoot(attempt);
    } catch (error) {
      return deferredReview(
        session,
        `裁判根资源获取结果尚未确定：${advancementErrorMessage(error)}`,
      );
    }
    if (acquired.kind === "terminal") {
      const afterFailure = await this.#state.loadSession(
        input.conversationId,
        session.id,
      );
      const durable = afterFailure
        ? reviewAttemptForRun(afterFailure, input.runRecordRef)
        : undefined;
      if (
        afterFailure &&
        (afterFailure.status !== "active" ||
          !durable ||
          durable.lineageId !== attempt.lineageId ||
          durable.generation !== attempt.generation ||
          durable.phase !== "started")
      ) {
        if (
          durable &&
          durable.lineageId === attempt.lineageId &&
          durable.generation === attempt.generation &&
          isTerminalReviewAttempt(durable)
        ) {
          await this.#cleanupTerminalRoot(durable);
        }
        return deferredReview(
          afterFailure,
          "裁判根获取结束前业务 owner 已推进，本代不再写入或调用外部裁判。",
        );
      }
      if (!afterFailure) {
        throw new Error(
          "Advancement session disappeared after its review root became terminal",
        );
      }
      session = afterFailure;
      attempt = durable!;
      const expired = terminalReviewAttempt(
        attempt,
        "expired",
        `裁判根资源已${describeReviewRootTerminal(acquired.inspection)}，本代不再复活。`,
        acquired.inspection.kind === "reservation"
          ? acquired.inspection.lease
          : undefined,
      );
      const settled = await this.#commitTerminal(
        input.conversationId,
        session.id,
        expired,
      );
      await this.#cleanupTerminalRoot(settled.attempt);
      return deferredReview(
        settled.session,
        settled.attempt.detail ?? expired.detail!,
      );
    }
    const lease = acquired.lease;

    const afterAcquire = await this.#state.loadSession(
      input.conversationId,
      session.id,
    );
    const durableAfterAcquire = afterAcquire
      ? reviewAttemptForRun(afterAcquire, input.runRecordRef)
      : undefined;
    if (
      !afterAcquire ||
      afterAcquire.status !== "active" ||
      !durableAfterAcquire ||
      durableAfterAcquire.lineageId !== attempt.lineageId ||
      durableAfterAcquire.generation !== attempt.generation ||
      durableAfterAcquire.phase !== "started"
    ) {
      const cleanupAttempt =
        durableAfterAcquire && isTerminalReviewAttempt(durableAfterAcquire)
          ? durableAfterAcquire
          : terminalReviewAttempt(
              { ...attempt, rootLease: lease },
              "expired",
              "裁判根取得后业务 owner 已不再允许本代继续。",
              lease,
            );
      if (durableAfterAcquire?.phase !== "invoking") {
        await this.#cleanupTerminalRoot(cleanupAttempt);
      }
      if (!afterAcquire) {
        throw new Error(
          "Advancement session disappeared after acquiring its review root",
        );
      }
      return deferredReview(
        afterAcquire,
        durableAfterAcquire?.phase === "invoking"
          ? "本代裁判已由唯一调用者接管。"
          : "裁判根取得后推进会话已进入终态，本代不再调用外部裁判。",
      );
    }
    session = afterAcquire;
    attempt = durableAfterAcquire;

    const evidence = await this.#mechanism.prepareEvidence({
      session,
      request,
      attempt,
      rootLease: lease,
    });
    if (evidence.kind === "deferred") {
      const expired = terminalReviewAttempt(
        { ...attempt, rootLease: lease },
        "expired",
        evidence.reason,
        lease,
      );
      const settled = await this.#commitTerminal(
        input.conversationId,
        session.id,
        expired,
      );
      await this.#cleanupTerminalRoot(settled.attempt);
      return deferredReview(
        settled.session,
        settled.attempt.detail ?? evidence.reason,
        evidence.cause,
      );
    }

    const invoking: AdvancementReviewAttempt = {
      ...attempt,
      phase: "invoking",
      rootLease: lease,
    };
    try {
      session = await this.#state.transitionReviewAttempt(
        input.conversationId,
        session.id,
        invoking,
        this.#now(),
      );
    } catch (error) {
      const latestSession = await this.#state.loadSession(
        input.conversationId,
        session.id,
      );
      const latestAttempt = latestSession
        ? reviewAttemptForRun(latestSession, input.runRecordRef)
        : undefined;
      if (
        latestSession &&
        (latestSession.status !== "active" ||
          (latestAttempt !== undefined && isTerminalReviewAttempt(latestAttempt)))
      ) {
        await this.#cleanupTerminalRoot(
          latestAttempt && isTerminalReviewAttempt(latestAttempt)
            ? latestAttempt
            : terminalReviewAttempt(
                { ...attempt, rootLease: lease },
                "expired",
                "裁判调用前业务 owner 已进入终态。",
                lease,
              ),
        );
        return deferredReview(
          latestSession,
          "裁判调用前推进会话已进入终态，本代未调用外部裁判。",
        );
      }
      throw error;
    }

    const outcome = await this.#mechanism.invokeReviewer({
      session,
      rubric,
      request,
      attempt: invoking,
      rootLease: lease,
      ...(evidence.canonicalEvidence
        ? { canonicalEvidence: evidence.canonicalEvidence }
        : {}),
    });
    if (outcome.kind === "deferred") {
      const deferred = terminalReviewAttempt(
        invoking,
        "deferred",
        outcome.reason,
        lease,
      );
      const settled = await this.#commitTerminal(
        input.conversationId,
        session.id,
        deferred,
      );
      await this.#cleanupTerminalRoot(settled.attempt);
      return deferredReview(
        settled.session,
        settled.attempt.detail ?? outcome.reason,
        outcome.cause,
      );
    }

    const consumed = terminalReviewAttempt(invoking, "consumed", undefined, lease);
    const result = await this.#persistReviewOutcome(
      session,
      outcome.review,
      outcome.advancementWindow,
      evidence.requestId,
      consumed,
    );
    await this.#cleanupTerminalRoot(consumed);
    return result;
  }

  async #prepareEligibility(
    initialSession: AdvancementSession,
    input: AdvancementReviewAttemptInput,
  ): Promise<
    | Readonly<{ kind: "return"; result: AdvancementTurnReviewResult }>
    | Readonly<{
        kind: "ready";
        session: AdvancementSession;
        rubric: ConfirmedRubricSnapshot;
      }>
  > {
    const settled = await this.#settleAcceptedProxyRun(initialSession, input);
    if (isTurnReviewResult(settled)) {
      return { kind: "return", result: settled };
    }
    const session = settled;
    const rubric = session.confirmedRubric;
    if (!rubric) {
      return {
        kind: "return",
        result: await this.#persistReviewOutcome(
          session,
          this.#systemExitReview(
            input,
            "推进会话已激活但缺少已确认 Rubric，无法继续可靠验收。",
          ),
        ),
      };
    }
    if (!this.#reviewerAvailable) {
      return {
        kind: "return",
        result: await this.#persistReviewOutcome(
          session,
          this.#systemExitReview(
            input,
            "推进侧验收运行体未装配，无法继续可靠验收。",
          ),
        ),
      };
    }
    const spentTokens = sumAdvancementUsage(session.runs).totalTokens;
    if (spentTokens >= this.#sessionTokenBudget) {
      return {
        kind: "return",
        result: await this.#persistReviewOutcome(
          session,
          this.#systemExitReview(
            input,
            `本次推进累计消耗约 ${spentTokens} tokens，已达单任务成本上限（${this.#sessionTokenBudget}），按系统边界退出。如需继续可调高推进保险丝阈值后重新发起。`,
            "budget-exceeded",
          ),
        ),
      };
    }
    return { kind: "ready", session, rubric };
  }

  async #settleAcceptedProxyRun(
    session: AdvancementSession,
    input: AdvancementReviewAttemptInput,
  ): Promise<AdvancementSession | AdvancementTurnReviewResult> {
    if (input.runRecord.source !== "advancement") return session;
    const proxyMessageId = input.runRecord.advancement?.proxyMessageId;
    if (
      !input.runRecord.advancement ||
      input.runRecord.advancement.sessionId !== session.id ||
      !proxyMessageId
    ) {
      return await this.#persistReviewOutcome(
        session,
        this.#systemExitReview(
          input,
          "推进侧代理 run 缺少匹配的来源元数据，无法可靠继续。",
        ),
      );
    }
    if (!session.outstandingProxyMessageId) {
      if (session.proxyMessages.some((message) => message.id === proxyMessageId)) {
        return session;
      }
      return await this.#persistReviewOutcome(
        session,
        this.#systemExitReview(
          input,
          "推进侧代理 run 来源元数据指向未知代理消息，无法可靠继续。",
        ),
      );
    }
    if (session.outstandingProxyMessageId !== proxyMessageId) {
      return await this.#persistReviewOutcome(
        session,
        this.#systemExitReview(
          input,
          "推进侧代理 run 与 outstanding proxy 不匹配，无法可靠继续。",
        ),
      );
    }
    return await this.#state.settleProxyMessage(
      input.conversationId,
      session.id,
      proxyMessageId,
      this.#now(),
    );
  }

  #systemExitReview(
    input: Pick<AdvancementReviewAttemptInput, "runIndex" | "runRecordRef">,
    message: string,
    exitReason: AdvancementExit["reason"] = "system-error",
  ): AdvancementRunReview {
    return {
      id: this.#reviewIdGenerator(),
      runIndex: input.runIndex,
      runRecordRef: input.runRecordRef,
      reviewedAt: this.#now(),
      decision: "exit",
      evidence: [],
      attribution: { criteria: [] },
      unmetCriteria: [message],
      exitReason,
    };
  }

  async #persistReviewOutcome(
    session: AdvancementSession,
    review: AdvancementRunReview,
    advancementWindow?: AdvancementWindowState,
    evidenceRequestId?: string,
    reviewAttempt?: AdvancementReviewAttempt,
  ): Promise<AdvancementTurnReviewResult> {
    if (review.decision === "passed") {
      const exit: AdvancementExit = {
        reason: "passed",
        message: "Rubric 已验收通过，任务推进闭环结束。",
        occurredAt: this.#now(),
      };
      const completed = await this.#state.commitReviewOutcome({
        kind: "terminal",
        conversationId: session.conversationId,
        sessionId: session.id,
        review,
        terminal: { type: "completed", exit, timestamp: exit.occurredAt },
        timestamp: review.reviewedAt,
        ...(advancementWindow ? { advancementWindow } : {}),
        ...(evidenceRequestId ? { evidenceRequestId } : {}),
        ...(reviewAttempt ? { reviewAttempt } : {}),
      });
      return {
        kind: "completed",
        session: completed,
        review,
        exit,
        closure: await composeAdvancementClosureReport(
          completed,
          this.#closureSynthesizer,
        ),
      };
    }
    if (review.decision === "exit") {
      const exit: AdvancementExit = {
        reason: review.exitReason ?? "system-error",
        message: review.unmetCriteria[0] ?? "推进侧判断继续推进已不合适。",
        occurredAt: this.#now(),
      };
      const exited = await this.#state.commitReviewOutcome({
        kind: "terminal",
        conversationId: session.conversationId,
        sessionId: session.id,
        review,
        terminal: { type: "exited", exit, timestamp: exit.occurredAt },
        timestamp: review.reviewedAt,
        ...(advancementWindow ? { advancementWindow } : {}),
        ...(evidenceRequestId ? { evidenceRequestId } : {}),
        ...(reviewAttempt ? { reviewAttempt } : {}),
      });
      return {
        kind: "exited",
        session: exited,
        review,
        exit,
        closure: await composeAdvancementClosureReport(
          exited,
          this.#closureSynthesizer,
        ),
      };
    }

    const spentWithThisRun = sumAdvancementUsage([
      ...session.runs,
      review,
    ]).totalTokens;
    if (spentWithThisRun >= this.#sessionTokenBudget) {
      const exit: AdvancementExit = {
        reason: "budget-exceeded",
        message: `本次推进累计消耗约 ${spentWithThisRun} tokens，已达单任务成本上限（${this.#sessionTokenBudget}），不再自动续推。如需继续可调高推进保险丝阈值后重新发起。`,
        occurredAt: this.#now(),
      };
      const exitReview: AdvancementRunReview = {
        ...review,
        decision: "exit",
        exitReason: "budget-exceeded",
      };
      const window = syncAdvancementWindowReview(
        advancementWindow,
        exitReview,
      );
      const exited = await this.#state.commitReviewOutcome({
        kind: "terminal",
        conversationId: session.conversationId,
        sessionId: session.id,
        review: exitReview,
        terminal: { type: "exited", exit, timestamp: exit.occurredAt },
        timestamp: review.reviewedAt,
        ...(window ? { advancementWindow: window } : {}),
        ...(evidenceRequestId ? { evidenceRequestId } : {}),
        ...(reviewAttempt ? { reviewAttempt } : {}),
      });
      return {
        kind: "exited",
        session: exited,
        review: exited.runs[exited.runs.length - 1]!,
        exit,
        closure: await composeAdvancementClosureReport(
          exited,
          this.#closureSynthesizer,
        ),
      };
    }

    const rubric = session.confirmedRubric;
    const handling = rubric
      ? selectFailureHandling(rubric, review.selectedFailureHandlingId)
      : undefined;
    if (!rubric || !handling) {
      const exit: AdvancementExit = {
        reason: "dead-end",
        message: "推进侧未能找到可执行的未通过处理准则，继续推进没有可靠收益。",
        occurredAt: this.#now(),
      };
      const exitReview: AdvancementRunReview = {
        ...review,
        decision: "exit",
        exitReason: "dead-end",
        unmetCriteria:
          review.unmetCriteria.length > 0 ? review.unmetCriteria : [exit.message],
      };
      const window = syncAdvancementWindowReview(
        advancementWindow,
        exitReview,
      );
      const exited = await this.#state.commitReviewOutcome({
        kind: "terminal",
        conversationId: session.conversationId,
        sessionId: session.id,
        review: exitReview,
        terminal: { type: "exited", exit, timestamp: exit.occurredAt },
        timestamp: review.reviewedAt,
        ...(window ? { advancementWindow: window } : {}),
        ...(evidenceRequestId ? { evidenceRequestId } : {}),
        ...(reviewAttempt ? { reviewAttempt } : {}),
      });
      return {
        kind: "exited",
        session: exited,
        review: exited.runs[exited.runs.length - 1]!,
        exit,
        closure: await composeAdvancementClosureReport(
          exited,
          this.#closureSynthesizer,
        ),
      };
    }

    const proxyMessageId = this.#proxyIdGenerator();
    const proxyMessage = buildAdvancementProxyMessage({
      id: proxyMessageId,
      sessionId: session.id,
      review,
      handling,
      rubric,
      createdAt: this.#now(),
    });
    const reviewWithProxy: AdvancementRunReview = {
      ...review,
      selectedFailureHandlingId: handling.id,
      proxyMessageId,
    };
    const window = syncAdvancementWindowReview(
      advancementWindow,
      reviewWithProxy,
    );
    const updated = await this.#state.commitReviewOutcome({
      kind: "proxy",
      conversationId: session.conversationId,
      sessionId: session.id,
      review: reviewWithProxy,
      proxyMessage,
      timestamp: review.reviewedAt,
      ...(window ? { advancementWindow: window } : {}),
      ...(evidenceRequestId ? { evidenceRequestId } : {}),
      ...(reviewAttempt ? { reviewAttempt } : {}),
    });
    return {
      kind: "proxy-enqueued",
      session: updated,
      review: reviewWithProxy,
      proxyMessage,
    };
  }

  async #commitTerminal(
    conversationId: string,
    sessionId: string,
    proposed: AdvancementReviewAttempt,
  ): Promise<Readonly<{
    session: AdvancementSession;
    attempt: AdvancementReviewAttempt;
  }>> {
    if (!isTerminalReviewAttempt(proposed)) {
      throw new TypeError("Review attempt terminal commit requires a terminal phase");
    }
    try {
      const session = await this.#state.transitionReviewAttempt(
        conversationId,
        sessionId,
        proposed,
        this.#now(),
      );
      return {
        session,
        attempt: reviewAttemptForRun(session, proposed.runRecordRef) ?? proposed,
      };
    } catch (error) {
      const session = await this.#state.loadSession(conversationId, sessionId);
      const winner = session
        ? reviewAttemptForRun(session, proposed.runRecordRef)
        : undefined;
      if (
        session &&
        winner &&
        winner.lineageId === proposed.lineageId &&
        winner.generation === proposed.generation &&
        isTerminalReviewAttempt(winner)
      ) {
        return { session, attempt: winner };
      }
      throw error;
    }
  }

  async #acquireRoot(
    attempt: AdvancementReviewAttempt,
  ): Promise<
    | Readonly<{ kind: "active"; lease: ImmediateRootResourceLease }>
    | Readonly<{
        kind: "terminal";
        inspection: Exclude<
          ImmediateRootReservationInspection,
          { readonly kind: "absent" | "queued" }
        >;
      }>
  > {
    const inspection = await this.#roots.inspect(attempt.root);
    if (inspection.kind === "reservation") {
      assertFrozenReviewRootLease(attempt.root, inspection.lease);
      return inspection.state === "active"
        ? { kind: "active", lease: inspection.lease }
        : { kind: "terminal", inspection };
    }
    if (inspection.kind === "dequeued") {
      return { kind: "terminal", inspection };
    }
    try {
      const lease = await this.#roots.acquire(attempt.root);
      assertFrozenReviewRootLease(attempt.root, lease);
      return { kind: "active", lease };
    } catch (error) {
      const afterFailure = await this.#roots.inspect(attempt.root);
      if (
        afterFailure.kind === "reservation" &&
        afterFailure.state === "active"
      ) {
        assertFrozenReviewRootLease(attempt.root, afterFailure.lease);
        return { kind: "active", lease: afterFailure.lease };
      }
      if (
        afterFailure.kind === "dequeued" ||
        (afterFailure.kind === "reservation" &&
          afterFailure.state !== "active")
      ) {
        return { kind: "terminal", inspection: afterFailure };
      }
      throw error;
    }
  }

  async #cleanupTerminalRoot(attempt: AdvancementReviewAttempt): Promise<boolean> {
    if (!isTerminalReviewAttempt(attempt)) return false;
    let inspection = await this.#roots.inspect(attempt.root);
    if (inspection.kind === "absent" || inspection.kind === "dequeued") {
      return true;
    }
    if (inspection.kind === "queued") {
      try {
        const lease = await this.#roots.acquire(attempt.root, 250);
        assertFrozenReviewRootLease(attempt.root, lease);
      } catch {
        // The bounded acquire records dequeue when it cannot activate. The
        // durable inspection below is authoritative for cleanup progress.
      }
      inspection = await this.#roots.inspect(attempt.root);
      if (inspection.kind === "absent" || inspection.kind === "dequeued") {
        return true;
      }
      if (inspection.kind === "queued") return false;
    }
    assertFrozenReviewRootLease(attempt.root, inspection.lease);
    if (inspection.state === "released" || inspection.state === "reclaimed") {
      return true;
    }
    if (inspection.state === "active") {
      try {
        await this.#roots.settle(attempt.root, inspection.lease);
      } catch {
        return false;
      }
    }
    try {
      await this.#roots.release(attempt.root, inspection.lease);
    } catch {
      return false;
    }
    inspection = await this.#roots.inspect(attempt.root);
    return (
      inspection.kind === "absent" ||
      inspection.kind === "dequeued" ||
      (inspection.kind === "reservation" &&
        (inspection.state === "released" || inspection.state === "reclaimed"))
    );
  }
}

export function selectFailureHandling(
  rubric: ConfirmedRubricSnapshot,
  selectedId: string | undefined,
): FailureHandlingSpec | undefined {
  const handlers = rubric.content.failureHandling;
  return selectedId
    ? handlers.find((handler) => handler.id === selectedId)
    : handlers[0];
}

function buildProxyVariables(
  review: AdvancementRunReview,
): Readonly<Record<string, string>> {
  return {
    unmet_criteria: review.unmetCriteria.join("\n"),
    review_id: review.id,
  };
}

function renderFailureHandlingReply(
  handling: FailureHandlingSpec,
  variables: Readonly<Record<string, string>>,
): string {
  return handling.reply.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    const value = variables[key];
    return value === undefined ? match : value;
  });
}

function composeProxyContent(
  handling: FailureHandlingSpec,
  variables: Readonly<Record<string, string>>,
  attribution: ReviewAttribution,
  rubric: ConfirmedRubricSnapshot,
): string {
  const reply = renderFailureHandlingReply(handling, variables);
  const facts = renderReviewAttribution(
    attribution,
    rubric.content.passCriteria,
  );
  return facts ? `${reply}\n\n${facts}` : reply;
}

export function buildAdvancementProxyMessage(input: Readonly<{
  id: string;
  sessionId: string;
  review: AdvancementRunReview;
  handling: FailureHandlingSpec;
  rubric: ConfirmedRubricSnapshot;
  createdAt: string;
}>): AdvancementProxyMessage {
  const variables = buildProxyVariables(input.review);
  return {
    id: input.id,
    sessionId: input.sessionId,
    reviewId: input.review.id,
    content: userTurnInputFromText(
      composeProxyContent(
        input.handling,
        variables,
        input.review.attribution,
        input.rubric,
      ),
    ),
    rubricFailureHandlingId: input.handling.id,
    variables,
    attribution: input.review.attribution,
    createdAt: input.createdAt,
  };
}

function syncAdvancementWindowReview(
  advancementWindow: AdvancementWindowState | undefined,
  review: AdvancementRunReview,
): AdvancementWindowState | undefined {
  if (!advancementWindow) return undefined;
  return {
    ...advancementWindow,
    entries: advancementWindow.entries.map((entry) =>
      entry.kind === "review" && entry.reviewId === review.id
        ? createAdvancementWindowReviewEntry(review)
        : entry,
    ),
  };
}

function isTurnReviewResult(
  value: AdvancementSession | AdvancementTurnReviewResult,
): value is AdvancementTurnReviewResult {
  return "kind" in value;
}

function reviewAttemptFlightKey(input: AdvancementReviewAttemptInput): string {
  return input.runRecordRef
    ? `${input.conversationId}:${input.runRecordRef.shardId}:${input.runRecordRef.runIndex}`
    : `${input.conversationId}:legacy:${input.runIndex}`;
}

function stableAcceptedRunId(ref: RunRecordRef): string {
  return `accepted-run:${ref.shardId}:${ref.runIndex}`;
}

function reviewAttemptForRun(
  session: AdvancementSession,
  ref: RunRecordRef,
): AdvancementReviewAttempt | undefined {
  return session.reviewAttempts?.find((attempt) =>
    sameRunRecordRef(attempt.runRecordRef, ref),
  );
}

function projectAdvancementActiveState(
  session: AdvancementSession,
): AdvancementActiveStateProjection | null {
  if (
    session.status !== "awaiting-rubric-confirmation" &&
    session.status !== "active"
  ) {
    return null;
  }
  const lastReview = session.runs[session.runs.length - 1];
  return freezeSnapshot({
    advancementSessionId: session.id,
    status: session.status,
    ...(session.confirmedRubric?.title
      ? { rubricTitle: session.confirmedRubric.title }
      : session.pendingRubricDraft?.title
        ? { rubricTitle: session.pendingRubricDraft.title }
        : {}),
    ...(session.pendingRubricDraft?.draftId
      ? { rubricDraftId: session.pendingRubricDraft.draftId }
      : {}),
    ...(session.status === "awaiting-rubric-confirmation" &&
    session.pendingRubricDraft
      ? { pendingRubricDraft: session.pendingRubricDraft }
      : {}),
    ...(session.outstandingProxyMessageId
      ? { outstandingProxyMessageId: session.outstandingProxyMessageId }
      : {}),
    ...(lastReview
      ? {
          lastReview: {
            id: lastReview.id,
            runIndex: lastReview.runIndex,
            round: session.runs.length,
            decision: lastReview.decision,
            reviewedAt: lastReview.reviewedAt,
          },
        }
      : {}),
  });
}

function sameRunRecordRef(left: RunRecordRef, right: RunRecordRef): boolean {
  return left.shardId === right.shardId && left.runIndex === right.runIndex;
}

function isTerminalReviewAttempt(attempt: AdvancementReviewAttempt): boolean {
  return (
    attempt.phase === "consumed" ||
    attempt.phase === "deferred" ||
    attempt.phase === "expired"
  );
}

function terminalReviewAttempt(
  attempt: AdvancementReviewAttempt,
  phase: "consumed" | "deferred" | "expired",
  detail?: string,
  rootLease?: ImmediateRootResourceLease,
): AdvancementReviewAttempt {
  return {
    lineageId: attempt.lineageId,
    generation: attempt.generation,
    runId: attempt.runId,
    runIndex: attempt.runIndex,
    runRecordRef: structuredClone(attempt.runRecordRef),
    phase,
    root: structuredClone(attempt.root),
    ...(rootLease ?? attempt.rootLease
      ? { rootLease: structuredClone(rootLease ?? attempt.rootLease!) }
      : {}),
    ...(detail === undefined ? {} : { detail }),
  };
}

function createReviewRootContract(input: Readonly<{
  lineageId: string;
  generation: number;
  conversationId: string;
  target?: AdvancementReviewRootTarget;
}>): AdvancementReviewRootContract {
  const id = advancementReviewAttemptId(input.lineageId, input.generation);
  return {
    workload: { kind: "control", id, attempt: 1 },
    budget: { maxCalls: 8, maxTokens: 300_000 },
    requestId: advancementReviewRootRequestId(input.lineageId, input.generation),
    ...(input.target
      ? {
          audience: { executorId: input.target.executorId },
          scopeBinding: {
            kind: "conversation" as const,
            conversationId: input.conversationId,
            ownerEpoch: input.target.ownerEpoch,
          },
        }
      : {}),
  };
}

function reviewRootTargetMatches(
  root: AdvancementReviewRootContract,
  target: AdvancementReviewRootTarget | undefined,
): boolean {
  if (!target) {
    return root.audience === undefined && root.scopeBinding === undefined;
  }
  return (
    root.audience?.executorId === target.executorId &&
    root.scopeBinding?.kind === "conversation" &&
    root.scopeBinding.ownerEpoch === target.ownerEpoch
  );
}

function assertFrozenReviewRootLease(
  root: AdvancementReviewRootContract,
  lease: ImmediateRootResourceLease,
): void {
  const expectedScope = root.scopeBinding ?? {
    kind: "control" as const,
    subject: root.workload.id,
  };
  if (
    canonicalize(lease.workload) !== canonicalize(root.workload) ||
    canonicalize(lease.budget) !== canonicalize(root.budget) ||
    canonicalize(lease.scopeBinding) !== canonicalize(expectedScope) ||
    (root.audience !== undefined &&
      canonicalize(lease.audience) !== canonicalize(root.audience))
  ) {
    throw new Error("Advancement review root changed its frozen contract");
  }
}

function describeReviewRootTerminal(
  inspection: Exclude<
    ImmediateRootReservationInspection,
    { readonly kind: "absent" | "queued" }
  >,
): string {
  return inspection.kind === "dequeued"
    ? `出队（${inspection.reason}）`
    : `进入 ${inspection.state} 终态`;
}

function deferredReview(
  session: AdvancementSession,
  reason: string,
  cause: "infrastructure" | "aborted" = "infrastructure",
): AdvancementTurnReviewResult {
  return { kind: "review-deferred", session, cause, reason };
}

function advancementErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "unknown error";
}

export interface AdvancementCommittedTurn {
  readonly conversationId: string;
  readonly turnId: string;
  readonly runIndex: number;
  readonly runRecord: RunRecordInput;
  readonly runRecordRef?: RunRecordRef;
  readonly ephemeral: boolean;
}

export type AdvancementAcceptedTurnCatchUpResult = Readonly<{
  status:
    | "no-active-session"
    | "not-active"
    | "no-pending-recovery"
    | "awaiting-original-run"
    | "already-running"
    | "already-scheduled"
    | "durable-run-owned"
    | "closed-run-recovered"
    | "scheduled"
    | "accepted-run-recovered"
    | "review-deferred"
    | "not-found"
    | "full"
    | "busy"
    | "missing-proxy"
    | "failed";
}>;

/** Path-free catch-up mechanism; the recovery scan and persistence remain outside Domain. */
export interface AdvancementAcceptedTurnCatchUpPort {
  catchUpAcceptedTurn(
    conversationId: string,
    beforeRunIndex: number,
  ): Promise<AdvancementAcceptedTurnCatchUpResult>;
}

export type AdvancementReviewPresentationEvent =
  | Readonly<{
      conversationId: string;
      runId: string;
      seq: 0;
      event: "advancement:review_deferred";
      payload: Readonly<{
        advancementSessionId: string;
        cause: "infrastructure" | "aborted";
        reason: string;
      }>;
    }>
  | Readonly<{
      conversationId: string;
      runId: string;
      seq: 0;
      event: "advancement:run_reviewed";
      payload: Readonly<{
        advancementSessionId: string;
        review: AdvancementRunReview;
        reviewRound: number;
      }>;
    }>
  | Readonly<{
      conversationId: string;
      runId: string;
      seq: 1;
      event: "advancement:proxy_enqueued";
      payload: Readonly<{
        advancementSessionId: string;
        proxyMessageId: string;
        reviewId: string;
      }>;
    }>
  | Readonly<{
      conversationId: string;
      runId: string;
      seq: 1;
      event: "advancement:completed" | "advancement:exited";
      payload: Readonly<{
        advancementSessionId: string;
        reviewId: string;
        exit: AdvancementExit;
        closure: AdvancementClosureReport;
      }>;
    }>;

export interface AdvancementReviewEventPort {
  emit(event: AdvancementReviewPresentationEvent): void;
}

/** Path-free proxy effect; scheduling mechanics remain in owner-services. */
export interface AdvancementReviewProxySchedulePort {
  schedule(input: Readonly<{
    session: AdvancementSession;
    proxyMessage: AdvancementProxyMessage;
  }>): Promise<void>;
}

export interface AdvancementReviewResultProjectionInput {
  readonly conversationId: string;
  readonly runId: string;
  readonly result: AdvancementTurnReviewResult;
  readonly emitProxyEnqueued?: boolean;
  readonly scheduleProxy?: boolean;
}

/** Shared application-owned review result projection used by live turns and recovery. */
export interface AdvancementReviewResultProjectionApplication {
  projectReviewResult(input: AdvancementReviewResultProjectionInput): Promise<void>;
}

export class AdvancementReviewResultProjectionApplicationService
  implements AdvancementReviewResultProjectionApplication
{
  readonly #events?: AdvancementReviewEventPort;
  readonly #proxySchedule?: AdvancementReviewProxySchedulePort;

  constructor(options: Readonly<{
    events?: AdvancementReviewEventPort;
    proxySchedule?: AdvancementReviewProxySchedulePort;
  }>) {
    this.#events = options.events;
    this.#proxySchedule = options.proxySchedule;
  }

  async projectReviewResult(
    input: AdvancementReviewResultProjectionInput,
  ): Promise<void> {
    this.#emitReviewEvents(input);
    if (
      input.scheduleProxy !== false &&
      input.result.kind === "proxy-enqueued" &&
      this.#proxySchedule
    ) {
      await this.#proxySchedule.schedule({
        session: input.result.session,
        proxyMessage: input.result.proxyMessage,
      });
    }
  }

  #emitReviewEvents(input: AdvancementReviewResultProjectionInput): void {
    const result = input.result;
    if (result.kind === "skipped" || !this.#events) return;
    if (result.kind === "review-deferred") {
      this.#events.emit({
        conversationId: input.conversationId,
        runId: input.runId,
        seq: 0,
        event: "advancement:review_deferred",
        payload: {
          advancementSessionId: result.session.id,
          cause: result.cause,
          reason: result.reason,
        },
      });
      return;
    }
    this.#events.emit({
      conversationId: input.conversationId,
      runId: input.runId,
      seq: 0,
      event: "advancement:run_reviewed",
      payload: {
        advancementSessionId: result.session.id,
        review: result.review,
        reviewRound: result.session.runs.length,
      },
    });
    if (result.kind === "proxy-enqueued") {
      if (input.emitProxyEnqueued === false) return;
      this.#events.emit({
        conversationId: input.conversationId,
        runId: result.proxyMessage.id,
        seq: 1,
        event: "advancement:proxy_enqueued",
        payload: {
          advancementSessionId: result.session.id,
          proxyMessageId: result.proxyMessage.id,
          reviewId: result.review.id,
        },
      });
      return;
    }
    if (result.kind !== "completed" && result.kind !== "exited") return;
    this.#events.emit({
      conversationId: input.conversationId,
      runId: input.runId,
      seq: 1,
      event:
        result.kind === "completed"
          ? "advancement:completed"
          : "advancement:exited",
      payload: {
        advancementSessionId: result.session.id,
        reviewId: result.review.id,
        exit: result.exit,
        closure: result.closure,
      },
    });
  }
}

export interface AdvancementAcceptedTurnApplication {
  acceptCommittedTurn(turn: AdvancementCommittedTurn): void;
}

/**
 * Fire-and-forget application use case for accepted turns. Per-conversation ordering
 * is product semantics; review attempt deduplication remains in the review application.
 */
export class AdvancementAcceptedTurnApplicationService
  implements AdvancementAcceptedTurnApplication
{
  readonly #catchUp: AdvancementAcceptedTurnCatchUpPort;
  readonly #review: Pick<AdvancementReviewAttemptApplication, "reviewAcceptedRun">;
  readonly #results: AdvancementReviewResultProjectionApplication;
  readonly #chains = new Map<string, Promise<void>>();

  constructor(options: Readonly<{
    catchUp: AdvancementAcceptedTurnCatchUpPort;
    review: Pick<AdvancementReviewAttemptApplication, "reviewAcceptedRun">;
    results: AdvancementReviewResultProjectionApplication;
  }>) {
    this.#catchUp = options.catchUp;
    this.#review = options.review;
    this.#results = options.results;
  }

  acceptCommittedTurn(turn: AdvancementCommittedTurn): void {
    if (turn.ephemeral) return;
    const previous = this.#chains.get(turn.conversationId) ?? Promise.resolve();
    const current = previous.then(() => this.#reviewCommittedTurn(turn));
    const tail = current.catch(() => {});
    this.#chains.set(turn.conversationId, tail);
    void tail.finally(() => {
      if (this.#chains.get(turn.conversationId) === tail) {
        this.#chains.delete(turn.conversationId);
      }
    });
  }

  async #reviewCommittedTurn(turn: AdvancementCommittedTurn): Promise<void> {
    let catchUp: AdvancementAcceptedTurnCatchUpResult;
    try {
      catchUp = await this.#catchUp.catchUpAcceptedTurn(
        turn.conversationId,
        turn.runIndex,
      );
    } catch {
      return;
    }
    if (!catchUpProvedContinuous(catchUp.status)) return;
    const result = await this.#review.reviewAcceptedRun({
      conversationId: turn.conversationId,
      runId: turn.turnId,
      runIndex: turn.runIndex,
      runRecord: turn.runRecord,
      ...(turn.runRecordRef ? { runRecordRef: turn.runRecordRef } : {}),
    });
    await this.#results.projectReviewResult({
      conversationId: turn.conversationId,
      runId: turn.turnId,
      result,
    });
  }
}

function catchUpProvedContinuous(
  status: AdvancementAcceptedTurnCatchUpResult["status"],
): boolean {
  return (
    status === "no-pending-recovery" ||
    status === "accepted-run-recovered" ||
    status === "scheduled" ||
    status === "already-running" ||
    status === "already-scheduled" ||
    status === "durable-run-owned" ||
    status === "closed-run-recovered"
  );
}

/** Path-free read mechanism for the current Advancement owner projection. */
export interface AdvancementDetailReadPort {
  loadLatestSession(conversationId: string): Promise<AdvancementSession | null>;
}

/** Conversation-owned exclusivity mechanism; Advancement owns the enclosed decision. */
export interface AdvancementConversationMaintenancePort {
  runNew<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<
    | { readonly status: "done"; readonly value: T }
    | { readonly status: "busy" }
  >;
  runExisting<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<
    | { readonly status: "done"; readonly value: T }
    | { readonly status: "busy" }
    | { readonly status: "not-found" }
  >;
}

/** Path-free mechanisms for Conversation-owned retirement and orphan cleanup. */
export interface AdvancementConversationLifecycleMechanismPort {
  loadOpenConversationLifecycleSession(
    conversationId: string,
  ): Promise<AdvancementSession | null>;
  persistConversationLifecycleCancellation(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    reason: AdvancementExit["reason"];
    message: string;
  }>): Promise<AdvancementSession>;
  removeConversationData(conversationId: string): Promise<void>;
  listConversationDataCandidates(): Promise<readonly string[]>;
  removeConversationDataCandidate(candidateId: string): Promise<void>;
}

/** Host-owned physical liveness probe injected into the domain application. */
export interface AdvancementConversationAlivePort {
  isConversationDataAlive(candidateId: string): Promise<boolean>;
}

export interface AdvancementOrphanSweepReport {
  readonly scanned: number;
  readonly removed: number;
  readonly warnings: readonly string[];
}

/** Finite cross-domain lifecycle use cases; no Store or path escapes this boundary. */
export interface AdvancementConversationLifecycleApplication {
  cancelConversationLifecycle(conversationId: string): Promise<void>;
  removeConversationData(conversationId: string): Promise<void>;
  sweepOrphanData(): Promise<AdvancementOrphanSweepReport>;
}

export interface AdvancementConversationLifecycleApplicationOptions {
  readonly mechanism: AdvancementConversationLifecycleMechanismPort;
  readonly conversationAlive: AdvancementConversationAlivePort;
}

/** One finite lifecycle application assembled before any Host consumer is published. */
export class AdvancementConversationLifecycleApplicationService
  implements AdvancementConversationLifecycleApplication
{
  readonly #mechanism: AdvancementConversationLifecycleMechanismPort;
  readonly #conversationAlive: AdvancementConversationAlivePort;

  constructor(options: AdvancementConversationLifecycleApplicationOptions) {
    this.#mechanism = options.mechanism;
    this.#conversationAlive = options.conversationAlive;
  }

  async cancelConversationLifecycle(conversationId: string): Promise<void> {
    assertConversationId(conversationId);
    const open =
      await this.#mechanism.loadOpenConversationLifecycleSession(conversationId);
    if (!open) return;
    await this.#mechanism.persistConversationLifecycleCancellation({
      conversationId,
      advancementSessionId: open.id,
      reason: "user-cancelled",
      message: "原始对话已删除，推进会话已取消。",
    });
  }

  async removeConversationData(conversationId: string): Promise<void> {
    assertConversationId(conversationId);
    await this.#mechanism.removeConversationData(conversationId);
  }

  async sweepOrphanData(): Promise<AdvancementOrphanSweepReport> {
    let candidates: readonly string[];
    try {
      candidates = await this.#mechanism.listConversationDataCandidates();
    } catch {
      return Object.freeze({
        scanned: 0,
        removed: 0,
        warnings: Object.freeze([]),
      });
    }

    let removed = 0;
    const warnings: string[] = [];
    for (const candidateId of candidates) {
      try {
        if (await this.#conversationAlive.isConversationDataAlive(candidateId)) {
          continue;
        }
        await this.#mechanism.removeConversationDataCandidate(candidateId);
        removed++;
      } catch (error) {
        warnings.push(`${candidateId}: ${applicationErrorMessage(error)}`);
      }
    }
    return Object.freeze({
      scanned: candidates.length,
      removed,
      warnings: Object.freeze(warnings),
    });
  }
}

/** Path-free mechanisms used by the no-open-session new-task decision. */
export interface AdvancementNewTaskMechanismPort {
  loadOpenNewTaskSession(
    conversationId: string,
  ): Promise<AdvancementSession | null>;
  decideNewTaskAdmission(input: Readonly<{
    conversationId: string;
    userInput: Readonly<UserTurnInput>;
  }>): Promise<AdvancementAdmissionDecision>;
  buildNewTaskRubricDraft(input: Readonly<{
    originalTurnId: string;
    originalUserTask: Readonly<UserTurnInput>;
  }>): Promise<RubricContractDraftSnapshot>;
  persistNewTaskAwaitingSession(input: Readonly<{
    conversationId: string;
    originalUserTask: Readonly<UserTurnInput>;
    draft: RubricContractDraftSnapshot;
  }>): Promise<AdvancementSession>;
}

/** Conversation application boundary used only after a draft has been built. */
export interface AdvancementNewTaskConversationPort {
  ensureShell(conversationId: string): Promise<void>;
}

/** Path-free owner mechanisms for the active user-turn state transition. */
export interface AdvancementActiveUserTurnMechanismPort {
  loadActiveUserTurnSession(
    conversationId: string,
  ): Promise<AdvancementSession | null>;
  decideActiveUserTurnAdmission(input: Readonly<{
    conversationId: string;
    userInput: Readonly<UserTurnInput>;
  }>): Promise<AdvancementAdmissionDecision>;
  activeUserTurnNow(): string;
  createActiveRubricDraftId(): string;
  reviseActiveRubricDraft(input: Readonly<{
    currentDraft: RubricContractDraftSnapshot;
    originalUserTask: AdvancementSession["originalUserTask"];
    userFeedback: string;
  }>): Promise<RubricContractDraftSnapshot>;
  persistActiveUserTurnExit(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    exit: AdvancementExit;
  }>): Promise<AdvancementSession>;
  composeActiveUserTurnClosure(
    session: AdvancementSession,
  ): Promise<AdvancementClosureReport>;
  persistRegeneratedRubricSession(input: Readonly<{
    advancementSessionId: string;
    conversationId: string;
    originalUserTask: AdvancementSession["originalUserTask"];
    draft: RubricContractDraftSnapshot;
  }>): Promise<AdvancementSession>;
  settleInterruptedProxy(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    proxyMessageId: string;
  }>): Promise<AdvancementSession>;
}

/** Anchor-owned effects; Advancement alone decides their ordering. */
export interface AdvancementActiveUserTurnRuntimePort {
  interruptProxy(input: Readonly<{
    conversationId: string;
    outstandingProxyMessageId?: string;
  }>): Promise<Readonly<{
    interrupted: boolean;
    proxyMessageId?: string;
  }>>;
  recoverInterruptedProxy(conversationId: string): Promise<void>;
}

/** Path-free mechanisms used by the Advancement rubric-revision application decision. */
export interface AdvancementRubricRevisionMechanismPort {
  loadRubricRevisionSession(
    conversationId: string,
    advancementSessionId: string,
  ): Promise<AdvancementSession | null>;
  reviseRubricDraftContent(input: Readonly<{
    currentDraft: RubricContractDraftSnapshot;
    originalUserTask: AdvancementSession["originalUserTask"];
    userFeedback: string;
  }>): Promise<RubricContractDraftSnapshot>;
  persistRubricDraftRevision(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    draft: RubricContractDraftSnapshot;
  }>): Promise<AdvancementSession>;
}

/** Path-free mechanisms for the durable Advancement cancellation transition. */
export interface AdvancementRubricCancellationMechanismPort {
  loadRubricCancellationSession(
    conversationId: string,
    advancementSessionId: string,
  ): Promise<AdvancementSession | null>;
  persistRubricCancellation(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    reason: AdvancementExit["reason"];
    message: string;
  }>): Promise<AdvancementSession>;
}

export type AdvancementAwaitingRubricAdmissionDecision = Omit<
  AdvancementAdmissionDecision,
  "action"
> & Readonly<{
  action:
    | "keep-awaiting-confirmation"
    | "downgrade-to-direct"
    | "cancel-pending-task";
}>;

/** Path-free natural-language admission mechanism for an already-awaiting Rubric. */
export interface AdvancementAwaitingRubricAdmissionMechanismPort {
  decideAwaitingRubricAdmission(input: Readonly<{
    conversationId: string;
    userInput: Readonly<UserTurnInput>;
  }>): Promise<AdvancementAwaitingRubricAdmissionDecision>;
}

/** Path-free mechanisms for confirming a Rubric and settling its durable handoff. */
export interface AdvancementRubricConfirmationMechanismPort {
  loadRubricConfirmationSession(
    conversationId: string,
    advancementSessionId: string,
  ): Promise<AdvancementSession | null>;
  confirmRubricDraftContent(
    draft: RubricContractDraftSnapshot,
  ): Promise<ConfirmedRubricSnapshot>;
  persistRubricConfirmation(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    confirmedRubric: ConfirmedRubricSnapshot;
    admissionIntent: AdvancementOriginalTaskAdmissionIntent;
  }>): Promise<AdvancementSession>;
  persistOriginalTaskAdmissionSettlement(input: Readonly<{
    conversationId: string;
    advancementSessionId: string;
    turnId: string;
    inputDigest: AdvancementOriginalTaskAdmissionIntent["inputDigest"];
    runId: string;
  }>): Promise<AdvancementSession>;
}

export type RubricPublicationOutcome =
  | Readonly<{ kind: "saved"; rubricId: string; revision: number }>
  | Readonly<{ kind: "deferred"; message: string }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "unavailable" }>;

/** Finite CAS projection required by the Rubric application adapters. */
export interface AdvancementRubricArtifactPort {
  readByDigest(digest: Digest): Promise<Uint8Array | undefined>;
  put(bytes: Uint8Array): Promise<ArtifactRef>;
}

/** Optional infrastructure effect. Advancement alone decides when publication applies. */
export interface RubricPublicationPort {
  publish(input: Readonly<{
    conversationId: string;
    draft: RubricContractDraftSnapshot;
    persistence: RubricDraftPersistenceChoice;
  }>): Promise<RubricPublicationOutcome>;
}

/** Cross-domain execution effect invoked only after the cancellation Fact is visible. */
export interface AdvancementOriginalTaskExecutionPort {
  execute(input: Readonly<{
    conversationId: string;
    originalTurnId: string;
    originalUserTask: Readonly<UserTurnInput>;
    surface: AdvancementOriginalTaskSurfacePort;
  }>): Promise<Readonly<{
    conversationId: string;
    turnId: string;
    runId?: string;
    runStatus: "immediate" | "queued";
  }>>;
}

export type AdvancementOriginalTaskAdmissionFailureReason =
  | "conversation-not-found"
  | "idempotency-conflict"
  | "queue-full"
  | "lifecycle-busy"
  | "turn-identity-invalid";

/**
 * Typed cross-domain failure used only so Advancement can decide compensation.
 * The original Conversation error is rethrown after that decision, preserving
 * the existing transport mapping without importing it into the domain.
 */
export class AdvancementOriginalTaskAdmissionError extends Error {
  constructor(
    readonly reason: AdvancementOriginalTaskAdmissionFailureReason,
    readonly originalError: unknown,
  ) {
    super(
      originalError instanceof Error
        ? originalError.message
        : "Original-task admission failed",
    );
    this.name = "AdvancementOriginalTaskAdmissionError";
  }
}

/** Cross-domain admission application invoked after the confirmed Fact is visible. */
export interface AdvancementConfirmedOriginalTaskAdmissionPort {
  admit(input: Readonly<{
    conversationId: string;
    originalUserTask: Readonly<UserTurnInput>;
    admissionIntent: AdvancementOriginalTaskAdmissionIntent;
    surface: AdvancementOriginalTaskSurfacePort;
  }>): Promise<Readonly<{
    conversationId: string;
    turnId: string;
    runId?: string;
    status: "immediate" | "queued" | "replayed";
  }>>;
}

/** Surface-owned effects needed by the Anchor cross-domain execution adapter. */
export interface AdvancementOriginalTaskSurfacePort {
  readonly caller: Readonly<{
    surfacePrincipal: string;
    connectionId: string;
  }>;
  readonly turnOrigin?: TurnOrigin;
  execute(input: Readonly<{
    conversationId: string;
    turnId: string;
    originalUserTask: Readonly<UserTurnInput>;
  }>): Promise<void>;
  cancelPending(input: Readonly<{
    conversationId: string;
    turnId: string;
  }>): void;
  onAdmitted?(input: Readonly<{
    conversationId: string;
    turnId: string;
    runId?: string;
    status: "immediate" | "queued" | "replayed";
  }>): void;
}

/** Surface projection effect; it cannot decide or persist Advancement state. */
export interface AdvancementRubricCancellationFactPort {
  publish(fact: AdvancementContractCancelledFact): void | Promise<void>;
}

/** Surface projection effect for the confirmation transaction and compensation. */
export interface AdvancementRubricConfirmationFactPort {
  publish(
    fact: AdvancementContractConfirmedFact | AdvancementContractCancelledFact,
  ): void | Promise<void>;
}

export interface AdvancementApplicationOptions {
  readonly activeState: Pick<AdvancementReviewAttemptApplication, "queryActiveState">;
  readonly detail: AdvancementDetailReadPort;
  readonly maintenance: AdvancementConversationMaintenancePort;
  readonly newTask: AdvancementNewTaskMechanismPort;
  readonly newTaskConversation: AdvancementNewTaskConversationPort;
  readonly activeUserTurn: AdvancementActiveUserTurnMechanismPort;
  readonly activeUserTurnRuntime: AdvancementActiveUserTurnRuntimePort;
  readonly rubricRevision: AdvancementRubricRevisionMechanismPort;
  readonly rubricCancellation: AdvancementRubricCancellationMechanismPort;
  readonly awaitingRubricAdmission: AdvancementAwaitingRubricAdmissionMechanismPort;
  readonly rubricConfirmation: AdvancementRubricConfirmationMechanismPort;
  readonly rubricPublication?: RubricPublicationPort;
  readonly originalTask: AdvancementOriginalTaskExecutionPort;
  readonly confirmedOriginalTask: AdvancementConfirmedOriginalTaskAdmissionPort;
}

export interface AdvancementNewTaskCommand {
  readonly conversationId: string;
  readonly conversationScope: "existing" | "new";
  readonly turnId: string;
  readonly userInput: Readonly<UserTurnInput>;
}

export interface AdvancementActiveUserTurnHandoff {
  readonly conversationId: string;
  readonly turnId: string;
  readonly runId?: string;
}

/** Surface effects only; no Advancement decision or persistence is allowed here. */
export interface AdvancementActiveUserTurnSurfacePort {
  publishExit(fact: AdvancementSessionExitedFact): void | Promise<void>;
  publishDraft(fact: AdvancementContractDraftCreatedFact): void | Promise<void>;
  publishContractFailure(input: Readonly<{
    conversationId: string;
    originalTurnId: string;
    error: Readonly<{ message: string }>;
  }>): void | Promise<void>;
  handoff(input: Readonly<{
    conversationId: string;
    turnId: string;
    userInput: Readonly<UserTurnInput>;
  }>): Promise<AdvancementActiveUserTurnHandoff>;
}

export interface AdvancementActiveUserTurnCommand {
  readonly conversationId: string;
  readonly turnId: string;
  readonly userInput: Readonly<UserTurnInput>;
  readonly surface: AdvancementActiveUserTurnSurfacePort;
}

export type AdvancementActiveUserTurnResult =
  | Readonly<{ kind: "not-applicable" }>
  | Readonly<{ kind: "owner-busy" }>
  | Readonly<{
      kind: "active-user-turn";
      conversationId: string;
      advancementSessionId: string;
      admission: AdvancementAdmissionDecision;
      interruptedProxy: boolean;
      handoff: AdvancementActiveUserTurnHandoff;
    }>
  | Readonly<{
      kind: "active-session-taken-over";
      conversationId: string;
      advancementSessionId: string;
      admission: AdvancementAdmissionDecision;
      exit: AdvancementExit;
      closure: AdvancementClosureReport;
      handoff: AdvancementActiveUserTurnHandoff;
    }>
  | Readonly<{
      kind: "rubric-regenerated";
      conversationId: string;
      exitedAdvancementSessionId: string;
      advancementSessionId: string;
      admission: AdvancementAdmissionDecision;
      exit: AdvancementExit;
      closure: AdvancementClosureReport;
      draft: RubricContractDraftSnapshot;
    }>
  | Readonly<{
      kind: "contract-failed";
      conversationId: string;
      originalTurnId: string;
      error: Readonly<{ message: string }>;
    }>;

type AdvancementActiveUserTurnDecision =
  | Readonly<{ kind: "not-applicable" }>
  | Readonly<{
      kind: "continue";
      session: AdvancementSession;
      admission: AdvancementAdmissionDecision;
      interruptedProxy: boolean;
    }>
  | Readonly<{
      kind: "take-over";
      exited: AdvancementSession;
      admission: AdvancementAdmissionDecision;
      exit: AdvancementExit;
      closure: AdvancementClosureReport;
      fact: AdvancementSessionExitedFact;
    }>
  | Readonly<{
      kind: "regenerated";
      exited: AdvancementSession;
      created: AdvancementSession;
      admission: AdvancementAdmissionDecision;
      exit: AdvancementExit;
      closure: AdvancementClosureReport;
      draft: RubricContractDraftSnapshot;
      exitFact: AdvancementSessionExitedFact;
      draftFact: AdvancementContractDraftCreatedFact;
    }>
  | Readonly<{
      kind: "contract-failed";
      conversationId: string;
      originalTurnId: string;
      error: Readonly<{ message: string }>;
    }>;

export interface AdvancementSessionExitedFact extends ProductApiFact {
  readonly kind: "advancement-session-exited";
  readonly conversationId: string;
  readonly originalTurnId: string;
  readonly advancementSessionId: string;
  readonly exit: AdvancementExit;
  readonly admission: AdvancementAdmissionDecision;
  readonly closure: AdvancementClosureReport;
}

export type AdvancementNewTaskResult =
  | Readonly<{ kind: "not-applicable" }>
  | Readonly<{
      kind: "run-direct";
      admission: AdvancementAdmissionDecision;
    }>
  | Readonly<{ kind: "owner-busy" }>
  | Readonly<{
      kind: "contract-failed";
      conversationId: string;
      originalTurnId: string;
      error: Readonly<{ message: string }>;
    }>
  | Readonly<{
      kind: "awaiting-rubric-confirmation";
      conversationId: string;
      advancementSessionId: string;
      draft: RubricContractDraftSnapshot;
      admission: AdvancementAdmissionDecision;
    }>;

export interface AdvancementContractDraftCreatedFact extends ProductApiFact {
  readonly kind: "advancement-contract-draft-created";
  readonly conversationId: string;
  readonly originalTurnId: string;
  readonly advancementSessionId: string;
  readonly rubricDraftId: string;
  readonly rubricDraft: RubricContractDraftSnapshot;
  readonly admission: AdvancementAdmissionDecision;
}

export interface AdvancementDetailQuery {
  readonly conversationId: string;
}

export interface AdvancementDetailProjection {
  readonly advancementSessionId: string;
  readonly status: AdvancementSessionStatus;
  readonly rubricTitle?: string;
  readonly exit?: AdvancementExit;
  readonly facts: AdvancementClosureFacts;
  readonly lastReview?: AdvancementRunReview;
}

export type AdvancementDetailResult = AdvancementDetailProjection | null;

export interface AdvancementActiveStateQuery {
  readonly conversationId: string;
}

export interface AdvancementActiveStateProjection {
  readonly advancementSessionId: string;
  readonly status: "awaiting-rubric-confirmation" | "active";
  readonly rubricTitle?: string;
  readonly rubricDraftId?: string;
  readonly pendingRubricDraft?: RubricContractDraftSnapshot;
  readonly outstandingProxyMessageId?: string;
  readonly lastReview?: Readonly<{
    id: string;
    runIndex: number;
    round: number;
    decision: AdvancementRunReview["decision"];
    reviewedAt: string;
  }>;
}

export type AdvancementActiveStateResult = AdvancementActiveStateProjection | null;

export interface AdvancementRubricRevisionCommand {
  readonly conversationId: string;
  readonly advancementSessionId: string;
  readonly userFeedback: string;
}

export interface AdvancementRubricRevisionResult {
  readonly conversationId: string;
  readonly advancementSessionId: string;
  readonly rubricDraftId: string;
  readonly rubricDraftVersion: number;
  readonly rubricDraft: RubricContractDraftSnapshot;
}

export interface AdvancementContractDraftRevisedFact extends ProductApiFact {
  readonly kind: "advancement-contract-draft-revised";
  readonly conversationId: string;
  readonly originalTurnId: string;
  readonly advancementSessionId: string;
  readonly rubricDraftId: string;
  readonly rubricDraftVersion: number;
  readonly rubricDraft: RubricContractDraftSnapshot;
  readonly revised: true;
}

export interface AdvancementRubricCancellationCommand {
  readonly conversationId: string;
  readonly advancementSessionId: string;
  readonly executeOriginal: boolean;
  readonly fact: AdvancementRubricCancellationFactPort;
  readonly surface: AdvancementOriginalTaskSurfacePort;
}

export interface AdvancementAwaitingRubricControlCommand {
  readonly conversationId: string;
  readonly userInput: Readonly<UserTurnInput>;
  readonly fact: AdvancementRubricCancellationFactPort;
  readonly surface: AdvancementOriginalTaskSurfacePort;
}

export type AdvancementAwaitingRubricControlResult =
  | Readonly<{ kind: "not-applicable" }>
  | Readonly<{
      kind: "keep-awaiting";
      conversationId: string;
      advancementSessionId: string;
      rubricDraft: RubricContractDraftSnapshot;
    }>
  | Readonly<{
      kind: "cancelled";
      conversationId: string;
      advancementSessionId: string;
    }>
  | Readonly<{
      kind: "direct-original-task";
      conversationId: string;
      advancementSessionId: string;
      turnId: string;
      runId?: string;
      runStatus: "immediate" | "queued";
    }>;

export interface AdvancementRubricConfirmationCommand {
  readonly conversationId: string;
  readonly advancementSessionId: string;
  readonly expectedRubricDraftId: string;
  readonly persistence?: RubricDraftPersistenceChoice;
  readonly originalTaskTurnOrigin: TurnOrigin;
  readonly fact: AdvancementRubricConfirmationFactPort;
  readonly surface: AdvancementOriginalTaskSurfacePort;
}

export interface AdvancementRubricConfirmationResult {
  readonly conversationId: string;
  readonly advancementSessionId: string;
  readonly turnId: string;
  readonly runId?: string;
  readonly runStatus: "immediate" | "queued";
  readonly rubricPublicationMessage?: string;
}

export interface AdvancementContractConfirmedFact extends ProductApiFact {
  readonly kind: "advancement-contract-confirmed";
  readonly conversationId: string;
  readonly originalTurnId: string;
  readonly advancementSessionId: string;
  readonly controlSeq: number;
  readonly rubricId?: string;
}

export type AdvancementRubricCancellationResult =
  | Readonly<{
      kind: "cancelled";
      conversationId: string;
      advancementSessionId: string;
    }>
  | Readonly<{
      kind: "direct-original-task";
      conversationId: string;
      advancementSessionId: string;
      turnId: string;
      runId?: string;
      runStatus: "immediate" | "queued";
    }>;

export interface AdvancementContractCancelledFact extends ProductApiFact {
  readonly kind: "advancement-contract-cancelled";
  readonly conversationId: string;
  readonly originalTurnId: string;
  readonly advancementSessionId: string;
  readonly controlSeq: number;
  readonly executeOriginal: boolean;
  readonly reason?: "original-task-admission-failed" | "user-cancelled";
}

export type AdvancementApplicationErrorCode =
  | "conversation-not-found"
  | "conversation-busy"
  | "advancement-session-not-found"
  | "advancement-session-identity-mismatch"
  | "not-awaiting-rubric-confirmation"
  | "pending-rubric-draft-missing"
  | "rubric-draft-stale"
  | "committed-rubric-draft-missing"
  | "committed-rubric-confirmation-missing"
  | "committed-original-task-admission-missing"
  | "committed-cancellation-missing";

export class AdvancementApplicationError extends Error {
  readonly code: AdvancementApplicationErrorCode;
  readonly advancementSessionId?: string;

  constructor(
    code: AdvancementApplicationErrorCode,
    message: string,
    options: Readonly<{ advancementSessionId?: string }> = {},
  ) {
    super(message);
    this.name = "AdvancementApplicationError";
    this.code = code;
    this.advancementSessionId = options.advancementSessionId;
  }
}

export interface AdvancementApplication {
  queryActiveState(
    query: AdvancementActiveStateQuery,
  ): Promise<AdvancementActiveStateResult>;
  queryDetail(query: AdvancementDetailQuery): Promise<AdvancementDetailResult>;
  prepareActiveUserTurn(
    command: AdvancementActiveUserTurnCommand,
  ): Promise<Readonly<{
    result: AdvancementActiveUserTurnResult;
    facts: readonly (
      | AdvancementSessionExitedFact
      | AdvancementContractDraftCreatedFact
    )[];
  }>>;
  prepareNewTask(
    command: AdvancementNewTaskCommand,
  ): Promise<Readonly<{
    result: AdvancementNewTaskResult;
    fact?: AdvancementContractDraftCreatedFact;
  }>>;
  reviseRubricDraft(
    command: AdvancementRubricRevisionCommand,
  ): Promise<Readonly<{
    result: AdvancementRubricRevisionResult;
    fact: AdvancementContractDraftRevisedFact;
  }>>;
  cancelRubric(
    command: AdvancementRubricCancellationCommand,
  ): Promise<Readonly<{
    result: AdvancementRubricCancellationResult;
    fact: AdvancementContractCancelledFact;
  }>>;
  controlAwaitingRubric(
    command: AdvancementAwaitingRubricControlCommand,
  ): Promise<Readonly<{
    result: AdvancementAwaitingRubricControlResult;
    fact?: AdvancementContractCancelledFact;
  }>>;
  confirmRubric(
    command: AdvancementRubricConfirmationCommand,
  ): Promise<Readonly<{
    result: AdvancementRubricConfirmationResult;
    fact: AdvancementContractConfirmedFact;
  }>>;
}

/** Advancement-owned application decisions exposed through one finite Product API contribution. */
export class AdvancementApplicationService implements AdvancementApplication {
  readonly #activeState: Pick<AdvancementReviewAttemptApplication, "queryActiveState">;
  readonly #detail: AdvancementDetailReadPort;
  readonly #maintenance: AdvancementConversationMaintenancePort;
  readonly #newTask: AdvancementNewTaskMechanismPort;
  readonly #newTaskConversation: AdvancementNewTaskConversationPort;
  readonly #activeUserTurn: AdvancementActiveUserTurnMechanismPort;
  readonly #activeUserTurnRuntime: AdvancementActiveUserTurnRuntimePort;
  readonly #rubricRevision: AdvancementRubricRevisionMechanismPort;
  readonly #rubricCancellation: AdvancementRubricCancellationMechanismPort;
  readonly #awaitingRubricAdmission: AdvancementAwaitingRubricAdmissionMechanismPort;
  readonly #rubricConfirmation: AdvancementRubricConfirmationMechanismPort;
  readonly #rubricPublication?: RubricPublicationPort;
  readonly #originalTask: AdvancementOriginalTaskExecutionPort;
  readonly #confirmedOriginalTask: AdvancementConfirmedOriginalTaskAdmissionPort;

  constructor(options: AdvancementApplicationOptions) {
    this.#activeState = options.activeState;
    this.#detail = options.detail;
    this.#maintenance = options.maintenance;
    this.#newTask = options.newTask;
    this.#newTaskConversation = options.newTaskConversation;
    this.#activeUserTurn = options.activeUserTurn;
    this.#activeUserTurnRuntime = options.activeUserTurnRuntime;
    this.#rubricRevision = options.rubricRevision;
    this.#rubricCancellation = options.rubricCancellation;
    this.#awaitingRubricAdmission = options.awaitingRubricAdmission;
    this.#rubricConfirmation = options.rubricConfirmation;
    this.#rubricPublication = options.rubricPublication;
    this.#originalTask = options.originalTask;
    this.#confirmedOriginalTask = options.confirmedOriginalTask;
  }

  async queryActiveState(
    query: AdvancementActiveStateQuery,
  ): Promise<AdvancementActiveStateResult> {
    assertConversationId(query.conversationId);
    return await this.#activeState.queryActiveState(query.conversationId);
  }

  async queryDetail(
    query: AdvancementDetailQuery,
  ): Promise<AdvancementDetailResult> {
    assertConversationId(query.conversationId);
    const session = await this.#detail.loadLatestSession(query.conversationId);
    if (!session) return null;

    const lastReview = session.runs[session.runs.length - 1];
    return freezeSnapshot({
      advancementSessionId: session.id,
      status: session.status,
      ...(session.confirmedRubric?.title
        ? { rubricTitle: session.confirmedRubric.title }
        : session.pendingRubricDraft?.title
          ? { rubricTitle: session.pendingRubricDraft.title }
          : {}),
      ...(session.exit ? { exit: session.exit } : {}),
      facts: buildClosureFacts(session),
      ...(lastReview ? { lastReview } : {}),
    });
  }

  async prepareActiveUserTurn(
    command: AdvancementActiveUserTurnCommand,
  ): Promise<Readonly<{
    result: AdvancementActiveUserTurnResult;
    facts: readonly (
      | AdvancementSessionExitedFact
      | AdvancementContractDraftCreatedFact
    )[];
  }>> {
    assertConversationId(command.conversationId);
    assertRubricRevisionIdentity(command.turnId, "Turn");
    if (!isNonEmptyUserTurnInput(command.userInput)) {
      throw new TypeError("Advancement active user turn requires non-empty user input");
    }
    assertActiveUserTurnSurface(command.surface);

    const initial = await this.#activeUserTurn.loadActiveUserTurnSession(
      command.conversationId,
    );
    if (initial?.status !== "active") {
      return noActiveUserTurn();
    }

    const decide = async (): Promise<AdvancementActiveUserTurnDecision> => {
      const current = await this.#activeUserTurn.loadActiveUserTurnSession(
        command.conversationId,
      );
      if (current?.status !== "active" || current.id !== initial.id) {
        return Object.freeze({ kind: "not-applicable" });
      }

      const interruption = await this.#activeUserTurnRuntime.interruptProxy({
        conversationId: command.conversationId,
        ...(current.outstandingProxyMessageId
          ? { outstandingProxyMessageId: current.outstandingProxyMessageId }
          : {}),
      });

      const admission = await this.#activeUserTurn.decideActiveUserTurnAdmission({
        conversationId: command.conversationId,
        userInput: command.userInput,
      });

      const exitActiveSession = async (
        exit: AdvancementExit,
      ): Promise<Extract<
        AdvancementActiveUserTurnDecision,
        { readonly kind: "take-over" }
      >> => {
        const exited = await this.#activeUserTurn.persistActiveUserTurnExit({
          conversationId: command.conversationId,
          advancementSessionId: current.id,
          exit,
        });
        assertCommittedActiveExit(exited, current, exit);
        const closure = await this.#activeUserTurn.composeActiveUserTurnClosure(
          exited,
        );
        const fact = freezeSnapshot<AdvancementSessionExitedFact>({
          kind: "advancement-session-exited",
          conversationId: exited.conversationId,
          originalTurnId: command.turnId,
          advancementSessionId: exited.id,
          exit,
          admission,
          closure,
        });
        return Object.freeze({
          kind: "take-over",
          exited,
          admission: freezeSnapshot(admission),
          exit: freezeSnapshot(exit),
          closure: freezeSnapshot(closure),
          fact,
        });
      };

      if (admission.action === "take-over-active") {
        return await exitActiveSession({
          reason: "user-took-over",
          message: "用户接管或改变了当前推进目标，原推进闭环已退出。",
          occurredAt: this.#activeUserTurn.activeUserTurnNow(),
        });
      }

      if (admission.action === "revise-rubric") {
        const oldRubric = current.confirmedRubric;
        if (!oldRubric) {
          return await exitActiveSession({
            reason: "system-error",
            message: "推进会话缺少已确认 Rubric，无法按其再生契约，已退出。",
            occurredAt: this.#activeUserTurn.activeUserTurnNow(),
          });
        }

        const prefillDraft: RubricContractDraftSnapshot = {
          draftId: this.#activeUserTurn.createActiveRubricDraftId(),
          originalTurnId: command.turnId,
          source: "generated",
          candidateRubricIds: [],
          title: oldRubric.title,
          description: oldRubric.description,
          content: projectConfirmedRubricToDraftContent(oldRubric),
          createdAt: this.#activeUserTurn.activeUserTurnNow(),
        };
        let revised: RubricContractDraftSnapshot;
        try {
          revised = await this.#activeUserTurn.reviseActiveRubricDraft({
            currentDraft: prefillDraft,
            originalUserTask: current.originalUserTask,
            userFeedback: extractUserTurnInputText(command.userInput).trim(),
          });
        } catch (error) {
          const failure = Object.freeze({
            kind: "contract-failed" as const,
            conversationId: command.conversationId,
            originalTurnId: command.turnId,
            error: Object.freeze({ message: applicationErrorMessage(error) }),
          });
          return failure;
        }

        const exit: AdvancementExit = {
          reason: "superseded",
          message: "用户修正验收标准，原契约退出，按修正后的标准重新确认。",
          occurredAt: this.#activeUserTurn.activeUserTurnNow(),
        };
        const exited = await this.#activeUserTurn.persistActiveUserTurnExit({
          conversationId: command.conversationId,
          advancementSessionId: current.id,
          exit,
        });
        assertCommittedActiveExit(exited, current, exit);
        const closure = await this.#activeUserTurn.composeActiveUserTurnClosure(
          exited,
        );
        const created = await this.#activeUserTurn.persistRegeneratedRubricSession({
          advancementSessionId: `adv_${revised.draftId}`,
          conversationId: command.conversationId,
          originalUserTask: current.originalUserTask,
          draft: revised,
        });
        assertCommittedRegeneratedSession(created, command, current, revised);
        const admissionSnapshot = freezeSnapshot(admission);
        const draftSnapshot = freezeSnapshot(revised);
        const exitFact = freezeSnapshot<AdvancementSessionExitedFact>({
          kind: "advancement-session-exited",
          conversationId: exited.conversationId,
          originalTurnId: command.turnId,
          advancementSessionId: exited.id,
          exit,
          admission: admissionSnapshot,
          closure,
        });
        const draftFact = freezeSnapshot<AdvancementContractDraftCreatedFact>({
          kind: "advancement-contract-draft-created",
          conversationId: created.conversationId,
          originalTurnId: command.turnId,
          advancementSessionId: created.id,
          rubricDraftId: draftSnapshot.draftId,
          rubricDraft: draftSnapshot,
          admission: admissionSnapshot,
        });
        return Object.freeze({
          kind: "regenerated",
          exited,
          created,
          admission: admissionSnapshot,
          exit: freezeSnapshot(exit),
          closure: freezeSnapshot(closure),
          draft: draftSnapshot,
          exitFact,
          draftFact,
        });
      }

      if (interruption.interrupted && interruption.proxyMessageId) {
        const settled = await this.#activeUserTurn.settleInterruptedProxy({
          conversationId: command.conversationId,
          advancementSessionId: current.id,
          proxyMessageId: interruption.proxyMessageId,
        });
        if (
          settled.id !== current.id ||
          settled.conversationId !== current.conversationId
        ) {
          throw new TypeError(
            "Advancement interrupted-proxy settlement returned a mismatched session",
          );
        }
      }
      return Object.freeze({
        kind: "continue",
        session: current,
        admission: freezeSnapshot(admission),
        interruptedProxy: interruption.interrupted,
      });
    };

    const maintained = await this.#maintenance.runExisting(
      command.conversationId,
      decide,
    );
    if (maintained.status === "not-found") {
      throw new AdvancementApplicationError(
        "conversation-not-found",
        `Conversation not found: ${command.conversationId}`,
      );
    }
    const decision = maintained.status === "busy"
      // A busy ordinary turn must not be interrupted, while an Advancement
      // proxy already received its stop signal. Preserve the existing active
      // classification/handoff semantics under the current session identity.
      ? await decide()
      : maintained.value;

    if (decision.kind === "not-applicable") {
      return noActiveUserTurn();
    }
    if (decision.kind === "contract-failed") {
      await command.surface.publishContractFailure(decision);
      try {
        await this.#activeUserTurnRuntime.recoverInterruptedProxy(
          command.conversationId,
        );
      } catch {
        // Recovery remains best-effort; the controlled contract failure wins.
      }
      return Object.freeze({
        result: Object.freeze<AdvancementActiveUserTurnResult>({
          kind: "contract-failed",
          conversationId: decision.conversationId,
          originalTurnId: decision.originalTurnId,
          error: decision.error,
        }),
        facts: Object.freeze([]),
      });
    }
    if (decision.kind === "regenerated") {
      await command.surface.publishExit(decision.exitFact);
      await command.surface.publishDraft(decision.draftFact);
      return Object.freeze({
        result: Object.freeze<AdvancementActiveUserTurnResult>({
          kind: "rubric-regenerated",
          conversationId: decision.created.conversationId,
          exitedAdvancementSessionId: decision.exited.id,
          advancementSessionId: decision.created.id,
          admission: decision.admission,
          exit: decision.exit,
          closure: decision.closure,
          draft: decision.draft,
        }),
        facts: Object.freeze([decision.exitFact, decision.draftFact]),
      });
    }

    const fact = decision.kind === "take-over" ? decision.fact : undefined;
    if (fact) await command.surface.publishExit(fact);
    const handoff = await command.surface.handoff({
      conversationId: command.conversationId,
      turnId: command.turnId,
      userInput: command.userInput,
    });
    assertActiveUserTurnHandoff(handoff, command);
    if (decision.kind === "take-over") {
      return Object.freeze({
        result: Object.freeze<AdvancementActiveUserTurnResult>({
          kind: "active-session-taken-over",
          conversationId: decision.exited.conversationId,
          advancementSessionId: decision.exited.id,
          admission: decision.admission,
          exit: decision.exit,
          closure: decision.closure,
          handoff: freezeSnapshot(handoff),
        }),
        facts: Object.freeze([decision.fact]),
      });
    }
    return Object.freeze({
      result: Object.freeze<AdvancementActiveUserTurnResult>({
        kind: "active-user-turn",
        conversationId: decision.session.conversationId,
        advancementSessionId: decision.session.id,
        admission: decision.admission,
        interruptedProxy: decision.interruptedProxy,
        handoff: freezeSnapshot(handoff),
      }),
      facts: Object.freeze([]),
    });
  }

  async prepareNewTask(
    command: AdvancementNewTaskCommand,
  ): Promise<Readonly<{
    result: AdvancementNewTaskResult;
    fact?: AdvancementContractDraftCreatedFact;
  }>> {
    assertConversationId(command.conversationId);
    assertRubricRevisionIdentity(command.turnId, "Turn");
    if (
      command.conversationScope !== "existing" &&
      command.conversationScope !== "new"
    ) {
      throw new TypeError("Advancement new task requires a conversation scope");
    }
    if (!isNonEmptyUserTurnInput(command.userInput)) {
      throw new TypeError("Advancement new task requires non-empty user input");
    }

    const decide = async () => {
      const open = await this.#newTask.loadOpenNewTaskSession(
        command.conversationId,
      );
      if (open) {
        return Object.freeze({
          result: Object.freeze<AdvancementNewTaskResult>({
            kind: "not-applicable",
          }),
        });
      }

      const admission = await this.#newTask.decideNewTaskAdmission({
        conversationId: command.conversationId,
        userInput: command.userInput,
      });
      if (admission.action !== "start-advancement") {
        if (admission.action !== "run-direct") {
          throw new TypeError(
            `Advancement new-task admission returned invalid action: ${admission.action}`,
          );
        }
        return Object.freeze({
          result: Object.freeze<AdvancementNewTaskResult>({
            kind: "run-direct",
            admission: freezeSnapshot(admission),
          }),
        });
      }

      let draft: RubricContractDraftSnapshot;
      try {
        draft = await this.#newTask.buildNewTaskRubricDraft({
          originalTurnId: command.turnId,
          originalUserTask: command.userInput,
        });
      } catch (error) {
        return Object.freeze({
          result: Object.freeze<AdvancementNewTaskResult>({
            kind: "contract-failed",
            conversationId: command.conversationId,
            originalTurnId: command.turnId,
            error: Object.freeze({ message: applicationErrorMessage(error) }),
          }),
        });
      }

      if (command.conversationScope === "new") {
        await this.#newTaskConversation.ensureShell(command.conversationId);
      }
      const committed = await this.#newTask.persistNewTaskAwaitingSession({
        conversationId: command.conversationId,
        originalUserTask: command.userInput,
        draft,
      });
      assertCommittedNewTaskSession(committed, command, draft);
      const admissionSnapshot = freezeSnapshot(admission);
      const draftSnapshot = freezeSnapshot(draft);
      const result = Object.freeze<AdvancementNewTaskResult>({
        kind: "awaiting-rubric-confirmation",
        conversationId: committed.conversationId,
        advancementSessionId: committed.id,
        draft: draftSnapshot,
        admission: admissionSnapshot,
      });
      const fact = Object.freeze<AdvancementContractDraftCreatedFact>({
        kind: "advancement-contract-draft-created",
        conversationId: committed.conversationId,
        originalTurnId: command.turnId,
        advancementSessionId: committed.id,
        rubricDraftId: draftSnapshot.draftId,
        rubricDraft: draftSnapshot,
        admission: admissionSnapshot,
      });
      return Object.freeze({ result, fact });
    };

    const maintained =
      command.conversationScope === "existing"
        ? await this.#maintenance.runExisting(command.conversationId, decide)
        : await this.#maintenance.runNew(command.conversationId, decide);
    if (maintained.status === "busy") {
      return Object.freeze({
        result: Object.freeze<AdvancementNewTaskResult>({ kind: "owner-busy" }),
      });
    }
    if (maintained.status === "not-found") {
      throw new AdvancementApplicationError(
        "conversation-not-found",
        `Conversation not found: ${command.conversationId}`,
      );
    }
    return maintained.value;
  }

  async reviseRubricDraft(
    command: AdvancementRubricRevisionCommand,
  ): Promise<Readonly<{
    result: AdvancementRubricRevisionResult;
    fact: AdvancementContractDraftRevisedFact;
  }>> {
    assertRubricRevisionIdentity(command.conversationId, "conversation");
    assertRubricRevisionIdentity(
      command.advancementSessionId,
      "Advancement session",
    );
    const userFeedback = normalizeUserFeedback(command.userFeedback);
    const maintained = await this.#maintenance.runExisting(
      command.conversationId,
      async () => {
        const session = await this.#rubricRevision.loadRubricRevisionSession(
          command.conversationId,
          command.advancementSessionId,
        );
        if (!session) {
          throw new AdvancementApplicationError(
            "advancement-session-not-found",
            `Advancement session not found: ${command.advancementSessionId}`,
            { advancementSessionId: command.advancementSessionId },
          );
        }
        if (session.status !== "awaiting-rubric-confirmation") {
          throw new AdvancementApplicationError(
            "not-awaiting-rubric-confirmation",
            `Advancement session is not awaiting rubric confirmation: ${session.id}`,
            { advancementSessionId: session.id },
          );
        }
        const currentDraft = session.pendingRubricDraft;
        if (!currentDraft) {
          throw new AdvancementApplicationError(
            "pending-rubric-draft-missing",
            `Advancement session has no pending rubric draft: ${session.id}`,
            { advancementSessionId: session.id },
          );
        }
        const revisedDraft =
          await this.#rubricRevision.reviseRubricDraftContent({
            currentDraft,
            originalUserTask: session.originalUserTask,
            userFeedback,
          });
        const updated =
          await this.#rubricRevision.persistRubricDraftRevision({
            conversationId: command.conversationId,
            advancementSessionId: command.advancementSessionId,
            draft: revisedDraft,
          });
        const committedDraft = updated.pendingRubricDraft;
        if (!committedDraft) {
          throw new AdvancementApplicationError(
            "committed-rubric-draft-missing",
            `Committed Advancement session has no pending rubric draft: ${updated.id}`,
            { advancementSessionId: updated.id },
          );
        }
        const rubricDraft = freezeSnapshot(committedDraft);
        const result = Object.freeze<AdvancementRubricRevisionResult>({
          conversationId: updated.conversationId,
          advancementSessionId: updated.id,
          rubricDraftId: rubricDraft.draftId,
          rubricDraftVersion: updated.rubricDraftVersion,
          rubricDraft,
        });
        const fact = Object.freeze<AdvancementContractDraftRevisedFact>({
          kind: "advancement-contract-draft-revised",
          conversationId: updated.conversationId,
          originalTurnId: rubricDraft.originalTurnId,
          advancementSessionId: updated.id,
          rubricDraftId: rubricDraft.draftId,
          rubricDraftVersion: updated.rubricDraftVersion,
          rubricDraft,
          revised: true,
        });
        return Object.freeze({ result, fact });
      },
    );
    if (maintained.status === "not-found") {
      throw new AdvancementApplicationError(
        "conversation-not-found",
        `Conversation not found: ${command.conversationId}`,
      );
    }
    if (maintained.status === "busy") {
      throw new AdvancementApplicationError(
        "conversation-busy",
        `Conversation is busy: ${command.conversationId}`,
      );
    }
    return maintained.value;
  }

  async confirmRubric(
    command: AdvancementRubricConfirmationCommand,
  ): Promise<Readonly<{
    result: AdvancementRubricConfirmationResult;
    fact: AdvancementContractConfirmedFact;
  }>> {
    assertRubricRevisionIdentity(command.conversationId, "conversation");
    assertRubricRevisionIdentity(
      command.advancementSessionId,
      "Advancement session",
    );
    assertRubricRevisionIdentity(command.expectedRubricDraftId, "Rubric draft");
    assertOriginalTaskSurface(command.surface);
    if (typeof command.fact?.publish !== "function") {
      throw new TypeError("Advancement rubric confirmation requires a Fact projection port");
    }
    if (
      command.originalTaskTurnOrigin.triggeredBy !==
      command.surface.caller.surfacePrincipal
    ) {
      throw new TypeError(
        "Advancement rubric confirmation origin must bind its surface principal",
      );
    }

    const maintained = await this.#maintenance.runExisting(
      command.conversationId,
      async () => {
        const session =
          await this.#rubricConfirmation.loadRubricConfirmationSession(
            command.conversationId,
            command.advancementSessionId,
          );
        if (!session) {
          throw new AdvancementApplicationError(
            "advancement-session-not-found",
            `Advancement session not found: ${command.advancementSessionId}`,
            { advancementSessionId: command.advancementSessionId },
          );
        }
        assertAdvancementSessionIdentity(session, command);
        if (session.status !== "awaiting-rubric-confirmation") {
          throw new AdvancementApplicationError(
            "not-awaiting-rubric-confirmation",
            `Advancement session is not awaiting rubric confirmation: ${session.id}`,
            { advancementSessionId: session.id },
          );
        }
        const draft = session.pendingRubricDraft;
        if (!draft) {
          throw new AdvancementApplicationError(
            "pending-rubric-draft-missing",
            `Advancement session has no pending rubric draft: ${session.id}`,
            { advancementSessionId: session.id },
          );
        }
        if (draft.draftId !== command.expectedRubricDraftId) {
          throw new AdvancementApplicationError(
            "rubric-draft-stale",
            "推进准则草案已被修订，请查看最新内容后再确认。",
            { advancementSessionId: session.id },
          );
        }

        const confirmedRubric =
          await this.#rubricConfirmation.confirmRubricDraftContent(draft);
        const admissionIntent = Object.freeze<AdvancementOriginalTaskAdmissionIntent>({
          turnId: draft.originalTurnId,
          surfacePrincipal: command.surface.caller.surfacePrincipal,
          turnOrigin: freezeSnapshot(command.originalTaskTurnOrigin),
          inputDigest: protocolDigest(
            "AdvancementOriginalTaskInput",
            1,
            session.originalUserTask,
          ),
        });
        const committed =
          await this.#rubricConfirmation.persistRubricConfirmation({
            conversationId: command.conversationId,
            advancementSessionId: command.advancementSessionId,
            confirmedRubric,
            admissionIntent,
          });
        assertCommittedRubricConfirmation(committed, command, admissionIntent);
        const committedRubric = committed.confirmedRubric!;
        const fact = Object.freeze<AdvancementContractConfirmedFact>({
          kind: "advancement-contract-confirmed",
          conversationId: committed.conversationId,
          originalTurnId: committed.originalTaskAdmission!.intent.turnId,
          advancementSessionId: committed.id,
          controlSeq: committed.rubricDraftVersion + 1,
          ...(committedRubric.source.kind === "library"
            ? { rubricId: committedRubric.source.rubricId }
            : {}),
        });
        return Object.freeze({
          committed,
          draft: freezeSnapshot(draft),
          fact,
          originalUserTask: freezeSnapshot(committed.originalUserTask),
        });
      },
    );

    if (maintained.status === "not-found") {
      await this.#cancelPreConfirmationNotFound(command);
      throw new AdvancementApplicationError(
        "conversation-not-found",
        `Conversation not found: ${command.conversationId}`,
      );
    }
    if (maintained.status === "busy") {
      throw new AdvancementApplicationError(
        "conversation-busy",
        `Conversation is busy: ${command.conversationId}`,
      );
    }

    const decision = maintained.value;
    await command.fact.publish(decision.fact);

    const publication =
      decision.draft.source === "generated" && command.persistence
        ? this.#publishRubric(decision.committed.conversationId, decision.draft, command.persistence)
        : undefined;

    let admitted: Awaited<
      ReturnType<AdvancementConfirmedOriginalTaskAdmissionPort["admit"]>
    >;
    try {
      admitted = await this.#confirmedOriginalTask.admit({
        conversationId: decision.committed.conversationId,
        originalUserTask: decision.originalUserTask,
        admissionIntent: decision.committed.originalTaskAdmission!.intent,
        surface: command.surface,
      });
    } catch (error) {
      if (error instanceof AdvancementOriginalTaskAdmissionError) {
        if (
          error.reason === "conversation-not-found" ||
          error.reason === "idempotency-conflict"
        ) {
          await this.#cancelFailedOriginalTaskAdmission(
            command,
            decision.committed,
            error.reason,
          );
        }
        throw error.originalError;
      }
      throw error;
    }
    if (
      admitted.conversationId !== decision.committed.conversationId ||
      admitted.turnId !== decision.committed.originalTaskAdmission!.intent.turnId
    ) {
      throw new TypeError(
        "Advancement original-task admission returned a mismatched identity",
      );
    }

    let settled = decision.committed;
    let settlementCommitted = false;
    if (admitted.runId) {
      try {
        settled =
          await this.#rubricConfirmation.persistOriginalTaskAdmissionSettlement({
            conversationId: decision.committed.conversationId,
            advancementSessionId: decision.committed.id,
            turnId: decision.committed.originalTaskAdmission!.intent.turnId,
            inputDigest:
              decision.committed.originalTaskAdmission!.intent.inputDigest,
            runId: admitted.runId,
          });
        settlementCommitted = true;
      } catch {
        // Admission is already durable. Recovery owns retrying the pending intent.
      }
    }
    const settledAdmission =
      admitted.runId && settlementCommitted
        ? assertCommittedOriginalTaskAdmission(
            settled,
            command,
            decision.committed.originalTaskAdmission!.intent,
            admitted.runId,
          )
        : decision.committed.originalTaskAdmission!;

    const rubricPublicationMessage = publication
      ? publicationMessage(await publication)
      : undefined;
    return Object.freeze({
      result: Object.freeze<AdvancementRubricConfirmationResult>({
        conversationId: settled.conversationId,
        advancementSessionId: settled.id,
        turnId: settledAdmission.intent.turnId,
        ...(admitted.runId ? { runId: admitted.runId } : {}),
        runStatus: admitted.status === "replayed" ? "queued" : admitted.status,
        ...(rubricPublicationMessage ? { rubricPublicationMessage } : {}),
      }),
      fact: decision.fact,
    });
  }

  async #cancelPreConfirmationNotFound(
    command: AdvancementRubricConfirmationCommand,
  ): Promise<void> {
    try {
      const source =
        await this.#rubricCancellation.loadRubricCancellationSession(
          command.conversationId,
          command.advancementSessionId,
        );
      if (!source) return;
      assertAdvancementSessionIdentity(source, command);
      await this.#rubricCancellation.persistRubricCancellation({
        conversationId: command.conversationId,
        advancementSessionId: command.advancementSessionId,
        reason: "system-error",
        message: "原始对话已不存在，推进会话已取消以避免悬空状态。",
      });
    } catch {
      // Preserve the maintenance NOT_FOUND; recovery can retry cancellation.
    }
  }

  async #cancelFailedOriginalTaskAdmission(
    command: AdvancementRubricConfirmationCommand,
    confirmed: AdvancementSession | undefined,
    reason: "conversation-not-found" | "idempotency-conflict" =
      "conversation-not-found",
  ): Promise<void> {
    try {
      const source =
        confirmed ??
        (await this.#rubricCancellation.loadRubricCancellationSession(
          command.conversationId,
          command.advancementSessionId,
        ));
      if (!source) return;
      assertAdvancementSessionIdentity(source, command);
      const cancelled =
        await this.#rubricCancellation.persistRubricCancellation({
          conversationId: command.conversationId,
          advancementSessionId: command.advancementSessionId,
          reason: "system-error",
          message:
            reason === "idempotency-conflict"
              ? "原始任务的耐久准入身份发生冲突，推进会话已安全取消。"
              : "原始对话已不存在，推进会话已取消以避免悬空状态。",
        });
      if (cancelled.status !== "cancelled") return;
      const originalTurnId =
        source.originalTaskAdmission?.intent.turnId ??
        source.pendingRubricDraft?.originalTurnId ??
        source.id;
      await command.fact.publish(
        Object.freeze<AdvancementContractCancelledFact>({
          kind: "advancement-contract-cancelled",
          conversationId: cancelled.conversationId,
          originalTurnId,
          advancementSessionId: cancelled.id,
          controlSeq:
            source.rubricDraftVersion +
            (source.originalTaskAdmission ? 2 : 1),
          executeOriginal: false,
          reason: "original-task-admission-failed",
        }),
      );
    } catch {
      // Preserve the original Conversation error; recovery can retry cancellation.
    }
  }

  #publishRubric(
    conversationId: string,
    draft: RubricContractDraftSnapshot,
    persistence: RubricDraftPersistenceChoice,
  ): Promise<RubricPublicationOutcome> {
    if (!this.#rubricPublication) {
      return Promise.resolve({
        kind: "deferred",
        message: "准则已用于本任务，连接值班设备后可保存到准则库。",
      });
    }
    return this.#rubricPublication
      .publish({ conversationId, draft, persistence })
      .catch(() => ({
        kind: "failed",
        message: "任务已继续执行，但准则暂未保存；稍后可重新保存。",
      }));
  }

  async controlAwaitingRubric(
    command: AdvancementAwaitingRubricControlCommand,
  ): Promise<Readonly<{
    result: AdvancementAwaitingRubricControlResult;
    fact?: AdvancementContractCancelledFact;
  }>> {
    assertRubricRevisionIdentity(command.conversationId, "conversation");
    if (!isNonEmptyUserTurnInput(command.userInput)) {
      throw new TypeError(
        "Advancement awaiting-Rubric control requires non-empty user input",
      );
    }
    if (typeof command.fact?.publish !== "function") {
      throw new TypeError(
        "Advancement awaiting-Rubric control requires a Fact projection port",
      );
    }
    assertOriginalTaskSurface(command.surface);

    const maintained = await this.#maintenance.runExisting(
      command.conversationId,
      async () => {
        const session = await this.#detail.loadLatestSession(
          command.conversationId,
        );
        if (!session || session.status !== "awaiting-rubric-confirmation") {
          return Object.freeze({ kind: "not-applicable" as const });
        }
        if (session.conversationId !== command.conversationId) {
          throw new AdvancementApplicationError(
            "advancement-session-identity-mismatch",
            "Advancement awaiting-Rubric read returned a mismatched conversation identity",
            { advancementSessionId: session.id },
          );
        }
        const draft = session.pendingRubricDraft;
        if (!draft) {
          throw new AdvancementApplicationError(
            "pending-rubric-draft-missing",
            `Advancement session has no pending rubric draft: ${session.id}`,
            { advancementSessionId: session.id },
          );
        }
        const admission =
          await this.#awaitingRubricAdmission.decideAwaitingRubricAdmission({
            conversationId: command.conversationId,
            userInput: freezeSnapshot(command.userInput),
          });
        if (admission.action === "keep-awaiting-confirmation") {
          return Object.freeze({
            kind: "keep-awaiting" as const,
            session,
            draft: freezeSnapshot(draft),
          });
        }
        if (
          admission.action !== "downgrade-to-direct" &&
          admission.action !== "cancel-pending-task"
        ) {
          throw new TypeError(
            "Advancement awaiting-Rubric admission returned an unsupported action",
          );
        }

        const executeOriginal = admission.action === "downgrade-to-direct";
        const committed =
          await this.#rubricCancellation.persistRubricCancellation({
            conversationId: command.conversationId,
            advancementSessionId: session.id,
            reason: "user-cancelled",
            message: executeOriginal
              ? "用户选择直接执行原始任务"
              : "用户取消待确认任务",
          });
        if (committed.status !== "cancelled") {
          throw new AdvancementApplicationError(
            "committed-cancellation-missing",
            `Committed Advancement session is not cancelled: ${committed.id}`,
            { advancementSessionId: committed.id },
          );
        }
        if (
          committed.conversationId !== command.conversationId ||
          committed.id !== session.id
        ) {
          throw new AdvancementApplicationError(
            "advancement-session-identity-mismatch",
            "Committed Advancement cancellation has a mismatched session identity",
            { advancementSessionId: session.id },
          );
        }
        const fact = Object.freeze<AdvancementContractCancelledFact>({
          kind: "advancement-contract-cancelled",
          conversationId: committed.conversationId,
          originalTurnId: draft.originalTurnId,
          advancementSessionId: committed.id,
          controlSeq: committed.rubricDraftVersion + 1,
          executeOriginal,
          ...(!executeOriginal ? { reason: "user-cancelled" as const } : {}),
        });
        return Object.freeze({
          kind: executeOriginal
            ? ("direct-original-task" as const)
            : ("cancelled" as const),
          committed,
          fact,
          draft: freezeSnapshot(draft),
          originalUserTask: freezeSnapshot(committed.originalUserTask),
        });
      },
    );
    if (maintained.status === "not-found") {
      throw new AdvancementApplicationError(
        "conversation-not-found",
        `Conversation not found: ${command.conversationId}`,
      );
    }
    if (maintained.status === "busy") {
      throw new AdvancementApplicationError(
        "conversation-busy",
        `Conversation is busy: ${command.conversationId}`,
      );
    }

    const decision = maintained.value;
    if (decision.kind === "not-applicable") {
      return Object.freeze({ result: decision });
    }
    if (decision.kind === "keep-awaiting") {
      return Object.freeze({
        result: Object.freeze<AdvancementAwaitingRubricControlResult>({
          kind: "keep-awaiting",
          conversationId: decision.session.conversationId,
          advancementSessionId: decision.session.id,
          rubricDraft: decision.draft,
        }),
      });
    }

    await command.fact.publish(decision.fact);
    if (decision.kind === "cancelled") {
      return Object.freeze({
        result: Object.freeze<AdvancementAwaitingRubricControlResult>({
          kind: "cancelled",
          conversationId: decision.committed.conversationId,
          advancementSessionId: decision.committed.id,
        }),
        fact: decision.fact,
      });
    }

    const executed = await this.#originalTask.execute({
      conversationId: decision.committed.conversationId,
      originalTurnId: decision.draft.originalTurnId,
      originalUserTask: decision.originalUserTask,
      surface: command.surface,
    });
    if (
      executed.conversationId !== decision.committed.conversationId ||
      executed.turnId !== decision.draft.originalTurnId
    ) {
      throw new TypeError(
        "Advancement original-task execution returned a mismatched identity",
      );
    }
    return Object.freeze({
      result: Object.freeze<AdvancementAwaitingRubricControlResult>({
        kind: "direct-original-task",
        conversationId: executed.conversationId,
        advancementSessionId: decision.committed.id,
        turnId: executed.turnId,
        ...(executed.runId ? { runId: executed.runId } : {}),
        runStatus: executed.runStatus,
      }),
      fact: decision.fact,
    });
  }

  async cancelRubric(
    command: AdvancementRubricCancellationCommand,
  ): Promise<Readonly<{
    result: AdvancementRubricCancellationResult;
    fact: AdvancementContractCancelledFact;
  }>> {
    assertRubricRevisionIdentity(command.conversationId, "conversation");
    assertRubricRevisionIdentity(
      command.advancementSessionId,
      "Advancement session",
    );
    if (typeof command.executeOriginal !== "boolean") {
      throw new TypeError("Advancement rubric cancellation requires an executeOriginal decision");
    }
    if (typeof command.fact?.publish !== "function") {
      throw new TypeError("Advancement rubric cancellation requires a Fact projection port");
    }
    if (
      typeof command.surface?.caller?.surfacePrincipal !== "string" ||
      command.surface.caller.surfacePrincipal.length === 0 ||
      typeof command.surface.caller.connectionId !== "string" ||
      command.surface.caller.connectionId.length === 0 ||
      typeof command.surface.execute !== "function" ||
      typeof command.surface.cancelPending !== "function"
    ) {
      throw new TypeError("Advancement rubric cancellation requires a surface effect port");
    }

    const maintained = await this.#maintenance.runExisting(
      command.conversationId,
      async () => {
        const session =
          await this.#rubricCancellation.loadRubricCancellationSession(
            command.conversationId,
            command.advancementSessionId,
          );
        if (!session) {
          throw new AdvancementApplicationError(
            "advancement-session-not-found",
            `Advancement session not found: ${command.advancementSessionId}`,
            { advancementSessionId: command.advancementSessionId },
          );
        }
        if (
          session.conversationId !== command.conversationId ||
          session.id !== command.advancementSessionId
        ) {
          throw new AdvancementApplicationError(
            "advancement-session-identity-mismatch",
            "Advancement cancellation mechanism returned a mismatched session identity",
            { advancementSessionId: command.advancementSessionId },
          );
        }
        if (session.status !== "awaiting-rubric-confirmation") {
          throw new AdvancementApplicationError(
            "not-awaiting-rubric-confirmation",
            `Advancement session is not awaiting rubric confirmation: ${session.id}`,
            { advancementSessionId: session.id },
          );
        }

        const committed =
          await this.#rubricCancellation.persistRubricCancellation({
            conversationId: command.conversationId,
            advancementSessionId: command.advancementSessionId,
            reason: "user-cancelled",
            message: command.executeOriginal
              ? "用户选择直接执行原始任务"
              : "用户取消 Rubric 确认",
          });
        if (committed.status !== "cancelled") {
          throw new AdvancementApplicationError(
            "committed-cancellation-missing",
            `Committed Advancement session is not cancelled: ${committed.id}`,
            { advancementSessionId: committed.id },
          );
        }
        if (
          committed.conversationId !== command.conversationId ||
          committed.id !== command.advancementSessionId
        ) {
          throw new AdvancementApplicationError(
            "advancement-session-identity-mismatch",
            "Committed Advancement cancellation has a mismatched session identity",
            { advancementSessionId: command.advancementSessionId },
          );
        }
        const draft = committed.pendingRubricDraft;
        const executeOriginal = command.executeOriginal && draft !== undefined;
        const fact = Object.freeze<AdvancementContractCancelledFact>({
          kind: "advancement-contract-cancelled",
          conversationId: committed.conversationId,
          originalTurnId: draft?.originalTurnId ?? committed.id,
          advancementSessionId: committed.id,
          controlSeq: committed.rubricDraftVersion + 1,
          executeOriginal,
        });
        return Object.freeze({
          committed,
          draft,
          executeOriginal,
          fact,
          originalUserTask: freezeSnapshot(committed.originalUserTask),
        });
      },
    );
    if (maintained.status === "not-found") {
      throw new AdvancementApplicationError(
        "conversation-not-found",
        `Conversation not found: ${command.conversationId}`,
      );
    }
    if (maintained.status === "busy") {
      throw new AdvancementApplicationError(
        "conversation-busy",
        `Conversation is busy: ${command.conversationId}`,
      );
    }

    const decision = maintained.value;
    await command.fact.publish(decision.fact);
    if (!decision.executeOriginal || !decision.draft) {
      return Object.freeze({
        result: Object.freeze<AdvancementRubricCancellationResult>({
          kind: "cancelled",
          conversationId: decision.committed.conversationId,
          advancementSessionId: decision.committed.id,
        }),
        fact: decision.fact,
      });
    }

    const executed = await this.#originalTask.execute({
      conversationId: decision.committed.conversationId,
      originalTurnId: decision.draft.originalTurnId,
      originalUserTask: decision.originalUserTask,
      surface: command.surface,
    });
    if (
      executed.conversationId !== decision.committed.conversationId ||
      executed.turnId !== decision.draft.originalTurnId
    ) {
      throw new TypeError(
        "Advancement original-task execution returned a mismatched identity",
      );
    }
    return Object.freeze({
      result: Object.freeze<AdvancementRubricCancellationResult>({
        kind: "direct-original-task",
        conversationId: executed.conversationId,
        advancementSessionId: decision.committed.id,
        turnId: executed.turnId,
        ...(executed.runId ? { runId: executed.runId } : {}),
        runStatus: executed.runStatus,
      }),
      fact: decision.fact,
    });
  }
}

export const ADVANCEMENT_DETAIL_QUERY = defineProductApiQuery<
  "advancement.query.detail",
  AdvancementDetailQuery,
  AdvancementDetailResult
>("advancement.query.detail");

export const ADVANCEMENT_ACTIVE_STATE_QUERY = defineProductApiQuery<
  "advancement.query.active-state",
  AdvancementActiveStateQuery,
  AdvancementActiveStateResult
>("advancement.query.active-state");

export const ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT =
  defineProductApiFactEvent<
    "advancement-contract-draft-revised",
    AdvancementContractDraftRevisedFact
  >("advancement-contract-draft-revised");

export const ADVANCEMENT_CONTRACT_DRAFT_CREATED_FACT_EVENT =
  defineProductApiFactEvent<
    "advancement-contract-draft-created",
    AdvancementContractDraftCreatedFact
  >("advancement-contract-draft-created");

export const ADVANCEMENT_SESSION_EXITED_FACT_EVENT =
  defineProductApiFactEvent<
    "advancement-session-exited",
    AdvancementSessionExitedFact
  >("advancement-session-exited");

export const ADVANCEMENT_PREPARE_ACTIVE_USER_TURN_COMMAND =
  defineProductApiCommand<
    "advancement.command.prepare-active-user-turn",
    AdvancementActiveUserTurnCommand,
    AdvancementActiveUserTurnResult,
    AdvancementSessionExitedFact | AdvancementContractDraftCreatedFact
  >(
    "advancement.command.prepare-active-user-turn",
    [
      ADVANCEMENT_SESSION_EXITED_FACT_EVENT,
      ADVANCEMENT_CONTRACT_DRAFT_CREATED_FACT_EVENT,
    ],
    { factEmission: "subset" },
  );

export const ADVANCEMENT_PREPARE_NEW_TASK_COMMAND = defineProductApiCommand<
  "advancement.command.prepare-new-task",
  AdvancementNewTaskCommand,
  AdvancementNewTaskResult,
  AdvancementContractDraftCreatedFact
>("advancement.command.prepare-new-task", [
  ADVANCEMENT_CONTRACT_DRAFT_CREATED_FACT_EVENT,
], { factEmission: "subset" });

export const ADVANCEMENT_REVISE_RUBRIC_COMMAND = defineProductApiCommand<
  "advancement.command.revise-rubric",
  AdvancementRubricRevisionCommand,
  AdvancementRubricRevisionResult,
  AdvancementContractDraftRevisedFact
>("advancement.command.revise-rubric", [
  ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT,
]);

export const ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT =
  defineProductApiFactEvent<
    "advancement-contract-cancelled",
    AdvancementContractCancelledFact
  >("advancement-contract-cancelled");

export const ADVANCEMENT_CONTRACT_CONFIRMED_FACT_EVENT =
  defineProductApiFactEvent<
    "advancement-contract-confirmed",
    AdvancementContractConfirmedFact
  >("advancement-contract-confirmed");

export const ADVANCEMENT_CONFIRM_RUBRIC_COMMAND = defineProductApiCommand<
  "advancement.command.confirm-rubric",
  AdvancementRubricConfirmationCommand,
  AdvancementRubricConfirmationResult,
  AdvancementContractConfirmedFact
>("advancement.command.confirm-rubric", [
  ADVANCEMENT_CONTRACT_CONFIRMED_FACT_EVENT,
]);

export const ADVANCEMENT_CANCEL_RUBRIC_COMMAND = defineProductApiCommand<
  "advancement.command.cancel-rubric",
  AdvancementRubricCancellationCommand,
  AdvancementRubricCancellationResult,
  AdvancementContractCancelledFact
>("advancement.command.cancel-rubric", [
  ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT,
]);

export const ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND =
  defineProductApiCommand<
    "advancement.command.control-awaiting-rubric",
    AdvancementAwaitingRubricControlCommand,
    AdvancementAwaitingRubricControlResult,
    AdvancementContractCancelledFact
  >("advancement.command.control-awaiting-rubric", [
    ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT,
  ], { factEmission: "subset" });

export const ADVANCEMENT_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [
    ADVANCEMENT_ACTIVE_STATE_QUERY,
    ADVANCEMENT_DETAIL_QUERY,
    ADVANCEMENT_PREPARE_ACTIVE_USER_TURN_COMMAND,
    ADVANCEMENT_PREPARE_NEW_TASK_COMMAND,
    ADVANCEMENT_REVISE_RUBRIC_COMMAND,
    ADVANCEMENT_CONFIRM_RUBRIC_COMMAND,
    ADVANCEMENT_CANCEL_RUBRIC_COMMAND,
    ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND,
  ],
  factEvents: [
    ADVANCEMENT_SESSION_EXITED_FACT_EVENT,
    ADVANCEMENT_CONTRACT_DRAFT_CREATED_FACT_EVENT,
    ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT,
    ADVANCEMENT_CONTRACT_CONFIRMED_FACT_EVENT,
    ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT,
  ],
});

export function createAdvancementProductApiContribution(
  application: AdvancementApplication,
): ProductApiContribution {
  return defineProductApiContribution({
    operations: [
      bindProductApiOperation(ADVANCEMENT_ACTIVE_STATE_QUERY, async (query) => ({
        result: await application.queryActiveState(query),
        facts: [],
      })),
      bindProductApiOperation(ADVANCEMENT_DETAIL_QUERY, async (query) => ({
        result: await application.queryDetail(query),
        facts: [],
      })),
      bindProductApiOperation(
        ADVANCEMENT_PREPARE_ACTIVE_USER_TURN_COMMAND,
        async (command) => await application.prepareActiveUserTurn(command),
      ),
      bindProductApiOperation(
        ADVANCEMENT_PREPARE_NEW_TASK_COMMAND,
        async (command) => {
          const prepared = await application.prepareNewTask(command);
          return {
            result: prepared.result,
            facts: prepared.fact ? [prepared.fact] : [],
          };
        },
      ),
      bindProductApiOperation(
        ADVANCEMENT_REVISE_RUBRIC_COMMAND,
        async (command) => {
          const revised = await application.reviseRubricDraft(command);
          return { result: revised.result, facts: [revised.fact] };
        },
      ),
      bindProductApiOperation(
        ADVANCEMENT_CONFIRM_RUBRIC_COMMAND,
        async (command) => {
          const confirmed = await application.confirmRubric(command);
          return { result: confirmed.result, facts: [confirmed.fact] };
        },
      ),
      bindProductApiOperation(
        ADVANCEMENT_CANCEL_RUBRIC_COMMAND,
        async (command) => {
          const cancelled = await application.cancelRubric(command);
          return { result: cancelled.result, facts: [cancelled.fact] };
        },
      ),
      bindProductApiOperation(
        ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND,
        async (command) => {
          const controlled = await application.controlAwaitingRubric(command);
          return {
            result: controlled.result,
            facts: controlled.fact ? [controlled.fact] : [],
          };
        },
      ),
    ],
    factEvents: [
      ADVANCEMENT_SESSION_EXITED_FACT_EVENT,
      ADVANCEMENT_CONTRACT_DRAFT_CREATED_FACT_EVENT,
      ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT,
      ADVANCEMENT_CONTRACT_CONFIRMED_FACT_EVENT,
      ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT,
    ],
  });
}

function assertConversationId(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Advancement detail requires a conversation identity");
  }
}

function assertRubricRevisionIdentity(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} identity must be non-empty`);
  }
}

function assertOriginalTaskSurface(
  surface: AdvancementOriginalTaskSurfacePort,
): void {
  if (
    typeof surface?.caller?.surfacePrincipal !== "string" ||
    surface.caller.surfacePrincipal.length === 0 ||
    typeof surface.caller.connectionId !== "string" ||
    surface.caller.connectionId.length === 0 ||
    typeof surface.execute !== "function" ||
    typeof surface.cancelPending !== "function"
  ) {
    throw new TypeError("Advancement rubric confirmation requires a surface effect port");
  }
}

function assertActiveUserTurnSurface(
  surface: AdvancementActiveUserTurnSurfacePort,
): void {
  if (
    typeof surface?.publishExit !== "function" ||
    typeof surface.publishDraft !== "function" ||
    typeof surface.publishContractFailure !== "function" ||
    typeof surface.handoff !== "function"
  ) {
    throw new TypeError(
      "Advancement active user turn requires a complete surface effect port",
    );
  }
}

function noActiveUserTurn(): Readonly<{
  result: AdvancementActiveUserTurnResult;
  facts: readonly never[];
}> {
  return Object.freeze({
    result: Object.freeze<AdvancementActiveUserTurnResult>({
      kind: "not-applicable",
    }),
    facts: Object.freeze([]),
  });
}

function assertActiveUserTurnHandoff(
  handoff: AdvancementActiveUserTurnHandoff,
  command: AdvancementActiveUserTurnCommand,
): void {
  if (
    handoff.conversationId !== command.conversationId ||
    handoff.turnId !== command.turnId
  ) {
    throw new TypeError(
      "Advancement active user-turn handoff returned a mismatched identity",
    );
  }
}

function assertCommittedActiveExit(
  committed: AdvancementSession,
  previous: AdvancementSession,
  exit: AdvancementExit,
): void {
  if (
    committed.id !== previous.id ||
    committed.conversationId !== previous.conversationId ||
    committed.status !== "exited" ||
    !committed.exit ||
    canonicalize(committed.exit) !== canonicalize(exit)
  ) {
    throw new TypeError(
      "Advancement active user-turn exit did not return the committed terminal session",
    );
  }
}

function assertCommittedRegeneratedSession(
  committed: AdvancementSession,
  command: AdvancementActiveUserTurnCommand,
  previous: AdvancementSession,
  draft: RubricContractDraftSnapshot,
): void {
  if (
    committed.id !== `adv_${draft.draftId}` ||
    committed.conversationId !== command.conversationId ||
    committed.status !== "awaiting-rubric-confirmation" ||
    !committed.pendingRubricDraft ||
    canonicalize(committed.pendingRubricDraft) !== canonicalize(draft) ||
    canonicalize(committed.originalUserTask) !==
      canonicalize(previous.originalUserTask)
  ) {
    throw new TypeError(
      "Advancement rubric regeneration did not return the committed awaiting session",
    );
  }
}

function assertAdvancementSessionIdentity(
  session: AdvancementSession,
  command: Pick<
    AdvancementRubricConfirmationCommand,
    "conversationId" | "advancementSessionId"
  >,
): void {
  if (
    session.conversationId !== command.conversationId ||
    session.id !== command.advancementSessionId
  ) {
    throw new AdvancementApplicationError(
      "advancement-session-identity-mismatch",
      "Advancement confirmation mechanism returned a mismatched session identity",
      { advancementSessionId: command.advancementSessionId },
    );
  }
}

function assertCommittedNewTaskSession(
  session: AdvancementSession,
  command: AdvancementNewTaskCommand,
  draft: RubricContractDraftSnapshot,
): void {
  if (
    session.status !== "awaiting-rubric-confirmation" ||
    session.conversationId !== command.conversationId ||
    session.id !== `adv_${draft.draftId}` ||
    !session.pendingRubricDraft ||
    canonicalize(session.pendingRubricDraft) !== canonicalize(draft) ||
    canonicalize(session.originalUserTask) !== canonicalize(command.userInput)
  ) {
    throw new AdvancementApplicationError(
      "committed-rubric-draft-missing",
      `Committed Advancement session has no matching new-task draft: ${session.id}`,
      { advancementSessionId: session.id },
    );
  }
}

function assertCommittedRubricConfirmation(
  session: AdvancementSession,
  command: AdvancementRubricConfirmationCommand,
  intent: AdvancementOriginalTaskAdmissionIntent,
): void {
  assertAdvancementSessionIdentity(session, command);
  const committed = session.originalTaskAdmission;
  if (
    session.status !== "active" ||
    !session.confirmedRubric ||
    !committed ||
    committed.status !== "pending" ||
    committed.intent.turnId !== intent.turnId ||
    committed.intent.inputDigest !== intent.inputDigest ||
    committed.intent.surfacePrincipal !== intent.surfacePrincipal
  ) {
    throw new AdvancementApplicationError(
      "committed-rubric-confirmation-missing",
      `Committed Advancement session has no matching Rubric confirmation: ${session.id}`,
      { advancementSessionId: session.id },
    );
  }
}

function assertCommittedOriginalTaskAdmission(
  session: AdvancementSession,
  command: AdvancementRubricConfirmationCommand,
  intent: AdvancementOriginalTaskAdmissionIntent,
  runId: string,
): Extract<
  NonNullable<AdvancementSession["originalTaskAdmission"]>,
  { readonly status: "admitted" }
> {
  assertAdvancementSessionIdentity(session, command);
  const admitted = session.originalTaskAdmission;
  if (
    session.status !== "active" ||
    !admitted ||
    admitted.status !== "admitted" ||
    admitted.runId !== runId ||
    admitted.intent.turnId !== intent.turnId ||
    admitted.intent.inputDigest !== intent.inputDigest
  ) {
    throw new AdvancementApplicationError(
      "committed-original-task-admission-missing",
      `Committed Advancement session has no matching original-task admission: ${session.id}`,
      { advancementSessionId: session.id },
    );
  }
  return admitted;
}

function publicationMessage(outcome: RubricPublicationOutcome): string {
  return outcome.kind === "saved"
    ? "准则已保存到准则库。"
    : outcome.kind === "unavailable"
      ? "准则已用于本任务，连接值班设备后可保存到准则库。"
    : outcome.message;
}

function applicationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeUserFeedback(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Advancement rubric revision requires non-empty user feedback");
  }
  return value.trim();
}

function freezeSnapshot<T>(value: T): Readonly<T> {
  const snapshot = structuredClone(value);
  return deepFreeze(snapshot);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
