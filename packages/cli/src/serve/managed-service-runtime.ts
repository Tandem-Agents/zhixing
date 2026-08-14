import { userInfo } from "node:os";
import path from "node:path";
import { canonicalize } from "@zhixing/core/protocol";
import { expandUserHome, getZhixingHome } from "@zhixing/core";
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
  managedServiceDefinitionDigest,
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

export type ManagedServiceStateLoadIntent = "inspect" | "activate";

export async function loadCurrentManagedServiceState(
  intent: ManagedServiceStateLoadIntent,
  homeDir = getZhixingHome(),
): Promise<ManagedServiceCurrentState> {
  const config = loadConfig({ homeDir });
  const initialBinding = await readPlatformSecretStoreBackendBinding(homeDir);
  const expectedBackend = managedExpectedBackend();
  if (
    initialBinding !== undefined &&
    expectedBackend !== undefined &&
    initialBinding !== expectedBackend
  ) {
    throw new Error("local-credentials-unavailable");
  }
  if (intent === "inspect" && initialBinding === undefined) {
    throw new Error("local-credentials-unavailable");
  }
  const secretStore = createPlatformSecretStore({
    homeDir,
    context: process.env.ZHIXING_MANAGED === "1" ? "managed" : "foreground",
  });
  if (await secretStore.unlockState() !== "unlocked") {
    throw new Error("local-credentials-unavailable");
  }
  const binding = await readPlatformSecretStoreBackendBinding(homeDir);
  if (
    binding === undefined ||
    (initialBinding !== undefined && binding !== initialBinding) ||
    (expectedBackend !== undefined && binding !== expectedBackend)
  ) {
    throw new Error("local-credentials-unavailable");
  }
  const key = await loadExistingDeviceKey(secretStore);
  let trust;
  if (key) {
    const store = new FileMeshBootstrapStore(homeDir, key);
    try {
      trust = await store.loadTrustRecord();
    } finally {
      store.stopStorageMaintenance();
    }
  }
  if (await readPlatformSecretStoreBackendBinding(homeDir) !== binding) {
    throw new Error("local-credentials-unavailable");
  }
  return createCurrentManagedServiceStateProjector(homeDir)({
    config,
    binding,
    key,
    trust,
  });
}

function createCurrentManagedServiceStateProjector(homeDir: string) {
  const entryScript = process.argv[1]
    ? path.resolve(process.argv[1])
    : path.resolve(import.meta.dirname, "../index.js");
  const account = userInfo();
  const serviceIdentity = Object.freeze({
    platform: process.platform,
    zhixingHome: homeDir,
    execPath: process.execPath,
    entryScript,
    osUser: account.username,
    userHome: expandUserHome("~"),
    ...(typeof account.uid === "number" ? { uid: account.uid } : {}),
  });
  return (snapshot: {
    readonly config: ReturnType<typeof loadConfig>;
    readonly binding: PlatformSecretStoreBackend;
    readonly key: Awaited<ReturnType<typeof loadExistingDeviceKey>>;
    readonly trust: Awaited<ReturnType<FileMeshBootstrapStore["loadTrustRecord"]>>;
  }): ManagedServiceCurrentState => {
    const { config, binding, key, trust } = snapshot;
    const localDeviceId = key?.deviceId ?? `unregistered:${homeDigest(homeDir)}`;
    const member = key && trust?.members.find((candidate) =>
      candidate.device.deviceId === key.deviceId);
    const spec = buildManagedServiceSpec({
      ...serviceIdentity,
      backend: binding,
      headless: member?.device.platform === "headless",
    });
    return {
      localDeviceId,
      ...(config.mesh ? { configuration: config.mesh } : {}),
      ...(trust ? { trust } : {}),
      spec,
    };
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
    loadCurrent: () => loadCurrentManagedServiceState("activate", homeDir),
    adapter: createManagedServiceAdapter({ storageGovernor: capacity.storage }),
    signal,
  });
}

export async function prepareCurrentManagedServiceConfigTurnover(
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const homeDir = getZhixingHome();
  const current = await loadCurrentManagedServiceState("activate", homeDir);
  if (resolveHostLaunchPlan(current).mode === "managed" || !current.spec) return;
  const capacity = createDeviceCapacityRuntime(
    path.join(homeDir, "distributed-runtime", "capacity"),
  );
  await createManagedServiceAdapter({ storageGovernor: capacity.storage })
    .disableFuture(current.spec, signal);
}

export async function prepareProgramRemovalManagedService(
  signal: AbortSignal = new AbortController().signal,
  homeDir = getZhixingHome(),
): Promise<() => Promise<void>> {
  if (await readPlatformSecretStoreBackendBinding(homeDir) === undefined) {
    return async () => undefined;
  }
  const current = await loadCurrentManagedServiceState("inspect", homeDir);
  if (!current.spec) return async () => undefined;
  const capacity = createDeviceCapacityRuntime(
    path.join(homeDir, "distributed-runtime", "capacity"),
  );
  const adapter = createManagedServiceAdapter({ storageGovernor: capacity.storage });
  const spec = current.spec;
  const definitionDigest = managedServiceDefinitionDigest(spec);
  const disabled = await adapter.disableFuture(spec, signal);
  if (disabled.state === "enabled") {
    throw new Error("托管服务的未来启动尚未停用");
  }
  return async () => {
    const latest = await loadCurrentManagedServiceState("inspect", homeDir);
    if (
      !latest.spec ||
      latest.spec.serviceId !== spec.serviceId ||
      managedServiceDefinitionDigest(latest.spec) !== definitionDigest
    ) {
      throw new Error("托管服务定义在应用移除前已换代");
    }
    const inspection = await adapter.inspect(spec, signal);
    if (inspection.state === "absent") return;
    if (!inspection.matches || inspection.running) {
      throw new Error("托管服务尚未安全停止，未注销未来启动");
    }
    const removed = await adapter.unregisterFutureExact(spec, inspection, signal);
    if (removed.state !== "absent" || removed.running) {
      throw new Error("托管服务注销未通过回读验证");
    }
  };
}

export async function coordinateManagedHostTrustTransition(
  deps: ManagedHostTrustTransitionDeps,
): Promise<"retained" | "stopped"> {
  const loadCurrent = deps.loadCurrent ?? loadCurrentManagedServiceState;
  const reconcile = deps.reconcile ?? reconcileCurrentManagedService;
  let shouldStop = false;
  try {
    const current = await loadCurrent("activate");
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
  const current = await loadCurrent("activate", homeDir);
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
