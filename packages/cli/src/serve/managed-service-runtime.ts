import { homedir, userInfo } from "node:os";
import path from "node:path";
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
    shouldStop = resolveHostLaunchPlan(await loadCurrent()).mode !== "managed";
  } catch {
    shouldStop = true;
  }
  if (shouldStop) deps.refuseNewMessages();
  try {
    await reconcile("current-trust-applied");
  } finally {
    if (shouldStop) await deps.requestShutdown();
  }
  return shouldStop ? "stopped" : "retained";
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
