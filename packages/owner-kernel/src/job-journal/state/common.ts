import { Buffer } from "node:buffer";
import {
  AuthorityStorageError,
  collectArtifactRefs,
  MAX_INLINE_LOGICAL_RECORD_BYTES,
  type ArtifactStore,
} from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AssignmentTerminationProof,
  AuthorityError,
  ControlResult,
  JobRunState,
  LogicalRecord,
} from "@zhixing-ai/core/contracts";
import { canonicalize } from "@zhixing-ai/core/protocol";
import type { Stored } from "../../conversation-run-contracts.js";
import {
  corruptJobJournal,
  isTerminalJobState,
  type JobJournalRecord,
} from "../../job-run-contracts.js";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends ReadonlySet<infer V>
      ? ReadonlySet<DeepReadonly<V>>
      : T extends readonly (infer U)[]
        ? readonly DeepReadonly<U>[]
        : T extends object
          ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
          : T;

export function jobStream(taskId: string): string {
  return `job:${taskId}`;
}

export function jobRecordFits(body: JobJournalRecord): boolean {
  return (
    Buffer.byteLength(canonicalize(body), "utf8") <=
    MAX_INLINE_LOGICAL_RECORD_BYTES
  );
}

export function assertJobRecordFits(body: JobJournalRecord): void {
  if (!jobRecordFits(body)) {
    throw new TypeError("Job journal record exceeds the durable record limit");
  }
}

export function jobRecord(
  taskId: string,
  body: JobJournalRecord,
): LogicalRecord<JobJournalRecord> {
  assertJobRecordFits(body);
  return { stream: jobStream(taskId), body };
}

export function stateRecord(
  taskId: string,
  jobRunId: string,
  state: JobRunState,
  statusRevision: number,
  assignmentId?: string,
  usageFinal?: { readonly reportDigest: string; readonly upToUsageSeq: number },
): LogicalRecord<JobJournalRecord> {
  return jobRecord(taskId, {
    t: "state",
    jobRunId,
    ...(assignmentId === undefined ? {} : { assignmentId }),
    ...(usageFinal === undefined ? {} : { usageFinal: snapshot(usageFinal) }),
    state,
    statusRevision,
  });
}

export interface PreparedJobStored<T> {
  readonly stored: Stored<T>;
  readonly references: readonly ArtifactRef[];
}

export async function prepareJobStored<T>(
  value: T,
  containingRecord: (stored: Stored<T>) => JobJournalRecord,
  artifacts: ArtifactStore,
): Promise<PreparedJobStored<T>> {
  const inlineRecord = containingRecord(value);
  if (jobRecordFits(inlineRecord)) {
    return { stored: value, references: [] };
  }
  const bytes = Buffer.from(canonicalize(value), "utf8");
  const ref = await artifacts.put(bytes);
  const stored = { ref };
  assertJobRecordFits(containingRecord(stored));
  return { stored, references: [ref] };
}

function isStoredJobReference<T>(
  value: Stored<T>,
): value is { readonly ref: ArtifactRef } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "ref" in value
  );
}

export async function loadJobStored<T>(
  stored: Stored<T>,
  artifacts: ArtifactStore,
  label: string,
): Promise<T> {
  if (!isStoredJobReference(stored)) {
    return snapshot(stored);
  }
  const text = Buffer.from(await artifacts.get(stored.ref)).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AuthorityStorageError(
      "invalid-authority-record",
      `${label} artifact is not valid JSON`,
      { cause: error },
    );
  }
  if (canonicalize(parsed) !== text) {
    throw corruptJobJournal(`${label} artifact is not canonical`);
  }
  return parsed as T;
}

export function revokedCapabilityKey(assignmentId: string, capId: string): string {
  return `${assignmentId}\0${capId}`;
}

export function rejected(
  code: AuthorityError["code"],
  message: string,
  retryable: boolean,
): { readonly committed: false; readonly error: AuthorityError } {
  return { committed: false, error: { code, message, retryable } };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.slice(0, 65_536);
  }
  return "System job handler failed";
}

export function rejectedControl(
  code: AuthorityError["code"],
  message: string,
): Extract<ControlResult, { status: "rejected" }> {
  return {
    v: 1,
    status: "rejected",
    error: { code, message, retryable: false },
  };
}

export async function assertArtifactsPresent(
  value: unknown,
  artifacts: ArtifactStore,
): Promise<ArtifactRef[]> {
  const references = collectArtifactRefs(value);
  for (const reference of references) {
    if (!(await artifacts.has(reference))) {
      throw new TypeError(`Dispatch dependency is not present: ${reference.digest}`);
    }
  }
  return references;
}

export function isTerminal(state: JobRunState): boolean {
  return isTerminalJobState(state);
}

export function isTaggedJobRecord(value: unknown): value is JobJournalRecord {
  return typeof value === "object" && value !== null && "t" in value;
}

export function withoutSignature<T extends { signature: unknown }>(
  value: T,
): Omit<T, "signature"> {
  const { signature: _, ...payload } = value;
  return payload;
}

export function sameTerminationProofIdentity(
  left: AssignmentTerminationProof,
  right: AssignmentTerminationProof,
): boolean {
  return (
    canonicalize(withoutSignature(left)) ===
    canonicalize(withoutSignature(right))
  );
}

export function assertPositive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

export function assertCanonicalTime(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}

export function snapshot<T>(value: T): T {
  return structuredClone(value);
}

export function assertNever(value: never): never {
  throw corruptJobJournal(`Unknown job journal record: ${canonicalize(value)}`);
}
