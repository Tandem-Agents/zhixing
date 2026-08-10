import type { LogicalRecord } from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";

export const ANCHOR_CANDIDATE_STREAM = "transfer:anchor-candidate";

export type AnchorCandidateMode = "planned" | "disaster-recovery";
export type AnchorCandidateTerminal = "committed" | "aborted" | "released";

export interface TargetWideAnchorCandidateIdentity {
  readonly mode: AnchorCandidateMode;
  readonly homeId: string;
  readonly transferId: string;
  readonly identityDigest: string;
}

export interface TargetWideAnchorCandidateState {
  readonly identity: TargetWideAnchorCandidateIdentity;
  readonly terminal?: AnchorCandidateTerminal;
}

export type TargetWideAnchorCandidateRecord =
  | {
      readonly v: 1;
      readonly t: "anchor-candidate-mode-claimed";
      readonly identity: TargetWideAnchorCandidateIdentity;
    }
  | {
      readonly v: 1;
      readonly t: "anchor-candidate-mode-terminal";
      readonly identity: TargetWideAnchorCandidateIdentity;
      readonly terminal: AnchorCandidateTerminal;
    };

export function emptyTargetWideAnchorCandidates(): ReadonlyMap<
  string,
  TargetWideAnchorCandidateState
> {
  return new Map();
}

export function reduceTargetWideAnchorCandidates(
  current: ReadonlyMap<string, TargetWideAnchorCandidateState>,
  entry: LogicalRecord<unknown>,
): ReadonlyMap<string, TargetWideAnchorCandidateState> {
  if (entry.stream !== ANCHOR_CANDIDATE_STREAM || !isTargetWideRecord(entry.body)) {
    return current;
  }
  return reduceTargetWideAnchorCandidateRecord(current, validateTargetWideRecord(entry.body));
}

export function reduceTargetWideAnchorCandidateRecord(
  current: ReadonlyMap<string, TargetWideAnchorCandidateState>,
  record: TargetWideAnchorCandidateRecord,
): ReadonlyMap<string, TargetWideAnchorCandidateState> {
  const existing = current.get(record.identity.transferId);
  if (record.t === "anchor-candidate-mode-claimed") {
    if (existing) {
      assertTargetWideAnchorCandidateIdentity(existing.identity, record.identity);
      return current;
    }
    for (const candidate of current.values()) {
      if (
        candidate.identity.homeId === record.identity.homeId &&
        candidate.identity.transferId !== record.identity.transferId &&
        candidate.terminal === undefined
      ) {
        throw new Error("Another duty recovery candidate is already in progress");
      }
    }
    const next = new Map(current);
    next.set(record.identity.transferId, { identity: record.identity });
    return next;
  }
  if (!existing) throw new Error("Recovery candidate terminal has no durable claim");
  assertTargetWideAnchorCandidateIdentity(existing.identity, record.identity);
  if (existing.terminal !== undefined) {
    if (existing.terminal !== record.terminal) {
      throw new Error("Recovery candidate terminal decision conflicts with replay");
    }
    return current;
  }
  const next = new Map(current);
  next.set(record.identity.transferId, {
    ...existing,
    terminal: record.terminal,
  });
  return next;
}

export function targetWideAnchorCandidateClaim(
  identity: TargetWideAnchorCandidateIdentity,
): TargetWideAnchorCandidateRecord {
  return { v: 1, t: "anchor-candidate-mode-claimed", identity: validateIdentity(identity) };
}

export function targetWideAnchorCandidateTerminal(
  identity: TargetWideAnchorCandidateIdentity,
  terminal: AnchorCandidateTerminal,
): TargetWideAnchorCandidateRecord {
  if (!(["committed", "aborted", "released"] as const).includes(terminal)) {
    throw new TypeError("Recovery candidate terminal is invalid");
  }
  return {
    v: 1,
    t: "anchor-candidate-mode-terminal",
    identity: validateIdentity(identity),
    terminal,
  };
}

export function assertTargetWideAnchorCandidateAvailable(
  current: ReadonlyMap<string, TargetWideAnchorCandidateState>,
  identity: TargetWideAnchorCandidateIdentity,
): TargetWideAnchorCandidateState | undefined {
  const valid = validateIdentity(identity);
  const exact = current.get(valid.transferId);
  if (exact) {
    assertTargetWideAnchorCandidateIdentity(exact.identity, valid);
    return exact;
  }
  for (const candidate of current.values()) {
    if (candidate.identity.homeId === valid.homeId && candidate.terminal === undefined) {
      throw new Error("Another duty recovery candidate is already in progress");
    }
  }
  return undefined;
}

export function assertTargetWideAnchorCandidateIdentity(
  actual: TargetWideAnchorCandidateIdentity,
  expected: TargetWideAnchorCandidateIdentity,
): void {
  if (canonicalize(actual) !== canonicalize(expected)) {
    throw new Error("Recovery candidate replay conflicts with its durable mode identity");
  }
}

function isTargetWideRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const t = (value as { readonly t?: unknown }).t;
  return t === "anchor-candidate-mode-claimed" || t === "anchor-candidate-mode-terminal";
}

function validateTargetWideRecord(value: unknown): TargetWideAnchorCandidateRecord {
  const record = value as Partial<TargetWideAnchorCandidateRecord> & Record<string, unknown>;
  const expected = record.t === "anchor-candidate-mode-terminal"
    ? ["identity", "t", "terminal", "v"]
    : ["identity", "t", "v"];
  if (
    record.v !== 1 ||
    canonicalize(Object.keys(record).sort()) !== canonicalize(expected) ||
    (record.t !== "anchor-candidate-mode-claimed" &&
      record.t !== "anchor-candidate-mode-terminal")
  ) {
    throw new TypeError("Recovery candidate mode record is invalid");
  }
  const identity = validateIdentity(record.identity);
  if (record.t === "anchor-candidate-mode-claimed") {
    return { v: 1, t: record.t, identity };
  }
  if (!(["committed", "aborted", "released"] as const).includes(
    record.terminal as AnchorCandidateTerminal,
  )) {
    throw new TypeError("Recovery candidate terminal is invalid");
  }
  return {
    v: 1,
    t: record.t,
    identity,
    terminal: record.terminal as AnchorCandidateTerminal,
  };
}

function validateIdentity(value: unknown): TargetWideAnchorCandidateIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Recovery candidate mode identity must be an object");
  }
  const identity = value as Partial<TargetWideAnchorCandidateIdentity> & Record<string, unknown>;
  if (
    canonicalize(Object.keys(identity).sort()) !==
      canonicalize(["homeId", "identityDigest", "mode", "transferId"]) ||
    (identity.mode !== "planned" && identity.mode !== "disaster-recovery") ||
    typeof identity.homeId !== "string" || identity.homeId.length === 0 ||
    typeof identity.transferId !== "string" || identity.transferId.length === 0 ||
    typeof identity.identityDigest !== "string" || identity.identityDigest.length === 0
  ) {
    throw new TypeError("Recovery candidate mode identity is invalid");
  }
  return Object.freeze({
    mode: identity.mode,
    homeId: identity.homeId,
    transferId: identity.transferId,
    identityDigest: identity.identityDigest,
  });
}
