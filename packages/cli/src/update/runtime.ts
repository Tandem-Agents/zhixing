import { EMBEDDED_RELEASE_TRUST, STABLE_RELEASE_INDEX_URL } from "./release-channel.js";
import { createReleaseVerifier } from "./release-verifier.js";
import { ProgramStore } from "./program-store.js";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import type { ProgramUpdateHealthSnapshot } from "@zhixing/server";
import {
  getDefaultTokenPath,
  isProcessAlive,
  readLock,
} from "@zhixing/server";
import { RpcProgramUpdateFacade } from "../runtime/rpc-program-update-facade.js";
import { readFile } from "node:fs/promises";
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
  const lock = await readLock().catch(() => null);
  if (!lock || !isProcessAlive(lock.pid)) return undefined;
  if (signal?.aborted) throw signal.reason;
  const token = (await readFile(getDefaultTokenPath(), "utf8")).trim();
  if (!token) throw new Error("本机宿主认证不可用");
  const rpc = new RpcProgramUpdateFacade({
    url: `ws://${lock.host ?? "127.0.0.1"}:${lock.port}/ws`,
    token,
    timeoutMs: 30_000,
  });
  return rpc.prepare({
    requestId: protocolDigest("ProgramUpdateHandoffRequest", 1, { candidateManifestDigest }),
    candidateManifestDigest,
    timeoutMs: 30_000,
  }, signal);
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
  if (options.restorePrevious) {
    const lock = await readLock().catch(() => null);
    if (lock && isProcessAlive(lock.pid)) {
      throw new Error("知行仍在安全运行；请先完成当前工作并停止知行，再恢复上一个可用版本");
    }
  }
  const receipt = options.restorePrevious
    ? await controller.restorePrevious()
    : await controller.checkFailSafe();
  if (!receipt) throw new Error("无法读取本机更新状态");
  return projectProgramUpdate(receipt);
}

export async function readProgramUpdateProjection(
  store = new ProgramStore(),
): Promise<ProgramUpdateProjection> {
  return projectProgramUpdate(await store.loadReceipt().catch(() => undefined));
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
