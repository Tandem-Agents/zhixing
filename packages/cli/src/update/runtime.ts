import { EMBEDDED_RELEASE_TRUST, STABLE_RELEASE_INDEX_URL } from "./release-channel.js";
import { createReleaseVerifier } from "./release-verifier.js";
import { ProgramStore } from "./program-store.js";
import {
  DURABLE_SCHEMA_INVENTORY,
  canonicalize,
  protocolDigest,
  type DeviceLifecycleOperation,
  type ProgramUpdateReceipt,
  type ProtocolSignatureVerifier,
  type ReleaseManifest,
} from "@zhixing/core/protocol";
import type { ProgramUpdateHealthSnapshot } from "@zhixing/server";
import type { MeshRuntimeBootstrap } from "../serve/mesh-runtime-bootstrap.js";
import {
  RpcProgramUpdateFacade,
  requestCurrentHostProgramUpdatePrepare,
  tryReadCurrentAuthorityProgramUpdateStatus,
} from "../runtime/rpc-program-update-facade.js";
import {
  projectProgramUpdate,
  StableUpdateController,
  type ProgramUpdateProjection,
} from "./update-controller.js";

const AUTOMATIC_CHECK_TIMEOUT_MS = 30_000;
const MANAGED_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

export interface UpdateRuntimeDeps {
  readonly store?: ProgramStore;
  readonly controller?: StableUpdateController;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
}

export function createInstalledUpdateController(
  store = new ProgramStore(),
): StableUpdateController | undefined {
  if (!STABLE_RELEASE_INDEX_URL || !EMBEDDED_RELEASE_TRUST) return undefined;
  return new StableUpdateController({
    store,
    verifier: createReleaseVerifier(EMBEDDED_RELEASE_TRUST),
    indexUrl: STABLE_RELEASE_INDEX_URL,
    handoffStaged: requestLocalUpgradeHandoff,
  });
}

export async function requestLocalUpgradeHandoff(
  candidateManifestDigest: string,
  signal?: AbortSignal,
): Promise<{ readonly operationId: string } | undefined> {
  if (signal?.aborted) throw signal.reason;
  return requestCurrentHostProgramUpdatePrepare(candidateManifestDigest, signal);
}

export async function verifyLocalUpgradeHealth(input: {
  readonly endpoint: { readonly host: string; readonly port: number };
  readonly token: string;
  readonly expected: ProgramUpdateHealthSnapshot;
}): Promise<string> {
  const rpc = new RpcProgramUpdateFacade({
    url: `ws://127.0.0.1:${input.endpoint.port}/ws`,
    token: input.token,
    timeoutMs: 30_000,
  });
  const actual = await rpc.health();
  if (canonicalize(actual) !== canonicalize(input.expected)) {
    throw new Error("Updated program health does not match its accepted runtime identity");
  }
  return protocolDigest("ProgramUpdateHealthSnapshot", 1, actual);
}

export function buildProgramUpdateHealthSnapshot(input: {
  readonly manifest: ReleaseManifest;
  readonly manifestDigest: string;
  readonly homeId: string;
  readonly endpoint: { readonly host: string; readonly port: number };
  readonly rolePlan: { readonly host: string; readonly loadExecutor: boolean };
  readonly trust: { readonly generation: number; readonly digest: string };
  readonly runtimeVersion?: string;
}): ProgramUpdateHealthSnapshot {
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.manifestDigest)) {
    throw new TypeError("Program health manifest digest is invalid");
  }
  if (
    !input.homeId || !input.endpoint.host ||
    !Number.isInteger(input.endpoint.port) || input.endpoint.port <= 0 || input.endpoint.port > 65_535 ||
    !Number.isSafeInteger(input.trust.generation) || input.trust.generation < 0 ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.trust.digest)
  ) throw new TypeError("Program health runtime identity is invalid");
  if (canonicalize(input.manifest.durableSchemas) !== canonicalize(DURABLE_SCHEMA_INVENTORY)) {
    throw new Error("Program health durable schema inventory drifted");
  }
  const runtimeVersion = (input.runtimeVersion ?? process.versions.node).replace(/^v/u, "");
  if (runtimeVersion !== input.manifest.nodeVersion) {
    throw new Error("Program health runtime version does not match the signed release");
  }
  return Object.freeze({
    releaseManifestDigest: input.manifestDigest,
    protocolRange: Object.freeze({ ...input.manifest.protocolRange }),
    durableSchemas: Object.freeze(DURABLE_SCHEMA_INVENTORY.map((row) => Object.freeze({ ...row }))),
    homeId: input.homeId,
    endpoint: Object.freeze({ ...input.endpoint }),
    rolePlan: Object.freeze({ ...input.rolePlan }),
    trust: Object.freeze({ ...input.trust }),
  });
}

