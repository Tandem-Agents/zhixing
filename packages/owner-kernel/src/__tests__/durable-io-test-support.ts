import type { FileAuthorityCommitLog } from "@zhixing/core/authority";
import { onTestFinished } from "vitest";

export const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;

/**
 * Register after createTempDir so Vitest's reverse cleanup order stops the
 * authority log before the directory cleanup runs.
 */
export function trackAuthorityLog<T extends FileAuthorityCommitLog>(log: T): T {
  onTestFinished(() => log.stopStorageMaintenance());
  return log;
}
