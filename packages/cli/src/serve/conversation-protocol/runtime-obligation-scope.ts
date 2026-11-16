import { beginLogPhase, observeLogPhase, type LogRecordPort } from "@zhixing-ai/core/logging";
import { holdForegroundObligation, type ForegroundActivityPort, type ForegroundObligation } from "@zhixing-ai/core/resources";
import type {
  AssignmentActivationProof,
  AuthorityCallContext,
  ControlLease,
  ConversationInvocation,
  ConversationRunState,
  ConversationStatusNotice,
  DispatchEnvelope,
  ExplicitEnvironmentSelection,
  IngressContext,
  InteractionMirrorBatch,
  OwnerControlGrant,
  ReservationOrigin,
  TranscriptRunRecord,
} from "@zhixing-ai/core/contracts";
import type { RunResult } from "@zhixing-ai/core/loop";
import {
  MAX_CONTROL_LEASE_TTL_MS,
  canonicalize,
  ownerControlRequestDigest,
  protocolDigest,
  type ConversationInteractionMirrorBatch,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import { toPermissionContext, type PermissionContextId } from "@zhixing-ai/core/security";
import { conversationRunTrustScope } from "@zhixing-ai/core/trust-administration";
import type {
  AssignmentSubmissionAuthorizer,
  ConversationRunJournal,
  InProcessDispatchContextFactory,
  PendingConversationInput,
} from "@zhixing-ai/owner-kernel/conversation-assignment";
import { channelSurfacePrincipal } from "@zhixing-ai/owner-kernel/control-admission";
import type { ConversationTransferPublication } from "@zhixing-ai/owner-kernel/conversation-transfer";
import type {
  DurableConversationAdmissionInput,
  DurableConversationTurnInput,
} from "@zhixing-ai/owner-kernel/run-turn";
import type { SessionRuntime } from "@zhixing-ai/owner-kernel/types";
import { randomUUID } from "node:crypto";
import {
  assignmentSubmissionContext,
  createAssignmentSubmissionAuthorizer,
} from "../assignment-worker-obligations.js";
import type {
  ConversationAssignmentArtifactAuthorityIndex,
  ConversationExecutorRequirement,
} from "../conversation-executor-dispatch.js";
import type { DurableConversationInteractionObserver } from "../durable-conversation-interactions.js";
import { withoutRecoveredSurfaceCapabilities } from "../execution-turn-context.js";
import type {
  AuthorityScope,
  PreparedConversationAdmission,
  RunAttemptHandle,
} from "./contracts.js";

const CONTEXT_TTL_MS = MAX_CONTROL_LEASE_TTL_MS;
const CONTROL_RENEWAL_INTERVAL_MS = Math.floor(CONTEXT_TTL_MS / 3);

export const NO_FOREGROUND_OBLIGATION: ForegroundObligation = Object.freeze({
  pause() {},
  resume() {},
  close() {},
});

export class RetryableRunEndPreparation extends Error {
  constructor(error: unknown) {
    super("Run end preparation remains pending", { cause: error });
  }
}

export interface AdoptedConversationEntry {
  readonly transferId: string;
  readonly ownerEpoch: number;
  readonly source?: ConversationTransferPublication["source"];
  readonly clearId?: string;
  readonly clearedThroughLsn: number;
}

export interface AssignmentRouteEntry {
  readonly conversationId: string;
  readonly routeRevision: number;
}

export interface ActiveAssignmentClaim {
  readonly runId: string;
  readonly claimToken: symbol;
}

export interface FirstSendWindowEntry {
  readonly runId: string;
  readonly claimToken: symbol;
  deferred: boolean;
}

export interface AuthorityScopeState {
  readonly scope: AuthorityScope;
  readonly journals: Map<string, ConversationRunJournal>;
  readonly adopting: Map<string, Promise<void>>;
  readonly adoptedConversations: Map<string, AdoptedConversationEntry>;
  readonly unavailableTransfers: Map<string, { readonly transferId: string; readonly error: Error }>;
  readonly sessionIdentities: Map<string, Promise<void>>;
  readonly assignmentRoutes: Map<string, AssignmentRouteEntry>;
  readonly assignmentIngress: Map<string, IngressContext>;
  readonly schedulingRuns: Map<string, symbol>;
  readonly scheduledRuns: Map<string, symbol>;
  readonly activeAssignmentClaims: Map<string, ActiveAssignmentClaim>;
  readonly preparedAdmissions: Map<string, PreparedConversationAdmission & { readonly claimToken: symbol }>;
  readonly firstPartyPublishedFinals: Set<string>;
  readonly ownerPublishedFirstPartyFinals: Set<string>;
  readonly pendingFirstPartyFinals: Set<string>;
  markSeq: number;
  readonly recoveryConversations: Map<string, number>;
  readonly recoveryMarkLedger: Map<string, string | null>;
  readonly firstSendWindows: Map<string, FirstSendWindowEntry>;
  readonly recoveryDeferredRounds: Map<string, number>;
  readonly recoveryAttempted: Map<string, number>;
  readonly pendingConversationRetirements: Set<string>;
  recoveryDiscovered: boolean;
  recoveryDiscoveryAfter: string | undefined;
  pendingCancellationAfter: string | undefined;
}

export interface CapturedRunAttemptHandle extends RunAttemptHandle {
  readonly scopeState: AuthorityScopeState;
  readonly capturedJournal: ConversationRunJournal;
  readonly attemptForeground: ForegroundObligation;
}

function createAuthorityScopeState(scopeId: number): AuthorityScopeState {
  return {
    scope: { scopeId, retired: false },
    journals: new Map(),
    adopting: new Map(),
    adoptedConversations: new Map(),
    unavailableTransfers: new Map(),
    sessionIdentities: new Map(),
    assignmentRoutes: new Map(),
    assignmentIngress: new Map(),
    schedulingRuns: new Map(),
    scheduledRuns: new Map(),
    activeAssignmentClaims: new Map(),
    preparedAdmissions: new Map(),
    firstPartyPublishedFinals: new Set(),
    ownerPublishedFirstPartyFinals: new Set(),
    pendingFirstPartyFinals: new Set(),
    markSeq: 0,
    recoveryConversations: new Map(),
    recoveryMarkLedger: new Map(),
    firstSendWindows: new Map(),
    recoveryDeferredRounds: new Map(),
    recoveryAttempted: new Map(),
    pendingConversationRetirements: new Set(),
    recoveryDiscovered: false,
    recoveryDiscoveryAfter: undefined,
    pendingCancellationAfter: undefined,
  };
}

/**
 * Owns the two-layer lifetime boundary:
 * 1. `AuthorityScopeState` is replaced ONLY in `swapAuthorityScope()` (called by `recoverInstalledAuthority`),
 *    NEVER in `stopRecoveryLoop` or `releaseConversation`.
 * 2. Monotonic `markSeq` per `AuthorityScopeState` is strictly decoupled from `scope.scopeId`.
 * 3. Route entries carry monotonic `routeRevision` tokens so stale async retirement cannot forget newly bound routes.
 * 4. Run and assignment claims carry per-attempt `claimToken` symbols so stale `run()` `finally` blocks
 *    clean up only their own `capturedScope` claims and never erase `newScope` state.
 */
export class RuntimeObligationScope {
  #current: AuthorityScopeState = createAuthorityScopeState(1);
  #nextRouteRevision = 0;
  #admissionSequence = 0;
  readonly activeRecoveryClaims = new Map<string, number>();
  readonly lifecycleProjectionClaims = new Map<string, Promise<number>>();

  get current(): AuthorityScopeState {
    return this.#current;
  }

  isCurrent(scopeState: AuthorityScopeState): boolean {
    return this.#current === scopeState && !scopeState.scope.retired;
  }

  nextAdmissionId(): string {
    return `admission-${++this.#admissionSequence}`;
  }

  /**
   * Ordinary cache eviction: drops ONLY rebuildable `journals` and `sessionIdentities`
   * in the current `AuthorityScope`, NEVER incrementing `scopeId` or touching routes/marks/claims.
   */
  releaseConversationCache(conversationId: string): void {
    this.#current.journals.delete(conversationId);
    this.#current.sessionIdentities.delete(conversationId);
  }

  /**
   * Replaces the entire `AuthorityScopeState` during `recoverInstalledAuthority`.
   * Closes only un-adopted `preparedAdmissions` foreground obligations on `oldScope`;
   * in-flight `run()` attempts own their already-detached `attemptForeground` and clean them up in `finally`.
   */
  swapAuthorityScope(
    artifactAuthority: ConversationAssignmentArtifactAuthorityIndex,
    interactions: DurableConversationInteractionObserver,
  ): AuthorityScopeState {
    const oldScope = this.#current;
    oldScope.scope.retired = true;
    const nextScope = createAuthorityScopeState(oldScope.scope.scopeId + 1);
    this.#current = nextScope;
    const errors: unknown[] = [];
    const isolate = (step: () => void) => {
      try {
        step();
      } catch (error) {
        errors.push(error);
      }
    };
    for (const assignmentId of [...oldScope.assignmentRoutes.keys()]) {
      oldScope.assignmentRoutes.delete(assignmentId);
      oldScope.assignmentIngress.delete(assignmentId);
      isolate(() => artifactAuthority.remove(assignmentId));
      isolate(() => interactions.releaseAssignment(assignmentId));
    }
    const preparedList = [...oldScope.preparedAdmissions.values()];
    oldScope.preparedAdmissions.clear();
    for (const prepared of preparedList) {
      isolate(() => prepared.foreground?.close());
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Authority scope retirement encountered release errors");
    }
    return nextScope;
  }

  markRecoveryInScope(
    scopeState: AuthorityScopeState,
    conversationId: string,
    routineRun?: string,
  ): number {
    if (!this.isCurrent(scopeState)) return scopeState.markSeq;
    scopeState.markSeq += 1;
    scopeState.recoveryConversations.delete(conversationId);
    scopeState.recoveryConversations.set(conversationId, scopeState.markSeq);
    const owner = scopeState.recoveryMarkLedger.get(conversationId);
    if (owner === undefined) {
      scopeState.recoveryMarkLedger.set(conversationId, routineRun ?? null);
    } else if (owner !== null && owner !== routineRun) {
      scopeState.recoveryMarkLedger.set(conversationId, null);
    }
    return scopeState.markSeq;
  }

  markRecoveryCurrent(conversationId: string, routineRun?: string): number {
    return this.markRecoveryInScope(this.#current, conversationId, routineRun);
  }

  closeFirstSendWindowInScope(
    scopeState: AuthorityScopeState,
    runId: string,
    expectedToken?: symbol,
  ): void {
    for (const [conversationId, window] of scopeState.firstSendWindows) {
      if (window.runId !== runId) continue;
      if (expectedToken !== undefined && window.claimToken !== expectedToken) continue;
      scopeState.firstSendWindows.delete(conversationId);
    }
  }

  clearRunClaimsInScope(
    scopeState: AuthorityScopeState,
    runId: string,
    expectedToken?: symbol,
  ): void {
    if (expectedToken === undefined || scopeState.schedulingRuns.get(runId) === expectedToken) {
      scopeState.schedulingRuns.delete(runId);
    }
    if (expectedToken === undefined || scopeState.scheduledRuns.get(runId) === expectedToken) {
      scopeState.scheduledRuns.delete(runId);
    }
    this.closeFirstSendWindowInScope(scopeState, runId, expectedToken);
    const errors: unknown[] = [];
    for (const [key, prepared] of [...scopeState.preparedAdmissions.entries()]) {
      if (prepared.admission.runId !== runId) continue;
      if (expectedToken !== undefined && prepared.claimToken !== expectedToken) continue;
      scopeState.preparedAdmissions.delete(key);
      try {
        prepared.foreground?.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Failed to close prepared admission foreground handles");
    }
  }

  claimAssignmentInScope(
    scopeState: AuthorityScopeState,
    assignmentId: string,
    runId: string,
    claimToken: symbol,
  ): void {
    scopeState.activeAssignmentClaims.set(assignmentId, { runId, claimToken });
  }

  releaseAssignmentClaimInScope(
    scopeState: AuthorityScopeState,
    assignmentId: string,
    claimToken: symbol,
  ): void {
    if (scopeState.activeAssignmentClaims.get(assignmentId)?.claimToken === claimToken) {
      scopeState.activeAssignmentClaims.delete(assignmentId);
    }
  }

  rememberAssignmentInScope(
    scopeState: AuthorityScopeState,
    envelope: Extract<DispatchEnvelope, { execution: "conversation" }>,
    activation: AssignmentActivationProof<"conversation">,
    artifactAuthority: ConversationAssignmentArtifactAuthorityIndex,
  ): number | undefined {
    const capability = envelope.capabilities[0];
    if (!capability) {
      throw new Error("Conversation assignment has no submission capability");
    }
    if (!this.isCurrent(scopeState)) return undefined;
    const routeRevision = ++this.#nextRouteRevision;
    scopeState.assignmentRoutes.set(envelope.assignmentId, {
      conversationId: envelope.work.conversationId,
      routeRevision,
    });
    artifactAuthority.install(envelope.assignmentId, capability, activation);
    scopeState.assignmentIngress.set(
      envelope.assignmentId,
      structuredClone(envelope.work.ingress),
    );
    return routeRevision;
  }

  forgetAssignmentInScope(
    scopeState: AuthorityScopeState,
    assignmentId: string,
    artifactAuthority: ConversationAssignmentArtifactAuthorityIndex,
    interactions: DurableConversationInteractionObserver,
  ): void {
    const route = scopeState.assignmentRoutes.get(assignmentId);
    if (!route) return;
    if (
      scopeState.activeAssignmentClaims.has(assignmentId) ||
      (this.isCurrent(scopeState) &&
        (this.activeRecoveryClaims.get(route.conversationId) ?? 0) > 0)
    ) {
      return;
    }
    scopeState.assignmentRoutes.delete(assignmentId);
    scopeState.assignmentIngress.delete(assignmentId);
    if (this.isCurrent(scopeState)) {
      let removeError: unknown;
      let hasRemoveError = false;
      try {
        artifactAuthority.remove(assignmentId);
      } catch (error) {
        removeError = error;
        hasRemoveError = true;
      }
      try {
        interactions.releaseAssignment(assignmentId);
      } catch (releaseError) {
        if (hasRemoveError) {
          throw new AggregateError(
            [removeError, releaseError],
            `Assignment retirement failed for ${assignmentId}`,
          );
        }
        throw releaseError;
      }
      if (hasRemoveError) throw removeError;
    }
  }

  snapshotConversationRouteRevisions(
    scopeState: AuthorityScopeState,
    conversationId: string,
  ): ReadonlyMap<string, number> {
    const snapshot = new Map<string, number>();
    for (const [assignmentId, route] of scopeState.assignmentRoutes) {
      if (route.conversationId === conversationId) {
        snapshot.set(assignmentId, route.routeRevision);
      }
    }
    return snapshot;
  }

  retireConversationInScope(
    scopeState: AuthorityScopeState,
    conversationId: string,
    artifactAuthority: ConversationAssignmentArtifactAuthorityIndex,
    interactions: DurableConversationInteractionObserver,
  ): void {
    if (!this.isCurrent(scopeState)) return;
    if ((this.activeRecoveryClaims.get(conversationId) ?? 0) > 0) {
      scopeState.pendingConversationRetirements.add(conversationId);
      return;
    }
    this.finalizeConversationRetirementInScope(
      scopeState,
      conversationId,
      artifactAuthority,
      interactions,
    );
  }

  finalizeConversationRetirementInScope(
    scopeState: AuthorityScopeState,
    conversationId: string,
    artifactAuthority: ConversationAssignmentArtifactAuthorityIndex,
    interactions: DurableConversationInteractionObserver,
  ): void {
    if (!this.isCurrent(scopeState)) return;
    scopeState.pendingConversationRetirements.delete(conversationId);
    const journal = scopeState.journals.get(conversationId);
    scopeState.journals.delete(conversationId);
    scopeState.recoveryConversations.delete(conversationId);
    scopeState.recoveryMarkLedger.delete(conversationId);
    scopeState.firstSendWindows.delete(conversationId);
    scopeState.recoveryDeferredRounds.delete(conversationId);
    scopeState.recoveryAttempted.delete(conversationId);
    const errors: unknown[] = [];
    const isolate = (step: () => void) => {
      try {
        step();
      } catch (error) {
        errors.push(error);
      }
    };
    isolate(() => journal?.discardProjectionCheckpoints());
    for (const [assignmentId, route] of [...scopeState.assignmentRoutes.entries()]) {
      if (route.conversationId === conversationId) {
        isolate(() =>
          this.forgetAssignmentInScope(
            scopeState,
            assignmentId,
            artifactAuthority,
            interactions,
          ),
        );
      }
    }
    for (const prepared of [...scopeState.preparedAdmissions.values()]) {
      if (prepared.conversationId === conversationId) {
        isolate(() => this.clearRunClaimsInScope(scopeState, prepared.admission.runId));
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `Conversation retirement failed for ${conversationId}`);
    }
  }
}

export function observeRuntimePhase<T>(
  phaseRecords: LogRecordPort | undefined,
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  return observeLogPhase(phaseRecords, `run.${name}`, work);
}

export function holdObservedForeground(
  port: ForegroundActivityPort,
  phaseRecords: LogRecordPort | undefined,
): ForegroundObligation {
  const obligation = holdForegroundObligation(port);
  if (!phaseRecords) return obligation;
  const held = beginLogPhase(phaseRecords, "run.foreground-held");
  let yielded: ReturnType<typeof beginLogPhase> | undefined;
  let closed = false;
  return {
    pause() {
      obligation.pause();
      if (!closed && !yielded) {
        yielded = beginLogPhase(phaseRecords, "run.foreground-yielded");
      }
    },
    resume() {
      obligation.resume();
      yielded?.finish();
      yielded = undefined;
    },
    close() {
      try {
        obligation.close();
      } finally {
        if (!closed) {
          closed = true;
          try {
            yielded?.finish();
          } finally {
            yielded = undefined;
            held.finish();
          }
        }
      }
    },
  };
}

export function ingressForTurn(
  input: DurableConversationTurnInput | DurableConversationAdmissionInput,
  deviceId: string,
  receivedAt: string,
): IngressContext {
  const origin = input.options?.turnContext?.turnOrigin;
  const ingressId = input.options?.turnContext?.turnId ?? `ingress:${randomUUID()}`;
  if (origin?.target && origin.channel !== "rpc") {
    const responder = {
      channelId: origin.channel,
      platformSubject: origin.triggeredBy ?? "unknown",
    };
    return {
      kind: "channel",
      surfacePrincipal: surfacePrincipalForTurn(input),
      responder,
      replyTarget: origin.target,
      deviceId,
      ingressId,
      turnOrigin: origin,
      receivedAt,
    };
  }
  return {
    kind: "first-party",
    surfacePrincipal: surfacePrincipalForTurn(input),
    deviceId,
    ingressId,
    ...(origin ? { turnOrigin: origin } : {}),
    receivedAt,
  };
}

export function admissionKey(
  input: DurableConversationTurnInput | DurableConversationAdmissionInput,
): string | undefined {
  const turnId = input.options?.turnContext?.turnId;
  if (!turnId) return undefined;
  return canonicalize([
    input.conversationId,
    surfacePrincipalForTurn(input),
    turnId,
  ]);
}

export function surfacePrincipalForTurn(
  input: DurableConversationTurnInput | DurableConversationAdmissionInput,
): string {
  const origin = input.options?.turnContext?.turnOrigin;
  if (origin?.target && origin.channel !== "rpc") {
    return channelSurfacePrincipal({
      channelId: origin.channel,
      platformSubject: origin.triggeredBy ?? "unknown",
    });
  }
  const declared =
    input.options?.surfacePrincipal ??
    ("surfacePrincipal" in input ? input.surfacePrincipal : undefined);
  return (
    declared ??
    `surface:${origin?.channel ?? "local"}:${origin?.triggeredBy ?? "local"}`
  );
}

export function inputControlRequestId(ingress: IngressContext): string {
  return `input:${protocolDigest("ConversationInputIdentity", 1, {
    surfacePrincipal: ingress.surfacePrincipal,
    ingressId: ingress.ingressId,
  })}`;
}

export function runOptionsForPending(
  pending: PendingConversationInput,
  abortSignal?: AbortSignal,
  recovered = false,
) {
  const ingress = pending.ingress;
  const invocation: ConversationInvocation = pending.invocation;
  return {
    source: invocation.source,
    ...(invocation.kind === "agent" && invocation.advancement
      ? { advancement: invocation.advancement }
      : {}),
    ...(abortSignal ? { abortSignal } : {}),
    turnContext: {
      turnId: ingress.ingressId,
      ...(ingress.kind === "channel"
        ? { emissionTarget: ingress.replyTarget }
        : {}),
      ...(ingress.turnOrigin
        ? {
            turnOrigin: recovered
              ? withoutRecoveredSurfaceCapabilities(ingress.turnOrigin)
              : ingress.turnOrigin,
          }
        : {}),
    },
    surfacePrincipal: ingress.surfacePrincipal,
  };
}

export { assignmentSubmissionContext };

export function assignmentResourceContext(
  envelope: Extract<DispatchEnvelope, { execution: "conversation" }>,
): AuthorityCallContext {
  const context = assignmentSubmissionContext(envelope);
  return {
    ...context,
    requestId: `resource-usage:${envelope.assignmentId}`,
    deadlineAt:
      Date.parse(context.deadlineAt) <= Date.parse(envelope.resourceLease.expiry)
        ? context.deadlineAt
        : envelope.resourceLease.expiry,
  };
}

export function createSubmissionAuthorizer(
  executorIdFor: (assignmentId: string) => string,
  verifier: ProtocolSignatureVerifier,
): AssignmentSubmissionAuthorizer {
  return createAssignmentSubmissionAuthorizer({
    executorIdFor,
    verifier,
  });
}

export function createDispatchContexts(options: {
  readonly signer: ProtocolSigner;
  readonly deviceId: string;
  readonly ownerEpochFor: (assignmentId: string) => number;
  readonly anchorEpochFor: (assignmentId: string) => number | undefined;
  readonly assertSigningAuthority: (assignmentId: string, tenure: number | undefined) => void;
  readonly clock: () => string;
  readonly conversationIdFor: (assignmentId: string) => string;
}): InProcessDispatchContextFactory {
  return {
    create(assignmentId, method, request) {
      const now = Date.parse(options.clock());
      const tenure = options.anchorEpochFor(assignmentId);
      options.assertSigningAuthority(assignmentId, tenure);
      const renewalWindow = Math.floor(now / CONTROL_RENEWAL_INTERVAL_MS);
      const renewalSeq = renewalWindow + Number(tenure !== undefined);
      const issuedAt = new Date(
        renewalWindow * CONTROL_RENEWAL_INTERVAL_MS,
      ).toISOString();
      const expiry = new Date(
        renewalWindow * CONTROL_RENEWAL_INTERVAL_MS + CONTEXT_TTL_MS,
      ).toISOString();
      const scope = {
        execution: "conversation" as const,
        conversationId: options.conversationIdFor(assignmentId),
        ownerEpoch: options.ownerEpochFor(assignmentId),
      };
      const controlPayload = {
        ...(tenure === undefined ? { v: 1 as const } : { v: 2 as const, anchorEpoch: tenure }),
        controlLeaseId: `control-${assignmentId}`,
        assignmentId,
        authority: scope,
        renewalSeq,
        issuedAt,
        expiry,
      };
      const controlLease: ControlLease = {
        ...controlPayload,
        signature: options.signer.sign("ControlLease", controlPayload.v, controlPayload),
      };
      const requestDigest = ownerControlRequestDigest({
        method,
        assignmentId,
        authority: scope,
        requestId: request.requestId,
        body: request.body,
      });
      const payload = {
        ...(tenure === undefined ? { v: 1 as const } : { v: 2 as const, anchorEpoch: tenure }),
        assignmentId,
        scope,
        methods: [method],
        callerDeviceId: options.deviceId,
        requestId: request.requestId,
        requestDigest,
        controlLease,
        issuedAt,
        expiry,
      };
      const grant: OwnerControlGrant = {
        ...payload,
        signature: options.signer.sign("OwnerControlGrant", payload.v, payload),
      };
      return {
        principal: { kind: "owner-control", grant },
        requestId: request.requestId,
        deadlineAt: expiry,
      };
    },
  };
}

export function reservationOriginForSource(source: string | undefined): ReservationOrigin {
  return source === "advancement"
    ? { admissionClass: "advancement", entry: "advancement-control" }
    : source === "scheduler"
      ? { admissionClass: "scheduler", entry: "schedule-trigger" }
      : { admissionClass: "interactive", entry: "conversation-input" };
}

export function conversationAssignmentId(runId: string, attempt: number): string {
  return `assignment:${protocolDigest("ConversationAssignmentIdentity", 1, {
    runId,
    attempt,
  })}`;
}

export function resourceHostContext(
  method: "reservation.prepareAssignmentRoot",
  assignmentId: string,
  now: string,
): AuthorityCallContext {
  return {
    principal: { kind: "host", component: "resource-governor" },
    requestId: `resource:${assignmentId}:${method}`,
    deadlineAt: new Date(Date.parse(now) + 60_000).toISOString(),
  };
}

export function usageReporterContext(
  executorId: string,
  reportDigest: string,
  now: string,
): AuthorityCallContext {
  return {
    principal: { kind: "usage-reporter", executorId },
    requestId: `usage-report:${reportDigest}`,
    deadlineAt: new Date(Date.parse(now) + 60_000).toISOString(),
  };
}

export function runFailureReason(result: RunResult["agentResult"]): string {
  if (result.reason === "error") return result.error.message;
  if (result.reason === "max_turns") return "达到最大轮次限制";
  if (result.reason === "aborted") return "运行已中止";
  return "运行未完成";
}

export function executionFailureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cancelledRunResult(result: RunResult): RunResult {
  if (result.agentResult.reason === "aborted") return result;
  return {
    ...result,
    agentResult: {
      reason: "aborted",
      usage: result.agentResult.usage,
    },
  };
}

export function replayCommittedRun(
  runRecord: TranscriptRunRecord,
  windowCompact: RunResult["windowCompact"],
): RunResult {
  const message = [...runRecord.messages]
    .reverse()
    .find((candidate) => candidate.role === "assistant");
  if (!message || message.role !== "assistant") {
    throw new Error("Committed conversation run has no assistant result");
  }
  const usage = runRecord.usage ?? { inputTokens: 0, outputTokens: 0 };
  return {
    agentResult: { reason: "completed", message, usage },
    runRecord: {
      timestamp: runRecord.timestamp,
      messages: [...runRecord.messages],
      usage,
      ...(runRecord.source ? { source: runRecord.source } : {}),
      ...(runRecord.advancement ? { advancement: runRecord.advancement } : {}),
      ...(runRecord.perspectives ? { perspectives: runRecord.perspectives } : {}),
      ...(runRecord.postTurnControl ? { postTurnControl: runRecord.postTurnControl } : {}),
    },
    ...(runRecord.postTurnControl ? { pendingPostTurnControl: runRecord.postTurnControl } : {}),
    ...(windowCompact ? { windowCompact } : {}),
    newMessages: runRecord.messages.slice(1),
    durationMs: 0,
  };
}

export function requireRuntimeSecuritySnapshot(
  runtime: SessionRuntime,
): ReturnType<NonNullable<SessionRuntime["securitySnapshot"]>> {
  const snapshot = runtime.securitySnapshot?.();
  if (snapshot === undefined) {
    throw new Error("Recovered conversation runtime lacks a security snapshot");
  }
  return snapshot;
}

export function requireRuntimeExecutionProfile(
  runtime: SessionRuntime,
): ReturnType<NonNullable<SessionRuntime["executionProfile"]>> {
  const profile = runtime.executionProfile?.();
  if (profile === undefined) {
    throw new Error("Recovered conversation runtime lacks an execution profile");
  }
  return profile;
}

export function requireRuntimeExecutionPermissionRules(
  runtime: SessionRuntime,
  scope: Parameters<NonNullable<SessionRuntime["executionPermissionRules"]>>[0],
): ReturnType<NonNullable<SessionRuntime["executionPermissionRules"]>> {
  const rules = runtime.executionPermissionRules?.(scope);
  if (rules === undefined) {
    throw new Error(
      "Recovered conversation runtime lacks an execution permission snapshot",
    );
  }
  return rules;
}

export function runTrustScope(
  conversationId: string,
  environment: ExplicitEnvironmentSelection | undefined,
): PermissionContextId {
  return toPermissionContext(conversationRunTrustScope(conversationId, environment));
}

export function isFinishedRunState(
  state: ConversationRunState,
): state is "committed" | "cancelled" | "failed" | "expired" {
  return (
    state === "committed" ||
    state === "cancelled" ||
    state === "failed" ||
    state === "expired"
  );
}

export function conversationIdFromSubmissionContext(context: AuthorityCallContext): string {
  const principal = context.principal;
  if (
    principal.kind !== "assignment" ||
    principal.capability.scope.execution !== "conversation"
  ) {
    throw new TypeError(
      "Conversation submission requires a conversation assignment capability",
    );
  }
  return principal.capability.scope.conversationId;
}

export function asConversationMirrorBatch(
  batch: InteractionMirrorBatch,
): ConversationInteractionMirrorBatch {
  for (const entry of batch.entries) {
    if (
      entry.kind === "allow-once" &&
      entry.outcome.t === "answered" &&
      entry.outcome.authority.via !== "surface-ticket"
    ) {
      throw new TypeError("Conversation interaction answer requires a surface ticket");
    }
  }
  return batch as ConversationInteractionMirrorBatch;
}

export function conversationExecutorRequirement(
  invocation: ConversationInvocation,
  ingress: IngressContext,
): ConversationExecutorRequirement {
  return invocation.kind === "agent" &&
    invocation.advancement === undefined &&
    ((invocation.source === "interactive" && ingress.kind === "first-party") ||
      (invocation.source === "channel" && ingress.kind === "channel"))
    ? { placement: "authorized-device" }
    : { placement: "current-device" };
}

export function routineStatusRun(
  state: ConversationStatusNotice["state"],
  runId: string,
): string | undefined {
  return state === "queued" || state === "dispatched" || state === "running"
    ? runId
    : undefined;
}
