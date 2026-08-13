import type {
  CredentialExposureRecord,
  HomeTrustEvent,
  HomeTrustRecord,
  SecretStorePort,
} from "@zhixing/core/contracts";
import {
  DeviceLifecycleJournal,
  type FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import {
  createSignedDeviceLifecycleAbort,
  canonicalize,
  createSignedExecutorRemovalReceipt,
  decodeExecutorRemovalDecision,
  emptyDeviceLifecycleProjection,
  encodeExecutorRemovalDecision,
  protocolDigest,
  reduceDeviceLifecycleProjection,
  validateDeviceLifecycleRecord,
  validateDeviceLifecycleAbort,
  validateExecutorRemovalReceipt,
  type DeviceLifecycleEvidenceRef,
  type DeviceLifecycleOperation,
  type DeviceLifecycleAbort,
  type DeviceLifecycleProjection,
  type ExecutorRemovalDecision,
  type ExecutorRemovalLifecycleIdentity,
  type ExecutorRemovalReceipt,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import { deleteDeviceKey } from "@zhixing/mesh/device-key-store";
import {
  applyTrustEvent,
  buildHomeTrustRecord,
  createSignedTrustEvent,
  homeTrustEventDigest,
  replayTrustChain,
} from "@zhixing/mesh/trust-chain";
import {
  projectCredentialExposures,
} from "@zhixing/mesh/credential-exposure";
import type { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import type {
  LocalConversationOwnerAssembly,
  LocalConversationRemovalSnapshot,
} from "./local-conversation-owner.js";

type TrustStreamRecord =
  | { readonly t: "home-trust-event"; readonly event: HomeTrustEvent }
  | { readonly t: "home-trust-record"; readonly record: HomeTrustRecord };

interface RemovalAuthorityProjection {
  readonly trustEvents: readonly HomeTrustEvent[];
  readonly exposures: readonly CredentialExposureRecord[];
  readonly lifecycle: DeviceLifecycleProjection;
}

export interface DeviceRemovalCandidate {
  readonly displayName: string;
  readonly reachable: boolean;
}

export interface ExecutorRemovalPublicState {
  readonly phase:
    | "waiting-for-device"
    | "needs-conversation-decision"
    | "moving-conversations"
    | "revoking-access"
    | "cleaning-device"
    | "removed"
    | "cancelled";
  readonly conversations: readonly string[];
  readonly localData: "known" | "unknown" | "removed";
  readonly credentialActions: readonly string[];
}

export type ExecutorRemovalTargetDecision =
  | {
      readonly kind: "ready";
      readonly receipt: ExecutorRemovalReceipt;
    }
  | {
      readonly kind: "preflight-changed";
      readonly snapshot: LocalConversationRemovalSnapshot;
    };

export class CurrentIssuerDeviceRemovalAuthority {
  readonly #journal: DeviceLifecycleJournal;
  readonly #authorizedTargets = new Map<string, string>();

  constructor(private readonly options: {
    readonly store: FileMeshBootstrapStore;
    readonly issuerKey: DeviceKey;
    readonly secretStore: SecretStorePort;
    readonly verifier: ProtocolSignatureVerifier;
    readonly isReachable: (deviceId: string) => boolean;
    readonly onGuardChanged?: (targetDeviceId: string, operationId: string | undefined) => void;
    readonly onTrustCommitted?: (record: HomeTrustRecord) => void | Promise<void>;
    readonly now?: () => string;
  }) {
    this.#journal = new DeviceLifecycleJournal(
      options.store.authorityLog(),
      options.verifier,
    );
  }

  async candidates(): Promise<readonly DeviceRemovalCandidate[]> {
    const trust = replayTrustChain(await this.options.store.loadTrustEvents());
    if (trust.issuer.deviceId !== this.options.issuerKey.deviceId) return [];
    return trust.members
      .filter((member) =>
        member.state === "active" &&
        member.device.deviceId !== trust.issuer.deviceId,
      )
      .map((member) => Object.freeze({
        displayName: member.device.displayName,
        reachable: this.options.isReachable(member.device.deviceId),
      }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName, "zh-CN"));
  }

  async accept(input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly targetName: string;
  }): Promise<ExecutorRemovalReceipt> {
    const trust = replayTrustChain(await this.options.store.loadTrustEvents());
    if (trust.issuer.deviceId !== this.options.issuerKey.deviceId) {
      throw new Error("Only the current duty device can remove a paired device");
    }
    const matches = trust.members.filter((member) =>
      member.state === "active" && member.device.displayName === input.targetName);
    if (matches.length !== 1) {
      throw new Error(matches.length === 0
        ? "No active paired device has that name"
        : "More than one active paired device has that name");
    }
    return this.#acceptMember(input.requestId, input.operationId, trust, matches[0]!);
  }

  async acceptForDevice(input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly targetDeviceId: string;
  }): Promise<ExecutorRemovalReceipt> {
    const trust = replayTrustChain(await this.options.store.loadTrustEvents());
    if (trust.issuer.deviceId !== this.options.issuerKey.deviceId) {
      throw new Error("Only the current duty device can remove a paired device");
    }
    const target = trust.members.find((member) =>
      member.state === "active" && member.device.deviceId === input.targetDeviceId);
    if (!target) throw new Error("Removal target is not an active paired device");
    return this.#acceptMember(input.requestId, input.operationId, trust, target);
  }

  async #acceptMember(
    requestId: string,
    operationId: string,
    trust: ReturnType<typeof replayTrustChain>,
    target: ReturnType<typeof replayTrustChain>["members"][number],
  ): Promise<ExecutorRemovalReceipt> {
    if (target.device.deviceId === trust.issuer.deviceId) {
      throw new Error("The current duty device cannot remove itself");
    }
    const identity: ExecutorRemovalLifecycleIdentity = Object.freeze({
      v: 1,
      kind: "executor-removal",
      requestId,
      operationId,
      homeId: trust.homeId,
      targetDeviceId: target.device.deviceId,
      targetMemberPublicKey: target.device.publicKey,
      targetDeviceKeyGeneration: deviceKeyGeneration(target.device),
      acceptedIssuerDeviceId: trust.issuer.deviceId,
      acceptedTrustHeadDigest: trust.chainHead.eventDigest,
    });
    let operation = await this.#journal.accept(identity);
    if (operation.phase === "accepted") {
      operation = await this.#journal.advance(operationId, "gate-frozen", [{
        kind: "accepted-work",
        digest: protocolDigest("ExecutorRemovalAdmission", 1, identity),
      }]);
    }
    if (operation.identity.kind !== "executor-removal") {
      throw new Error("Removal acceptance replay changed operation kind");
    }
    this.options.onGuardChanged?.(identity.targetDeviceId, identity.operationId);
    this.#authorizedTargets.set(identity.targetDeviceId, identity.operationId);
    return createSignedExecutorRemovalReceipt({
      v: 1,
      operationId: identity.operationId,
      homeId: identity.homeId,
      targetDeviceId: identity.targetDeviceId,
      targetDeviceKeyGeneration: identity.targetDeviceKeyGeneration,
      acceptedIssuerDeviceId: identity.acceptedIssuerDeviceId,
      acceptedTrustHeadDigest: identity.acceptedTrustHeadDigest,
      phase: "accepted",
      evidenceDigest: protocolDigest("ExecutorRemovalAdmission", 1, identity),
      at: acceptedReceiptTime(trust),
    }, this.options.issuerKey);
  }

  authorizesTarget(deviceId: string): boolean {
    return this.#authorizedTargets.has(deviceId);
  }

  async resumeActive(): Promise<void> {
    for (const operation of await this.#journal.operations()) {
      if (
        operation.identity.kind !== "executor-removal" ||
        operation.phase === "aborted"
      ) {
        continue;
      }
      const identity = operation.identity;
      this.#authorizedTargets.set(identity.targetDeviceId, identity.operationId);
      if (operation.phase === "terminal") continue;
      this.options.onGuardChanged?.(identity.targetDeviceId, identity.operationId);
      if (operation.phase === "revocation-ready" || operation.phase === "revoked") {
        await this.#commitRevocation(identity);
      }
    }
  }

  async operation(operationId: string): Promise<ExecutorRemovalLifecycleIdentity | undefined> {
    const operation = await this.#journal.state(operationId);
    return operation?.identity.kind === "executor-removal" ? operation.identity : undefined;
  }

  async operationForTarget(targetDeviceId: string): Promise<ExecutorRemovalLifecycleIdentity | undefined> {
    const operations = (await this.#journal.operations())
      .filter((operation) =>
        operation.identity.kind === "executor-removal" &&
        operation.identity.targetDeviceId === targetDeviceId,
      );
    const active = operations.filter((operation) =>
      operation.phase !== "terminal" && operation.phase !== "aborted");
    if (active.length > 1) {
      throw new Error("Paired device has conflicting active removal operations");
    }
    return (active[0] ?? operations.at(-1))?.identity as
      | ExecutorRemovalLifecycleIdentity
      | undefined;
  }

  async commitReady(input: ExecutorRemovalReceipt): Promise<ExecutorRemovalReceipt> {
    const ready = validateExecutorRemovalReceipt(input, this.options.verifier);
    if (ready.phase !== "revocation-ready" || ready.signature.keyId !== ready.targetDeviceId) {
      throw new Error("Device removal ready receipt is not signed by the target device");
    }
    let operation = await this.#journal.state(ready.operationId);
    if (!operation || operation.identity.kind !== "executor-removal") {
      throw new Error("Device removal operation is not accepted by the current issuer");
    }
    const identity = operation.identity;
    assertReceiptIdentity(ready, identity);
    if (operation.phase === "terminal" || operation.phase === "cleanup-complete") {
      return this.#removedReceipt(identity);
    }
    if (operation.phase === "revoked") return this.#revokedReceipt(identity);
    operation = await this.#journal.peerEffect(operation.identity.operationId, {
      kind: "target-ready",
      digest: protocolDigest("ExecutorRemovalReadyReceipt", 1, ready),
      evidence: [{ kind: "accepted-work", digest: ready.evidenceDigest }],
    });
    const readyEvidence: DeviceLifecycleEvidenceRef = {
      kind: "accepted-work",
      digest: ready.evidenceDigest,
    };
    for (const phase of ["authority-decided", "authority-settled", "revocation-ready"] as const) {
      if (operation.phase === phase) continue;
      if (phaseOrder(operation.phase) < phaseOrder(phase)) {
        operation = await this.#journal.advance(operation.identity.operationId, phase, [readyEvidence]);
      }
    }
    return this.#commitRevocation(identity);
  }

  async terminal(operationId: string): Promise<ExecutorRemovalReceipt | undefined> {
    const operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "executor-removal" || operation.phase !== "terminal") {
      return undefined;
    }
    return this.#removedReceipt(operation.identity);
  }

  async commitCleanupReady(input: ExecutorRemovalReceipt): Promise<ExecutorRemovalReceipt> {
    const ready = validateExecutorRemovalReceipt(input, this.options.verifier);
    if (ready.phase !== "cleanup-ready" || ready.signature.keyId !== ready.targetDeviceId) {
      throw new Error("Device cleanup-ready receipt is not signed by the target device");
    }
    let operation = await this.#journal.state(ready.operationId);
    if (!operation || operation.identity.kind !== "executor-removal") {
      throw new Error("Device removal operation is not accepted by the current issuer");
    }
    assertReceiptIdentity(ready, operation.identity);
    const identity = operation.identity;
    if (operation.phase === "terminal") return this.#removedReceipt(identity);
    if (operation.phase !== "revoked" && operation.phase !== "cleanup-complete") {
      throw new Error("Device cleanup-ready requires durable issuer revocation");
    }
    operation = await this.#journal.peerEffect(identity.operationId, {
      kind: "target-cleanup-ready",
      digest: protocolDigest("ExecutorRemovalCleanupReadyReceipt", 1, ready),
      evidence: [],
    });
    if (operation.phase === "revoked") {
      operation = await this.#journal.advance(identity.operationId, "cleanup-complete", [{
        kind: "cleanup",
        digest: ready.evidenceDigest,
      }]);
    }
    if (operation.phase === "cleanup-complete") {
      operation = await this.#journal.terminal(identity.operationId, "removed", [{
        kind: "cleanup",
        digest: protocolDigest("ExecutorRemovalIssuerTerminalEvidence", 1, {
          operationId: identity.operationId,
          cleanupDigest: ready.evidenceDigest,
        }),
      }]);
    }
    await this.#journal.peerEffect(identity.operationId, {
      kind: "issuer-terminal",
      digest: protocolDigest("ExecutorRemovalIssuerTerminal", 1, {
        operationId: identity.operationId,
        cleanupDigest: ready.evidenceDigest,
      }),
      evidence: [],
    });
    this.options.onGuardChanged?.(identity.targetDeviceId, undefined);
    return this.#removedReceipt(identity);
  }

  async acceptTargetAborted(input: ExecutorRemovalReceipt): Promise<void> {
    const receipt = validateExecutorRemovalReceipt(input, this.options.verifier);
    if (receipt.phase !== "aborted" || receipt.signature.keyId !== receipt.targetDeviceId) {
      throw new Error("Device removal abort receipt is not signed by the target device");
    }
    let operation = await this.#journal.state(receipt.operationId);
    if (!operation || operation.identity.kind !== "executor-removal") {
      throw new Error("Device removal operation is unknown");
    }
    const identity = operation.identity;
    assertReceiptIdentity(receipt, identity);
    const abort = await this.#issuerAbort(operation);
    if (!abort) throw new Error("Device removal target abort has no durable issuer command");
    if (receipt.evidenceDigest !== protocolDigest("ExecutorRemovalTargetAborted", 1, abort)) {
      throw new Error("Device removal target abort does not acknowledge the durable issuer command");
    }
    operation = await this.#journal.abort(identity.operationId, abort);
    await this.#journal.peerEffect(identity.operationId, {
      kind: "target-aborted",
      digest: protocolDigest("ExecutorRemovalTargetAborted", 1, receipt),
      evidence: [],
    });
    this.options.onGuardChanged?.(identity.targetDeviceId, undefined);
    this.#authorizedTargets.delete(identity.targetDeviceId);
  }

  async commitLost(operationId: string): Promise<ExecutorRemovalReceipt> {
    let operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "executor-removal") {
      throw new Error("Lost-device removal operation is unknown");
    }
    const identity = operation.identity;
    if (operation.phase === "terminal") return this.#removedReceipt(identity);
    if (operation.phase === "revoked") {
      operation = await this.#journal.advance(operationId, "cleanup-complete", [{
        kind: "cleanup",
        digest: protocolDigest("LostExecutorLocalData", 1, { operationId, state: "unknown" }),
      }]);
      await this.#journal.terminal(operationId, "removed", operation.evidence);
      this.options.onGuardChanged?.(identity.targetDeviceId, undefined);
      return this.#removedReceipt(identity, "lost");
    }
    const evidence = [{
      kind: "accepted-work" as const,
      digest: protocolDigest("LostExecutorRemovalDecision", 1, {
        operationId,
        targetDeviceId: identity.targetDeviceId,
        localAuthority: "unknown",
      }),
    }];
    for (const phase of ["authority-decided", "authority-settled", "revocation-ready"] as const) {
      if (phaseOrder(operation.phase) < phaseOrder(phase)) {
        operation = await this.#journal.advance(operationId, phase, evidence);
      }
    }
    await this.#commitRevocation(identity);
    const revoked = await this.#journal.state(operationId);
    if (!revoked || revoked.phase !== "revoked") throw new Error("Lost removal revocation did not commit");
    operation = await this.#journal.advance(operationId, "cleanup-complete", [{
      kind: "cleanup",
      digest: protocolDigest("LostExecutorLocalData", 1, { operationId, state: "unknown" }),
    }]);
    await this.#journal.terminal(operationId, "removed", operation.evidence);
    this.options.onGuardChanged?.(identity.targetDeviceId, undefined);
    return this.#removedReceipt(identity, "lost");
  }

  async abort(operationId: string): Promise<DeviceLifecycleAbort> {
    const operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "executor-removal") {
      throw new Error("Device removal operation is unknown");
    }
    if (operation.phase === "aborted" && operation.abort) return operation.abort;
    if (operation.phase === "terminal" || phaseOrder(operation.phase) >= phaseOrder("authority-decided")) {
      throw new Error("Device removal has already crossed its cancellation boundary");
    }
    const replay = await this.#issuerAbort(operation);
    if (replay) return replay;
    const requested = createSignedDeviceLifecycleAbort({
          v: 1,
          operationId,
          homeId: operation.identity.homeId,
          subjectDeviceId: operation.identity.targetDeviceId,
          authorizedByDeviceId: operation.identity.acceptedIssuerDeviceId,
          reason: "user-cancelled",
          at: this.options.now?.() ?? new Date().toISOString(),
        }, this.options.issuerKey);
    const ref = await this.options.store.artifactStore().put(
      Buffer.from(canonicalize(requested), "utf8"),
    );
    try {
      await this.#journal.peerEffect(operationId, {
        kind: "issuer-abort",
        digest: protocolDigest("ExecutorRemovalIssuerAbort", 1, requested),
        evidence: [{ kind: "accepted-work", digest: ref.digest, artifact: ref }],
      });
      return requested;
    } catch (error) {
      const winner = await this.#journal.state(operationId);
      const replayed = winner ? await this.#issuerAbort(winner) : undefined;
      if (replayed) return replayed;
      throw error;
    }
  }

  async pendingAbortForTarget(targetDeviceId: string): Promise<{
    readonly operationId: string;
    readonly abort: DeviceLifecycleAbort;
  } | undefined> {
    const operations = (await this.#journal.operations()).filter((operation) =>
      operation.identity.kind === "executor-removal" &&
      operation.identity.targetDeviceId === targetDeviceId &&
      operation.phase !== "terminal" &&
      operation.phase !== "aborted" &&
      !operation.peerEffects.some((effect) =>
        effect.kind === "target-ready" || effect.kind === "target-aborted"),
    );
    if (operations.length > 1) {
      throw new Error("Paired device has conflicting pending abort operations");
    }
    const operation = operations[0];
    if (!operation) return undefined;
    const abort = await this.#issuerAbort(operation);
    return abort ? { operationId: operation.identity.operationId, abort } : undefined;
  }

  async #issuerAbort(
    operation: NonNullable<Awaited<ReturnType<DeviceLifecycleJournal["state"]>>>,
  ): Promise<DeviceLifecycleAbort | undefined> {
    if (operation.identity.kind !== "executor-removal") {
      throw new Error("Device removal issuer abort requires an executor-removal identity");
    }
    const effect = [...operation.peerEffects].reverse().find((item) => item.kind === "issuer-abort");
    const evidence = effect?.evidence.filter((item) => item.artifact);
    if (!effect) return undefined;
    if (evidence?.length !== 1 || !evidence[0]?.artifact) {
      throw new Error("Device removal issuer abort is missing its durable command");
    }
    const bytes = await this.options.store.artifactStore().get(evidence[0].artifact);
    let parsed: unknown;
    try {
      const text = Buffer.from(bytes).toString("utf8");
      parsed = JSON.parse(text);
      if (canonicalize(parsed) !== text) throw new TypeError("abort is not canonical");
    } catch (error) {
      throw new Error("Device removal issuer abort is corrupt", { cause: error });
    }
    const abort = validateDeviceLifecycleAbort(parsed, this.options.verifier);
    assertAbortIdentity(abort, operation.identity);
    if (protocolDigest("ExecutorRemovalIssuerAbort", 1, abort) !== effect.digest) {
      throw new Error("Device removal issuer abort digest is invalid");
    }
    return abort;
  }

  async #commitRevocation(
    identity: ExecutorRemovalLifecycleIdentity,
  ): Promise<ExecutorRemovalReceipt> {
    const log = this.options.store.authorityLog();
    const result = await log.transactProjection<RemovalAuthorityProjection, unknown, {
      readonly receipt: ExecutorRemovalReceipt;
      readonly trustRecord: HomeTrustRecord;
    }>(
      {
        trustEvents: [],
        exposures: [],
        lifecycle: emptyDeviceLifecycleProjection(),
      },
      (state, entry) => {
        if (entry.stream === "trust" && isTrustRecord(entry.body)) {
          return entry.body.t === "home-trust-event"
            ? { ...state, trustEvents: [...state.trustEvents, entry.body.event] }
            : state;
        }
        if (entry.stream === "exposure" && isExposureRecord(entry.body)) {
          return { ...state, exposures: [...state.exposures, entry.body] };
        }
        if (entry.stream === "device-lifecycle") {
          return {
            ...state,
            lifecycle: reduceDeviceLifecycleProjection(
              state.lifecycle,
              entry.body,
              this.options.verifier,
            ),
          };
        }
        return state;
      },
      (state, context) => {
        const operation = state.lifecycle.operations.get(identity.operationId);
        if (!operation || operation.identity.kind !== "executor-removal") {
          throw new Error("Removal revocation lost its lifecycle operation");
        }
        if (operation.phase === "revoked") {
          const trust = replayTrustChain(state.trustEvents);
          return {
            kind: "return",
            value: {
              receipt: terminalReceiptFromState(
                identity,
                operation.evidence,
                state.trustEvents,
                this.options.issuerKey,
              ),
              trustRecord: buildHomeTrustRecord(trust, this.options.issuerKey),
            },
          };
        }
        if (operation.phase !== "revocation-ready") {
          throw new Error("Removal revocation requires a durable ready receipt");
        }
        const current = replayTrustChain(state.trustEvents);
        if (current.issuer.deviceId !== this.options.issuerKey.deviceId) {
          throw new Error("Device removal issuer is no longer current");
        }
        if (!state.trustEvents.some((event) =>
          homeTrustEventDigest(event) === identity.acceptedTrustHeadDigest)) {
          throw new Error("Accepted device removal trust head is not an ancestor");
        }
        const member = current.members.find((candidate) =>
          candidate.device.deviceId === identity.targetDeviceId);
        if (
          !member ||
          member.state !== "active" ||
          member.device.publicKey !== identity.targetMemberPublicKey ||
          deviceKeyGeneration(member.device) !== identity.targetDeviceKeyGeneration
        ) {
          throw new Error("Device removal target membership changed after acceptance");
        }
        const revoke = createSignedTrustEvent({
          current,
          body: {
            t: "revoke",
            deviceId: identity.targetDeviceId,
            reason: "device-removed",
          },
          at: context.at,
          signer: this.options.issuerKey,
        });
        const nextTrust = applyTrustEvent(current, revoke);
        const trustRecord = buildHomeTrustRecord(nextTrust, this.options.issuerKey);
        const activeExposures = projectCredentialExposures(state.exposures).records
          .filter((record) =>
            record.deviceId === identity.targetDeviceId && record.state === "active");
        const compromised = activeExposures.map((record) => Object.freeze({
          ...record,
          state: "compromised" as const,
          markedAt: context.at,
          rotationHint: record.rotationHint ?? "Rotate this external account credential",
        }));
        const trustDigest = homeTrustEventDigest(revoke);
        const exposureDigest = protocolDigest("CredentialExposureBatch", 1, compromised);
        const evidence = [
          { kind: "trust-event" as const, digest: trustDigest },
          { kind: "credential-exposure" as const, digest: exposureDigest },
        ];
        const lifecycleRecord = validateDeviceLifecycleRecord({
          v: 1,
          t: "advanced",
          operationId: identity.operationId,
          phase: "revoked",
          evidence,
        });
        reduceDeviceLifecycleProjection(
          state.lifecycle,
          lifecycleRecord,
          this.options.verifier,
        );
        const receipt = createSignedExecutorRemovalReceipt({
          v: 1,
          operationId: identity.operationId,
          homeId: identity.homeId,
          targetDeviceId: identity.targetDeviceId,
          targetDeviceKeyGeneration: identity.targetDeviceKeyGeneration,
          acceptedIssuerDeviceId: identity.acceptedIssuerDeviceId,
          acceptedTrustHeadDigest: identity.acceptedTrustHeadDigest,
          phase: "revoked",
          evidenceDigest: terminalEvidenceDigest(trustDigest, exposureDigest),
          at: context.at,
        }, this.options.issuerKey);
        return {
          kind: "append",
          entries: [
            { stream: "trust", body: { t: "home-trust-event", event: revoke } },
            { stream: "trust", body: { t: "home-trust-record", record: trustRecord } },
            ...compromised.map((body) => ({ stream: "exposure", body })),
            { stream: "device-lifecycle", body: lifecycleRecord },
          ],
          value: { receipt, trustRecord },
        };
      },
      { streams: ["trust", "exposure", "device-lifecycle"] },
    );
    await this.options.secretStore.delete({
      kind: "rendezvous",
      bindingId: identity.targetDeviceId,
    });
    await this.options.onTrustCommitted?.(result.value.trustRecord);
    return result.value.receipt;
  }

  async #revokedReceipt(
    identity: ExecutorRemovalLifecycleIdentity,
  ): Promise<ExecutorRemovalReceipt> {
    const operation = await this.#journal.state(identity.operationId);
    if (!operation || operation.phase !== "revoked") {
      throw new Error("Device removal has no revoked terminal receipt");
    }
    return terminalReceiptFromState(
      identity,
      operation.evidence,
      await this.options.store.loadTrustEvents(),
      this.options.issuerKey,
    );
  }

  async #removedReceipt(
    identity: ExecutorRemovalLifecycleIdentity,
    requestedPhase?: "removed" | "lost",
  ): Promise<ExecutorRemovalReceipt> {
    const operation = await this.#journal.state(identity.operationId);
    if (!operation || operation.phase !== "terminal") {
      throw new Error("Device removal has no durable issuer terminal");
    }
    const trustDigest = [...operation.evidence].reverse().find((item) => item.kind === "trust-event")?.digest;
    const cleanupDigest = [...operation.evidence].reverse().find((item) => item.kind === "cleanup")?.digest;
    if (!trustDigest || !cleanupDigest) throw new Error("Device removal terminal evidence is incomplete");
    const events = await this.options.store.loadTrustEvents();
    const revoke = events.find((event) => homeTrustEventDigest(event) === trustDigest);
    if (!revoke || revoke.body.t !== "revoke" || revoke.body.deviceId !== identity.targetDeviceId) {
      throw new Error("Device removal terminal has no exact trust event");
    }
    const phase = requestedPhase ?? (
      cleanupDigest === protocolDigest("LostExecutorLocalData", 1, {
        operationId: identity.operationId,
        state: "unknown",
      }) ? "lost" : "removed"
    );
    return createSignedExecutorRemovalReceipt({
      v: 1,
      operationId: identity.operationId,
      homeId: identity.homeId,
      targetDeviceId: identity.targetDeviceId,
      targetDeviceKeyGeneration: identity.targetDeviceKeyGeneration,
      acceptedIssuerDeviceId: identity.acceptedIssuerDeviceId,
      acceptedTrustHeadDigest: identity.acceptedTrustHeadDigest,
      phase,
      evidenceDigest: protocolDigest("ExecutorRemovalRemovedTerminal", 1, {
        operationId: identity.operationId,
        trustDigest,
        cleanupDigest,
        phase,
      }),
      at: revoke.at,
    }, this.options.issuerKey);
  }
}

