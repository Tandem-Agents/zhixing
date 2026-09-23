/** Observation evidence only. Producers receive LogRecordPort, never a Store or reader. */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogTier = "critical" | "detail";
export type LogResult = "success" | "failure" | "unknown" | "refused" | "cancelled";
export type LogGapKind = "expired" | "not-collected" | "unavailable" | "insufficient";
export interface LogRef {
  readonly kind: string;
  readonly id: string;
  readonly storeId?: string;
}
export interface LogAccess {
  readonly scope: string;
}
export interface LogGap {
  readonly kind: LogGapKind;
  readonly reason: string;
}
export type LogValue =
  | null
  | boolean
  | number
  | string
  | readonly LogValue[]
  | { readonly [key: string]: LogValue };
export interface LogDetailRef {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface LogRecord {
  readonly schema: 1;
  readonly id: string;
  readonly storeId: string;
  readonly process: string;
  readonly seq: number;
  readonly occurredAt: number;
  readonly receivedAt: number;
  readonly source: string;
  readonly sourceVersion: number;
  readonly event: string;
  readonly level: LogLevel;
  readonly tier: LogTier;
  readonly refs: readonly LogRef[];
  readonly access: LogAccess;
  readonly message: string;
  readonly result?: LogResult;
  readonly data: Readonly<Record<string, LogValue>>;
  readonly detail?: LogDetailRef;
  readonly gaps?: readonly LogGap[];
  readonly redacted?: boolean;
  readonly truncated?: boolean;
  readonly repeat?: { readonly count: number; readonly until: number };
}
export type CapturedLogRecord = Omit<LogRecord, "storeId" | "receivedAt" | "detail">;
export interface LogCapture {
  readonly record: CapturedLogRecord;
  readonly detail?: string;
}
export interface LogDraft {
  readonly event: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly refs?: readonly LogRef[];
  readonly result?: LogResult;
}
export interface LogRecordPort {
  record(draft: LogDraft): void;
}
export type LogField =
  | "text"
  | "number"
  | "boolean"
  | "secret"
  | { readonly fields: Readonly<Record<string, LogField>> }
  | { readonly items: LogField; readonly maxItems: number };
export interface LogEventDefinition {
  readonly message: string;
  readonly level: LogLevel;
  readonly tier: LogTier;
  /** Only these fields may leave the producer. Secret fields are always discarded. */
  readonly fields: Readonly<Record<string, LogField>>;
}
export interface LogSource {
  readonly id: string;
  readonly version: number;
  readonly events: Readonly<Record<string, LogEventDefinition>>;
}
export interface LogHealth {
  readonly state: "starting" | "ready" | "degraded" | "closed";
  readonly queued: number;
  readonly queuedBytes: number;
  readonly lost: number;
  readonly captureFailures: number;
  readonly unconfirmed: number;
  readonly lastFailure?: string;
}
export interface LogPolicy {
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly criticalTtlMs: number;
  readonly detailTtlMs: number;
  readonly attachmentTtlMs: number;
  readonly segmentBytes: number;
  readonly segmentAgeMs: number;
  readonly recordBytes: number;
  readonly attachmentBytes: number;
  readonly queueBytes: number;
  readonly queueRecords: number;
  readonly sourceQueueRecords: number;
  readonly queryScanBytes: number;
  readonly queryResultBytes: number;
  readonly queryRecords: number;
  readonly queryMs: number;
  readonly governanceBytes: number;
  readonly maintenanceMs: number;
}
export interface LogPolicyState {
  readonly version: number;
  readonly effective: LogPolicy;
  readonly desired?: LogPolicy;
  readonly blocked?: string;
}
export interface LogStatus {
  readonly storeId: string;
  readonly layout: "zxlog/1";
  readonly policy: LogPolicyState;
  readonly bytes: number;
  readonly files: number;
  readonly retainedSegments: number;
  readonly pendingReclaims: number;
  readonly overdue: boolean;
  readonly upper: number;
}
export interface LogFilter {
  readonly from?: number;
  readonly until?: number;
  readonly source?: string;
  readonly level?: LogLevel;
  readonly ref?: LogRef;
  readonly id?: string;
}
export interface LogReadContext {
  readonly subject: string;
  readonly revision: string;
  readonly manageStorage: boolean;
  /** Whole-store readers may be explicitly denied policy changes by their trusted surface. */
  readonly managePolicy?: boolean;
  readonly scopes: readonly string[];
}
export interface LogPage {
  readonly records: readonly LogRecord[];
  readonly gaps: readonly LogGap[];
  readonly cursor?: string;
  readonly coverage: {
    /** Fixed query bound: storage ordinal for managers, authorized record count otherwise. */
    readonly upper: number;
    /** Bytes scanned in the authorized query view, including authorized detail reads. */
    readonly scannedBytes: number;
    readonly complete: boolean;
  };
}
export interface LogSink {
  initialize(): Promise<LogStatus>;
  append(records: readonly LogCapture[]): Promise<LogAppendReceipt>;
  maintain(): Promise<LogStatus>;
  close(): Promise<void>;
}
/** Successful append acknowledges durability, independently of subsequent owner cleanup. */
export interface LogAppendReceipt {
  readonly policy: LogPolicyState;
  readonly storageDegraded?: boolean;
}

/** A physical write may have published; callers must not replay this observation batch. */
export class LogAppendIndeterminateError extends Error {
  constructor() {
    super("日志批次保存状态不确定");
    this.name = "LogAppendIndeterminateError";
  }
}
