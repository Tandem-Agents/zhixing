import type { MutationBatch, PublishRecord } from '@zhixing/core/contracts';

export function mutationNeedsExternalPublish(record: MutationBatch['records'][number]): boolean {
  return record.domain === 'global' && record.mutation.kind !== 'delivery-enqueue';
}

/** Shared by the commit decision and recovery discovery; counts alone do not
 * establish an external publication obligation. */
export function domainPublishDecisionRequired(
  records: MutationBatch['records'],
  outcomes: Extract<PublishRecord, { t: 'publish-decision' }>['outcomes'],
  domain: 'session' | 'global',
): boolean {
  return records.some((record, index) => record.domain === domain &&
    (mutationNeedsExternalPublish(record) || outcomes[index]?.outcome.t === 'conflicted'));
}

export function publishDomainSequence(records: MutationBatch['records'],
  outcomes: Extract<PublishRecord, { t: 'publish-decision' }>['outcomes'], domain: 'session' | 'global') {
  const required = records.filter((record, index) => record.domain === domain &&
    (mutationNeedsExternalPublish(record) || outcomes[index]?.outcome.t === 'conflicted'));
  if (!required.length) return;
  const grantedSeqs = outcomes.filter(item => item.outcome.t === 'granted' &&
    records[item.seq - 1]?.domain === domain && mutationNeedsExternalPublish(records[item.seq - 1]!)).map(item => item.seq);
  return { grantedSeqs, terminalSeq: grantedSeqs.at(-1) ?? required.at(-1)!.seq };
}

export function publishProgressFollows(input: {
  readonly current?: { readonly state: string; readonly upToSeq: number };
  readonly next: { readonly state: string; readonly upToSeq: number };
  readonly nextGrantedSeq?: number; readonly terminalSeq: number; readonly noGranted: boolean;
}): boolean {
  const { current, next, nextGrantedSeq, terminalSeq, noGranted } = input;
  return (next.upToSeq === 0 && next.state === 'pending' && !current) ||
    (current?.state === 'pending' && nextGrantedSeq !== undefined && next.upToSeq === nextGrantedSeq &&
      next.state === (next.upToSeq === terminalSeq ? 'settled' : 'pending')) ||
    (current?.state === 'pending' && noGranted && next.upToSeq === terminalSeq && next.state === 'settled');
}