export class ExecutorRemovalTarget {
  readonly #journal: DeviceLifecycleJournal;

  constructor(private readonly options: {
    readonly log: FileAuthorityCommitLog;
    readonly homeId: string;
    readonly deviceKey: DeviceKey;
    readonly verifier: ProtocolSignatureVerifier;
    readonly localOwner?: LocalConversationOwnerAssembly;
    readonly captureExternalAcceptedWork?: (
      operationId: string,
    ) => Promise<LocalConversationRemovalSnapshot["ownerItems"]>;
    readonly closeAdmission: (operationId: string) => Promise<void>;
    readonly settleAcceptedWork: (input: {
      readonly operationId: string;
      readonly mode: "transfer" | "destroy";
      readonly ownerItems: LocalConversationRemovalSnapshot["ownerItems"];
    }) => Promise<void>;
    readonly releaseAdmission: (operationId: string) => Promise<void>;
    readonly transferToAnchor: (
      operationId: string,
      currentAnchorDeviceId: string,
      conversationIds: readonly string[],
    ) => Promise<void>;
    readonly cleanup: (operationId: string) => Promise<readonly DeviceLifecycleEvidenceRef[]>;
    readonly finalizeDeviceKey: (
      operationId: string,
      identity: ExecutorRemovalLifecycleIdentity,
    ) => Promise<readonly DeviceLifecycleEvidenceRef[]>;
    readonly onRemoved?: (operationId: string) => void | Promise<void>;
    readonly now?: () => string;
  }) {
    this.#journal = new DeviceLifecycleJournal(options.log, options.verifier);
  }

