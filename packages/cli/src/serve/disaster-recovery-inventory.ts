import type {
  InventoryRecoveryCheckpointTarget,
  RecoveryCheckpointInventoryEntry,
} from "@zhixing/mesh/checkpoint-target";

export interface DisasterRecoveryInventoryTarget {
  readonly displayName: string;
  readonly target: InventoryRecoveryCheckpointTarget;
}

export interface PublicDisasterRecoveryCandidate {
  readonly number: number;
  readonly location: string;
  readonly backedUpAt: string;
  readonly state: "pending-verification";
}

export interface DisasterRecoveryCandidate {
  readonly public: PublicDisasterRecoveryCandidate;
  readonly target: InventoryRecoveryCheckpointTarget;
  readonly entry: RecoveryCheckpointInventoryEntry;
}

export async function discoverDisasterRecoveryCandidates(input: {
  readonly requestId: string;
  readonly targets: readonly DisasterRecoveryInventoryTarget[];
  readonly signal?: AbortSignal;
}): Promise<readonly DisasterRecoveryCandidate[]> {
  assertRequestId(input.requestId);
  const candidates: {
    readonly displayName: string;
    readonly target: InventoryRecoveryCheckpointTarget;
    readonly entry: RecoveryCheckpointInventoryEntry;
  }[] = [];
  for (const source of input.targets) {
    const displayName = publicTargetName(source.displayName);
    for (const entry of await source.target.inventory(input.requestId, input.signal)) {
      candidates.push({ target: source.target, entry, displayName });
    }
  }
  return candidates
    .sort((left, right) =>
      right.entry.envelope.createdAt.localeCompare(left.entry.envelope.createdAt) ||
      left.entry.targetId.localeCompare(right.entry.targetId) ||
      left.entry.checkpointId.localeCompare(right.entry.checkpointId))
    .map((candidate, index) => {
      return {
        target: candidate.target,
        entry: candidate.entry,
        public: {
          number: index + 1,
          location: candidate.displayName,
          backedUpAt: candidate.entry.envelope.createdAt,
          state: "pending-verification",
        },
      };
    });
}

export function selectDisasterRecoveryCandidate(
  candidates: readonly DisasterRecoveryCandidate[],
  number?: number,
): DisasterRecoveryCandidate {
  if (candidates.length === 0) throw new Error("没有找到完整的恢复备份");
  if (number === undefined) {
    if (candidates.length !== 1) throw new Error("发现多个恢复备份，请按位置和时间选择一个");
    return candidates[0]!;
  }
  if (!Number.isSafeInteger(number) || number < 1 || number > candidates.length) {
    throw new TypeError("恢复备份序号无效");
  }
  return candidates[number - 1]!;
}

function publicTargetName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 120 || /[\r\n\0]/u.test(normalized)) {
    throw new TypeError("恢复备份位置名称无效");
  }
  return normalized;
}

function assertRequestId(value: string): void {
  if (!/^[A-Za-z0-9._:-]{1,192}$/u.test(value)) {
    throw new TypeError("恢复备份发现请求无效");
  }
}