export function buildProgramUpdateTrustProjection(
  mesh: MeshRuntimeBootstrap,
): { readonly generation: number; readonly digest: string } {
  if (mesh.mode === "trusted-home") {
    return Object.freeze({
      generation: mesh.trust.trustEpoch,
      digest: protocolDigest("ProgramUpdateTrustProjection", 1, mesh.trust),
    });
  }
  return Object.freeze({
    generation: 0,
    digest: protocolDigest("ProgramUpdateSingleMachineTrust", 1, {
      deviceId: mesh.deviceKey.deviceId,
      trustedIdentities: mesh.trustedIdentities,
      authorizedDeviceIds: mesh.authorizedDeviceIds,
    }),
  });
}

export function startAutomaticUpdateCheck(
  deps: UpdateRuntimeDeps = {},
): void {
  const controller = deps.controller ?? createInstalledUpdateController(deps.store);
  if (!controller) return;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), AUTOMATIC_CHECK_TIMEOUT_MS);
  timeout.unref?.();
  void controller.checkFailSafe(abort.signal).finally(() => clearTimeout(timeout));
}

export function startManagedUpdateChecks(
  deps: UpdateRuntimeDeps = {},
): () => void {
  const controller = deps.controller ?? createInstalledUpdateController(deps.store);
  if (!controller) return () => undefined;
  startAutomaticUpdateCheck({ ...deps, controller });
  const timer = (deps.setIntervalFn ?? setInterval)(
    () => startAutomaticUpdateCheck({ ...deps, controller }),
    MANAGED_CHECK_INTERVAL_MS,
  );
  timer.unref?.();
  return () => (deps.clearIntervalFn ?? clearInterval)(timer);
}

export async function runUpdateCommand(
  options: { readonly restorePrevious?: boolean },
  deps: UpdateRuntimeDeps = {},
): Promise<ProgramUpdateProjection> {
  const store = deps.store ?? new ProgramStore();
  const controller = deps.controller ?? createInstalledUpdateController(store);
  if (!controller) {
    throw new Error("当前开发构建未嵌入稳定发布源；请使用正式安装包");
  }
  const receipt = options.restorePrevious
    ? await controller.restorePrevious()
    : await controller.checkFailSafe();
  if (!receipt) throw new Error("无法读取本机更新状态");
  return projectProgramUpdate(receipt);
}

export async function readProgramUpdateProjection(
  store: ProgramStore,
  deps: {
    readonly verifier: ProtocolSignatureVerifier;
    readonly lifecycle: { state(operationId: string): Promise<DeviceLifecycleOperation | undefined> };
    readonly health: () => Promise<ProgramUpdateHealthSnapshot>;
  },
): Promise<ProgramUpdateProjection> {
  const receipt = await store.loadReceipt().catch(() => undefined);
  if (!receipt) return { visible: false };
  const pointer = await store.loadPointer().catch(() => undefined);
  const current = pointer
    ? await store.loadCurrentManifest(deps.verifier).catch(() => undefined)
    : undefined;
  const staged = receipt.candidateManifestDigest
    ? await store.loadStagedManifest(receipt.candidateManifestDigest, deps.verifier).catch(() => undefined)
    : undefined;
  const lifecycle = receipt.operationId
    ? await deps.lifecycle.state(receipt.operationId).catch(() => undefined)
    : undefined;
  const health = await deps.health().catch(() => undefined);
  return buildProgramUpdateProjection({
    receipt,
    pointerCurrentManifestDigest: current?.digest,
    stagedManifestDigest: staged?.digest,
    lifecycle,
    health,
  }, staged?.manifest.releaseVersion ?? (
    current && current.digest === receipt.candidateManifestDigest
      ? current.manifest.releaseVersion
      : undefined
  ));
}

