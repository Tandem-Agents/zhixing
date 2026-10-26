import type {
  HomeTrustEvent,
  RecoveryActivationPlan,
} from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import type { RootActivationRecord } from "@zhixing/mesh/paired-checkpoint-target";
import {
  applyTrustEvent,
  homeTrustEventDigest,
  verifyHistoricalHomeTrustRecord,
  verifyHomeTrustRecord,
} from "@zhixing/mesh/trust-chain";
import type { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";

export async function commitRecoveryRootActivation(
  store: FileMeshBootstrapStore,
  event: HomeTrustEvent,
  record: RootActivationRecord,
): Promise<void> {
  if (await isExactRecoveryRootActivationReplay(store, event, record)) return;
  // 不是精确重放就是新激活：只收当前快照
  if (record.v !== 2) throw new TypeError("Recovery root activation requires a current trust snapshot");
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
  record: RootActivationRecord,
): Promise<void> {
  if (!(await isExactRecoveryRootActivationReplay(store, event, record))) {
    throw new TypeError("Recovery root activation is not an exact terminal replay");
  }
}

export async function commitRecoveryRootLifecycleActivation(
  store: FileMeshBootstrapStore,
  plan: RecoveryActivationPlan,
  record: RootActivationRecord,
): Promise<void> {
  const events = plan.kind === "domain-reset-establish"
    ? [plan.resetEvent, plan.rootEvent]
    : [plan.rootEvent];
  await store.commitRecoveryRootLifecycle({ events, record });
}

/**
 * 精确的终态重放：激活事件就是当前链头，且给出的记录是这个链头的签名快照。
 * v2 与本机当前快照逐字相同；v1 是一次性接续之前入链的历史帧，按原规则验证为同一链头的快照。
 */
async function isExactRecoveryRootActivationReplay(
  store: FileMeshBootstrapStore,
  event: HomeTrustEvent,
  record: RootActivationRecord,
): Promise<boolean> {
  const current = await store.loadTrustProjection();
  const events = await store.loadTrustEvents();
  if (!current || events.length === 0) return false;
  if (
    current.chainHead.seq !== event.seq ||
    current.chainHead.eventDigest !== homeTrustEventDigest(event) ||
    canonicalize(events.at(-1)) !== canonicalize(event)
  ) return false;
  if (record.v === 1) {
    verifyHistoricalHomeTrustRecord(record, current);
    return true;
  }
  const persisted = await store.loadTrustRecord();
  if (!persisted || canonicalize(persisted) !== canonicalize(record)) return false;
  verifyHomeTrustRecord(record, current);
  return true;
}
