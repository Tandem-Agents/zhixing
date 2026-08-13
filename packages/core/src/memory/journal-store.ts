/** Path-free journal lifecycle planning over global memory authority DTOs. */

import type { JsonValue } from "../contracts/index.js";
import type { Digest } from "../types/distributed.js";
import { isSubstantiveJournalContent } from "./canonical-identity.js";

// ─── 类型 ───

export interface JournalStats {
  hotCount: number;
  warmCount: number;
  condensedCount: number;
  totalFiles: number;
}

/** Path-free journal fact consumed by authority-backed lifecycle planning. */
export interface JournalLifecycleEntry {
  id: string;
  meta: Record<string, JsonValue>;
  content: string;
  digest: Digest;
}

export interface JournalLifecycleMonth {
  month: string;
  sources: JournalLifecycleEntry[];
  target?: JournalLifecycleEntry;
}

export interface JournalAuthorityLifecyclePlan {
  expired: JournalLifecycleEntry[];
  condense: JournalLifecycleMonth[];
  stats: JournalStats;
}

export interface JournalConfig {
  /** 日志保留天数，超过此天数的日志参与凝练（默认 30） */
  dailyRetentionDays: number;
  /** 月度凝练保留月数（默认 12） */
  condensedRetentionMonths: number;
}

type JournalPhase = "hot" | "warm" | "condensed" | "expired";

const DEFAULT_CONFIG: JournalConfig = {
  dailyRetentionDays: 30,
  condensedRetentionMonths: 12,
};

/**
 * Pure lifecycle planner. It consumes logical authority DTOs only; paths and
 * filesystem state cannot influence the decision.
 */
export function planJournalLifecycle(
  entries: readonly JournalLifecycleEntry[],
  options: {
    now?: Date;
    config?: Partial<JournalConfig>;
  } = {},
): JournalAuthorityLifecyclePlan {
  const now = options.now ?? new Date();
  const config = { ...DEFAULT_CONFIG, ...options.config };
  if (
    !Number.isFinite(now.getTime()) ||
    !Number.isSafeInteger(config.dailyRetentionDays) ||
    config.dailyRetentionDays < 0 ||
    !Number.isSafeInteger(config.condensedRetentionMonths) ||
    config.condensedRetentionMonths < 0
  ) {
    throw new TypeError("Journal lifecycle configuration is invalid");
  }
  const expired: JournalLifecycleEntry[] = [];
  const warm = new Map<string, JournalLifecycleEntry[]>();
  const targets = new Map<string, JournalLifecycleEntry>();
  let hotCount = 0;
  let warmCount = 0;
  let condensedCount = 0;
  const seenIds = new Set<string>();

  for (const source of [...entries].sort((left, right) =>
    left.id.localeCompare(right.id, "en-US")
  )) {
    const entry = structuredClone(source);
    assertJournalLifecycleEntry(entry, seenIds);
    if (!isSubstantiveJournalContent(entry.content)) {
      expired.push(entry);
      continue;
    }
    const phase = classifyJournalPhase(entry.id, entry.meta, now, config);
    if (entry.meta.condensed === true) {
      targets.set(journalDate(entry), entry);
    }
    if (phase === "hot") {
      hotCount++;
      continue;
    }
    if (phase === "warm") {
      warmCount++;
      const month = journalDate(entry).slice(0, 7);
      const group = warm.get(month) ?? [];
      group.push(entry);
      warm.set(month, group);
      continue;
    }
    if (phase === "condensed") {
      condensedCount++;
      continue;
    }
    expired.push(entry);
  }

  return {
    expired,
    condense: [...warm.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en-US"))
      .map(([month, sources]) => ({
        month,
        sources,
        ...(targets.get(month) ? { target: targets.get(month)! } : {}),
      })),
    stats: {
      hotCount,
      warmCount,
      condensedCount,
      totalFiles: entries.length,
    },
  };
}

function journalDate(entry: Pick<JournalLifecycleEntry, "id" | "meta">): string {
  const date = entry.meta.date;
  return typeof date === "string" ? date : entry.id;
}

function assertJournalLifecycleEntry(
  entry: JournalLifecycleEntry,
  seenIds: Set<string>,
): void {
  const date = journalDate(entry);
  const condensed = entry.meta.condensed === true;
  if (
    seenIds.has(entry.id) ||
    date !== entry.id ||
    !(condensed ? isCalendarMonth(date) : isCalendarDay(date)) ||
    !/^sha256:[a-f0-9]{64}$/u.test(entry.digest)
  ) {
    throw new TypeError("Journal lifecycle entry is invalid");
  }
  seenIds.add(entry.id);
}

function isCalendarMonth(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(value)) return false;
  const parsed = new Date(`${value}-01T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 7) === value;
}

function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/u.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function classifyJournalPhase(
  id: string,
  meta: Record<string, JsonValue>,
  now: Date,
  config: JournalConfig,
): JournalPhase {
  const date = typeof meta.date === "string" ? meta.date : id;
  if (meta.condensed === true) {
    const monthDate = new Date(`${date}-01T00:00:00.000Z`);
    const monthsAgo = (now.getUTCFullYear() - monthDate.getUTCFullYear()) * 12
      + (now.getUTCMonth() - monthDate.getUTCMonth());
    return monthsAgo > config.condensedRetentionMonths ? "expired" : "condensed";
  }
  const entryDate = new Date(`${date}T00:00:00.000Z`);
  const daysAgo = Math.floor((now.getTime() - entryDate.getTime()) / 86_400_000);
  return daysAgo <= config.dailyRetentionDays ? "hot" : "warm";
}