export function buildProgramUpdateProjection(
  facts: {
    readonly receipt?: ProgramUpdateReceipt;
    readonly pointerCurrentManifestDigest?: string;
    readonly stagedManifestDigest?: string;
    readonly lifecycle?: DeviceLifecycleOperation;
    readonly health?: ProgramUpdateHealthSnapshot;
  },
  candidateRelease?: string,
): ProgramUpdateProjection {
  const receipt = facts.receipt;
  if (!receipt) return { visible: false };
  const inconsistent = (): ProgramUpdateProjection => ({
    visible: true,
    state: "action-required",
    message: "更新状态需要修复",
    code: "update-state-inconsistent",
    action: "contact-support",
  });
  const currentDigest = facts.pointerCurrentManifestDigest;
  if (!currentDigest) return inconsistent();

  if (receipt.phase === "downloading") {
    return currentDigest === receipt.currentManifestDigest
      ? projectProgramUpdate(receipt, candidateRelease)
      : inconsistent();
  }
  if (receipt.phase === "staged") {
    return currentDigest === receipt.currentManifestDigest &&
      facts.stagedManifestDigest === receipt.candidateManifestDigest
      ? projectProgramUpdate(receipt, candidateRelease)
      : inconsistent();
  }
  if (receipt.phase === "handed-off") {
    const operation = facts.lifecycle;
    const identity = operation?.identity;
    if (
      !operation || identity?.kind !== "upgrade" ||
      identity.operationId !== receipt.operationId ||
      identity.fromManifestDigest !== receipt.currentManifestDigest ||
      identity.targetManifestDigest !== receipt.candidateManifestDigest ||
      (facts.stagedManifestDigest !== receipt.candidateManifestDigest &&
        currentDigest !== receipt.candidateManifestDigest) ||
      operation.phase === "terminal" || operation.phase === "aborted"
    ) return inconsistent();
    const switched = operation.phase === "pointer-switched" || operation.phase === "health-verified";
    const expectedCurrent = switched ? identity.targetManifestDigest : identity.fromManifestDigest;
    if (currentDigest !== expectedCurrent) return inconsistent();
    if (switched && facts.health?.releaseManifestDigest !== identity.targetManifestDigest) {
      return inconsistent();
    }
    return projectProgramUpdate(receipt, candidateRelease);
  }

  if (
    currentDigest !== receipt.currentManifestDigest ||
    facts.health?.releaseManifestDigest !== receipt.currentManifestDigest
  ) return inconsistent();
  return projectProgramUpdate(receipt, candidateRelease);
}

export async function readCurrentAuthorityProgramUpdateProjection(): Promise<ProgramUpdateProjection> {
  const result = await tryReadCurrentAuthorityProgramUpdateStatus();
  if (result.availability === "available") return result.projection;
  return {
    visible: true,
    state: "action-required",
    message: "当前权威设备暂不可达，请稍后重试更新检查",
    code: "current-authority-unavailable",
    action: "retry-update",
  };
}

export async function consumeProgramUpdateNotice(
  noticeToken: string,
  store = new ProgramStore(),
): Promise<{ readonly consumed: boolean }> {
  return { consumed: await store.consumeNotice(noticeToken) };
}

export function printProgramUpdateProjection(
  projection: ProgramUpdateProjection,
  output: Pick<Console, "log"> = console,
): void {
  if (!projection.visible || !projection.message) return;
  output.log(projection.message);
  if (projection.code) output.log(`问题码：${projection.code}`);
  if (projection.action === "retry-update") output.log("下一步：运行 zz update 重试");
  if (projection.action === "restore-previous") {
    output.log("下一步：运行 zz update --restore-previous");
  }
  if (projection.action === "contact-support") output.log("下一步：联系支持并提供问题码");
}
