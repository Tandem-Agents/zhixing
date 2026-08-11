import type { HomeTrustRecord, MeshRoleBootConfig } from "@zhixing/core/contracts";
import {
  resolveHostLaunchPlan,
  type HostLaunchPlan,
} from "@zhixing/mesh/bootstrap";
import type {
  ManagedServiceAdapter,
  ManagedServiceInspection,
  ManagedServiceSpec,
} from "./managed-service.js";

export const MANAGED_HOST_ASSEMBLY_DESCRIPTOR = Object.freeze({
  owner: "home-managed-host",
  planModes: Object.freeze(["managed", "on-demand", "none"] as const),
  triggers: Object.freeze([
    "pairing-issuer-committed",
    "pairing-joiner-committed",
    "local-role-config-committed",
    "current-trust-applied",
    "managed-preflight",
    "host-missing",
  ] as const),
  managedProfiles: Object.freeze(["anchor-executor", "anchor-only"] as const),
  selectableProfiles: Object.freeze(["executor-only", "executor-surface"] as const),
  excludedProfiles: Object.freeze(["surface-only", "disabled-empty"] as const),
});

export const MANAGED_SERVICE_RECONCILE_TRIGGERS =
  MANAGED_HOST_ASSEMBLY_DESCRIPTOR.triggers;

export type ManagedServiceReconcileTrigger =
  (typeof MANAGED_SERVICE_RECONCILE_TRIGGERS)[number];

export interface ManagedServiceCurrentState {
  readonly localDeviceId: string;
  readonly configuration?: MeshRoleBootConfig;
  readonly trust?: HomeTrustRecord;
  readonly spec?: ManagedServiceSpec;
}

export interface ManagedServiceReconcileResult {
  readonly plan: HostLaunchPlan;
  readonly service: ManagedServiceInspection | undefined;
  readonly action: "installed-and-started" | "started" | "disabled" | "unchanged";
}

const inFlight = new Map<string, Promise<ManagedServiceReconcileResult>>();

/**
 * Reconciles one home from current durable inputs. Callers provide a loader,
 * never a precomputed plan, so every trigger crosses the same authority check.
 */
export async function reconcileManagedService(input: {
  readonly trigger: ManagedServiceReconcileTrigger;
  readonly loadCurrent: () => Promise<ManagedServiceCurrentState>;
  readonly adapter: ManagedServiceAdapter;
  readonly signal: AbortSignal;
}): Promise<ManagedServiceReconcileResult> {
  if (!MANAGED_SERVICE_RECONCILE_TRIGGERS.includes(input.trigger)) {
    throw new TypeError("Managed service reconcile trigger is invalid");
  }
  const initial = await input.loadCurrent();
  const key = initial.spec?.serviceId ?? `unregistered:${initial.localDeviceId}`;
  const current = inFlight.get(key);
  if (current) return current;
  const operation = reconcileCurrent(initial, input);
  inFlight.set(key, operation);
  try {
    return await operation;
  } finally {
    if (inFlight.get(key) === operation) inFlight.delete(key);
  }
}

async function reconcileCurrent(
  initial: ManagedServiceCurrentState,
  input: {
    readonly loadCurrent: () => Promise<ManagedServiceCurrentState>;
    readonly adapter: ManagedServiceAdapter;
    readonly signal: AbortSignal;
  },
): Promise<ManagedServiceReconcileResult> {
  throwIfAborted(input.signal);
  let plan: HostLaunchPlan;
  try {
    plan = resolveHostLaunchPlan(initial);
  } catch (error) {
    if (initial.spec) {
      const current = await input.adapter.inspect(initial.spec, input.signal);
      if (current.state !== "absent" && current.matches) {
        await input.adapter.disable(initial.spec, input.signal);
      }
    }
    throw error;
  }
  if (!initial.spec) {
    if (plan.mode === "managed") {
      throw new Error("Managed launch requires an established SecretStore backend and service specification");
    }
    return { plan, service: undefined, action: "unchanged" };
  }
  const before = await input.adapter.inspect(initial.spec, input.signal);
  if (plan.mode === "managed") {
    if (before.state === "enabled" && before.running && before.matches) {
      return { plan, service: before, action: "unchanged" };
    }
    const installed = before.state === "enabled" && before.matches
      ? before
      : await input.adapter.install(initial.spec, input.signal);
    const latest = await input.loadCurrent();
    const latestPlan = resolveHostLaunchPlan(latest);
    if (latestPlan.mode !== "managed" || latest.spec?.serviceId !== initial.spec.serviceId) {
      const disabled = await input.adapter.disable(initial.spec, input.signal);
      return { plan: latestPlan, service: disabled, action: "disabled" };
    }
    if (installed.running) {
      return { plan: latestPlan, service: installed, action: "installed-and-started" };
    }
    const started = await input.adapter.start(initial.spec, input.signal);
    return {
      plan: latestPlan,
      service: started,
      action: before.state === "absent" ? "installed-and-started" : "started",
    };
  }
  if (before.state === "absent" || (before.state === "disabled" && !before.running)) {
    return { plan, service: before, action: "unchanged" };
  }
  const disabled = await input.adapter.disable(initial.spec, input.signal);
  return { plan, service: disabled, action: "disabled" };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Managed service reconcile was cancelled");
}
