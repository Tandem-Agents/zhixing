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
  createSignedExecutorRemovalReceipt,
  decodeExecutorRemovalDecision,
  emptyDeviceLifecycleProjection,
  encodeExecutorRemovalDecision,
  protocolDigest,
  reduceDeviceLifecycleProjection,
  validateDeviceLifecycleRecord,
  validateExecutorRemovalReceipt,
  type DeviceLifecycleEvidenceRef,
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
        operation.phase === "terminal" ||
        operation.phase === "aborted"
      ) {
        continue;
      }
      const identity = operation.identity;
      this.#authorizedTargets.set(identity.targetDeviceId, identity.operationId);
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
    if (operation.phase === "revoked") return this.#terminalReceipt(identity);
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
    if (!operation || operation.identity.kind !== "executor-removal" || operation.phase !== "revoked") {
      return undefined;
    }
    return this.#terminalReceipt(operation.identity);
  }

  async commitLost(operationId: string): Promise<ExecutorRemovalReceipt> {
    let operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "executor-removal") {
      throw new Error("Lost-device removal operation is unknown");
    }
    const identity = operation.identity;
    if (operation.phase === "revoked") return this.#terminalReceipt(identity);
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
    return this.#commitRevocation(identity);
  }

  async abort(operationId: string): Promise<DeviceLifecycleAbort> {
    const operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "executor-removal") {
      throw new Error("Device removal operation is unknown");
    }
    const abort = createSignedDeviceLifecycleAbort({
      v: 1,
      operationId,
      homeId: operation.identity.homeId,
      subjectDeviceId: operation.identity.targetDeviceId,
      authorizedByDeviceId: operation.identity.acceptedIssuerDeviceId,
      reason: "user-cancelled",
      at: this.options.now?.() ?? new Date().toISOString(),
    }, this.options.issuerKey);
    await this.#journal.abort(operationId, abort);
    this.options.onGuardChanged?.(operation.identity.targetDeviceId, undefined);
    this.#authorizedTargets.delete(operation.identity.targetDeviceId);
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

  async #terminalReceipt(
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
}

export class ExecutorRemovalTarget {
  readonly #journal: DeviceLifecycleJournal;