  async accept(receiptInput: ExecutorRemovalReceipt): Promise<LocalConversationRemovalSnapshot> {
    const receipt = validateExecutorRemovalReceipt(receiptInput, this.options.verifier);
    if (
      receipt.phase !== "accepted" ||
      receipt.signature.keyId !== receipt.acceptedIssuerDeviceId ||
      receipt.homeId !== this.options.homeId ||
      receipt.targetDeviceId !== this.options.deviceKey.deviceId ||
      receipt.targetDeviceKeyGeneration !== deviceKeyGeneration({
        deviceId: this.options.deviceKey.deviceId,
        publicKey: this.options.deviceKey.publicKey,
      })
    ) {
      throw new Error("Removal receipt does not bind this target device");
    }
    const identity: ExecutorRemovalLifecycleIdentity = Object.freeze({
      v: 1,
      kind: "executor-removal",
      requestId: `target:${receipt.operationId}`,
      operationId: receipt.operationId,
      homeId: receipt.homeId,
      targetDeviceId: receipt.targetDeviceId,
      targetMemberPublicKey: this.options.deviceKey.publicKey,
      targetDeviceKeyGeneration: receipt.targetDeviceKeyGeneration,
      acceptedIssuerDeviceId: receipt.acceptedIssuerDeviceId,
      acceptedTrustHeadDigest: receipt.acceptedTrustHeadDigest,
    });
    const operation = await this.#journal.accept(identity);
    if (operation.phase === "aborted") {
      throw new Error("Device removal was cancelled before target preflight");
    }
    const snapshot = await this.#acceptedWorkSnapshot(identity.operationId, false);
    await this.#recordPreflight(identity.operationId, snapshot);
    return snapshot;
  }

