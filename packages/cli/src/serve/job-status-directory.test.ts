import { describe, expect, it, vi } from "vitest";
import type { JobStatusNotice } from "@zhixing/core/contracts";
import {
  JobStatusDirectory,
  type JobStatusSource,
} from "./job-status-directory.js";

describe("JobStatusDirectory", () => {
  it("merges live and catch-up notices while preserving task ownership", async () => {
    const directory = new JobStatusDirectory();
    const fixture = source("task-1");
    directory.register("task-1", fixture.source);
    const live = vi.fn();
    directory.onStatus(live);

    fixture.emit(notice("task-1", "run-1", 1, "running"));
    expect(live).toHaveBeenCalledTimes(1);
    await expect(
      directory.statusHistory([
        { taskId: "task-1", jobRunId: "run-1", afterStatusRevision: 0 },
      ]),
    ).resolves.toEqual({
      notices: [notice("task-1", "run-1", 1, "running")],
      next: [{ taskId: "task-1", jobRunId: "run-1", afterStatusRevision: 1 }],
    });
  });

  it("rejects a source that emits another task identity", () => {
    const directory = new JobStatusDirectory();
    const fixture = source("task-1");
    directory.register("task-1", fixture.source);
    expect(() =>
      fixture.emit(notice("task-2", "run-1", 1, "running")),
    ).toThrow(/different task/);
  });
});

function source(taskId: string): {
  source: JobStatusSource;
  emit(notice: JobStatusNotice): void;
} {
  const listeners = new Set<(notice: JobStatusNotice) => void | Promise<void>>();
  const records = [notice(taskId, "run-1", 1, "running")];
  return {
    source: {
      async statusHistory(jobRunId, after) {
        return records.filter(
          (record) =>
            record.ref.jobRunId === jobRunId &&
            record.statusRevision > after,
        );
      },
      onStatus(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(value) {
      for (const listener of listeners) void listener(value);
    },
  };
}

function notice(
  taskId: string,
  jobRunId: string,
  statusRevision: number,
  state: "running",
): JobStatusNotice {
  return {
    ref: { execution: "job", taskId, jobRunId, anchorEpoch: 1 },
    state,
    statusRevision,
    actions: [],
    at: "2026-07-28T00:00:00.000Z",
  };
}