  constructor(private readonly options: {
    readonly log: FileAuthorityCommitLog;
    readonly homeId: string;
    readonly deviceKey: DeviceKey;
    readonly verifier: ProtocolSignatureVerifier;
    readonly localOwner?: LocalConversationOwnerAssembly;
    readonly closeAdmission: (operationId: string) => Promise<void>;
    readonly settleAcceptedWork: (operationId: string) => Promise<void>;
    readonly releaseAdmission: (operationId: string) => Promise<void>;
    readonly transferToAnchor: (
      operationId: string,
      currentAnchorDeviceId: string,
      conversationIds: readonly string[],
    ) => Promise<void>;
    readonly cleanup: (operationId: string) => Promise<readonly DeviceLifecycleEvidenceRef[]>;
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
    let operation = await this.#journal.accept(identity);
    await this.options.closeAdmission(identity.operationId);
    const snapshot = this.options.localOwner
      ? await this.options.localOwner.freezeForDeviceRemoval(identity.operationId)
      : emptyRemovalSnapshot(identity.operationId);
    if (operation.phase === "accepted") {
      operation = await this.#journal.advance(identity.operationId, "gate-frozen", [{
        kind: "accepted-work",
        digest: protocolDigest("ExecutorRemovalFrozenSnapshot", 1, snapshot),
      }]);
    }
    if (operation.phase === "aborted") {
      throw new Error("Device removal was cancelled before target preflight");
    }
    return snapshot;
  }

  async decide(input: {
    readonly operationId: string;
    readonly mode: "transfer" | "destroy";
    readonly currentAnchorDeviceId: string;
  }): Promise<ExecutorRemovalReceipt> {
    let operation = await this.#journal.state(input.operationId);
    if (!operation || operation.identity.kind !== "executor-removal") {
      throw new Error("Device removal target has not accepted this operation");
    }
    const identity = operation.identity;
    const existing = await this.#decision(operation);
    let decision = existing;
    if (!decision) {
      const snapshot = this.options.localOwner
        ? await this.options.localOwner.freezeForDeviceRemoval(input.operationId)
        : emptyRemovalSnapshot(input.operationId);
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
        decidedAt: this.options.now?.() ?? new Date().toISOString(),
      });
      const ref = await this.options.log.artifactStore.put(
        encodeExecutorRemovalDecision(decision),
      );
      operation = await this.#journal.advance(input.operationId, "authority-decided", [{
        kind: "accepted-work",
        digest: ref.digest,
        artifact: ref,
      }]);
    } else if (
      decision.mode !== input.mode ||
      decision.currentAnchorDeviceId !== input.currentAnchorDeviceId
    ) {
      throw new Error("Device removal decision conflicts with its durable replay");
    }
    if (operation.phase === "authority-decided") {
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
        conversationIds,
      );
      await this.options.settleAcceptedWork(input.operationId);
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

  async finish(receiptInput: ExecutorRemovalReceipt): Promise<void> {
    const receipt = validateExecutorRemovalReceipt(receiptInput, this.options.verifier);
    const operation = await this.#journal.state(receipt.operationId);
    if (!operation || operation.identity.kind !== "executor-removal") {
      throw new Error("Device removal target operation is unknown");
    }
    assertReceiptIdentity(receipt, operation.identity);
    if (receipt.phase !== "revoked" || receipt.signature.keyId !== receipt.acceptedIssuerDeviceId) {
      throw new Error("Device cleanup requires the current issuer's revoked receipt");
    }
    let current = operation;
    if (current.phase === "revocation-ready") {
      current = await this.#journal.advance(receipt.operationId, "revoked", [{
        kind: "trust-event",
        digest: receipt.evidenceDigest,
      }]);
    }
    if (current.phase === "revoked") {
      const evidence = await this.options.cleanup(receipt.operationId);
      current = await this.#journal.advance(receipt.operationId, "cleanup-complete", evidence);
    }
    if (current.phase === "cleanup-complete") {
      await this.#journal.terminal(receipt.operationId, "removed", current.evidence);
    }
    await this.options.onRemoved?.(receipt.operationId);
  }

  async resumeWithIssuer(issuer: {
    ready(receipt: ExecutorRemovalReceipt): Promise<ExecutorRemovalReceipt>;
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
        const ready = await this.decide({
          operationId: operation.identity.operationId,
          mode: decision.mode,
          currentAnchorDeviceId: decision.currentAnchorDeviceId,
        });
        await this.finish(await issuer.ready(ready));
        continue;
      }
      if (operation.phase === "revoked" || operation.phase === "cleanup-complete") {
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
      active.push(operation.identity.operationId);
      const snapshot = this.options.localOwner
        ? await this.options.localOwner.freezeForDeviceRemoval(operation.identity.operationId)
        : emptyRemovalSnapshot(operation.identity.operationId);
      if (operation.phase === "accepted") {
        operation = await this.#journal.advance(operation.identity.operationId, "gate-frozen", [{
          kind: "accepted-work",
          digest: protocolDigest("ExecutorRemovalFrozenSnapshot", 1, snapshot),
        }]);
      }
    }
    return Object.freeze(active);
  }

  async abort(operationId: string, abort: DeviceLifecycleAbort): Promise<void> {
    const operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "executor-removal") {
      throw new Error("Device removal target operation is unknown");
    }
    await this.#journal.abort(operationId, abort);
    this.options.localOwner?.releaseDeviceRemovalFreeze(operationId);
    await this.options.releaseAdmission(operationId);
  }

  async state(operationId: string): Promise<ExecutorRemovalPublicState | undefined> {
    const operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "executor-removal") return undefined;
    const decision = await this.#decision(operation);
    return publicRemovalState(operation.phase, decision);
  }

  async #decision(
    operation: Awaited<ReturnType<DeviceLifecycleJournal["state"]>>,
  ): Promise<ExecutorRemovalDecision | undefined> {
    if (!operation) return undefined;
    const ref = operation.evidence.find((item) => item.artifact)?.artifact;
    if (!ref) return undefined;
    const decision = decodeExecutorRemovalDecision(
      await this.options.log.artifactStore.get(ref),
    );
    if (
      decision.operationId !== operation.identity.operationId ||
      decision.homeId !== operation.identity.homeId ||
      operation.identity.kind !== "executor-removal" ||
      decision.targetDeviceId !== operation.identity.targetDeviceId
    ) {
      throw new Error("Executor removal decision does not bind its lifecycle operation");
    }
    return decision;
  }
}

export async function cleanupRemovedDeviceSecrets(input: {
  readonly store: SecretStorePort;
  readonly deviceKey: DeviceKey;
  readonly preserveDeviceKey?: boolean;
}): Promise<readonly DeviceLifecycleEvidenceRef[]> {
  const refs = await input.store.list("");
  const deviceKeyBinding = `device/v1/${input.deviceKey.deviceId}`;
  for (const ref of refs) {
    if (ref.kind === "device-key" && ref.bindingId === deviceKeyBinding) continue;
    await input.store.delete(ref);
    if (await input.store.get(ref) !== null) {
      throw new Error("Removed device retained a secret after deletion");
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
  });
}

function publicRemovalState(
  phase: string,
  decision: ExecutorRemovalDecision | undefined,
): ExecutorRemovalPublicState {
  const conversations = decision?.conversations.map((item) => item.displayName) ?? [];
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
