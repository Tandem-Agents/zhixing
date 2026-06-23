import { afterEach, describe, expect, it, vi } from "vitest";
import { open, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import {
  SERVER_LOG_ACTIVE_OPEN_FLAGS,
  formatServerLogRotationFileName,
  type ServerLogPaths,
  type ServerLogPolicy,
} from "../server-log.js";
import { ServerLogLifecycle } from "../server-log-lifecycle.js";

const BASE_TIME = new Date(Date.UTC(2026, 5, 23, 4, 5, 6, 7));

function makePolicy(overrides: Partial<ServerLogPolicy> = {}): ServerLogPolicy {
  return {
    activeMaxBytes: 5,
    maxRotatedFiles: 5,
    maxRotatedFileAgeMs: 14 * 24 * 60 * 60 * 1000,
    totalMaxBytes: 1_000,
    ...overrides,
  };
}

async function makePaths(prefix = "server-log-lifecycle"): Promise<ServerLogPaths> {
  const dirPath = await createTempDir(prefix);
  return {
    dirPath,
    activeLogPath: join(dirPath, "server.log"),
    legacyLogPath: join(dirPath, "..", "server.log"),
  };
}

function makeLogger() {
  const errors: Array<{ msg: string; err?: unknown }> = [];
  return {
    errors,
    logger: {
      info: () => undefined,
      error: (msg: string, err?: unknown) => errors.push({ msg, err }),
    },
  };
}

async function writeRotated(
  paths: ServerLogPaths,
  sequence: number,
  content: string,
  mtime: Date,
): Promise<string> {
  const path = join(paths.dirPath, formatServerLogRotationFileName(BASE_TIME, sequence));
  await writeFile(path, content, "utf-8");
  await utimes(path, mtime, mtime);
  return path;
}

describe("ServerLogLifecycle", () => {
  it("rotates oversized active log with copy-truncate and preserves the snapshot", async () => {
    const paths = await makePaths();
    await writeFile(paths.activeLogPath, "abcdef", "utf-8");
    const lifecycle = new ServerLogLifecycle({
      paths,
      policy: makePolicy({ activeMaxBytes: 3 }),
      clock: () => BASE_TIME,
    });

    const result = await lifecycle.runMaintenanceOnce();

    expect(result.errors).toEqual([]);
    expect(result.rotatedPath).toBe(join(paths.dirPath, "server-20260623-040506-007-0000.log"));
    expect(await readFile(result.rotatedPath!, "utf-8")).toBe("abcdef");
    expect(await readFile(paths.activeLogPath, "utf-8")).toBe("");
  });

  it("keeps append-mode fd writes contiguous after truncate rotation", async () => {
    const paths = await makePaths();
    const handle = await open(paths.activeLogPath, SERVER_LOG_ACTIVE_OPEN_FLAGS);
    try {
      await handle.write("abcdef");
      const lifecycle = new ServerLogLifecycle({
        paths,
        policy: makePolicy({ activeMaxBytes: 3 }),
        clock: () => BASE_TIME,
      });

      await lifecycle.runMaintenanceOnce();
      await handle.write("Z");
    } finally {
      await handle.close();
    }

    const active = await readFile(paths.activeLogPath);
    expect(active.equals(Buffer.from("Z"))).toBe(true);
    expect((await stat(paths.activeLogPath)).size).toBe(1);
  });

  it("allocates a new rotation name when the first timestamp sequence exists", async () => {
    const paths = await makePaths();
    await writeFile(paths.activeLogPath, "abcdef", "utf-8");
    await writeFile(join(paths.dirPath, "server-20260623-040506-007-0000.log"), "old", "utf-8");
    const lifecycle = new ServerLogLifecycle({
      paths,
      policy: makePolicy({ activeMaxBytes: 3 }),
      clock: () => BASE_TIME,
    });

    const result = await lifecycle.runMaintenanceOnce();

    expect(result.rotatedPath).toBe(join(paths.dirPath, "server-20260623-040506-007-0001.log"));
    expect(await readFile(result.rotatedPath!, "utf-8")).toBe("abcdef");
  });

  it("does not rotate missing or within-budget active logs", async () => {
    const paths = await makePaths();
    const missingLifecycle = new ServerLogLifecycle({
      paths,
      policy: makePolicy({ activeMaxBytes: 3 }),
      clock: () => BASE_TIME,
    });

    expect((await missingLifecycle.runMaintenanceOnce()).rotatedPath).toBeUndefined();

    await writeFile(paths.activeLogPath, "abc", "utf-8");
    const withinBudget = await missingLifecycle.runMaintenanceOnce();

    expect(withinBudget.rotatedPath).toBeUndefined();
    expect(await readFile(paths.activeLogPath, "utf-8")).toBe("abc");
  });

  it("prunes expired rotated logs before count-limited retained logs", async () => {
    const paths = await makePaths();
    await writeFile(paths.activeLogPath, "active", "utf-8");
    const old = await writeRotated(paths, 0, "old", new Date(BASE_TIME.getTime() - 10_000));
    const keep1 = await writeRotated(paths, 1, "keep1", new Date(BASE_TIME.getTime() - 2_000));
    const keep2 = await writeRotated(paths, 2, "keep2", new Date(BASE_TIME.getTime() - 1_000));
    const lifecycle = new ServerLogLifecycle({
      paths,
      policy: makePolicy({ activeMaxBytes: 999, maxRotatedFiles: 2, maxRotatedFileAgeMs: 5_000 }),
      clock: () => BASE_TIME,
    });

    const result = await lifecycle.runMaintenanceOnce();

    expect(result.deletedPaths.sort()).toEqual([old].sort());
    expect((await readdir(paths.dirPath)).sort()).toEqual(
      ["server.log", keep1, keep2].map((p) => p.split(/[\\/]/).at(-1)!).sort(),
    );
  });

  it("prunes oldest retained logs when count exceeds the policy", async () => {
    const paths = await makePaths();
    await writeFile(paths.activeLogPath, "active", "utf-8");
    const deleted = await writeRotated(paths, 0, "delete", new Date(BASE_TIME.getTime() - 3_000));
    const keep1 = await writeRotated(paths, 1, "keep1", new Date(BASE_TIME.getTime() - 2_000));
    const keep2 = await writeRotated(paths, 2, "keep2", new Date(BASE_TIME.getTime() - 1_000));
    const lifecycle = new ServerLogLifecycle({
      paths,
      policy: makePolicy({ activeMaxBytes: 999, maxRotatedFiles: 2 }),
      clock: () => BASE_TIME,
    });

    const result = await lifecycle.runMaintenanceOnce();

    expect(result.deletedPaths).toEqual([deleted]);
    const names = await readdir(paths.dirPath);
    expect(names).toContain(keep1.split(/[\\/]/).at(-1)!);
    expect(names).toContain(keep2.split(/[\\/]/).at(-1)!);
  });

  it("prunes oldest rotated logs until the directory total fits the policy", async () => {
    const paths = await makePaths();
    await writeFile(paths.activeLogPath, "12345", "utf-8");
    const delete1 = await writeRotated(paths, 0, "aaaaa", new Date(BASE_TIME.getTime() - 3_000));
    const delete2 = await writeRotated(paths, 1, "bbbbb", new Date(BASE_TIME.getTime() - 2_000));
    const keep = await writeRotated(paths, 2, "ccccc", new Date(BASE_TIME.getTime() - 1_000));
    const lifecycle = new ServerLogLifecycle({
      paths,
      policy: makePolicy({ activeMaxBytes: 999, maxRotatedFiles: 10, totalMaxBytes: 10 }),
      clock: () => BASE_TIME,
    });

    const result = await lifecycle.runMaintenanceOnce();

    expect(result.deletedPaths.sort()).toEqual([delete1, delete2].sort());
    expect(await readFile(keep, "utf-8")).toBe("ccccc");
  });

  it("reports rotation errors without throwing through maintenance", async () => {
    const paths = await makePaths();
    await writeFile(paths.activeLogPath, "abcdef", "utf-8");
    const { logger, errors } = makeLogger();
    const lifecycle = new ServerLogLifecycle({
      paths,
      policy: makePolicy({ activeMaxBytes: 3 }),
      clock: () => BASE_TIME,
      logger,
      deps: {
        copyFile: async () => {
          throw Object.assign(new Error("copy failed"), { code: "EACCES" });
        },
      },
    });

    const result = await lifecycle.runMaintenanceOnce();

    expect(result.rotatedPath).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.stage).toBe("rotate");
    expect(errors[0]?.msg).toBe("server log rotation failed");
    expect(await readFile(paths.activeLogPath, "utf-8")).toBe("abcdef");
  });

  it("reports preparation errors without throwing through maintenance", async () => {
    const paths = await makePaths();
    const { logger, errors } = makeLogger();
    const lifecycle = new ServerLogLifecycle({
      paths,
      policy: makePolicy(),
      clock: () => BASE_TIME,
      logger,
      deps: {
        mkdir: async () => {
          throw Object.assign(new Error("mkdir failed"), { code: "EACCES" });
        },
      },
    });

    const result = await lifecycle.runMaintenanceOnce();

    expect(result.deletedPaths).toEqual([]);
    expect(result.rotatedPath).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.stage).toBe("prepare");
    expect(errors[0]?.msg).toBe("server log lifecycle preparation failed");
  });

  it("continues pruning when deleting one rotated log fails", async () => {
    const paths = await makePaths();
    await writeFile(paths.activeLogPath, "active", "utf-8");
    const failDelete = await writeRotated(paths, 0, "old1", new Date(BASE_TIME.getTime() - 3_000));
    const okDelete = await writeRotated(paths, 1, "old2", new Date(BASE_TIME.getTime() - 2_000));
    const { logger, errors } = makeLogger();
    const lifecycle = new ServerLogLifecycle({
      paths,
      policy: makePolicy({ activeMaxBytes: 999, maxRotatedFiles: 0 }),
      clock: () => BASE_TIME,
      logger,
      deps: {
        unlink: async (path) => {
          if (path === failDelete) throw Object.assign(new Error("unlink failed"), { code: "EACCES" });
          await unlinkFromFs(path);
        },
      },
    });

    const result = await lifecycle.runMaintenanceOnce();

    expect(result.errors).toEqual([]);
    expect(result.deletedPaths).toEqual([okDelete]);
    expect(errors[0]?.msg).toContain("failed to delete rotated server log");
    expect(await readFile(failDelete, "utf-8")).toBe("old1");
  });

  it("start runs startup maintenance and registers one periodic check", async () => {
    const paths = await makePaths();
    await writeFile(paths.activeLogPath, "abcdef", "utf-8");
    const intervalHandles: unknown[] = [];
    const setIntervalSpy = vi.fn((callback: () => void, _ms?: number) => {
      const handle = { callback, unref: vi.fn() };
      intervalHandles.push(handle);
      return handle as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSpy = vi.fn();
    const lifecycle = new ServerLogLifecycle({
      paths,
      policy: makePolicy({ activeMaxBytes: 3 }),
      checkIntervalMs: 1234,
      clock: () => BASE_TIME,
      deps: {
        setInterval: setIntervalSpy as unknown as typeof setInterval,
        clearInterval: clearIntervalSpy as unknown as typeof clearInterval,
      },
    });

    const startup = await lifecycle.start();
    const secondStart = await lifecycle.start();

    expect(startup.rotatedPath).toBe(join(paths.dirPath, "server-20260623-040506-007-0000.log"));
    expect(secondStart.rotatedPath).toBeUndefined();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1234);
    expect((intervalHandles[0] as { unref: ReturnType<typeof vi.fn> }).unref).toHaveBeenCalledTimes(
      1,
    );
    expect(clearIntervalSpy).not.toHaveBeenCalled();
  });

  it("stop clears the periodic check and is idempotent", async () => {
    const paths = await makePaths();
    const intervalHandle = { unref: vi.fn() };
    const setIntervalSpy = vi.fn(
      () => intervalHandle as unknown as ReturnType<typeof setInterval>,
    );
    const clearIntervalSpy = vi.fn();
    const lifecycle = new ServerLogLifecycle({
      paths,
      policy: makePolicy(),
      clock: () => BASE_TIME,
      deps: {
        setInterval: setIntervalSpy as unknown as typeof setInterval,
        clearInterval: clearIntervalSpy as unknown as typeof clearInterval,
      },
    });

    await lifecycle.start();
    lifecycle.stop();
    lifecycle.stop();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalHandle);
  });
});

async function unlinkFromFs(path: string): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  await unlink(path);
}
