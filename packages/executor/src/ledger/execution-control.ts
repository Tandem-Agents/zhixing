import {
  AuthorityPreparationRequired,
  type ArtifactStore,
  type ProjectionTransactionContext,
  type ProjectionTransactionDecision,
} from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AssignmentActivationProof,
  AssignmentEntry,
  AssignmentRecord,
  AuthorityCallContext,
  AuthorityEpochRef,
  AuthorityError,
  CancelProofBody,
  DispatchConflictProof,
  DispatchRejectionProof,
  DispatchResult,
  ExecutionAbortRequest,
  ExecutionManifest,
  LogicalRecord,
  PermissionSnapshotLease,
  RunDispatchArguments,
  StreamConsumerAuth,
  SupersedeProof,
} from "@zhixing-ai/core/contracts";
import {
  acceptedRemoteIntervalRemainingMs,
  advanceAssignmentLedger,
  assertActivePermissionSnapshotLease,
  assertProtocolIdentifier as assertIdentifier,
  canonicalize,
  controlLeaseIdentityDigest,
  dataPlaneTicketDigest,
  dispatchEnvelopeArtifact,
  dispatchEnvelopeDigest,
  matchManifest,
  MAX_CONTROL_LEASE_TTL_MS,
  MAX_PERMISSION_LEASE_TTL_MS,
  protocolDigest,
  requiresFormalResourceCoordination,
  rethrowUnloadedProtocolIdentity,
  signCancelProof,
  signDispatchConflictProof,
  signSupersedeProof,
  validateConversationActivation,
  validateConversationEnvelope,
  validateDispatchControlBinding,
  validateExecutionAbortRequest,
  validateJobActivation,
  validateJobEnvelope,
  validateTrustRuleSnapshot,
  verifyProtocolStep,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing-ai/core/protocol";
import {
  DeviceCapacityAdmissionError,
  StorageMaintenanceAdmissionError,
  StorageMaintenanceCancelledError,
} from "@zhixing-ai/core/resources";
import type { PermissionRule } from "@zhixing-ai/core/security";
import {
  AssignmentLeaseClock,
  leaseClockRecord,
  leaseTime,
} from "../assignment-lease-clock.js";
import type {
  ExecutorAssignmentResourceCoordinator,
  ExecutorExecutionScope,
} from "../resource-governor.js";
import {
  assertDigest,
  assertFence,
  assertNonNegativeSafeInteger,
  assignmentRecord,
  AssignmentStartCancelledError,
  authorityForExecutionRef,
  nextEntryFromSeq,
  requiresExecutorResourceReceipt,
  snapshot,
  withoutSignature,
  type AbortCause,
  type AnyAssignmentActivationPayload,
  type AnyAssignmentActivationProof,
  type AssignmentEnvelope,
  type AssignmentLedgerOptions,
  type DispatchDecision,
  type ExecutionControlFacts,
  type LedgerControlState,
  type LedgerReceivedState,
  type OwnerControlAuthorizer,
  type OwnerControlRequest,
  type PreparedExecutionAuthorityCheck,
  type SurfaceAbortDisposition,
  type SurfaceAbortInput,
} from "./contracts.js";
import type { LedgerProjectionHistoryStore } from "./projection-history-store.js";
import { assertEnvelopeArtifactsPresent } from "./state-replay.js";

const NO_EXECUTION_SCOPE: ExecutorExecutionScope = Object.freeze({ close() {} });

export interface LedgerExecutionControlOptions {
  readonly store: LedgerProjectionHistoryStore;
  readonly artifacts: ArtifactStore;
  readonly executorId: string;
  readonly signer: ProtocolSigner;
  readonly verifier: ProtocolSignatureVerifier;
  readonly ownerControl: OwnerControlAuthorizer;
  readonly snapshotFor: AssignmentLedgerOptions["snapshotFor"];
  readonly permissionSnapshotFor: AssignmentLedgerOptions["permissionSnapshotFor"];
  readonly runtimeBindingGuard?: AssignmentLedgerOptions["runtimeBindingGuard"];
  readonly clock: () => string;
  readonly leaseTime: AssignmentLeaseClock;
  readonly usageFinal: NonNullable<AssignmentLedgerOptions["usageFinal"]>;
  readonly resources?: ExecutorAssignmentResourceCoordinator;
  readonly surfaceAbort?: AssignmentLedgerOptions["surfaceAbort"];
  readonly dataPlaneTickets?: AssignmentLedgerOptions["dataPlaneTickets"];
  readonly reconcileSupersededReceipts: () => Promise<number>;
  readonly runExecutionResourceRetired?: (assignmentId: string) => Promise<boolean>;
}

export class LedgerExecutionControl {
  readonly #store: LedgerProjectionHistoryStore;
  readonly #artifacts: ArtifactStore;
  readonly #executorId: string;
  readonly #signer: ProtocolSigner;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #ownerControl: OwnerControlAuthorizer;
  readonly #snapshotFor: AssignmentLedgerOptions["snapshotFor"];
  readonly #permissionSnapshotFor: AssignmentLedgerOptions["permissionSnapshotFor"];
  readonly #runtimeBindingGuard: AssignmentLedgerOptions["runtimeBindingGuard"];
  readonly #clock: () => string;
  readonly #leaseTime: AssignmentLeaseClock;
  readonly #usageFinal: NonNullable<AssignmentLedgerOptions["usageFinal"]>;
  readonly #resources: ExecutorAssignmentResourceCoordinator | undefined;
  readonly #surfaceAbort: AssignmentLedgerOptions["surfaceAbort"];
  readonly #dataPlaneTickets: AssignmentLedgerOptions["dataPlaneTickets"];
  readonly #reconcileSupersededReceipts: () => Promise<number>;
  readonly #runExecutionResourceRetired:
    | ((assignmentId: string) => Promise<boolean>)
    | undefined;

  constructor(options: LedgerExecutionControlOptions) {
    this.#store = options.store;
    this.#artifacts = options.artifacts;
    this.#executorId = options.executorId;
    this.#signer = options.signer;
    this.#verifier = options.verifier;
    this.#ownerControl = options.ownerControl;
    this.#snapshotFor = options.snapshotFor;
    this.#permissionSnapshotFor = options.permissionSnapshotFor;
    this.#runtimeBindingGuard = options.runtimeBindingGuard;
    this.#clock = options.clock;
    this.#leaseTime = options.leaseTime;
    this.#usageFinal = options.usageFinal;
    this.#resources = options.resources;
    this.#surfaceAbort = options.surfaceAbort;
    this.#dataPlaneTickets = options.dataPlaneTickets;
    this.#reconcileSupersededReceipts = options.reconcileSupersededReceipts;
    this.#runExecutionResourceRetired = options.runExecutionResourceRetired;
  }

  async dispatch(
    ...[rawEnvelope, rawActivation, ctx]: RunDispatchArguments
  ): Promise<DispatchResult> {
    const controlBinding = await verifyProtocolStep(() =>
      validateDispatchControlBinding(rawEnvelope, this.#verifier),
    );
    const assignmentId = assertDispatchIdentity(rawEnvelope, this.#executorId);
    if (
      controlBinding.assignmentId !== assignmentId ||
      controlBinding.executorId !== this.#executorId
    ) {
      throw new TypeError("Dispatch control binding targets a different executor");
    }
    const artifact = dispatchEnvelopeArtifact(rawEnvelope);
    const dispatchDigest = dispatchEnvelopeDigest(rawEnvelope);
    const rawActivationPayload = withoutSignature(rawActivation);
    const claimedAuthority = controlBinding.authority;
    await this.acceptOwnerControl(ctx, {
      method: "executor.dispatch",
      assignmentId,
      authority: claimedAuthority,
      requestId: ctx.requestId,
      body: {
        dispatchDigest,
        activationDigest: protocolDigest(
          "AssignmentActivationPayload",
          1,
          rawActivationPayload,
        ),
      },
      expectedOwnerDeviceId: controlBinding.ownerDeviceId,
      ...(controlBinding.anchorEpoch === undefined
        ? {}
        : { anchorEpoch: controlBinding.anchorEpoch }),
    });

    let envelope: AssignmentEnvelope;
    let envelopeReferences: ArtifactRef[];
    let activation: AnyAssignmentActivationProof;
    let activationPayload: AnyAssignmentActivationPayload;
    try {
      envelope =
        rawEnvelope.execution === "conversation"
          ? await verifyProtocolStep(() =>
              validateConversationEnvelope(rawEnvelope, this.#verifier),
            )
          : await verifyProtocolStep(() =>
              validateJobEnvelope(rawEnvelope, this.#verifier),
            );
      activation = snapshot(rawActivation, "Assignment activation proof");
      const validatedEnvelope = envelope;
      activationPayload =
        validatedEnvelope.execution === "conversation"
          ? await verifyProtocolStep(() =>
              validateConversationActivation({
                envelope: validatedEnvelope,
                activation:
                  activation as AssignmentActivationProof<"conversation">,
                dispatchRef: artifact.ref,
                verifier: this.#verifier,
              }),
            )
          : await verifyProtocolStep(() =>
              validateJobActivation({
                envelope: validatedEnvelope,
                activation: activation as AssignmentActivationProof<"job">,
                dispatchRef: artifact.ref,
                verifier: this.#verifier,
              }),
            );
    } catch (error) {
      rethrowUnloadedProtocolIdentity(error);
      const authorityError = invalidDispatchError(error);
      return this.#rejectBeforeReceived(
        assignmentId,
        dispatchDigest,
        authorityError,
      );
    }

    if (
      canonicalize(claimedAuthority) !==
      canonicalize(authorityForExecutionRef(activationPayload.ref))
    ) {
      throw new TypeError("Dispatch authority changed during validation");
    }
    try {
      if (
        (await this.#artifacts.put(artifact.bytes)).digest !== artifact.ref.digest
      ) {
        throw new TypeError("Dispatch artifact store returned a different digest");
      }
      envelopeReferences = await assertEnvelopeArtifactsPresent(
        envelope,
        this.#artifacts,
      );
    } catch (error) {
      if (
        error instanceof StorageMaintenanceAdmissionError ||
        error instanceof StorageMaintenanceCancelledError ||
        error instanceof DeviceCapacityAdmissionError
      ) {
        throw error;
      }
      const authorityError = invalidDispatchError(error);
      return this.#rejectBeforeReceived(
        assignmentId,
        dispatchDigest,
        authorityError,
      );
    }

    await this.#reconcileSupersededReceipts();

    const shouldCheckRuntimeBinding =
      envelope.execution === "conversation" &&
      this.#runtimeBindingGuard !== undefined &&
      (await this.#store.selectExecutionControl(
        assignmentId,
        (facts) => facts.received === undefined && facts.rejection === undefined,
      ));
    const runtimeBindingError = shouldCheckRuntimeBinding
      ? await this.#runtimeBindingGuard!({
          assignmentId,
          manifest: envelope.manifest as ExecutionManifest<"conversation">,
        })
      : undefined;
    const permissionSnapshot = await this.#permissionSnapshotFor(
      envelope.permissionLease.snapshotDigest,
    );

    const transaction = await this.#store.transactExecutionControl<DispatchDecision>(
      assignmentId,
      (facts) => {
        if (facts.supersedeFence || facts.hasAborts || facts.halted) {
          throw new Error(
            "Assignment is durably fenced and rejects late dispatch",
          );
        }
        if (facts.rejection) {
          return {
            kind: "return",
            value: {
              kind: "rejected",
              dispatchDigest: facts.rejection.body.dispatchDigest,
              error: facts.rejection.body.reason,
              recordSeq: facts.rejection.recordSeq,
              ledgerDigest: facts.rejection.ledgerDigest,
            },
          };
        }
        if (facts.received) {
          const acceptedPayload = withoutSignature(facts.received.body.activation);
          return canonicalize(acceptedPayload) === canonicalize(activationPayload)
            ? { kind: "return", value: { kind: "accepted" } }
            : {
                kind: "return",
                value: { kind: "conflict", received: facts.received },
              };
        }
        const target = this.#snapshotFor(this.#executorId);
        const compatibility =
          target === undefined
            ? {
                ok: false as const,
                error: {
                  code: "capability-gap" as const,
                  message: "Executor capability snapshot is unavailable",
                  retryable: true,
                },
              }
            : matchManifest(
                envelope.manifest,
                target.descriptor,
                target.inventory,
              );
        if (!compatibility.ok) {
          const entry = nextEntryFromSeq(facts.lastSeq, {
            v: 1,
            t: "dispatch-rejected",
            dispatchDigest,
            reason: compatibility.error,
          });
          const ledgerDigest = advanceAssignmentLedger(facts.chainDigest, entry);
          return {
            kind: "append",
            entries: [assignmentRecord(assignmentId, entry)],
            value: {
              kind: "rejected",
              dispatchDigest,
              error: compatibility.error,
              recordSeq: entry.recordSeq,
              ledgerDigest,
            },
          };
        }
        if (runtimeBindingError !== undefined) {
          const entry = nextEntryFromSeq(facts.lastSeq, {
            v: 1,
            t: "dispatch-rejected",
            dispatchDigest,
            reason: runtimeBindingError,
          });
          const ledgerDigest = advanceAssignmentLedger(facts.chainDigest, entry);
          return {
            kind: "append",
            entries: [assignmentRecord(assignmentId, entry)],
            value: {
              kind: "rejected",
              dispatchDigest,
              error: runtimeBindingError,
              recordSeq: entry.recordSeq,
              ledgerDigest,
            },
          };
        }
        const effectiveAcceptedAt = new Date(
          this.#effectiveLeaseNow(facts),
        ).toISOString();
        let permissionError: AuthorityError | undefined;
        try {
          acceptedRemoteIntervalRemainingMs({
            issuedAt: envelope.permissionLease.issuedAt,
            expiry: envelope.permissionLease.expiry,
            acceptedAt: effectiveAcceptedAt,
            maxTtlMs: MAX_PERMISSION_LEASE_TTL_MS,
          });
        } catch {
          permissionError = {
            code: "invalid",
            message:
              "Permission snapshot lease is outside its accepted time window",
            retryable: false,
          };
        }
        if (permissionError !== undefined) {
          // Preserve the time error; no snapshot lookup can make this lease valid.
        } else if (permissionSnapshot === undefined) {
          permissionError = {
            code: "capability-gap",
            message: "Permission snapshot is unavailable",
            retryable: true,
          };
        } else {
          try {
            const validated = validateTrustRuleSnapshot(
              permissionSnapshot,
              this.#verifier,
            );
            if (
              validated.digest !== envelope.permissionLease.snapshotDigest ||
              validated.snapshotVersion !==
                envelope.permissionLease.snapshotVersion
            ) {
              permissionError = {
                code: "invalid",
                message: "Permission snapshot does not match its dispatch lease",
                retryable: false,
              };
            }
          } catch (error) {
            rethrowUnloadedProtocolIdentity(error);
            permissionError = {
              code: "invalid",
              message: "Permission snapshot is invalid",
              retryable: false,
            };
          }
        }
        if (permissionError !== undefined) {
          const entry = nextEntryFromSeq(facts.lastSeq, {
            v: 1,
            t: "dispatch-rejected",
            dispatchDigest,
            reason: permissionError,
          });
          const ledgerDigest = advanceAssignmentLedger(facts.chainDigest, entry);
          return {
            kind: "append",
            entries: [assignmentRecord(assignmentId, entry)],
            value: {
              kind: "rejected",
              dispatchDigest,
              error: permissionError,
              recordSeq: entry.recordSeq,
              ledgerDigest,
            },
          };
        }
        const entry = nextEntryFromSeq(facts.lastSeq, {
          v: 3,
          effectiveAcceptedAt,
          t: "received",
          envelope: { ref: artifact.ref },
          activation: activation as unknown as AssignmentActivationProof,
        });
        let resourceRecords: readonly LogicalRecord<unknown>[] = [];
        if (requiresExecutorResourceReceipt(envelope.resourceLease)) {
          if (!this.#resources) {
            const error: AuthorityError = {
              code: "capability-gap",
              message: "Executor resource governance is unavailable",
              retryable: true,
            };
            const rejected = nextEntryFromSeq(facts.lastSeq, {
              v: 1,
              t: "dispatch-rejected",
              dispatchDigest,
              reason: error,
            });
            return {
              kind: "append",
              entries: [assignmentRecord(assignmentId, rejected)],
              value: {
                kind: "rejected",
                dispatchDigest,
                error,
                recordSeq: rejected.recordSeq,
                ledgerDigest: advanceAssignmentLedger(
                  facts.chainDigest,
                  rejected,
                ),
              },
            };
          }
          try {
            resourceRecords = this.#resources.prepareReceipt(
              envelope.resourceLease,
            );
          } catch (cause) {
            if (cause instanceof AuthorityPreparationRequired) throw cause;
            const error: AuthorityError = {
              code: "lease-exhausted",
              message:
                cause instanceof Error
                  ? cause.message
                  : "Executor resource admission failed",
              retryable: true,
            };
            const rejected = nextEntryFromSeq(facts.lastSeq, {
              v: 1,
              t: "dispatch-rejected",
              dispatchDigest,
              reason: error,
            });
            return {
              kind: "append",
              entries: [assignmentRecord(assignmentId, rejected)],
              value: {
                kind: "rejected",
                dispatchDigest,
                error,
                recordSeq: rejected.recordSeq,
                ledgerDigest: advanceAssignmentLedger(
                  facts.chainDigest,
                  rejected,
                ),
              },
            };
          }
        }
        return {
          kind: "append",
          entries: [...resourceRecords, assignmentRecord(assignmentId, entry)],
          value: { kind: "accepted" },
        };
      },
      {
        candidateReferences: [artifact.ref, ...envelopeReferences],
        ...(requiresExecutorResourceReceipt(envelope.resourceLease)
          ? {
              resourcePreparation: [
                {
                  reservationId: envelope.resourceLease.reservationId,
                  workload: envelope.resourceLease.workload,
                },
              ],
            }
          : {}),
      },
    );

    if (transaction.value.kind === "accepted") {
      return { v: 1, accepted: true };
    }
    if (transaction.value.kind === "rejected") {
      return this.#rejectionResult(
        assignmentId,
        transaction.value.dispatchDigest,
        transaction.value.error,
        transaction.value.recordSeq,
        transaction.value.ledgerDigest,
      );
    }
    return this.#conflictResult(
      assignmentId,
      artifact.ref,
      activationPayload,
      transaction.value.received,
    );
  }

  async preflightOwnerControl(
    context: AuthorityCallContext,
    request: OwnerControlRequest,
    authenticatedCallerDeviceId: string,
  ): Promise<void> {
    await this.acceptOwnerControl(context, request, authenticatedCallerDeviceId);
  }

  async acceptOwnerControl(
    context: AuthorityCallContext,
    request: OwnerControlRequest,
    authenticatedCallerDeviceId = ownerControlCallerDeviceId(context),
  ): Promise<void> {
    const verifyCurrent = await this.#ownerControl.prepare?.(
      context,
      request,
      authenticatedCallerDeviceId,
    );
    const transaction = await this.#store.transactExecutionControl<boolean>(
      request.assignmentId,
      async (facts, prefix) => {
        await verifyCurrent?.(prefix);
        const durableAuthority =
          facts.control?.authority ?? authorityForControlFacts(facts);
        const grant =
          context.principal.kind === "owner-control"
            ? context.principal.grant
            : undefined;
        if (
          verifyCurrent &&
          request.method === "executor.queryLedger" &&
          grant?.v === 2 &&
          grant.scope.execution === "conversation" &&
          durableAuthority?.execution === "conversation" &&
          grant.scope.conversationId === durableAuthority.conversationId &&
          grant.scope.ownerEpoch > durableAuthority.ownerEpoch
        ) {
          const authorized = this.#ownerControl.authorize(
            context,
            {
              ...request,
              authority: grant.scope,
              expectedOwnerDeviceId: grant.callerDeviceId,
            },
            authenticatedCallerDeviceId,
          );
          if (
            canonicalize(authorized.authority) !== canonicalize(grant.scope) ||
            authorized.ownerDeviceId !== grant.callerDeviceId
          ) {
            throw new TypeError(
              "Historical ledger query has no current owner authorization",
            );
          }
          return { kind: "return", value: true };
        }
        const durableOwnerDeviceId =
          facts.control?.ownerDeviceId ??
          facts.received?.body.activation.signature.keyId;
        const authority = durableAuthority ?? request.authority;
        const expectedOwnerDeviceId =
          durableOwnerDeviceId ?? request.expectedOwnerDeviceId;
        const authorized = this.#ownerControl.authorize(
          context,
          {
            ...request,
            ...(authority === undefined ? {} : { authority }),
            ...(expectedOwnerDeviceId === undefined
              ? {}
              : { expectedOwnerDeviceId }),
          },
          authenticatedCallerDeviceId,
        );
        if (
          (authority !== undefined &&
            canonicalize(authorized.authority) !== canonicalize(authority)) ||
          (expectedOwnerDeviceId !== undefined &&
            authorized.ownerDeviceId !== expectedOwnerDeviceId)
        ) {
          throw new TypeError(
            "Owner control authority changed during authorization",
          );
        }
        const current = facts.control;
        if (current) {
          if (
            canonicalize(current.authority) !==
              canonicalize(authorized.authority) ||
            current.ownerDeviceId !== authorized.ownerDeviceId ||
            current.lease.controlLeaseId !==
              authorized.controlLease.controlLeaseId
          ) {
            throw new TypeError(
              "Owner control grant conflicts with durable authority",
            );
          }
          if (authorized.controlLease.renewalSeq < current.lease.renewalSeq) {
            throw new TypeError(
              "Owner control lease renewal sequence regressed",
            );
          }
          if (
            authorized.controlLease.renewalSeq === current.lease.renewalSeq &&
            controlLeaseIdentityDigest(authorized.controlLease) !==
              controlLeaseIdentityDigest(current.lease)
          ) {
            throw new TypeError("Owner control lease sequence was reused");
          }
          const resourceReclaimed = this.#executionResourceReclaimed(facts);
          if (resourceReclaimed && request.method === "executor.queryLedger") {
            return { kind: "return", value: true };
          }
          if (authorized.controlLease.renewalSeq === current.lease.renewalSeq) {
            if (!this.#ownerControlLeaseIsActive(facts)) {
              return this.#expiredLeaseDecision(
                facts,
                leaseTime(current.acceptedAt) + current.validForMs,
                false,
              );
            }
            return { kind: "return", value: true };
          }
          if (resourceReclaimed) {
            throw new TypeError(
              "Owner control lease cannot be renewed after the execution resource was reclaimed",
            );
          }
        }
        const effectiveAcceptedAt = new Date(
          this.#effectiveLeaseNow(facts),
        ).toISOString();
        acceptedRemoteIntervalRemainingMs({
          issuedAt: authorized.controlLease.issuedAt,
          expiry: authorized.controlLease.expiry,
          acceptedAt: effectiveAcceptedAt,
          maxTtlMs: MAX_CONTROL_LEASE_TTL_MS,
        });
        const entry = nextEntryFromSeq(facts.lastSeq, {
          v: 3,
          effectiveAcceptedAt,
          t: "control-lease-renewed",
          lease: snapshot(
            authorized.controlLease,
            "Authorized control lease",
          ),
        });
        return {
          kind: "append",
          entries: [assignmentRecord(request.assignmentId, entry)],
          value: true,
        };
      },
      { readProjectionIds: this.#ownerControl.readProjectionIds },
    );
    if (!transaction.value) {
      throw new TypeError("Owner control lease is no longer active");
    }
  }

  async prepareExecutionAuthority(
    assignmentId: string,
    terminalReplay = false,
  ): Promise<PreparedExecutionAuthorityCheck | undefined> {
    if (!this.#ownerControl.prepareExecution) return undefined;
    const selected = await this.#store.selectExecutionControl(
      assignmentId,
      (facts) => ({
        phase: facts.phase,
        control: facts.control
          ? snapshot(facts.control, "Execution control authority")
          : undefined,
      }),
    );
    if (
      terminalReplay &&
      selected.phase !== "received" &&
      selected.phase !== "started"
    ) {
      return undefined;
    }
    if (!selected.control) {
      throw new TypeError("Execution has no accepted control authority");
    }
    const check = await this.#ownerControl.prepareExecution(selected.control);
    if (!check) return undefined;
    const identity = (control: Readonly<LedgerControlState>) =>
      canonicalize({
        authority: control.authority,
        ownerDeviceId: control.ownerDeviceId,
        controlLeaseId: control.lease.controlLeaseId,
        anchorEpoch: control.lease.anchorEpoch ?? null,
      });
    const prepared = identity(selected.control);
    return async (
      facts: {
        readonly phase: ExecutionControlFacts["phase"];
        readonly control: Readonly<LedgerControlState> | undefined;
      },
      prefix: ProjectionTransactionContext,
    ) => {
      if (
        terminalReplay &&
        facts.phase !== "received" &&
        facts.phase !== "started"
      ) {
        return;
      }
      if (!facts.control || identity(facts.control) !== prepared) {
        throw new TypeError("Execution authority changed during preparation");
      }
      await check(prefix);
    };
  }

  async cancel(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<void> {
    await this.beginOwnerCancellation(assignmentId, fence, ctx);
    await this.finishOwnerCancellation(assignmentId, fence, ctx);
  }

  async beginOwnerCancellation(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<void> {
    assertFence(fence, "Cancel fence");
    if (ctx.principal.kind !== "owner-control") {
      throw new Error("Cancellation requires an owner-control principal");
    }
    await this.acceptOwnerControl(ctx, {
      method: "executor.cancel",
      assignmentId,
      requestId: fence.requestId,
      body: { fenceSeq: fence.fenceSeq },
    });
    await this.requestAbort(
      assignmentId,
      {
        cause: "owner-fence",
        fence: snapshot(fence, "Cancel fence"),
        authority: snapshot(ctx.principal.grant.scope, "Cancel authority"),
      },
      false,
    );
  }

  async finishOwnerCancellation(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<void> {
    assertFence(fence, "Cancel fence");
    if (ctx.principal.kind !== "owner-control") {
      throw new Error("Cancellation requires an owner-control principal");
    }
    await this.requestAbort(assignmentId, {
      cause: "owner-fence",
      fence: snapshot(fence, "Cancel fence"),
      authority: snapshot(ctx.principal.grant.scope, "Cancel authority"),
    });
  }

  async abortFromSurface(
    assignmentId: string,
    input: SurfaceAbortInput,
  ): Promise<void> {
    assertDigest(input.ticketDigest, "Abort ticket digest");
    assertIdentifier(input.surfacePrincipal, "Abort surface principal");
    if (!this.#surfaceAbort) {
      throw new Error("Surface abort authorization is not configured");
    }
    this.#surfaceAbort.authorize(assignmentId, input);
    await this.requestAbort(assignmentId, {
      cause: "abort-ticket",
      ticketDigest: input.ticketDigest,
      surfacePrincipal: input.surfacePrincipal,
    });
  }

  async abortWithTicket(
    input: ExecutionAbortRequest,
  ): Promise<SurfaceAbortDisposition> {
    const request = await verifyProtocolStep(() =>
      validateExecutionAbortRequest(input, this.#verifier),
    );
    const ticketDigest = dataPlaneTicketDigest(request.ticket);
    const existing = await this.#store.selectExecutionControl(
      request.assignmentId,
      (facts) => ({
        matching: facts.hasAbortMatching(
          (abort) =>
            abort.via === "abort-ticket" &&
            abort.refId === ticketDigest &&
            abort.surfacePrincipal === request.ticket.surfacePrincipal,
        ),
        conflicting: facts.hasAbortMatching(
          (abort) =>
            abort.via === "abort-ticket" &&
            (abort.refId !== ticketDigest ||
              abort.surfacePrincipal !== request.ticket.surfacePrincipal),
        ),
        terminal: surfaceOperationIsTerminal(facts),
      }),
    );
    if (existing.matching) return { kind: "accepted" };
    if (existing.conflicting) {
      throw new Error("Assignment already has a different surface abort");
    }
    if (existing.terminal) return { kind: "terminal" };
    const tickets = this.#dataPlaneTickets;
    if (!tickets) {
      throw new Error("Data-plane ticket authorization is not configured");
    }
    await tickets.authorize(request.ticket.ticketId, "abort", {
      assignmentId: request.assignmentId,
      ref: request.ref,
      executorId: this.#executorId,
      surfacePrincipal: request.ticket.surfacePrincipal,
    });
    await this.requestAbort(
      request.assignmentId,
      {
        cause: "abort-ticket",
        ticketDigest,
        surfacePrincipal: request.ticket.surfacePrincipal,
      },
      false,
    );
    return this.#store.selectExecutionControl(request.assignmentId, (facts) => {
      if (
        facts.hasAbortMatching(
          (abort) =>
            abort.via === "abort-ticket" &&
            abort.refId === ticketDigest &&
            abort.surfacePrincipal === request.ticket.surfacePrincipal,
        )
      ) {
        return { kind: "accepted" as const };
      }
      if (surfaceOperationIsTerminal(facts)) {
        return { kind: "terminal" as const };
      }
      throw new Error("Surface abort produced no durable disposition");
    });
  }

  async supersede(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    ctx: AuthorityCallContext,
  ): Promise<SupersedeProof> {
    assertFence(fence, "Supersede fence");
    await this.acceptOwnerControl(ctx, {
      method: "executor.supersede",
      assignmentId,
      requestId: fence.requestId,
      body: { fenceSeq: fence.fenceSeq },
    });
    const transaction = await this.#store.transactExecutionControl<{
      readonly decision: SupersedeProof["decision"];
      readonly recordSeq: number;
      readonly ledgerDigest: string;
    }>(assignmentId, (facts) => {
      if (facts.supersedeFence) {
        if (
          canonicalize(facts.supersedeFence.body) !==
          canonicalize({
            v: 1,
            t: "supersede-fenced",
            ...fence,
          })
        ) {
          throw new Error(
            "Assignment already has a different supersede fence",
          );
        }
        return {
          kind: "return",
          value: {
            decision: "not-started-fenced",
            recordSeq: facts.supersedeFence.recordSeq,
            ledgerDigest: facts.supersedeFence.ledgerDigest,
          },
        };
      }
      if (facts.started) {
        return {
          kind: "return",
          value: {
            decision: "already-started",
            recordSeq: facts.started.recordSeq,
            ledgerDigest: facts.started.ledgerDigest,
          },
        };
      }
      if (
        facts.phase === "dispatch-rejected" ||
        facts.phase === "halted" ||
        facts.phase === "failed"
      ) {
        throw new Error(
          "Terminated assignment cannot be superseded through a new fence",
        );
      }
      if (facts.hasAborts) {
        throw new Error("Cancelling assignment cannot accept a supersede fence");
      }
      const entry = nextEntryFromSeq(facts.lastSeq, {
        v: 1,
        t: "supersede-fenced",
        ...fence,
      });
      return {
        kind: "append",
        entries: [assignmentRecord(assignmentId, entry)],
        value: {
          decision: "not-started-fenced",
          recordSeq: entry.recordSeq,
          ledgerDigest: advanceAssignmentLedger(facts.chainDigest, entry),
        },
      };
    });
    return signSupersedeProof(
      {
        v: 1,
        assignmentId,
        executorId: this.#executorId,
        fence: snapshot(fence, "Supersede fence"),
        decision: transaction.value.decision,
        lastRecordSeq: transaction.value.recordSeq,
        ledgerDigest: transaction.value.ledgerDigest,
      },
      this.#signer,
    );
  }

  openExecutionScope(assignmentId: string): ExecutorExecutionScope {
    assertIdentifier(assignmentId, "Execution scope assignment id");
    return this.#resources?.openExecutionScope(assignmentId) ?? NO_EXECUTION_SCOPE;
  }

  async executionResourceRetired(assignmentId: string): Promise<boolean> {
    const lease = await this.#store.selectExecutionControl(
      assignmentId,
      (facts) => facts.received?.resourceLease,
    );
    if (!lease || !requiresExecutorResourceReceipt(lease) || !this.#resources) {
      return false;
    }
    return (
      (await this.#resources.reservationStates([lease.reservationId])).get(
        lease.reservationId,
      ) === "reclaimed"
    );
  }

  async start(assignmentId: string): Promise<{ readonly started: boolean }> {
    this.#resources?.assertExecutionScope(assignmentId);
    const current = await this.prepareExecutionAuthority(assignmentId, true);
    const transaction = await this.#store.transactExecutionControl<{
      started: boolean;
    }>(
      assignmentId,
      async (facts, prefix) => {
        await current?.(facts, prefix);
        if (facts.hasAborts) {
          throw new AssignmentStartCancelledError(assignmentId);
        }
        if (facts.supersedeFence) {
          throw new Error("Assignment is fenced and cannot start");
        }
        if (facts.phase === "received") {
          return {
            kind: "append",
            entries: [
              assignmentRecord(
                assignmentId,
                nextEntryFromSeq(facts.lastSeq, { v: 1, t: "started" }),
              ),
            ],
            value: { started: true },
          };
        }
        if (
          facts.phase === "started" ||
          facts.phase === "failed" ||
          facts.phase === "sealed" ||
          facts.phase === "acked"
        ) {
          return { kind: "return", value: { started: false } };
        }
        throw new Error(
          "Assignment cannot start before a durable received record",
        );
      },
      { readProjectionIds: this.#ownerControl.readProjectionIds },
    );
    return transaction.value;
  }

  async authorizeOwnerRelay(input: {
    readonly assignmentId: string;
    readonly consumer: Extract<
      StreamConsumerAuth,
      { readonly kind: "owner-relay" }
    >;
    readonly ownerDeviceId: string;
  }): Promise<void> {
    assertIdentifier(input.assignmentId, "Owner relay assignment id");
    assertIdentifier(input.ownerDeviceId, "Owner relay device id");
    const transaction = await this.#store.transactExecutionControl<boolean>(
      input.assignmentId,
      (facts) => {
        const ref = facts.received?.body.activation.ref;
        const control = facts.control;
        if (
          !ref ||
          ref.execution !== "job" ||
          !control ||
          control.ownerDeviceId !== input.ownerDeviceId ||
          canonicalize(control.authority) !==
            canonicalize(input.consumer.authority) ||
          control.lease.controlLeaseId !== input.consumer.controlLeaseId
        ) {
          throw new Error(
            "Owner relay authorization is not active for this assignment",
          );
        }
        if (!this.#ownerControlLeaseIsActive(facts)) {
          return this.#expiredLeaseDecision(
            facts,
            leaseTime(control.acceptedAt) + control.validForMs,
            false,
          );
        }
        return { kind: "return", value: true };
      },
    );
    if (!transaction.value) {
      throw new Error(
        "Owner relay authorization is not active for this assignment",
      );
    }
  }

  async authorizeToolExecution(
    assignmentId: string,
    lease:
      | PermissionSnapshotLease<"conversation">
      | PermissionSnapshotLease<"job">,
  ): Promise<readonly PermissionRule[]> {
    const current = await this.prepareExecutionAuthority(assignmentId);
    const prefetchedDigest =
      typeof lease?.snapshotDigest === "string"
        ? lease.snapshotDigest
        : undefined;
    const prefetched =
      prefetchedDigest === undefined
        ? undefined
        : await this.#permissionSnapshotFor(prefetchedDigest);
    const transaction = await this.#store.transactExecutionControl<
      readonly PermissionRule[] | undefined
    >(
      assignmentId,
      async (facts, prefix) => {
        await current?.(facts, prefix);
        const received = facts.received?.body.activation;
        const active =
          facts.phase === "started" &&
          facts.supersedeFence === undefined &&
          !facts.hasAborts &&
          facts.halted === undefined;
        const validatedLease = assertActivePermissionSnapshotLease({
          lease,
          verifier: this.#verifier,
          activationDigest: received?.permissionLeaseDigest,
          assignmentId,
          executorId: this.#executorId,
          active,
          now: this.#clock(),
          timeValid: true,
        });
        if (
          received === undefined ||
          canonicalize(validatedLease.binding) !== canonicalize(received.ref)
        ) {
          throw new TypeError(
            "Permission snapshot lease does not bind received execution",
          );
        }
        const permissionSnapshot =
          validatedLease.snapshotDigest === prefetchedDigest
            ? prefetched
            : undefined;
        if (permissionSnapshot === undefined) {
          throw new TypeError(
            "Permission snapshot is unavailable for active execution",
          );
        }
        const validatedSnapshot = validateTrustRuleSnapshot(
          permissionSnapshot,
          this.#verifier,
        );
        if (
          validatedSnapshot.snapshotVersion !==
            validatedLease.snapshotVersion ||
          validatedSnapshot.digest !== validatedLease.snapshotDigest
        ) {
          throw new TypeError(
            "Permission snapshot does not match the active lease",
          );
        }
        const control = facts.control;
        const permission = facts.received?.permission;
        if (
          !control ||
          !permission ||
          control.lease.controlLeaseId !== validatedLease.controlLeaseId ||
          permission.controlLeaseId !== validatedLease.controlLeaseId
        ) {
          throw new TypeError(
            "Permission snapshot lease is inactive, expired, or misbound",
          );
        }
        const resourceLease = facts.received?.resourceLease;
        if (
          this.#resources?.lostExecutionRetirement &&
          resourceLease &&
          requiresExecutorResourceReceipt(resourceLease) &&
          this.#resources.assignmentRootState(resourceLease) !== "active"
        ) {
          throw new TypeError(
            "Permission snapshot lease is inactive because its execution resource is no longer active",
          );
        }
        const expiry = Math.min(
          leaseTime(control.acceptedAt) + control.validForMs,
          leaseTime(permission.acceptedAt) + permission.validForMs,
        );
        if (this.#effectiveLeaseNow(facts) >= expiry) {
          return this.#expiredLeaseDecision(facts, expiry, undefined);
        }
        return {
          kind: "return",
          value: validatedSnapshot.rules.map(
            (rule): PermissionRule => ({
              ...rule,
              pattern: { ...rule.pattern },
              ...(rule.contextId === undefined
                ? {}
                : { contextId: structuredClone(rule.contextId) }),
              ...(rule.contributors === undefined
                ? {}
                : { contributors: structuredClone(rule.contributors) }),
              lastMatchedAt: 0,
              matchCount: 0,
            }),
          ),
        };
      },
      { readProjectionIds: this.#ownerControl.readProjectionIds },
    );
    if (transaction.value === undefined) {
      throw new TypeError(
        "Permission snapshot lease is inactive, expired, or misbound",
      );
    }
    return transaction.value;
  }

  async requestAbort(
    assignmentId: string,
    cause: AbortCause,
    complete = true,
  ): Promise<CancelProofBody | undefined> {
    const prefix = await this.#store.transactExecutionControl<{
      readonly proof?: CancelProofBody;
      readonly ready: boolean;
    }>(assignmentId, (facts) => {
      if (facts.halted) {
        return {
          kind: "return",
          value: { proof: facts.halted, ready: false },
        };
      }
      if (
        facts.phase === "failed" ||
        facts.phase === "sealed" ||
        facts.phase === "acked"
      ) {
        return { kind: "return", value: { ready: false } };
      }
      if (facts.phase === "dispatch-rejected" || facts.supersedeFence) {
        return { kind: "return", value: { ready: false } };
      }
      assertAbortAuthority(facts, cause);

      let recordSeq = facts.lastSeq;
      const entries: AssignmentEntry[] = [];
      const append = (body: AssignmentRecord) => {
        const entry = {
          recordSeq: ++recordSeq,
          body: snapshot(body, "Cancellation record"),
        };
        entries.push(entry);
      };
      const via =
        cause.cause === "owner-fence" ? "owner-fence" : "abort-ticket";
      const refId =
        cause.cause === "owner-fence"
          ? cause.fence.requestId
          : cause.ticketDigest;
      if (
        !facts.hasAbortMatching(
          (abort) => abort.via === via && abort.refId === refId,
        )
      ) {
        if (cause.cause === "owner-fence") {
          append({
            v: 1,
            t: "abort-requested",
            via: "owner-fence",
            refId: cause.fence.requestId,
          });
        } else {
          append({
            v: 1,
            t: "abort-requested",
            via: "abort-ticket",
            refId: cause.ticketDigest,
            surfacePrincipal: cause.surfacePrincipal,
          });
        }
      }
      for (const request of facts.pendingRequestsSnapshot()) {
        append({
          v: 1,
          t: "interaction-finished",
          requestId: request.body.requestId,
          kind: "allow-once",
          outcome: {
            t: "cancelled",
            via:
              cause.cause === "owner-fence" ? "cancel-fence" : "abort-ticket",
          },
        });
      }
      if (facts.hasOpenSideEffects || facts.hasPendingInteractionObligations) {
        if (entries.length === 0) {
          return { kind: "return", value: { ready: false } };
        }
        return {
          kind: "append",
          entries: entries.map((entry) =>
            assignmentRecord(assignmentId, entry),
          ),
          value: { ready: false },
        };
      }
      if (entries.length === 0) {
        return { kind: "return", value: { ready: true } };
      }
      return {
        kind: "append",
        entries: entries.map((entry) =>
          assignmentRecord(assignmentId, entry),
        ),
        value: { ready: true },
      };
    });
    if (prefix.value.proof) return prefix.value.proof;
    if (!complete || !prefix.value.ready) return undefined;
    return this.#completeAbort(assignmentId, cause);
  }

  async #completeAbort(
    assignmentId: string,
    cause: AbortCause,
  ): Promise<CancelProofBody | undefined> {
    const governed = await this.#store.selectExecutionControl(
      assignmentId,
      (facts) => {
        const lease = facts.received?.resourceLease;
        return lease !== undefined && requiresFormalResourceCoordination(lease);
      },
    );
    if (
      governed &&
      (await (this.#runExecutionResourceRetired
        ? this.#runExecutionResourceRetired(assignmentId)
        : this.executionResourceRetired(assignmentId)))
    ) {
      return undefined;
    }
    const finalUsage = snapshot(
      governed
        ? await this.#usageFinal(assignmentId)
        : zeroAssignmentUsageFinal(assignmentId),
      "Final usage report",
    );
    assertDigest(finalUsage.reportDigest, "Final usage report digest");
    assertNonNegativeSafeInteger(
      finalUsage.upToUsageSeq,
      "Final usage sequence",
    );
    const transaction = await this.#store.transactExecutionControl<
      CancelProofBody | undefined
    >(assignmentId, (facts) => {
      if (facts.halted) return { kind: "return", value: facts.halted };
      if (
        facts.phase === "failed" ||
        facts.phase === "sealed" ||
        facts.phase === "acked" ||
        facts.phase === "dispatch-rejected" ||
        facts.supersedeFence
      ) {
        return { kind: "return", value: undefined };
      }
      const lease = facts.received?.resourceLease;
      if (
        lease &&
        requiresExecutorResourceReceipt(lease) &&
        this.#resources?.assignmentRootState(lease) === "reclaimed"
      ) {
        return { kind: "return", value: undefined };
      }
      const authority = assertAbortAuthority(facts, cause);
      const via =
        cause.cause === "owner-fence" ? "owner-fence" : "abort-ticket";
      const refId =
        cause.cause === "owner-fence"
          ? cause.fence.requestId
          : cause.ticketDigest;
      if (
        !facts.hasAbortMatching(
          (abort) => abort.via === via && abort.refId === refId,
        )
      ) {
        return { kind: "return", value: undefined };
      }
      if (facts.hasOpenSideEffects || facts.hasPendingInteractionObligations) {
        return { kind: "return", value: undefined };
      }
      const decision = facts.started ? "halted" : "not-started";
      const proof = signCancelProof(
        {
          v: 1,
          assignmentId,
          executorId: this.#executorId,
          authority,
          lastRecordSeq: facts.lastSeq,
          usageFinal: finalUsage,
          ledgerDigest: facts.chainDigest,
          issuedAt: this.#clock(),
          ...(cause.cause === "owner-fence"
            ? { cause: "owner-fence" as const, fence: cause.fence }
            : {
                cause: "abort-ticket" as const,
                ticketDigest: cause.ticketDigest,
                surfacePrincipal: cause.surfacePrincipal,
              }),
          ...(decision === "halted"
            ? {
                decision: "halted" as const,
                lastEffectSeq: facts.sideEffectCount,
              }
            : { decision: "not-started" as const }),
        },
        this.#signer,
      );
      const entry = nextEntryFromSeq(facts.lastSeq, {
        v: 1,
        t: "halted",
        proof,
      });
      return {
        kind: "append",
        entries: [assignmentRecord(assignmentId, entry)],
        value: proof,
      };
    });
    return transaction.value;
  }

  async #rejectBeforeReceived(
    assignmentId: string,
    dispatchDigest: string,
    error: AuthorityError,
  ): Promise<DispatchResult> {
    const transaction = await this.#store.transactExecutionControl<DispatchDecision>(
      assignmentId,
      (facts) => {
        if (facts.received) {
          throw new Error(
            "Invalid redelivery cannot change an accepted assignment ledger",
          );
        }
        if (facts.rejection) {
          return {
            kind: "return",
            value: {
              kind: "rejected",
              dispatchDigest: facts.rejection.body.dispatchDigest,
              error: facts.rejection.body.reason,
              recordSeq: facts.rejection.recordSeq,
              ledgerDigest: facts.rejection.ledgerDigest,
            },
          };
        }
        const entry = nextEntryFromSeq(facts.lastSeq, {
          v: 1,
          t: "dispatch-rejected",
          dispatchDigest,
          reason: error,
        });
        const ledgerDigest = advanceAssignmentLedger(facts.chainDigest, entry);
        return {
          kind: "append",
          entries: [assignmentRecord(assignmentId, entry)],
          value: {
            kind: "rejected",
            dispatchDigest,
            error,
            recordSeq: entry.recordSeq,
            ledgerDigest,
          },
        };
      },
    );
    if (transaction.value.kind !== "rejected") {
      throw new Error("Dispatch rejection did not produce a rejection result");
    }
    return this.#rejectionResult(
      assignmentId,
      transaction.value.dispatchDigest,
      transaction.value.error,
      transaction.value.recordSeq,
      transaction.value.ledgerDigest,
    );
  }

  #effectiveLeaseNow(facts: ExecutionControlFacts): number {
    return this.#leaseTime.now(
      Math.max(facts.leaseTimeFrontier, facts.leaseAcceptanceFloor),
    );
  }

  #executionResourceReclaimed(facts: ExecutionControlFacts): boolean {
    const lease = facts.received?.resourceLease;
    return (
      lease !== undefined &&
      requiresExecutorResourceReceipt(lease) &&
      this.#resources?.assignmentRootState(lease) === "reclaimed"
    );
  }

  #ownerControlLeaseIsActive(facts: ExecutionControlFacts): boolean {
    const control = facts.control;
    return (
      control !== undefined &&
      this.#effectiveLeaseNow(facts) <
        leaseTime(control.acceptedAt) + control.validForMs
    );
  }

  #expiredLeaseDecision<Value>(
    facts: ExecutionControlFacts,
    expiry: number,
    value: Value,
  ): ProjectionTransactionDecision<unknown, Value> {
    if (facts.leaseTimeFrontier >= expiry) return { kind: "return", value };
    return {
      kind: "append",
      entries: [
        leaseClockRecord(this.#executorId, this.#effectiveLeaseNow(facts)),
      ],
      value,
    };
  }

  #rejectionResult(
    assignmentId: string,
    dispatchDigest: string,
    error: AuthorityError,
    recordSeq: number,
    ledgerDigest: string,
  ): DispatchResult {
    const payload = {
      v: 1 as const,
      assignmentId,
      executorId: this.#executorId,
      dispatchDigest,
      error,
      lastRecordSeq: recordSeq,
      ledgerDigest,
    };
    const proof: DispatchRejectionProof = snapshot(
      {
        ...payload,
        signature: this.#signer.sign("DispatchRejectionProof", 1, payload),
      },
      "Dispatch rejection proof",
    );
    return {
      v: 1,
      accepted: false,
      outcome: "rejected-before-received",
      error: snapshot(error, "Dispatch rejection error"),
      proof,
    };
  }

  #conflictResult(
    assignmentId: string,
    conflictingDispatchRef: ArtifactRef,
    conflictingPayload: AnyAssignmentActivationPayload,
    received: Readonly<LedgerReceivedState>,
  ): DispatchResult {
    const acceptedPayload = withoutSignature(received.body.activation);
    const payload = {
      v: 1 as const,
      assignmentId,
      executorId: this.#executorId,
      acceptedDispatchRef: received.body.envelope.ref,
      conflictingDispatchRef,
      acceptedActivationDigest: protocolDigest(
        "AssignmentActivationPayload",
        1,
        acceptedPayload,
      ),
      conflictingActivationDigest: protocolDigest(
        "AssignmentActivationPayload",
        1,
        conflictingPayload,
      ),
      receivedRecordSeq: received.recordSeq,
      receivedLedgerDigest: received.ledgerDigest,
      error: { code: "idempotency-conflict" as const, retryable: false as const },
    };
    const proof: DispatchConflictProof = signDispatchConflictProof(
      payload,
      this.#signer,
    );
    return {
      v: 1,
      accepted: false,
      outcome: "conflicting-redelivery",
      error: {
        code: "idempotency-conflict",
        retryable: false,
        message:
          "Assignment id was redelivered with a different activation payload",
      },
      proof,
    };
  }
}

