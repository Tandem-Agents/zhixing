import type {
  HomeTrustEvent,
  HomeTrustRecord,
  RecoveryActivationPlan,
} from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import {
  applyTrustEvent,
  homeTrustEventDigest,
  verifyHomeTrustRecord,
} from "@zhixing/mesh/trust-chain";
import type { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";

export async function commitRecoveryRootActivation(
  store: FileMeshBootstrapStore,
  event: HomeTrustEvent,
  record: HomeTrustRecord,
): Promise<void> {
  if (await isExactRecoveryRootActivationReplay(store, event, record)) return;
  const current = await store.loadTrustProjection();
  if (!current) throw new Error("Recovery root establishment trust chain is missing");
  if (
    current.issuer.deviceId !== record.issuer.deviceId ||
    event.body.t !== "recovery-root" ||
    event.body.op !== "establish"
  ) throw new TypeError("Recovery root activation is outside the current-issuer establishment boundary");
  const next = applyTrustEvent(current, event);
  verifyHomeTrustRecord(record, next);
  try {
    await store.appendTrustEvent({ event, record });
  } catch (error) {
    if (await isExactRecoveryRootActivationReplay(store, event, record)) return;
    throw error;
  }
  if (!(await isExactRecoveryRootActivationReplay(store, event, record))) {
    throw new Error("Recovery root activation was not committed durably");
  }
}

export async function assertRecoveryRootActivationReplay(
  store: FileMeshBootstrapStore,
  event: HomeTrustEvent,
  record: HomeTrustRecord,
): Promise<void> {
  if (!(await isExactRecoveryRootActivationReplay(store, event, record))) {
    throw new TypeError("Recovery root activation is not an exact terminal replay");
  }
}

export async function commitRecoveryRootLifecycleActivation(
  store: FileMeshBootstrapStore,
  plan: RecoveryActivationPlan,
  record: HomeTrustRecord,
): Promise<void> {
  const events = plan.kind === "domain-reset-establish"
    ? [plan.resetEvent, plan.rootEvent]
    : [plan.rootEvent];
  await store.commitRecoveryRootLifecycle({ events, record });
}

async function isExactRecoveryRootActivationReplay(
  store: FileMeshBootstrapStore,
  event: HomeTrustEvent,
  record: HomeTrustRecord,
): Promise<boolean> {
  const current = await store.loadTrustProjection();
  const persisted = await store.loadTrustRecord();
  const events = await store.loadTrustEvents();
  if (!current || !persisted || events.length === 0) return false;
  if (
    current.chainHead.seq !== event.seq ||
    current.chainHead.eventDigest !== homeTrustEventDigest(event) ||
    canonicalize(events.at(-1)) !== canonicalize(event) ||
    canonicalize(persisted) !== canonicalize(record)
  ) return false;
  verifyHomeTrustRecord(record, current);
  return true;
}