  async decide(input: {
    readonly operationId: string;
    readonly mode: "transfer" | "destroy";
    readonly currentAnchorDeviceId: string;
  }): Promise<ExecutorRemovalTargetDecision> {
    let operation = await this.#journal.state(input.operationId);
    if (!operation || operation.identity.kind !== "executor-removal") {
      throw new Error("Device removal target has not accepted this operation");
    }
    const identity = operation.identity;
    const existing = await this.#decision(operation);
    let decision = existing;
    if (!decision) {
      const preflight = await this.#preflight(operation);
      if (!preflight) throw new Error("Device removal must complete effect-free preflight first");
      await this.options.closeAdmission(identity.operationId);
      let snapshot: LocalConversationRemovalSnapshot;
      try {
        snapshot = await this.#acceptedWorkSnapshot(input.operationId, true);
      } catch (error) {
        this.options.localOwner?.releaseDeviceRemovalFreeze(input.operationId);
        await this.options.releaseAdmission(input.operationId);
        throw error;
      }
      const snapshotDigest = protocolDigest("ExecutorRemovalPreflightSnapshot", 1, snapshot);
      if (snapshotDigest !== preflight.digest) {
        try {
          await this.#recordPreflight(input.operationId, snapshot);
        } finally {
          this.options.localOwner?.releaseDeviceRemovalFreeze(input.operationId);
          await this.options.releaseAdmission(input.operationId);
        }
        return Object.freeze({ kind: "preflight-changed", snapshot });
      }
      if (operation.phase === "accepted") {
        operation = await this.#journal.advance(input.operationId, "gate-frozen", [{
          kind: "accepted-work",
          digest: preflight.ref.digest,
          artifact: preflight.ref,
        }]);
      }
      decision = Object.freeze({
        v: 1,
        t: "executor-removal-decision",
        operationId: input.operationId,
        homeId: this.options.homeId,
        targetDeviceId: this.options.deviceKey.deviceId,
        mode: input.mode,
        currentAnchorDeviceId: input.currentAnchorDeviceId,
        conversations: snapshot.conversations,
        acceptedWork: snapshot.acceptedWork,
        ownerItems: snapshot.ownerItems,
        snapshotDigest,
        decidedAt: this.options.now?.() ?? new Date().toISOString(),
      });
      const ref = await this.options.log.artifactStore.put(
        encodeExecutorRemovalDecision(decision),
      );
      try {
        operation = await this.#journal.advance(input.operationId, "authority-decided", [{
          kind: "accepted-work",
          digest: ref.digest,
          artifact: ref,
        }]);
      } catch (error) {
        const winner = await this.#journal.state(input.operationId);
        if (winner?.phase === "aborted") {
          this.options.localOwner?.releaseDeviceRemovalFreeze(input.operationId);
          await this.options.releaseAdmission(input.operationId);
          throw new Error("Device removal was cancelled before its durable decision", { cause: error });
        }
        throw error;
      }
    } else if (
      decision.mode !== input.mode ||
      decision.currentAnchorDeviceId !== input.currentAnchorDeviceId
    ) {
      throw new Error("Device removal decision conflicts with its durable replay");
    }
    if (operation.phase === "authority-decided") {
      const ownerItems = decision.ownerItems;
      if (!ownerItems) {
        throw new Error("Device removal decision is missing its frozen owner exact-set");
      }
      const conversationIds = decision.conversations.map((item) => item.conversationId);
      if (decision.mode === "transfer") {
        if (conversationIds.length > 0) {
          await this.options.transferToAnchor(
            input.operationId,
            decision.currentAnchorDeviceId,
            conversationIds,
          );
        }
      } else if (this.options.localOwner) {
        await this.options.localOwner.destroyFrozenConversations(
          input.operationId,
          conversationIds,
        );
      }
      await this.options.localOwner?.assertDeviceRemovalSettled(
        input.operationId,
        decision.mode,
        ownerItems,
      );
      await this.options.settleAcceptedWork({
        operationId: input.operationId,
        mode: decision.mode,
        ownerItems,
      });
      operation = await this.#journal.advance(input.operationId, "authority-settled", [{
        kind: decision.mode === "transfer" ? "authority-transfer" : "authority-deletion",
        digest: protocolDigest("ExecutorRemovalAuthoritySettlement", 1, decision),
      }]);
    }
    if (operation.phase === "authority-settled") {
      operation = await this.#journal.advance(input.operationId, "revocation-ready", [{
        kind: "accepted-work",
        digest: protocolDigest("ExecutorRemovalReady", 1, decision),
      }]);
    }
    return Object.freeze({
      kind: "ready",
      receipt: await this.#readyReceipt(operation, decision),
    });
  }

  async finish(receiptInput: ExecutorRemovalReceipt): Promise<ExecutorRemovalReceipt | undefined> {
    const receipt = validateExecutorRemovalReceipt(receiptInput, this.options.verifier);
    const operation = await this.#journal.state(receipt.operationId);
    if (!operation || operation.identity.kind !== "executor-removal") {
      throw new Error("Device removal target operation is unknown");
    }
    const identity = operation.identity;
    assertReceiptIdentity(receipt, identity);
    if (
      !new Set(["revoked", "removed"]).has(receipt.phase) ||
      receipt.signature.keyId !== receipt.acceptedIssuerDeviceId
    ) {
      throw new Error("Device cleanup requires the current issuer's authenticated receipt");
    }
    let current = operation;
    if (receipt.phase === "revoked" && current.phase === "revocation-ready") {
      current = await this.#journal.peerEffect(receipt.operationId, {
        kind: "issuer-revoked",
        digest: protocolDigest("ExecutorRemovalIssuerRevoked", 1, receipt),
        evidence: [{ kind: "trust-event", digest: receipt.evidenceDigest }],
      });
      current = await this.#journal.advance(receipt.operationId, "revoked", [{
        kind: "trust-event",
        digest: receipt.evidenceDigest,
      }]);
    }
    if (receipt.phase === "revoked" && current.phase === "revoked") {
      const evidence = await this.options.cleanup(receipt.operationId);
      current = await this.#journal.advance(receipt.operationId, "cleanup-complete", evidence);
    }
    if (receipt.phase === "revoked" && current.phase === "cleanup-complete") {
      const replay = await this.#receiptFromPeerEffect(current, "target-cleanup-ready");
      if (replay) return replay;
      const cleanupDigest = protocolDigest("ExecutorRemovalCleanupReady", 1, current.evidence);
      const ready = createSignedExecutorRemovalReceipt({
        v: 1,
        operationId: identity.operationId,
        homeId: identity.homeId,
        targetDeviceId: identity.targetDeviceId,
        targetDeviceKeyGeneration: identity.targetDeviceKeyGeneration,
        acceptedIssuerDeviceId: identity.acceptedIssuerDeviceId,
        acceptedTrustHeadDigest: identity.acceptedTrustHeadDigest,
        phase: "cleanup-ready",
        evidenceDigest: cleanupDigest,
        at: this.options.now?.() ?? new Date().toISOString(),
      }, this.options.deviceKey);
      const readyRef = await this.options.log.artifactStore.put(
        Buffer.from(canonicalize(ready), "utf8"),
      );
      await this.#journal.peerEffect(receipt.operationId, {
        kind: "target-cleanup-ready",
        digest: protocolDigest("ExecutorRemovalCleanupReadyReceipt", 1, ready),
        evidence: [{ kind: "cleanup", digest: readyRef.digest, artifact: readyRef }],
      });
      return ready;
    }
    if (receipt.phase === "removed" && current.phase === "cleanup-complete") {
      current = await this.#journal.peerEffect(receipt.operationId, {
        kind: "issuer-terminal",
        digest: protocolDigest("ExecutorRemovalIssuerTerminalReceipt", 1, receipt),
        evidence: [],
      });
      const keyEvidence = await this.options.finalizeDeviceKey(receipt.operationId, operation.identity);
      await this.#journal.terminal(receipt.operationId, "removed", keyEvidence);
      await this.options.onRemoved?.(receipt.operationId);
    }
    return undefined;
  }

  async resumeWithIssuer(issuer: {
    ready(receipt: ExecutorRemovalReceipt): Promise<ExecutorRemovalReceipt>;
    cleanupReady(receipt: ExecutorRemovalReceipt): Promise<ExecutorRemovalReceipt>;
    terminal(operationId: string): Promise<ExecutorRemovalReceipt | undefined>;
  }): Promise<void> {
    for (const operation of await this.#journal.operations()) {
      if (operation.identity.kind !== "executor-removal") continue;
      if (
        operation.phase === "authority-decided" ||
        operation.phase === "authority-settled" ||
        operation.phase === "revocation-ready"
      ) {
        const decision = await this.#decision(operation);
        if (!decision) throw new Error("Active device removal is missing its durable decision");
        const result = await this.decide({
          operationId: operation.identity.operationId,
          mode: decision.mode,
          currentAnchorDeviceId: decision.currentAnchorDeviceId,
        });
        if (result.kind === "preflight-changed") continue;
        const ready = result.receipt;
        const cleanupReady = await this.finish(await issuer.ready(ready));
        if (cleanupReady) await this.finish(await issuer.cleanupReady(cleanupReady));
        continue;
      }
      if (operation.phase === "revoked" || operation.phase === "cleanup-complete") {
        const cleanupReady = await this.#receiptFromPeerEffect(operation, "target-cleanup-ready");
        if (cleanupReady) {
          await this.finish(await issuer.cleanupReady(cleanupReady));
          continue;
        }
        const terminal = await issuer.terminal(operation.identity.operationId);
        if (terminal) await this.finish(terminal);
      }
    }
  }

  async resumeBeforeAdmission(): Promise<void> {
    for (const operationId of await this.restoreLocalAdmissionGate()) {
      await this.options.closeAdmission(operationId);
    }
  }

  async restoreLocalAdmissionGate(): Promise<readonly string[]> {
    const active: string[] = [];
    for (let operation of await this.#journal.operations()) {
      if (
        operation.identity.kind !== "executor-removal" ||
        operation.phase === "terminal" ||
        operation.phase === "aborted"
      ) {
        continue;
      }
      if (operation.phase === "accepted") continue;
      active.push(operation.identity.operationId);
      const preflight = await this.#preflight(operation);
      if (!preflight) throw new Error("Active device removal is missing its durable preflight");
      if (this.options.localOwner) {
        await this.options.localOwner.freezeForDeviceRemoval(
          operation.identity.operationId,
          preflight.digest,
        );
      }
    }
    return Object.freeze(active);
  }

  async abort(operationId: string, abort: DeviceLifecycleAbort): Promise<ExecutorRemovalReceipt> {
    let operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "executor-removal") {
      throw new Error("Device removal target operation is unknown");
    }
    const requested = validateDeviceLifecycleAbort(abort, this.options.verifier);
    assertAbortIdentity(requested, operation.identity);
    let aborted;
    let replay: ExecutorRemovalReceipt | undefined;
    if (operation.phase === "aborted") {
      aborted = await this.#journal.abort(operationId, requested);
      replay = await this.#receiptFromPeerEffect(aborted, "target-aborted");
    } else if (phaseOrder(operation.phase) >= phaseOrder("authority-decided")) {
      const decision = await this.#decision(operation);
      if (!decision) throw new Error("Irreversible device removal is missing its durable decision");
      return this.#readyReceipt(operation, decision);
    } else {
      try {
        aborted = await this.#journal.abort(operationId, requested);
      } catch (error) {
        operation = await this.#journal.state(operationId);
        if (
          operation?.identity.kind === "executor-removal" &&
          phaseOrder(operation.phase) >= phaseOrder("authority-decided")
        ) {
          const decision = await this.#decision(operation);
          if (!decision) throw new Error("Irreversible device removal is missing its durable decision");
          return this.#readyReceipt(operation, decision);
        }
        throw error;
      }
    }
    const durableAbort = aborted.abort;
    if (!durableAbort) throw new Error("Device removal target abort was not durably projected");
    this.options.localOwner?.releaseDeviceRemovalFreeze(operationId);
    await this.options.releaseAdmission(operationId);
    if (replay) return replay;
    const identity = operation.identity;
    const receipt = createSignedExecutorRemovalReceipt({
      v: 1,
      operationId: identity.operationId,
      homeId: identity.homeId,
      targetDeviceId: identity.targetDeviceId,
      targetDeviceKeyGeneration: identity.targetDeviceKeyGeneration,
      acceptedIssuerDeviceId: identity.acceptedIssuerDeviceId,
      acceptedTrustHeadDigest: identity.acceptedTrustHeadDigest,
      phase: "aborted",
      evidenceDigest: protocolDigest("ExecutorRemovalTargetAborted", 1, durableAbort),
      at: durableAbort.at,
    }, this.options.deviceKey);
    const receiptRef = await this.options.log.artifactStore.put(
      Buffer.from(canonicalize(receipt), "utf8"),
    );
    await this.#journal.peerEffect(operationId, {
      kind: "target-aborted",
      digest: protocolDigest("ExecutorRemovalTargetAbortedReceipt", 1, receipt),
      evidence: [{ kind: "accepted-work", digest: receiptRef.digest, artifact: receiptRef }],
    });
    return receipt;
  }

  async #readyReceipt(
    operation: NonNullable<Awaited<ReturnType<DeviceLifecycleJournal["state"]>>>,
    decision: ExecutorRemovalDecision,
  ): Promise<ExecutorRemovalReceipt> {
    if (operation.identity.kind !== "executor-removal") {
      throw new Error("Device removal ready receipt requires an executor-removal identity");
    }
    const identity = operation.identity;
    return createSignedExecutorRemovalReceipt({
      v: 1,
      operationId: identity.operationId,
      homeId: identity.homeId,
      targetDeviceId: identity.targetDeviceId,
      targetDeviceKeyGeneration: identity.targetDeviceKeyGeneration,
      acceptedIssuerDeviceId: identity.acceptedIssuerDeviceId,
      acceptedTrustHeadDigest: identity.acceptedTrustHeadDigest,
      phase: "revocation-ready",
      evidenceDigest: protocolDigest("ExecutorRemovalReady", 1, decision),
      at: decision.decidedAt,
    }, this.options.deviceKey);
  }

  async #acceptedWorkSnapshot(
    operationId: string,
    freeze: boolean,
  ): Promise<LocalConversationRemovalSnapshot> {
    const local = this.options.localOwner
      ? freeze
        ? await this.options.localOwner.freezeForDeviceRemoval(operationId)
        : await this.options.localOwner.preflightForDeviceRemoval(operationId)
      : emptyRemovalSnapshot(operationId);
    const external = await this.options.captureExternalAcceptedWork?.(operationId) ?? [];
    const ownerItems = Object.freeze([...local.ownerItems, ...external].sort((left, right) =>
      `${left.owner}:${left.id}`.localeCompare(`${right.owner}:${right.id}`, "en-US")));
    return Object.freeze({
      ...local,
      acceptedWork: Object.freeze({
        ...local.acceptedWork,
        active: local.acceptedWork.active + external.length,
      }),
      ownerItems,
    });
  }

  async #recordPreflight(
    operationId: string,
    snapshot: LocalConversationRemovalSnapshot,
  ): Promise<void> {
    const digest = protocolDigest("ExecutorRemovalPreflightSnapshot", 1, snapshot);
    const ref = await this.options.log.artifactStore.put(
      Buffer.from(canonicalize(snapshot), "utf8"),
    );
    await this.#journal.peerEffect(operationId, {
      kind: "preflight",
      digest,
      evidence: [{ kind: "accepted-work", digest: ref.digest, artifact: ref }],
    });
  }

  async state(operationId: string): Promise<ExecutorRemovalPublicState | undefined> {
    const operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "executor-removal") return undefined;
    const decision = await this.#decision(operation);
    const preflight = decision ? undefined : await this.#preflight(operation);
    return publicRemovalState(operation.phase, decision, preflight?.snapshot);
  }

  async #preflight(
    operation: NonNullable<Awaited<ReturnType<DeviceLifecycleJournal["state"]>>>,
  ): Promise<{
    readonly digest: string;
    readonly ref: NonNullable<DeviceLifecycleEvidenceRef["artifact"]>;
    readonly snapshot: LocalConversationRemovalSnapshot;
  } | undefined> {
    const effect = [...operation.peerEffects].reverse().find((item) => item.kind === "preflight");
    const evidence = effect?.evidence.find((item) => item.kind === "accepted-work" && item.artifact);
    if (!effect || !evidence?.artifact) return undefined;
    const snapshot = decodeRemovalSnapshot(
      await this.options.log.artifactStore.get(evidence.artifact),
      operation.identity.operationId,
    );
    if (protocolDigest("ExecutorRemovalPreflightSnapshot", 1, snapshot) !== effect.digest) {
      throw new Error("Executor removal preflight digest does not match its durable artifact");
    }
    return { digest: effect.digest, ref: evidence.artifact, snapshot };
  }

  async #receiptFromPeerEffect(
    operation: NonNullable<Awaited<ReturnType<DeviceLifecycleJournal["state"]>>>,
    kind: "target-aborted" | "target-cleanup-ready",
  ): Promise<ExecutorRemovalReceipt | undefined> {
    const effect = [...operation.peerEffects].reverse().find((item) => item.kind === kind);
    const ref = effect?.evidence.find((item) => item.artifact)?.artifact;
    if (!effect || !ref) return undefined;
    const bytes = await this.options.log.artifactStore.get(ref);
    let parsed: unknown;
    try {
      const text = Buffer.from(bytes).toString("utf8");
      parsed = JSON.parse(text);
      if (canonicalize(parsed) !== text) throw new TypeError("receipt is not canonical");
    } catch (error) {
      throw new Error("Executor removal peer receipt is corrupt", { cause: error });
    }
    const receipt = validateExecutorRemovalReceipt(parsed, this.options.verifier);
    if (operation.identity.kind !== "executor-removal") {
      throw new Error("Executor removal peer receipt has an incompatible operation identity");
    }
    assertReceiptIdentity(receipt, operation.identity);
    if (protocolDigest(kind === "target-aborted"
      ? "ExecutorRemovalTargetAbortedReceipt"
      : "ExecutorRemovalCleanupReadyReceipt", 1, receipt) !== effect.digest) {
      throw new Error("Executor removal peer receipt digest is invalid");
    }
    return receipt;
  }

  async #decision(
    operation: Awaited<ReturnType<DeviceLifecycleJournal["state"]>>,
  ): Promise<ExecutorRemovalDecision | undefined> {
    return operation ? loadExecutorRemovalLifecycleDecision(this.options.log, operation) : undefined;
  }
}

