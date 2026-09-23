import { LogRequestError } from "./errors.js";
import type { LogPolicy } from "./contracts.js";

const MIB = 1024 * 1024;
const DAY = 86_400_000;
export const MAX_LOG_RECORD_BYTES = 256 * 1024;
export const MAX_LOG_QUERY_RESULT_BYTES = 4 * MIB;
export const DEFAULT_LOG_POLICY: Readonly<LogPolicy> = Object.freeze({
  maxBytes: 256 * MIB,
  maxFiles: 1024,
  criticalTtlMs: 30 * DAY,
  detailTtlMs: 7 * DAY,
  attachmentTtlMs: 3 * DAY,
  segmentBytes: 2 * MIB,
  segmentAgeMs: 30 * 60_000,
  recordBytes: 32 * 1024,
  attachmentBytes: 256 * 1024,
  queueBytes: 2 * MIB,
  queueRecords: 512,
  sourceQueueRecords: 128,
  queryScanBytes: 2 * MIB,
  queryResultBytes: 256 * 1024,
  queryRecords: 100,
  queryMs: 1000,
  governanceBytes: 2 * MIB,
  maintenanceMs: 30_000,
});

export function validateLogPolicy(input: LogPolicy): LogPolicy {
  const result = {} as Record<keyof LogPolicy, number>;
  for (const key of Object.keys(DEFAULT_LOG_POLICY) as (keyof LogPolicy)[]) {
    const value = input[key];
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new LogRequestError(`日志策略 ${key} 必须是正整数`);
    result[key] = value;
  }
  if (
    result.maxFiles < 16 ||
    result.maxFiles > 4096 ||
    result.governanceBytes < 64 * 1024 ||
    result.governanceBytes > 12 * MIB ||
    result.maxBytes < result.governanceBytes * 2 + result.segmentBytes + result.attachmentBytes ||
    result.maxBytes > 64 * 1024 * MIB ||
    result.governanceBytes < result.maxFiles * 2048 ||
    result.recordBytes < 2048 ||
    result.recordBytes > 256 * 1024 ||
    result.recordBytes > result.segmentBytes ||
    result.segmentBytes > 8 * MIB ||
    result.attachmentBytes > MIB ||
    result.queueBytes < result.recordBytes ||
    result.queueBytes > 16 * MIB ||
    result.queueRecords < 2 ||
    result.queueRecords > 4096 ||
    result.sourceQueueRecords > result.queueRecords ||
    result.queryScanBytes < MAX_LOG_RECORD_BYTES ||
    result.queryScanBytes > 16 * MIB ||
    result.queryResultBytes < Math.max(result.recordBytes, 4096) ||
    result.queryResultBytes > MAX_LOG_QUERY_RESULT_BYTES ||
    result.queryRecords > 1000 ||
    result.queryMs > 10_000 ||
    result.maintenanceMs > 2_147_483_647 ||
    result.detailTtlMs > result.criticalTtlMs ||
    result.attachmentTtlMs > result.criticalTtlMs
  ) {
    throw new LogRequestError("日志策略限额或保留期限不一致");
  }
  return Object.freeze(result);
}
