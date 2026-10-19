import type { AuthorityCommitLog, DurableLogCheckpoint, DurableProjectionReadContext, DurableProjectionSource,
  ProjectionTransactionContext, VerifiedAnchorTenure } from '@zhixing/core/authority';

/** Composition binds the trust domain's verified projection; the conversation
 * owner never reads mesh storage or accepts a request's claimed tenure. */
export interface ConversationAnchorTenurePort {
  readonly projectionId: string;
  current(view: DurableProjectionReadContext): Promise<VerifiedAnchorTenure | undefined>;
  at(view: DurableProjectionReadContext, checkpoint: DurableLogCheckpoint): Promise<VerifiedAnchorTenure | undefined>;
}
const ports = new WeakMap<AuthorityCommitLog, ConversationAnchorTenurePort>();
export function registerConversationAnchorTenure(log: AuthorityCommitLog, port: ConversationAnchorTenurePort): void {
  const prior = ports.get(log);
  if (prior && prior.projectionId !== port.projectionId) throw new TypeError('Conversation anchor tenure source changed');
  ports.set(log, port);
}
export function conversationAnchorProjectionIds(log: AuthorityCommitLog): readonly string[] {
  const port = ports.get(log); return port ? [port.projectionId] : [];
}
export async function conversationAnchorAtPrefix(log: AuthorityCommitLog, context: Pick<ProjectionTransactionContext, 'readProjection'>): Promise<VerifiedAnchorTenure | undefined> {
  const port = ports.get(log); return port ? port.current(context.readProjection(port.projectionId)) : undefined;
}
export async function conversationAnchorAtSource(log: AuthorityCommitLog, source: DurableProjectionSource): Promise<VerifiedAnchorTenure | undefined> {
  const port = ports.get(log);
  if (!port) return;
  if (!source.readPreparedProjection) throw new TypeError('Conversation tenure has no verified source dependency');
  return port.at(source.readPreparedProjection(port.projectionId), source.checkpoint);
}
export interface ConversationOwnerBasis {
  readonly homeId: string;
  readonly anchorEpoch: number;
  readonly ownerEpoch: number;
  readonly deviceId: string;
}
export function conversationOwnerBasis(tenure: VerifiedAnchorTenure, deviceId: string, ownerEpoch: number): ConversationOwnerBasis {
  if (tenure.deviceId !== deviceId || !Number.isSafeInteger(tenure.anchorEpoch) || tenure.anchorEpoch < 1 || !Number.isSafeInteger(ownerEpoch) || ownerEpoch < 1) {
    throw new TypeError('Conversation adoption is not bound to the verified current anchor');
  }
  return { homeId: tenure.homeId, anchorEpoch: tenure.anchorEpoch, ownerEpoch, deviceId };
}
export function adoptedConversationOwner(basis: ConversationOwnerBasis, current: VerifiedAnchorTenure): { deviceId: string; ownerEpoch: number; anchorEpoch: number } {
  if (basis.homeId !== current.homeId || current.anchorEpoch < basis.anchorEpoch) throw new TypeError('Conversation owner succession is missing or regressed');
  const ownerEpoch = basis.ownerEpoch + current.anchorEpoch - basis.anchorEpoch;
  if (!Number.isSafeInteger(ownerEpoch)) throw new TypeError('Conversation owner epoch exceeds the supported integer range');
  return { deviceId: current.deviceId, ownerEpoch, anchorEpoch: current.anchorEpoch };
}
