/** Finite evidence consumed by conversation fact validation. It neither grants
 * reservations nor replaces the resource governor's quota/clock decisions. */
import type { AssignmentResourceLease, GovernorRecord, LogicalRecord, ReservableResourceLease, UsageReport } from '@zhixing/core/contracts';
import { acceptedRemoteIntervalRemainingMs, canonicalize, protocolDigest, validateGovernorRecord, validateReservableResourceLease, type ProtocolSignatureVerifier } from '@zhixing/core/protocol';

export function assertAssignmentActivationEvidence(input: { readonly lease: AssignmentResourceLease;
  readonly records: readonly LogicalRecord<unknown>[]; readonly acceptedAt: string }, verifier: ProtocolSignatureVerifier): void {
  const lease = validateReservableResourceLease(input.lease, verifier);
  acceptedRemoteIntervalRemainingMs({ issuedAt: lease.issuedAt, expiry: lease.expiry, acceptedAt: input.acceptedAt, maxTtlMs: 24 * 60 * 60_000 });
  const actual = input.records.filter(record => record.stream === 'governor')
    .map(record => ({ ...record, body: validateGovernorRecord(record.body, verifier) }));
  if (canonicalize(actual) !== canonicalize([{ stream: 'governor', body: { t: 'reserve', lease } }])) throw new TypeError('Assignment resource activation records are incomplete or conflicting');
}

export interface AssignmentUsageEvidence {
  readonly root?: { readonly lease: ReservableResourceLease; readonly depth: number };
  readonly watermark: number;
  readonly block: () => UsageReport['usages'];
}
export interface AssignmentUsageClaim {
  readonly reservationId: string; readonly assignmentId: string; readonly executorId: string;
  readonly usageFinal: { readonly reportDigest: string; readonly upToUsageSeq: number };
}
export function assertAssignmentUsageEvidence(evidence: AssignmentUsageEvidence, input: AssignmentUsageClaim, verifier: ProtocolSignatureVerifier): void {
  const root = evidence.root;
  if (!root || root.depth !== 0) throw new TypeError('Final usage has no matching resource root');
  const lease = validateReservableResourceLease(root.lease, verifier);
  const activation = 'activation' in lease ? lease.activation : undefined;
  if (activation?.kind !== 'assignment' || activation.assignmentId !== input.assignmentId || lease.audience.executorId !== input.executorId) {
    throw new TypeError('Final usage does not bind the assignment resource root');
  }
  if (input.usageFinal.upToUsageSeq !== evidence.watermark) throw new TypeError('Final usage watermark does not match durable usage');
  let expected: string;
  if (evidence.watermark === 0) expected = protocolDigest('AssignmentUsageFinal', 1, { assignmentId: input.assignmentId, upToUsageSeq: 0 });
  else {
    const fromUsageSeq = Math.floor((evidence.watermark - 1) / 256) * 256 + 1, usages = evidence.block();
    if (usages.length !== evidence.watermark - fromUsageSeq + 1 || usages.some((usage, index) => usage.usageSeq !== fromUsageSeq + index)) {
      throw new TypeError('Final usage report range is not durably continuous');
    }
    expected = protocolDigest('UsageReport', 1, { v: 1, reporterId: lease.audience.executorId, rootReservationId: lease.reservationId,
      workloadRef: { kind: 'assignment', assignmentId: input.assignmentId }, fromUsageSeq, toUsageSeq: evidence.watermark, usages });
  }
  if (input.usageFinal.reportDigest !== expected) throw new TypeError('Final usage report digest does not match durable usage');
}

export function assertAssignmentTerminalEvidence(input: { readonly reservationId: string;
  readonly mode: 'settle-release' | 'release' | 'reclaim'; readonly records: readonly LogicalRecord<unknown>[] }, verifier: ProtocolSignatureVerifier): void {
  const expected: LogicalRecord<GovernorRecord>[] = (input.mode === 'settle-release' ? ['settle', 'release'] as const : [input.mode])
    .map(t => ({ stream: 'governor', body: { t, reservationId: input.reservationId } }));
  const actual = input.records.filter(record => record.stream === 'governor')
    .map(record => ({ ...record, body: validateGovernorRecord(record.body, verifier) }));
  if (canonicalize(actual) !== canonicalize(expected)) throw new TypeError('Assignment resource terminal records are incomplete or conflicting');
}
