import type {
  HomeTrustEvent,
  HomeTrustRecord,
  SecretStorePort,
} from "@zhixing/core/contracts";
import {
  DEVICE_LIFECYCLE_PROJECTION_ID,
  DeviceLifecycleJournal,
  readDeviceLifecycleOperation,
  type FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import {
  createSignedDeviceLifecycleAbort,
  canonicalize,
  createSignedExecutorRemovalReceipt,
  decodeExecutorRemovalDecision,
  encodeExecutorRemovalDecision,
  protocolDigest,
  reduceDeviceLifecycle,
  validateDeviceLifecycleRecord,
  validateDeviceLifecycleAbort,
  validateExecutorRemovalReceipt,
  verifyProtocolStep,
  type DeviceLifecycleEvidenceRef,
  type DeviceLifecycleOperation,
  type DeviceLifecycleAbort,
  type ExecutorRemovalDecision,
  type ExecutorRemovalLifecycleIdentity,
  type ExecutorRemovalReceipt,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import type { MeshEndpointDescriptor, SecretRef } from "@zhixing/core/contracts";
import {
  assertTerminalRouteSecret,
  createTerminalRouteSecret,
  deriveTerminalRouteLocator,
  isTerminalRouteLocator,
  terminalRouteDigest,
  validateMeshEndpointDescriptor,
} from "@zhixing/mesh/bootstrap";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import { deleteDeviceKey, deleteDeviceKeyExact } from "@zhixing/mesh/device-key-store";
import type { TrustedMeshPeer } from "@zhixing/mesh/handshake";
import {
  applyTrustEvent,
  buildHomeTrustRecord,
  createSignedTrustEvent,
  CURRENT_TRUST_PROJECTION_ID,
  homeTrustEventDigest,
  readCurrentTrust,
  readTrustEventByDigest,
  replayTrustChain,
} from "@zhixing/mesh/trust-chain";
import {
  CREDENTIAL_EXPOSURE_PROJECTION_ID,
  credentialExposureIndex,
  readExposureRecords,
} from "@zhixing/mesh/credential-exposure";
import type { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { loadExistingDeviceKey } from "./mesh-device-key.js";
import type {
  LocalConversationOwnerAssembly,
  LocalConversationRemovalSnapshot,
} from "./local-conversation-owner.js";


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
    // 终态定位在接受时绑定，先于把 accepted 回执交给 target。
    await this.#bindTerminalRoute(operation.identity);
    this.options.onGuardChanged?.(identity.targetDeviceId, identity.operationId);
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

  /**
   * 本 operation 的终态路由材料，只经已认证、绑定本次移除的 accept 通道交给 target。
   * 定位由 issuer 终态路由秘密派生，重复调用得到同一值；中止后不再提供。
   */
  async terminalRoute(operationId: string): Promise<ExecutorRemovalTerminalRoute> {
    const operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "executor-removal" || operation.phase === "aborted") {
      throw new Error("Device removal has no live terminal route");
    }
    return this.#bindTerminalRoute(operation.identity);
  }

  /** 终态入口按定位精确解析：未知、已中止或不是本 issuer 接受的移除都查不到。 */
  async operationForRoute(locator: string): Promise<ExecutorRemovalLifecycleIdentity | undefined> {
    if (!isTerminalRouteLocator(locator)) return undefined;
    const operation = await this.#journal.removalForRoute(terminalRouteDigest(locator));
    if (
      !operation ||
      operation.identity.kind !== "executor-removal" ||
      operation.identity.acceptedIssuerDeviceId !== this.options.issuerKey.deviceId
    ) {
      return undefined;
    }
    return operation.identity;
  }

  async #bindTerminalRoute(identity: ExecutorRemovalLifecycleIdentity): Promise<ExecutorRemovalTerminalRoute> {
    const secret = await loadOrCreateIssuerTerminalRouteSecret(
      this.options.secretStore,
      this.options.issuerKey.deviceId,
    );
    const locator = deriveTerminalRouteLocator(secret, identity.operationId);
    await this.#journal.peerEffect(identity.operationId, {
      kind: "terminal-route",
      digest: terminalRouteDigest(locator),
      evidence: [],
    });
    return Object.freeze({ locator, secret });
  }

  /**
   * 目标设备能否使用移除相关的终端专用服务：它最后一个未中止的移除存在（终结的也算）。
   * 访问时按目标设备精确读一条，不在启动时预装已移除的设备。
   */
  async authorizesTarget(deviceId: string): Promise<boolean> {
    return (await this.#journal.lastRemovalFor(deviceId)) !== undefined;
  }

  /** 启动只恢复未终结的移除：移除守卫与待重提的撤销；读取随未终结移除数，与已终结的历史无关。 */
  async resumeActive(): Promise<void> {
    for (const operation of await this.#journal.activeOfKind("executor-removal")) {
      if (operation.identity.kind !== "executor-removal") continue;
      const identity = operation.identity;
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
    return (await this.#operationStateForTarget(targetDeviceId))?.identity as
      | ExecutorRemovalLifecycleIdentity
      | undefined;
  }

  async publicStateForTarget(
    targetDeviceId: string,
  ): Promise<ExecutorRemovalPublicState | undefined> {
    const operation = await this.#operationStateForTarget(targetDeviceId);
    return operation ? publicIssuerRemovalState(operation) : undefined;
  }

  async #operationStateForTarget(
    targetDeviceId: string,
  ): Promise<DeviceLifecycleOperation | undefined> {
    const operations = (await this.#journal.activeFor(targetDeviceId))
      .filter((operation) =>
        operation.identity.kind === "executor-removal" &&
        operation.identity.targetDeviceId === targetDeviceId,
      );
    const active = operations.filter((operation) =>
      operation.phase !== "terminal" && operation.phase !== "aborted");
    if (active.length > 1) {
      throw new Error("Paired device has conflicting active removal operations");
    }
    return active[0] ?? await this.#journal.latest("executor-removal", targetDeviceId);
  }

  async commitReady(input: ExecutorRemovalReceipt): Promise<ExecutorRemovalReceipt> {
    // 目标的签名身份未必常驻（例如已撤销、值班设备刚重启）：在验签边界内校验，未载入的身份按 keyId 精确补齐；
    // 授权仍由该 operation 的生命周期绑定裁决
    const ready = await verifyProtocolStep(() => validateExecutorRemovalReceipt(input, this.options.verifier));
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
    // 目标的签名身份未必常驻（例如已撤销、值班设备刚重启）：在验签边界内校验，未载入的身份按 keyId 精确补齐；
    // 授权仍由该 operation 的生命周期绑定裁决
    const ready = await verifyProtocolStep(() => validateExecutorRemovalReceipt(input, this.options.verifier));
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
    // 目标的签名身份未必常驻（例如已撤销、值班设备刚重启）：在验签边界内校验，未载入的身份按 keyId 精确补齐；
    // 授权仍由该 operation 的生命周期绑定裁决
    const receipt = await verifyProtocolStep(() => validateExecutorRemovalReceipt(input, this.options.verifier));
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
  }

  async commitLost(operationId: string): Promise<ExecutorRemovalReceipt> {
    let operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "executor-removal") {
      throw new Error("Lost-device removal operation is unknown");
    }
    const identity = operation.identity;
    if (operation.phase === "terminal") return this.#removedReceipt(identity);
    if (operation.phase === "aborted") throw new Error("Lost-device removal was cancelled before its durable decision");
    // 每一步按当前阶段续做：重复调用与停在任一阶段后的重驱都走同一条路，结果相同
    const cleanupDigest = protocolDigest("LostExecutorLocalData", 1, { operationId, state: "unknown" });
    if (phaseOrder(operation.phase) < phaseOrder("revoked")) {
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
      operation = revoked;
    }
    if (operation.phase === "revoked") {
      operation = await this.#journal.advance(operationId, "cleanup-complete", [{
        kind: "cleanup",
        digest: cleanupDigest,
      }]);
    }
    if (operation.phase === "cleanup-complete") {
      // 终结证据单独构造，与正常路径同一口径：由清理摘要派生一条，不沿用各阶段累加的证据
      await this.#journal.terminal(operationId, "removed", [{
        kind: "cleanup",
        digest: protocolDigest("ExecutorRemovalIssuerTerminalEvidence", 1, { operationId, cleanupDigest }),
      }]);
    }
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
    const operations = (await this.#journal.activeFor(targetDeviceId)).filter((operation) =>
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
    // 已撤销的重驱（启动恢复）：撤销与信任记录早已耐久，只重做幂等的秘密删除并精确取回回执
    if ((await this.#journal.state(identity.operationId))?.phase === "revoked") {
      await this.options.secretStore.delete({ kind: "rendezvous", bindingId: identity.targetDeviceId });
      return this.#revokedReceipt(identity);
    }
    const log = this.options.store.authorityLog();
    // 同一锁定前缀上：生命周期按 operation、当前信任按链头与 active 目录、祖先按事件摘要、凭据暴露按目标设备，
    // 都是精确读，不重放任何流；下一份签名快照只列 active 成员，读取随当前成员数。
    credentialExposureIndex(log);
    const result = await log.transactDurableProjection<unknown, {
      readonly receipt: ExecutorRemovalReceipt;
      readonly trustRecord?: HomeTrustRecord;
    }>(
      DEVICE_LIFECYCLE_PROJECTION_ID,
      async (lifecycle, context) => {
        const operation = await readDeviceLifecycleOperation(lifecycle, identity.operationId);
        if (!operation || operation.identity.kind !== "executor-removal") {
          throw new Error("Removal revocation lost its lifecycle operation");
        }
        const trustView = context.readProjection(CURRENT_TRUST_PROJECTION_ID);
        if (operation.phase === "revoked") {
          // 并发撤销已先提交：按证据精确取回回执，信任记录由那次提交方发布
          const trustDigest = [...operation.evidence].reverse().find((item) => item.kind === "trust-event")?.digest;
          return {
            kind: "return",
            value: {
              receipt: terminalReceiptFromState(
                identity,
                operation.evidence,
                trustDigest ? await readTrustEventByDigest(trustView, trustDigest) : undefined,
                this.options.issuerKey,
              ),
            },
          };
        }
        if (operation.phase !== "revocation-ready") {
          throw new Error("Removal revocation requires a durable ready receipt");
        }
        const current = await readCurrentTrust(trustView);
        if (!current) throw new Error("Device removal has no current trust projection");
        if (current.issuer.deviceId !== this.options.issuerKey.deviceId) {
          throw new Error("Device removal issuer is no longer current");
        }
        if (!await readTrustEventByDigest(trustView, identity.acceptedTrustHeadDigest)) {
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
        const activeExposures = await readExposureRecords(
          context.readProjection(CREDENTIAL_EXPOSURE_PROJECTION_ID),
          { state: "active", deviceId: identity.targetDeviceId },
        );
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
        reduceDeviceLifecycle(operation, lifecycleRecord, this.options.verifier);
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
      { readProjectionIds: [CURRENT_TRUST_PROJECTION_ID, CREDENTIAL_EXPOSURE_PROJECTION_ID] },
    );
    await this.options.secretStore.delete({
      kind: "rendezvous",
      bindingId: identity.targetDeviceId,
    });
    if (result.value.trustRecord) await this.options.onTrustCommitted?.(result.value.trustRecord);
    return result.value.receipt;
  }

  async #revokedReceipt(
    identity: ExecutorRemovalLifecycleIdentity,
  ): Promise<ExecutorRemovalReceipt> {
    const operation = await this.#journal.state(identity.operationId);
    if (!operation || operation.phase !== "revoked") {
      throw new Error("Device removal has no revoked terminal receipt");
    }
    // 只按证据里的撤销事件摘要精确读这一条，不整读信任流
    return terminalReceiptFromState(
      identity,
      operation.evidence,
      await this.#revocationEvent(identity, operation.evidence),
      this.options.issuerKey,
    );
  }

  async #revocationEvent(
    identity: ExecutorRemovalLifecycleIdentity,
    evidence: readonly DeviceLifecycleEvidenceRef[],
  ): Promise<HomeTrustEvent> {
    const trustDigest = [...evidence].reverse().find((item) => item.kind === "trust-event")?.digest;
    if (!trustDigest) throw new Error("Device removal has no durable revocation evidence");
    const revoke = await this.options.store.trustEventByDigest(trustDigest);
    if (!revoke || revoke.body.t !== "revoke" || revoke.body.deviceId !== identity.targetDeviceId) {
      throw new Error("Device removal has no exact revocation trust event");
    }
    return revoke;
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
    const revoke = await this.#revocationEvent(identity, operation.evidence);
    // 失联移除：最后一条 cleanup 证据是失联清理摘要，或由它派生的终结证据（与正常路径同一口径）
    const lostCleanup = protocolDigest("LostExecutorLocalData", 1, {
      operationId: identity.operationId,
      state: "unknown",
    });
    const lost = cleanupDigest === lostCleanup || cleanupDigest === protocolDigest("ExecutorRemovalIssuerTerminalEvidence", 1, {
      operationId: identity.operationId,
      cleanupDigest: lostCleanup,
    });
    const phase = requestedPhase ?? (lost ? "lost" : "removed");
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
  #completion: Promise<void> = Promise.resolve();

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
    /** 本机秘密存储：保存本操作终态路由秘密的副本，终结或中止后删除。 */
    readonly secretStore: SecretStorePort;
    /** accept 时冻结 issuer 的传输身份与端点，作为撤销后取回终态的恢复材料。 */
    readonly issuerRoute: (issuerDeviceId: string) => Promise<{
      readonly peer: TrustedMeshPeer;
      readonly endpoint: MeshEndpointDescriptor;
    }>;
  }) {
    this.#journal = new DeviceLifecycleJournal(options.log, options.verifier);
  }

  async accept(
    receiptInput: ExecutorRemovalReceipt,
    routeInput: ExecutorRemovalTerminalRoute,
  ): Promise<LocalConversationRemovalSnapshot> {
    const route = validateExecutorRemovalTerminalRoute(routeInput);
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
    // 撤销之后取回终态所需的材料先于回复 accept 耐久。
    await this.#recordTerminalRoute(operation, route);
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
    // 没有耐久的终态路由材料就不产生 revocation-ready：撤销之后必须还能取回终态。
    if (!operation.peerEffects.some((effect) => effect.kind === "terminal-route")) {
      throw new Error("Device removal target has no durable terminal route");
    }
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

  /**
   * 撤销之后的本机收尾串行执行：内联请求与专用取回同时续做时按序进行，每一步按已存阶段幂等。
   * 不用 SerialTaskQueue：本机清理里的存储维护步骤要按原期限等待，不能被标成零等待互斥区。
   */
  finish(receiptInput: ExecutorRemovalReceipt): Promise<ExecutorRemovalReceipt | undefined> {
    const run = this.#completion.then(() => this.#finish(receiptInput));
    this.#completion = run.then(() => undefined, () => undefined);
    return run;
  }

  async #finish(receiptInput: ExecutorRemovalReceipt): Promise<ExecutorRemovalReceipt | undefined> {
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
      // 终态依据连同回执本身耐久之后才删钥：此后重启可在本机核验并完成，不再联网。
      const receiptRef = await this.options.log.artifactStore.put(
        Buffer.from(canonicalize(receipt), "utf8"),
      );
      current = await this.#journal.peerEffect(receipt.operationId, {
        kind: "issuer-terminal",
        digest: protocolDigest("ExecutorRemovalIssuerTerminalReceipt", 1, receipt),
        evidence: [{ kind: "cleanup", digest: receiptRef.digest, artifact: receiptRef }],
      });
      const keyEvidence = await this.options.finalizeDeviceKey(receipt.operationId, operation.identity);
      // 路由副本在本机 terminal 之前删除：删失败时操作仍未终结，重驱或启动结算会再删一次
      await deleteTargetTerminalRouteSecret(this.options.secretStore, receipt.operationId);
      await this.#journal.terminal(receipt.operationId, "removed", keyEvidence);
      await this.options.onRemoved?.(receipt.operationId);
    }
    return undefined;
  }

  /** 本机这次移除是否已写本机 terminal。 */
  async isRetired(operationId: string): Promise<boolean> {
    return (await this.#journal.state(operationId))?.phase === "terminal";
  }

  /** 本机已进入撤销阶段、还没终结的那次移除；读取随本机未终结的生命周期操作数。 */
  async revokingOperation(): Promise<string | undefined> {
    for (const operation of await this.#journal.activeFor(this.options.deviceKey.deviceId)) {
      if (
        operation.identity.kind === "executor-removal" &&
        operation.identity.targetDeviceId === this.options.deviceKey.deviceId &&
        phaseOrder(operation.phase) >= phaseOrder("revocation-ready")
      ) {
        return operation.identity.operationId;
      }
    }
    return undefined;
  }

  /**
   * 已耐久 issuer 终态回执、本机还没终结时，凭这份回执在本机完成，不联网：
   * 删钥、删路由副本、写本机 terminal。没有耐久回执返回 false。
   */
  async finishFromDurableTerminal(operationId: string): Promise<boolean> {
    const operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "executor-removal" || operation.phase !== "cleanup-complete") {
      return false;
    }
    const effect = operation.peerEffects.find((item) => item.kind === "issuer-terminal");
    const ref = effect?.evidence.find((item) => item.artifact)?.artifact;
    if (!effect || !ref) return false;
    const receipt = decodeIssuerTerminalReceipt(await this.options.log.artifactStore.get(ref), this.options.verifier);
    if (protocolDigest("ExecutorRemovalIssuerTerminalReceipt", 1, receipt) !== effect.digest) {
      throw new Error("Device removal issuer terminal receipt does not match its durable record");
    }
    await this.finish(receipt);
    return this.isRetired(operationId);
  }

  /** 撤销之后的专用取回所需的恢复材料：accept 时冻结的定位、issuer 身份与端点，加本机秘密副本。 */
  async terminalRecovery(operationId: string): Promise<ExecutorRemovalTerminalRecovery> {
    const operation = await this.#journal.state(operationId);
    if (!operation || operation.identity.kind !== "executor-removal") {
      throw new Error("Device removal target operation is unknown");
    }
    return loadExecutorRemovalTerminalRecovery(this.options.log, operation, this.options.secretStore);
  }

  async #recordTerminalRoute(
    operation: DeviceLifecycleOperation,
    route: ExecutorRemovalTerminalRoute,
  ): Promise<void> {
    if (operation.identity.kind !== "executor-removal") {
      throw new Error("Device removal terminal route requires an executor-removal identity");
    }
    const identity = operation.identity;
    const digest = terminalRouteDigest(route.locator);
    const effect = operation.peerEffects.find((item) => item.kind === "terminal-route");
    if (effect && effect.digest !== digest) {
      throw new Error("Device removal terminal route changed on replay");
    }
    const ref = targetTerminalRouteRef(identity.operationId);
    const existing = await this.options.secretStore.get(ref);
    if (existing !== null && existing !== route.secret) {
      throw new Error("Device removal terminal route secret changed on replay");
    }
    if (existing === null) {
      await this.options.secretStore.put(ref, route.secret);
      if (await this.options.secretStore.get(ref) !== route.secret) {
        throw new Error("Device removal terminal route secret did not survive durable read-back");
      }
    }
    if (effect) return;
    const issuer = await this.options.issuerRoute(identity.acceptedIssuerDeviceId);
    const material: ExecutorRemovalTerminalRouteArtifact = {
      v: 1,
      t: "executor-removal-terminal-route",
      operationId: identity.operationId,
      locator: route.locator,
      issuer: issuer.peer,
      endpoint: issuer.endpoint,
    };
    decodeTerminalRouteArtifact(Buffer.from(canonicalize(material), "utf8"), identity);
    const artifact = await this.options.log.artifactStore.put(
      Buffer.from(canonicalize(material), "utf8"),
    );
    await this.#journal.peerEffect(identity.operationId, {
      kind: "terminal-route",
      digest,
      evidence: [{ kind: "cleanup", digest: artifact.digest, artifact }],
    });
  }

  async resumeWithIssuer(issuer: {
    ready(receipt: ExecutorRemovalReceipt): Promise<ExecutorRemovalReceipt>;
    cleanupReady(receipt: ExecutorRemovalReceipt): Promise<ExecutorRemovalReceipt>;
    terminal(operationId: string): Promise<ExecutorRemovalReceipt | undefined>;
  }): Promise<void> {
    for (const operation of await this.#journal.activeFor(this.options.deviceKey.deviceId)) {
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
        if (terminal) {
          await this.finish(terminal);
          continue;
        }
        // 撤销已记、清理或 cleanup-ready 尚未落盘：按同一 ready 取回 issuer 已存的撤销回执，续做本机清理。
        const decision = await this.#decision(operation);
        if (!decision) throw new Error("Revoked device removal is missing its durable decision");
        const next = await this.finish(await issuer.ready(await this.#readyReceipt(operation, decision)));
        if (next) await this.finish(await issuer.cleanupReady(next));
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
    for (let operation of await this.#journal.activeFor(this.options.deviceKey.deviceId)) {
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
    await deleteTargetTerminalRouteSecret(this.options.secretStore, operationId);
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
  // 设备密钥与本机移除的终态路由副本留到本机终结：撤销之后还要凭它们取回终态。
  const removable = refs
    .filter((ref) => !(ref.kind === "device-key" && ref.bindingId === deviceKeyBinding))
    .filter((ref) => !isTargetTerminalRouteRef(ref))
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

/**
 * 终态入口的窄解析：定位 → removal-route 精确读出 operation → 目标设备的传输身份精确读，
 * 公钥与冻结的密钥代际必须一致；未知、中止或换代都返回空，在 TLS 之前拒绝。
 */
export async function resolveExecutorRemovalTerminalRoute(
  input: {
    readonly authority: Pick<CurrentIssuerDeviceRemovalAuthority, "operationForRoute">;
    readonly transportPeer: (deviceId: string) => Promise<TrustedMeshPeer | undefined>;
  },
  locator: string,
): Promise<{ readonly peer: TrustedMeshPeer; readonly binding: string } | undefined> {
  const identity = await input.authority.operationForRoute(locator);
  if (!identity) return undefined;
  const peer = await input.transportPeer(identity.targetDeviceId);
  if (
    !peer ||
    peer.identity.deviceId !== identity.targetDeviceId ||
    peer.identity.publicKey !== identity.targetMemberPublicKey ||
    deviceKeyGeneration(peer.identity) !== identity.targetDeviceKeyGeneration
  ) {
    return undefined;
  }
  return Object.freeze({ peer, binding: identity.operationId });
}

/** issuer 交给 target 的终态路由材料：定位与终态路由秘密。 */
export interface ExecutorRemovalTerminalRoute {
  readonly locator: string;
  readonly secret: string;
}

/** target 撤销之后取回终态所需的全部材料。 */
export interface ExecutorRemovalTerminalRecovery {
  readonly operationId: string;
  readonly locator: string;
  readonly secret: string;
  readonly issuer: TrustedMeshPeer;
  readonly endpoint: MeshEndpointDescriptor;
}

interface ExecutorRemovalTerminalRouteArtifact {
  readonly v: 1;
  readonly t: "executor-removal-terminal-route";
  readonly operationId: string;
  readonly locator: string;
  readonly issuer: TrustedMeshPeer;
  readonly endpoint: MeshEndpointDescriptor;
}

export function validateExecutorRemovalTerminalRoute(value: unknown): ExecutorRemovalTerminalRoute {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    canonicalize(Object.keys(value).sort()) !== canonicalize(["locator", "secret"])
  ) {
    throw new TypeError("Device removal terminal route shape is invalid");
  }
  const route = value as Record<string, unknown>;
  if (!isTerminalRouteLocator(route.locator) || typeof route.secret !== "string") {
    throw new TypeError("Device removal terminal route is invalid");
  }
  assertTerminalRouteSecret(route.secret);
  return Object.freeze({ locator: route.locator, secret: route.secret });
}

function issuerTerminalRouteRef(deviceId: string): SecretRef {
  return { kind: "terminal-route", bindingId: `issuer/${deviceId}` };
}

function targetTerminalRouteRef(operationId: string): SecretRef {
  const digest = protocolDigest("ExecutorRemovalTerminalRouteRef", 1, { operationId });
  return { kind: "terminal-route", bindingId: `removal/${digest.slice("sha256:".length)}` };
}

export function isTargetTerminalRouteRef(ref: SecretRef): boolean {
  return ref.kind === "terminal-route" && ref.bindingId.startsWith("removal/");
}

/** issuer 自有的终态路由秘密：首次需要时生成并回读，此后长期保留，不随成员撤销删除。 */
export async function loadOrCreateIssuerTerminalRouteSecret(
  store: SecretStorePort,
  deviceId: string,
): Promise<string> {
  const ref = issuerTerminalRouteRef(deviceId);
  let secret = store.getOrCreate
    ? await store.getOrCreate(ref, createTerminalRouteSecret)
    : await store.get(ref);
  if (secret === null) {
    secret = createTerminalRouteSecret();
    await store.put(ref, secret);
  }
  assertTerminalRouteSecret(secret);
  if (await store.get(ref) !== secret) {
    throw new Error("Terminal route secret did not survive durable read-back");
  }
  return secret;
}

async function deleteTargetTerminalRouteSecret(store: SecretStorePort, operationId: string): Promise<void> {
  const ref = targetTerminalRouteRef(operationId);
  await store.delete(ref);
  if (await store.get(ref) !== null) {
    throw new Error("Removed device retained its terminal route secret");
  }
}

function decodeTerminalRouteArtifact(
  bytes: Uint8Array,
  identity: ExecutorRemovalLifecycleIdentity,
): ExecutorRemovalTerminalRouteArtifact {
  let value: unknown;
  try {
    const text = Buffer.from(bytes).toString("utf8");
    value = JSON.parse(text);
    if (canonicalize(value) !== text) throw new TypeError("terminal route artifact is not canonical");
  } catch (error) {
    throw new Error("Executor removal terminal route artifact is corrupt", { cause: error });
  }
  const record = value as Record<string, unknown>;
  if (
    !record || typeof record !== "object" || Array.isArray(record) ||
    canonicalize(Object.keys(record).sort()) !==
      canonicalize(["endpoint", "issuer", "locator", "operationId", "t", "v"]) ||
    record.v !== 1 || record.t !== "executor-removal-terminal-route" ||
    record.operationId !== identity.operationId || !isTerminalRouteLocator(record.locator)
  ) {
    throw new Error("Executor removal terminal route artifact does not bind its operation");
  }
  const issuer = record.issuer as TrustedMeshPeer;
  if (
    !issuer || typeof issuer !== "object" || !issuer.identity ||
    issuer.identity.deviceId !== identity.acceptedIssuerDeviceId ||
    typeof issuer.rootCertificatePem !== "string"
  ) {
    throw new Error("Executor removal terminal route artifact does not bind the accepted issuer");
  }
  const endpoint = validateMeshEndpointDescriptor(record.endpoint);
  if (endpoint.deviceId !== identity.acceptedIssuerDeviceId) {
    throw new Error("Executor removal terminal route endpoint is not the accepted issuer");
  }
  return Object.freeze({
    v: 1,
    t: "executor-removal-terminal-route",
    operationId: identity.operationId,
    locator: record.locator,
    issuer,
    endpoint,
  });
}

async function loadExecutorRemovalTerminalRecovery(
  log: FileAuthorityCommitLog,
  operation: DeviceLifecycleOperation,
  store: SecretStorePort,
): Promise<ExecutorRemovalTerminalRecovery> {
  if (operation.identity.kind !== "executor-removal") {
    throw new Error("Device removal terminal recovery requires an executor-removal identity");
  }
  const identity = operation.identity;
  const effect = operation.peerEffects.find((item) => item.kind === "terminal-route");
  const ref = effect?.evidence.find((item) => item.artifact)?.artifact;
  if (!effect || !ref) throw new Error("Device removal target has no durable terminal route");
  const material = decodeTerminalRouteArtifact(await log.artifactStore.get(ref), identity);
  if (terminalRouteDigest(material.locator) !== effect.digest) {
    throw new Error("Device removal terminal route digest does not match its artifact");
  }
  const secret = await store.get(targetTerminalRouteRef(identity.operationId));
  if (secret === null) throw new Error("Device removal terminal route secret is missing");
  assertTerminalRouteSecret(secret);
  return Object.freeze({
    operationId: identity.operationId,
    locator: material.locator,
    secret,
    issuer: material.issuer,
    endpoint: material.endpoint,
  });
}

/**
 * 启动在普通身份与角色装配之前处理本机处于撤销阶段的移除：
 * 已有验签通过、反绑 operation 与代际的 issuer 终态回执，就按冻结代际删钥、写本机 terminal、删路由副本，
 * 零网络、不需私钥、不新建身份；没有就要求只运行专用取回。缺依据、坏签名、错 operation 一律失败关闭。
 */
export async function settleExecutorRemovalBeforeBootstrap(input: {
  readonly log: FileAuthorityCommitLog;
  readonly verifier: ProtocolSignatureVerifier;
  readonly secretStore: SecretStorePort;
}): Promise<
  | { readonly kind: "none" }
  | { readonly kind: "completed"; readonly operationId: string }
  | { readonly kind: "retrieval"; readonly operationId: string; readonly targetDeviceId: string }
> {
  const journal = new DeviceLifecycleJournal(input.log, input.verifier);
  const revoking = (await journal.activeOfKind("executor-removal")).filter((operation) =>
    operation.identity.kind === "executor-removal" &&
    operation.identity.requestId === `target:${operation.identity.operationId}` &&
    phaseOrder(operation.phase) >= phaseOrder("revocation-ready"));
  if (revoking.length > 1) throw new Error("This device has conflicting device removals");
  const operation = revoking[0];
  if (!operation || operation.identity.kind !== "executor-removal") return { kind: "none" };
  const identity = operation.identity;
  const effect = operation.peerEffects.find((item) => item.kind === "issuer-terminal");
  if (!effect) {
    return { kind: "retrieval", operationId: identity.operationId, targetDeviceId: identity.targetDeviceId };
  }
  const ref = effect.evidence.find((item) => item.artifact)?.artifact;
  if (!ref) throw new Error("Device removal issuer terminal has no durable receipt");
  const receipt = decodeIssuerTerminalReceipt(await input.log.artifactStore.get(ref), input.verifier);
  assertReceiptIdentity(receipt, identity);
  if (
    receipt.phase !== "removed" ||
    receipt.signature.keyId !== identity.acceptedIssuerDeviceId ||
    protocolDigest("ExecutorRemovalIssuerTerminalReceipt", 1, receipt) !== effect.digest
  ) {
    throw new Error("Device removal issuer terminal receipt does not bind this operation");
  }
  const keyEvidence = await deleteRemovedDeviceKeyGeneration(input.secretStore, identity);
  // 先删路由副本再写本机 terminal：删失败时下次启动仍会走到这里重做
  await deleteTargetTerminalRouteSecret(input.secretStore, identity.operationId);
  await journal.terminal(identity.operationId, "removed", keyEvidence);
  return { kind: "completed", operationId: identity.operationId };
}

function decodeIssuerTerminalReceipt(
  bytes: Uint8Array,
  verifier: ProtocolSignatureVerifier,
): ExecutorRemovalReceipt {
  let parsed: unknown;
  try {
    const text = Buffer.from(bytes).toString("utf8");
    parsed = JSON.parse(text);
    if (canonicalize(parsed) !== text) throw new TypeError("receipt is not canonical");
  } catch (error) {
    throw new Error("Device removal issuer terminal receipt is corrupt", { cause: error });
  }
  return validateExecutorRemovalReceipt(parsed, verifier);
}

/** 按 operation 冻结的代际精确删钥：钥已不在视为完成，换代的钥拒绝删除。 */
async function deleteRemovedDeviceKeyGeneration(
  store: SecretStorePort,
  identity: ExecutorRemovalLifecycleIdentity,
): Promise<readonly DeviceLifecycleEvidenceRef[]> {
  const existing = await loadExistingDeviceKey(store);
  if (existing) {
    if (
      existing.deviceId !== identity.targetDeviceId ||
      deviceKeyGeneration(existing) !== identity.targetDeviceKeyGeneration
    ) {
      throw new Error("Device removal key finalizer does not own the frozen key generation");
    }
    await deleteDeviceKeyExact(store, existing);
  }
  return [{
    kind: "cleanup",
    digest: protocolDigest("ExecutorRemovalDeviceKeyDeleted", 1, {
      operationId: identity.operationId,
      targetDeviceId: identity.targetDeviceId,
      targetDeviceKeyGeneration: identity.targetDeviceKeyGeneration,
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
  revoke: HomeTrustEvent | undefined,
  issuerKey: DeviceKey,
): ExecutorRemovalReceipt {
  const trustDigest = [...evidence].reverse().find((item) => item.kind === "trust-event")?.digest;
  const exposureDigest = [...evidence].reverse().find((item) => item.kind === "credential-exposure")?.digest;
  if (!trustDigest || !exposureDigest) {
    throw new Error("Revoked removal operation has incomplete terminal evidence");
  }
  if (!revoke || homeTrustEventDigest(revoke) !== trustDigest ||
      revoke.body.t !== "revoke" || revoke.body.deviceId !== identity.targetDeviceId) {
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

function publicIssuerRemovalState(
  operation: DeviceLifecycleOperation,
): ExecutorRemovalPublicState {
  if (operation.phase === "aborted") {
    return { phase: "cancelled", conversations: [], localData: "known", credentialActions: [] };
  }
  if (operation.phase === "terminal") {
    return {
      phase: "removed",
      conversations: [],
      localData: "unknown",
      credentialActions: ["Change credentials for accounts used on this device"],
    };
  }
  if (operation.peerEffects.some((effect) => effect.kind === "issuer-abort")) {
    return {
      phase: "waiting-for-device",
      conversations: [],
      localData: "known",
      credentialActions: ["取消已安全记录；目标设备上线后会自动恢复准入"],
    };
  }
  if (operation.phase === "revoked" || operation.phase === "cleanup-complete") {
    return { phase: "cleaning-device", conversations: [], localData: "known", credentialActions: [] };
  }
  if (operation.phase === "revocation-ready") {
    return { phase: "revoking-access", conversations: [], localData: "known", credentialActions: [] };
  }
  if (operation.phase === "authority-decided" || operation.phase === "authority-settled") {
    return { phase: "moving-conversations", conversations: [], localData: "known", credentialActions: [] };
  }
  return {
    phase: "needs-conversation-decision",
    conversations: [],
    localData: "known",
    credentialActions: ["移除已登记，可继续或取消"],
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
