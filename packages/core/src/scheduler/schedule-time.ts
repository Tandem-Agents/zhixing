import { CronExpressionParser } from "cron-parser";
import type { TaskSchedule } from "./types.js";

/** Deterministic next-fire calculation shared by legacy import and anchor scheduler. */
export function nextScheduleTime(
  schedule: TaskSchedule,
  after: Date,
): string | undefined {
  if (!Number.isFinite(after.getTime())) {
    throw new TypeError("Schedule anchor must be a valid date");
  }
  if (schedule.kind === "once") {
    const at = new Date(schedule.at);
    if (!Number.isFinite(at.getTime()) || at.toISOString() !== schedule.at) {
      throw new TypeError("Once schedule must use a canonical ISO timestamp");
    }
    return at.getTime() > after.getTime() ? at.toISOString() : undefined;
  }
  if (schedule.kind === "interval") {
    if (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < 60_000) {
      throw new TypeError("Interval schedule must be at least 60000ms");
    }
    return new Date(after.getTime() + schedule.everyMs).toISOString();
  }
  const next = CronExpressionParser.parse(schedule.expr, {
    currentDate: after,
    ...(schedule.tz ? { tz: schedule.tz } : {}),
  }).next();
  return next.toDate().toISOString();
}

/**
 * Advances a recurring schedule to the first instant strictly after `now`.
 * Work is bounded so corrupt schedules cannot monopolize the owner loop.
 */
export function nextFutureScheduleTime(
  schedule: TaskSchedule,
  previous: string,
  now: Date,
  maxAdvances = 10_000,
): string | undefined {
  if (schedule.kind === "once") return undefined;
  let cursor = new Date(previous);
  if (!Number.isFinite(cursor.getTime()) || cursor.toISOString() !== previous) {
    throw new TypeError("Previous schedule instant must be canonical");
  }
  for (let index = 0; index < maxAdvances; index += 1) {
    const next = nextScheduleTime(schedule, cursor);
    if (!next) return undefined;
    if (Date.parse(next) > now.getTime()) return next;
    cursor = new Date(next);
  }
  throw new Error("Schedule catch-up exceeded its bounded advance limit");
}