export async function loadExecutorRemovalLifecycleDecision(
  log: FileAuthorityCommitLog,
  operation: DeviceLifecycleOperation,
): Promise<ExecutorRemovalDecision | undefined> {
  if (phaseOrder(operation.phase) < phaseOrder("authority-decided")) return undefined;
  for (const evidence of operation.evidence) {
    if (!evidence.artifact) continue;
    const bytes = await log.artifactStore.get(evidence.artifact);
    let parsed: unknown;
    try {
      const text = Buffer.from(bytes).toString("utf8");
      parsed = JSON.parse(text);
      if (canonicalize(parsed) !== text) throw new TypeError("artifact is not canonical");
    } catch (error) {
      throw new Error("Executor removal evidence artifact is corrupt", { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      (parsed as { t?: unknown }).t !== "executor-removal-decision") continue;
    const decision = decodeExecutorRemovalDecision(bytes);
    if (
      operation.identity.kind !== "executor-removal" ||
      decision.operationId !== operation.identity.operationId ||
      decision.homeId !== operation.identity.homeId ||
      decision.targetDeviceId !== operation.identity.targetDeviceId
    ) {
      throw new Error("Executor removal decision does not bind its lifecycle operation");
    }
    return decision;
  }
  return undefined;
}

export async function cleanupRemovedDeviceSecrets(input: {
  readonly store: SecretStorePort;
  readonly deviceKey: DeviceKey;
  readonly preserveDeviceKey?: boolean;
}): Promise<readonly DeviceLifecycleEvidenceRef[]> {
  const refs = await input.store.list("");
  const deviceKeyBinding = `device/v1/${input.deviceKey.deviceId}`;
  const removable = refs
    .filter((ref) => !(ref.kind === "device-key" && ref.bindingId === deviceKeyBinding))
    .sort((left, right) => `${left.kind}:${left.bindingId}`.localeCompare(
      `${right.kind}:${right.bindingId}`,
      "en-US",
    ));
  for (let offset = 0; offset < removable.length; offset += 128) {
    for (const ref of removable.slice(offset, offset + 128)) {
      await input.store.delete(ref);
      if (await input.store.get(ref) !== null) {
        throw new Error("Removed device retained a secret after deletion");
      }
    }
  }
  if (!input.preserveDeviceKey) {
    await deleteDeviceKey(input.store, input.deviceKey.deviceId);
  }
  return [{
    kind: "cleanup",
    digest: protocolDigest("RemovedDeviceSecretCleanup", 1, {
      deviceId: input.deviceKey.deviceId,
      refs: refs.map((ref) => ({ kind: ref.kind, bindingId: ref.bindingId })).sort((a, b) =>
        `${a.kind}:${a.bindingId}`.localeCompare(`${b.kind}:${b.bindingId}`, "en-US")),
    }),
  }];
}

function deviceKeyGeneration(device: {
  readonly deviceId: string;
  readonly publicKey: string;
}): string {
  return protocolDigest("DeviceKeyGeneration", 1, {
    deviceId: device.deviceId,
    publicKey: device.publicKey,
  });
}

function acceptedReceiptTime(trust: ReturnType<typeof replayTrustChain>): string {
  const member = trust.members.find((item) => item.device.deviceId === trust.issuer.deviceId);
  return member?.device.enrolledAt ?? new Date(0).toISOString();
}

function assertReceiptIdentity(
  receipt: ExecutorRemovalReceipt,
  identity: ExecutorRemovalLifecycleIdentity,
): void {
  if (
    receipt.operationId !== identity.operationId ||
    receipt.homeId !== identity.homeId ||
    receipt.targetDeviceId !== identity.targetDeviceId ||
    receipt.targetDeviceKeyGeneration !== identity.targetDeviceKeyGeneration ||
    receipt.acceptedIssuerDeviceId !== identity.acceptedIssuerDeviceId ||
    receipt.acceptedTrustHeadDigest !== identity.acceptedTrustHeadDigest
  ) {
    throw new Error("Executor removal receipt changes the accepted identity");
  }
}

function assertAbortIdentity(
  abort: DeviceLifecycleAbort,
  identity: ExecutorRemovalLifecycleIdentity,
): void {
  if (
    abort.operationId !== identity.operationId ||
    abort.homeId !== identity.homeId ||
    abort.subjectDeviceId !== identity.targetDeviceId ||
    abort.authorizedByDeviceId !== identity.acceptedIssuerDeviceId
  ) {
    throw new Error("Executor removal abort changes the accepted identity");
  }
}

function phaseOrder(phase: string): number {
  return [
    "accepted",
    "gate-frozen",
    "authority-decided",
    "authority-settled",
    "revocation-ready",
    "revoked",
    "cleanup-complete",
    "terminal",
    "aborted",
  ].indexOf(phase);
}

function terminalEvidenceDigest(trustDigest: string, exposureDigest: string): string {
  return protocolDigest("ExecutorRemovalTerminalEvidence", 1, {
    trustDigest,
    exposureDigest,
  });
}

function terminalReceiptFromState(
  identity: ExecutorRemovalLifecycleIdentity,
  evidence: readonly DeviceLifecycleEvidenceRef[],
  events: readonly HomeTrustEvent[],
  issuerKey: DeviceKey,
): ExecutorRemovalReceipt {
  const trustDigest = [...evidence].reverse().find((item) => item.kind === "trust-event")?.digest;
  const exposureDigest = [...evidence].reverse().find((item) => item.kind === "credential-exposure")?.digest;
  if (!trustDigest || !exposureDigest) {
    throw new Error("Revoked removal operation has incomplete terminal evidence");
  }
  const revoke = events.find((event) => homeTrustEventDigest(event) === trustDigest);
  if (!revoke || revoke.body.t !== "revoke" || revoke.body.deviceId !== identity.targetDeviceId) {
    throw new Error("Revoked removal operation has no exact trust event");
  }
  return createSignedExecutorRemovalReceipt({
    v: 1,
    operationId: identity.operationId,
    homeId: identity.homeId,
    targetDeviceId: identity.targetDeviceId,
    targetDeviceKeyGeneration: identity.targetDeviceKeyGeneration,
    acceptedIssuerDeviceId: identity.acceptedIssuerDeviceId,
    acceptedTrustHeadDigest: identity.acceptedTrustHeadDigest,
    phase: "revoked",
    evidenceDigest: terminalEvidenceDigest(trustDigest, exposureDigest),
    at: revoke.at,
  }, issuerKey);
}

function isTrustRecord(input: unknown): input is TrustStreamRecord {
  return !!input && typeof input === "object" &&
    ((input as { t?: unknown }).t === "home-trust-event" ||
      (input as { t?: unknown }).t === "home-trust-record");
}

function isExposureRecord(input: unknown): input is CredentialExposureRecord {
  return !!input && typeof input === "object" &&
    typeof (input as { deviceId?: unknown }).deviceId === "string" &&
    typeof (input as { bindingId?: unknown }).bindingId === "string" &&
    new Set(["active", "compromised", "rotated"])
      .has((input as { state?: unknown }).state as string);
}

function emptyRemovalSnapshot(operationId: string): LocalConversationRemovalSnapshot {
  return Object.freeze({
    operationId,
    conversations: Object.freeze([]),
    acceptedWork: Object.freeze({
      active: 0,
      pendingFinals: 0,
      pendingAssignments: 0,
      deferredIntents: 0,
      outbox: 0,
      leases: 0,
      permits: 0,
    }),
    ownerItems: Object.freeze([]),
  });
}

function publicRemovalState(
  phase: string,
  decision: ExecutorRemovalDecision | undefined,
  preflight?: LocalConversationRemovalSnapshot,
): ExecutorRemovalPublicState {
  const conversations = (decision?.conversations ?? preflight?.conversations ?? [])
    .map((item) => item.displayName);
  if (phase === "aborted") {
    return { phase: "cancelled", conversations, localData: "known", credentialActions: [] };
  }
  if (phase === "terminal") {
    return { phase: "removed", conversations: [], localData: "removed", credentialActions: [] };
  }
  if (phase === "revoked" || phase === "cleanup-complete") {
    return { phase: "cleaning-device", conversations, localData: "known", credentialActions: [] };
  }
  if (phase === "revocation-ready") {
    return { phase: "revoking-access", conversations, localData: "known", credentialActions: [] };
  }
  if (phase === "authority-decided" || phase === "authority-settled") {
    return { phase: "moving-conversations", conversations, localData: "known", credentialActions: [] };
  }
  return {
    phase: decision ? "moving-conversations" : "needs-conversation-decision",
    conversations,
    localData: "known",
    credentialActions: [],
  };
}

function decodeRemovalSnapshot(
  input: Uint8Array,
  operationId: string,
): LocalConversationRemovalSnapshot {
  let parsed: unknown;
  try {
    const text = Buffer.from(input).toString("utf8");
    parsed = JSON.parse(text);
    if (canonicalize(parsed) !== text) throw new TypeError("snapshot is not canonical");
  } catch (error) {
    throw new Error("Executor removal preflight artifact is corrupt", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Executor removal preflight must be an object");
  }
  const value = parsed as Record<string, unknown>;
  assertExactKeys(value, ["acceptedWork", "conversations", "operationId", "ownerItems"], "Executor removal preflight");
  if (value.operationId !== operationId || !Array.isArray(value.conversations) || !Array.isArray(value.ownerItems)) {
    throw new TypeError("Executor removal preflight identity is invalid");
  }
  const conversations = value.conversations.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`Executor removal preflight conversation ${index} is invalid`);
    }
    const item = entry as Record<string, unknown>;
    assertExactKeys(item, ["conversationId", "displayName", "state"], `Executor removal preflight conversation ${index}`);
    if (
      typeof item.conversationId !== "string" ||
      typeof item.displayName !== "string" ||
      !new Set(["current", "frozen", "importing"]).has(item.state as string)
    ) throw new TypeError(`Executor removal preflight conversation ${index} is invalid`);
    return item as unknown as LocalConversationRemovalSnapshot["conversations"][number];
  });
  if (!value.acceptedWork || typeof value.acceptedWork !== "object" || Array.isArray(value.acceptedWork)) {
    throw new TypeError("Executor removal accepted work is invalid");
  }
  const acceptedWork = value.acceptedWork as Record<string, unknown>;
  const acceptedKeys = ["active", "deferredIntents", "leases", "outbox", "pendingAssignments", "pendingFinals", "permits"];
  assertExactKeys(acceptedWork, acceptedKeys, "Executor removal accepted work");
  for (const key of acceptedKeys) {
    if (!Number.isSafeInteger(acceptedWork[key]) || (acceptedWork[key] as number) < 0) {
      throw new TypeError(`Executor removal accepted work ${key} is invalid`);
    }
  }
  const ownerItems = value.ownerItems.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`Executor removal owner item ${index} is invalid`);
    }
    const item = entry as Record<string, unknown>;
    assertExactKeys(item, ["id", "owner", "revision"], `Executor removal owner item ${index}`);
    if (
      !new Set([
        "conversation",
        "intent",
        "final",
        "assignment",
        "remote",
        "channel",
        "scheduler",
        "delivery",
        "lease",
        "permit",
      ]).has(item.owner as string) ||
      typeof item.id !== "string" ||
      typeof item.revision !== "string"
    ) throw new TypeError(`Executor removal owner item ${index} is invalid`);
    return item as unknown as LocalConversationRemovalSnapshot["ownerItems"][number];
  });
  return Object.freeze({
    operationId,
    conversations: Object.freeze(conversations),
    acceptedWork: Object.freeze(acceptedWork) as unknown as LocalConversationRemovalSnapshot["acceptedWork"],
    ownerItems: Object.freeze(ownerItems),
  });
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (canonicalize(Object.keys(value).sort()) !== canonicalize([...keys].sort())) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}
import { Buffer } from "node:buffer";
