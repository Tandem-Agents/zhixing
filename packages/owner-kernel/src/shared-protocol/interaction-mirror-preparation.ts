import type {
  EnvironmentRequirement,
  TrustRuleHitMirrorEntry,
  TrustSedimentMirrorEntry,
} from "@zhixing-ai/core/contracts";
import type {
  TrustRuleHitBatchInput,
  TrustRuleHitPort,
} from "../trust-rule-hits.js";

export interface MirrorBatchCursorLike {
  readonly previousDigest: string;
  readonly mirrorDigest: string;
  readonly entries: readonly {
    readonly seq: number;
    readonly ordinal: number;
    readonly requestId: string;
  }[];
}

export function batchRepeatsDurableRequestId(
  batch: Pick<MirrorBatchCursorLike, "entries">,
  durableRequestIds: { has(requestId: string): boolean },
): boolean {
  const seenInBatch = new Set<string>();
  for (const entry of batch.entries) {
    if (durableRequestIds.has(entry.requestId) || seenInBatch.has(entry.requestId)) {
      return true;
    }
    seenInBatch.add(entry.requestId);
  }
  return false;
}

export function extendsDurableMirrorCursor(
  batch: MirrorBatchCursorLike,
  cursor: {
    readonly upTo: number;
    readonly ordinal: number;
    readonly digest: string;
  },
): boolean {
  const first = batch.entries[0];
  if (!first) return false;
  return (
    batch.previousDigest === cursor.digest &&
    first.ordinal === cursor.ordinal + 1 &&
    first.seq > cursor.upTo
  );
}

export interface SharedTrustRuleHitMirrorSession {
  readonly target: TrustRuleHitBatchInput | undefined;
  readonly prepared: boolean;
  settleAfterError(): Promise<void>;
  acceptCommitted(): Promise<void>;
}

/**
 * Single-prepare lock-free trust rule hit preparation session shared by
 * conversation and job interaction mirror & bundle commit paths.
 */
export async function prepareSharedTrustRuleHitMirrorSession(input: {
  readonly origin: TrustRuleHitBatchInput["origin"];
  readonly assignmentId: string;
  readonly batchDigest: string;
  readonly hits: readonly TrustRuleHitMirrorEntry[];
  readonly trustRuleHits: TrustRuleHitPort | undefined;
  readonly selectPrecheck: () => Promise<
    | {
        readonly prepare: boolean;
        readonly environment: EnvironmentRequirement;
      }
    | undefined
  >;
  readonly selectBatchCommitted: () => Promise<boolean>;
}): Promise<SharedTrustRuleHitMirrorSession> {
  if (!input.trustRuleHits || input.hits.length === 0) {
    return {
      target: undefined,
      prepared: false,
      settleAfterError: async () => undefined,
      acceptCommitted: async () => undefined,
    };
  }
  const checked = await input.selectPrecheck();
  if (!checked) {
    return {
      target: undefined,
      prepared: false,
      settleAfterError: async () => undefined,
      acceptCommitted: async () => undefined,
    };
  }
  const target: TrustRuleHitBatchInput = {
    origin: input.origin,
    assignmentId: input.assignmentId,
    environment: checked.environment,
    batchDigest: input.batchDigest,
    entries: input.hits,
  };
  if (checked.prepare) {
    await input.trustRuleHits.prepare(target);
  }
  let settled = false;
  return {
    target,
    prepared: checked.prepare,
    async settleAfterError() {
      if (settled || !checked.prepare) return;
      settled = true;
      const committed = await input.selectBatchCommitted().catch(() => undefined);
      if (committed === true) {
        await input.trustRuleHits!.accept(target).catch(() => undefined);
      } else if (committed === false) {
        await input.trustRuleHits!.discard(target).catch(() => undefined);
      }
    },
    async acceptCommitted() {
      if (settled) return;
      settled = true;
      await input.trustRuleHits!.accept(target).catch(() => undefined);
    },
  };
}

export async function prepareSharedTrustSediments(input: {
  readonly assignmentId: string;
  readonly sediments: readonly TrustSedimentMirrorEntry[];
  readonly selectAssigned: () => Promise<
    | {
        readonly executorId: string;
        readonly environment: EnvironmentRequirement;
      }
    | undefined
  >;
  readonly isAnswered: (requestId: string) => Promise<boolean>;
  readonly prepareOne: (item: {
    readonly assignmentId: string;
    readonly executorId: string;
    readonly environment: EnvironmentRequirement;
    readonly entry: TrustSedimentMirrorEntry;
    readonly answered: (requestId: string) => Promise<boolean>;
  }) => Promise<void>;
}): Promise<void> {
  if (input.sediments.length === 0) return;
  const assigned = await input.selectAssigned();
  if (!assigned) return;
  for (const entry of input.sediments) {
    await input.prepareOne({
      assignmentId: input.assignmentId,
      executorId: assigned.executorId,
      environment: assigned.environment,
      entry,
      answered: input.isAnswered,
    });
  }
}
