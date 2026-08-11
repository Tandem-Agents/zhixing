import { homedir, userInfo } from "node:os";
import path from "node:path";
import { canonicalize } from "@zhixing/core/protocol";
import { getZhixingHome } from "@zhixing/core";
import { loadConfig } from "@zhixing/providers";
import {
  createPlatformSecretStore,
  readPlatformSecretStoreBackendBinding,
  type PlatformSecretStoreBackend,
} from "@zhixing/secrets";
import { createDeviceCapacityRuntime } from "./device-capacity-runtime.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";
import { loadExistingDeviceKey } from "./mesh-device-key.js";
import {
  buildManagedServiceSpec,
  createManagedServiceAdapter,
} from "./managed-service.js";
import {
  reconcileManagedService,
  type ManagedServiceCurrentState,
  type ManagedServiceReconcileResult,
  type ManagedServiceReconcileTrigger,
} from "./managed-service-reconciler.js";
import { resolveHostLaunchPlan } from "@zhixing/mesh/bootstrap";

export interface ManagedHostTrustTransitionDeps {
  readonly loadCurrent?: typeof loadCurrentManagedServiceState;
  readonly reconcile?: typeof reconcileCurrentManagedService;
  readonly refuseNewMessages: () => void;
  readonly requestShutdown: () => void | Promise<void>;
  readonly processMode?: "foreground" | "on-demand" | "managed";
  readonly expectedAdmission?: ManagedHostAdmissionSnapshot;
}

export interface ManagedHostAdmissionSnapshot {
  readonly identity: string;
  readonly admitted: boolean;
}

export async function loadCurrentManagedServiceState(
  homeDir = getZhixingHome(),
): Promise<ManagedServiceCurrentState> {
  const config = loadConfig({ homeDir });
  const binding = await readPlatformSecretStoreBackendBinding(homeDir);
  const expectedBackend = managedExpectedBackend();
  if (expectedBackend !== undefined && binding !== expectedBackend) {
    throw new Error("local-credentials-unavailable");
  }
  const secretStore = createPlatformSecretStore({
    homeDir,
    context: process.env.ZHIXING_MANAGED === "1" ? "managed" : "foreground",
  });
  if (await secretStore.unlockState() !== "unlocked") {
    throw new Error("local-credentials-unavailable");
  }
  const key = await loadExistingDeviceKey(secretStore);
  const localDeviceId = key?.deviceId ?? `unregistered:${homeDigest(homeDir)}`;
  let trust;
  if (key) {
    const store = new FileMeshBootstrapStore(homeDir, key);
    try {
      trust = await store.loadTrustRecord();
    } finally {
      store.stopStorageMaintenance();
    }
  }
  const member = key && trust?.members.find((candidate) =>
    candidate.device.deviceId === key.deviceId);
  const entryScript = process.argv[1]
    ? path.resolve(process.argv[1])
    : path.resolve(import.meta.dirname, "../index.js");
  const account = userInfo();
  const spec = binding
    ? buildManagedServiceSpec({
        platform: process.platform,
        zhixingHome: homeDir,
        backend: binding,
        execPath: process.execPath,
        entryScript,
        osUser: account.username,
        userHome: homedir(),
        ...(typeof account.uid === "number" ? { uid: account.uid } : {}),
        headless: member?.device.platform === "headless",
      })
    : undefined;
  return {
    localDeviceId,
    ...(config.mesh ? { configuration: config.mesh } : {}),
    ...(trust ? { trust } : {}),
    ...(spec ? { spec } : {}),
  };
}

export async function reconcileCurrentManagedService(
  trigger: ManagedServiceReconcileTrigger,
  signal: AbortSignal = new AbortController().signal,
): Promise<ManagedServiceReconcileResult> {
  const homeDir = getZhixingHome();
  const capacity = createDeviceCapacityRuntime(
    path.join(homeDir, "distributed-runtime", "capacity"),
  );
  return reconcileManagedService({
    homeKey: path.resolve(homeDir),
    trigger,
    loadCurrent: () => loadCurrentManagedServiceState(homeDir),
    adapter: createManagedServiceAdapter({ storageGovernor: capacity.storage }),
    signal,
  });
}

export async function coordinateManagedHostTrustTransition(
  deps: ManagedHostTrustTransitionDeps,
): Promise<"retained" | "stopped"> {
  const loadCurrent = deps.loadCurrent ?? loadCurrentManagedServiceState;
  const reconcile = deps.reconcile ?? reconcileCurrentManagedService;
  let shouldStop = false;
  try {
    const current = await loadCurrent();
    const mode = resolveHostLaunchPlan(current).mode;
    const processMode = deps.processMode ?? "managed";
    const modeRejected = processMode === "managed"
      ? mode !== "managed"
      : processMode === "on-demand"
        ? mode !== "on-demand"
        : mode === "none";
    shouldStop = modeRejected || (
      deps.expectedAdmission !== undefined &&
      (
        !deps.expectedAdmission.admitted ||
        deps.expectedAdmission.identity !== canonicalize(current)
      )
    );
  } catch {
    shouldStop = true;
  }
  if (shouldStop) {
    deps.refuseNewMessages();
    await deps.requestShutdown();
    return "stopped";
  }
  await reconcile("current-trust-applied");
  return "retained";
}

export async function captureManagedHostAdmission(
  processMode: "foreground" | "on-demand" | "managed",
  homeDir = getZhixingHome(),
  loadCurrent: typeof loadCurrentManagedServiceState = loadCurrentManagedServiceState,
): Promise<ManagedHostAdmissionSnapshot> {
  const current = await loadCurrent(homeDir);
  const plan = resolveHostLaunchPlan(current);
  return {
    identity: canonicalize(current),
    admitted: processMode === "managed"
      ? plan.mode === "managed"
      : processMode === "on-demand"
        ? plan.mode === "on-demand"
        : plan.mode !== "none",
  };
}

export async function verifyManagedHostAdmission(
  expected: ManagedHostAdmissionSnapshot,
  processMode: "foreground" | "on-demand" | "managed",
  homeDir = getZhixingHome(),
  loadCurrent: typeof loadCurrentManagedServiceState = loadCurrentManagedServiceState,
): Promise<boolean> {
  const current = await captureManagedHostAdmission(processMode, homeDir, loadCurrent);
  return expected.admitted && current.admitted && current.identity === expected.identity;
}

function homeDigest(homeDir: string): string {
  return Buffer.from(path.resolve(homeDir), "utf8").toString("base64url").slice(0, 64);
}

function managedExpectedBackend(): PlatformSecretStoreBackend | undefined {
  if (process.env.ZHIXING_MANAGED !== "1") return undefined;
  const value = process.env.ZHIXING_SECRET_BACKEND;
  if (value === undefined) return undefined;
  if (
    value === "windows-dpapi" || value === "macos-keychain" ||
    value === "linux-secret-service" || value === "machine-bound"
  ) return value;
  throw new Error("local-credentials-unavailable");
}
