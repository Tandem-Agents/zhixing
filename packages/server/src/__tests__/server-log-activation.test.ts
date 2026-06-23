import { describe, expect, it, vi } from "vitest";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import type { ServerLogPaths } from "../server-log.js";
import { prepareServerLogForWrite } from "../server-log-activation.js";

async function makePaths(): Promise<ServerLogPaths> {
  const home = await createTempDir("server-log-activation");
  return {
    dirPath: join(home, "logs", "server"),
    activeLogPath: join(home, "logs", "server", "server.log"),
    legacyLogPath: join(home, "server.log"),
  };
}

describe("prepareServerLogForWrite", () => {
  it("initializes the governed active log path when no log exists", async () => {
    const paths = await makePaths();

    const prepared = await prepareServerLogForWrite({ paths });

    expect(prepared.logPath).toBe(paths.activeLogPath);
    expect(prepared.transition.kind).toBe("initialize-active");
    expect(prepared.migratedLegacy).toBe(false);
    expect(await exists(paths.dirPath)).toBe(true);
  });

  it("migrates a legacy log into the governed active path before writing", async () => {
    const paths = await makePaths();
    await writeFile(paths.legacyLogPath, "legacy log", "utf-8");

    const prepared = await prepareServerLogForWrite({ paths });

    expect(prepared.logPath).toBe(paths.activeLogPath);
    expect(prepared.transition.kind).toBe("migrate-legacy");
    expect(prepared.migratedLegacy).toBe(true);
    expect(prepared.removedLegacy).toBe(true);
    expect(await readFile(paths.activeLogPath, "utf-8")).toBe("legacy log");
    expect(await exists(paths.legacyLogPath)).toBe(false);
  });

  it("keeps the active log as the only write target when both paths exist", async () => {
    const paths = await makePaths();
    await mkdir(paths.dirPath, { recursive: true });
    await writeFile(paths.activeLogPath, "active", "utf-8");
    await writeFile(paths.legacyLogPath, "legacy", "utf-8");

    const prepared = await prepareServerLogForWrite({ paths });

    expect(prepared.transition.kind).toBe("use-active");
    expect(prepared.migratedLegacy).toBe(false);
    expect(await readFile(paths.activeLogPath, "utf-8")).toBe("active");
    expect(await readFile(paths.legacyLogPath, "utf-8")).toBe("legacy");
  });

  it("does not fail startup preparation when legacy removal is blocked", async () => {
    const paths = await makePaths();
    await writeFile(paths.legacyLogPath, "legacy", "utf-8");
    const error = vi.fn();

    const prepared = await prepareServerLogForWrite({
      paths,
      logger: { error },
      deps: {
        unlink: vi.fn(async () => {
          throw Object.assign(new Error("locked"), { code: "EACCES" });
        }),
      },
    });

    expect(prepared.logPath).toBe(paths.activeLogPath);
    expect(prepared.migratedLegacy).toBe(true);
    expect(prepared.removedLegacy).toBe(false);
    expect(error).toHaveBeenCalledWith(
      "failed to remove legacy server log after migration",
      expect.any(Error),
    );
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
