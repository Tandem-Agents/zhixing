/** Finite upgrade observations, supplied by the physical composition root. */
export interface LogWriterIdentity { readonly pid: number; readonly birth: string }
export interface LogWriterObservation {
  readonly complete: boolean;
  readonly at: number;
  /** Current product process, identified by the OS incarnation observed in this scan. */
  readonly self?: LogWriterIdentity;
  /** All possible product writers, including self even when it uses the new protocol.
   * A complete inventory must contain self with the same pid and birth. */
  readonly candidates: readonly LogWriterIdentity[];
}
export interface LegacyLogEntry {
  readonly legacyPath?: string;
  readonly name: string;
  readonly id: string;
  readonly identity: string;
  readonly bytes: number;
  readonly registeredAt: number;
  readonly generation: number;
}
export interface LogMigration {
  readonly state: "pending" | "blocked" | "confirmed";
  readonly checkedAt: number;
  readonly reason?: string;
}
export function isLegacyFile(name: string): boolean { return /^legacy-[a-f0-9]{64}\.log$/u.test(name); }

export function validateWriterObservation(value: LogWriterObservation): boolean {
  const valid = (entry: LogWriterIdentity) => Number.isSafeInteger(entry.pid) && entry.pid > 0 && typeof entry.birth === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(entry.birth);
  return typeof value.complete === "boolean" && Number.isSafeInteger(value.at) && value.at >= 0 &&
    (value.self === undefined || valid(value.self)) && Array.isArray(value.candidates) && value.candidates.length <= 256 && value.candidates.every(valid);
}