export function zeroAssignmentUsageFinal(assignmentId: string): {
  readonly reportDigest: string;
  readonly upToUsageSeq: 0;
} {
  return {
    reportDigest: protocolDigest("AssignmentUsageFinal", 1, {
      assignmentId,
      upToUsageSeq: 0,
    }),
    upToUsageSeq: 0,
  };
}

function authorityForControlFacts(
  facts: ExecutionControlFacts,
): AuthorityEpochRef | undefined {
  return facts.received === undefined
    ? facts.control?.authority
    : authorityForExecutionRef(facts.received.body.activation.ref);
}

function assertAbortAuthority(
  facts: ExecutionControlFacts,
  cause: AbortCause,
): AuthorityEpochRef {
  const receivedRef = facts.received?.body.activation.ref;
  const receivedAuthority = receivedRef
    ? authorityForExecutionRef(receivedRef)
    : undefined;
  const authority =
    cause.cause === "owner-fence" ? cause.authority : receivedAuthority;
  if (!authority) throw new Error("Cancellation has no authority binding");
  if (
    receivedAuthority &&
    canonicalize(receivedAuthority) !== canonicalize(authority)
  ) {
    throw new Error(
      "Cancellation authority does not bind the received assignment",
    );
  }
  return authority;
}

function surfaceOperationIsTerminal(facts: ExecutionControlFacts): boolean {
  return (
    facts.halted !== undefined ||
    facts.phase === "failed" ||
    facts.phase === "sealed" ||
    facts.phase === "acked" ||
    facts.phase === "dispatch-rejected" ||
    facts.supersedeFence !== undefined
  );
}

function assertDispatchIdentity(
  envelope: AssignmentEnvelope,
  executorId: string,
): string {
  assertIdentifier(envelope?.assignmentId, "Dispatch assignmentId");
  if (envelope.executorId !== executorId) {
    throw new TypeError("Dispatch targets a different executor");
  }
  return envelope.assignmentId;
}

function invalidDispatchError(error: unknown): AuthorityError {
  return {
    code: "invalid",
    message:
      error instanceof Error ? error.message : "Dispatch validation failed",
    retryable: false,
  };
}

function ownerControlCallerDeviceId(context: AuthorityCallContext): string {
  if (context.principal.kind !== "owner-control") {
    throw new Error("Executor control requires an owner grant");
  }
  return context.principal.grant.callerDeviceId;
}
