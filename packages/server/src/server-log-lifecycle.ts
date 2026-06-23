import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  stat,
  truncate,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_SERVER_LOG_POLICY,
  formatServerLogRotationFileName,
  getDefaultServerLogPaths,
  isServerLogRotationFileName,
  type ServerLogPaths,
  type ServerLogPolicy,
} from "./server-log.js";

export interface ServerLogLifecycleLogger {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
}

export interface ServerLogLifecycleDeps {
  mkdir: typeof mkdir;
  stat: typeof stat;
  readdir: typeof readdir;
  copyFile: typeof copyFile;
  truncate: typeof truncate;
  unlink: typeof unlink;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

export interface ServerLogLifecycleOptions {
  paths?: ServerLogPaths;
  policy?: ServerLogPolicy;
  checkIntervalMs?: number;
  clock?: () => Date;
  logger?: ServerLogLifecycleLogger;
  deps?: Partial<ServerLogLifecycleDeps>;
}

export interface ServerLogMaintenanceError {
  stage: "prepare" | "rotate" | "prune";
  error: unknown;
}

export interface ServerLogMaintenanceResult {
  rotatedPath?: string;
  deletedPaths: string[];
  errors: ServerLogMaintenanceError[];
}

interface RotatedLogEntry {
  path: string;
  fileName: string;
  size: number;
  mtimeMs: number;
}

const DEFAULT_CHECK_INTERVAL_MS = 60_000;

export class ServerLogLifecycle {
  private readonly paths: ServerLogPaths;
  private readonly policy: ServerLogPolicy;
  private readonly checkIntervalMs: number;
  private readonly clock: () => Date;
  private readonly logger: ServerLogLifecycleLogger;
  private readonly deps: ServerLogLifecycleDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(opts: ServerLogLifecycleOptions = {}) {
    this.paths = opts.paths ?? getDefaultServerLogPaths();
    this.policy = opts.policy ?? DEFAULT_SERVER_LOG_POLICY;
    this.checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.clock = opts.clock ?? (() => new Date());
    this.logger = opts.logger ?? {
      error: (msg, err) => console.error(`[server-log] ${msg}`, err ?? ""),
    };
    this.deps = {
      mkdir,
      stat,
      readdir,
      copyFile,
      truncate,
      unlink,
      setInterval,
      clearInterval,
      ...opts.deps,
    };
  }

  async start(): Promise<ServerLogMaintenanceResult> {
    const startup = await this.runMaintenanceOnce();
    if (this.timer !== null) return startup;

    this.timer = this.deps.setInterval(() => {
      void this.runMaintenanceOnce();
    }, this.checkIntervalMs);
    this.timer.unref?.();
    return startup;
  }

  stop(): void {
    if (this.timer === null) return;
    this.deps.clearInterval(this.timer);
    this.timer = null;
  }

  async runMaintenanceOnce(): Promise<ServerLogMaintenanceResult> {
    if (this.running) {
      return { deletedPaths: [], errors: [] };
    }
    this.running = true;
    const result: ServerLogMaintenanceResult = { deletedPaths: [], errors: [] };
    try {
      try {
        await this.ensureLogDir();
      } catch (error) {
        result.errors.push({ stage: "prepare", error });
        this.logger.error("server log lifecycle preparation failed", error);
        return result;
      }

      try {
        result.rotatedPath = await this.rotateActiveLogIfNeeded();
      } catch (error) {
        result.errors.push({ stage: "rotate", error });
        this.logger.error("server log rotation failed", error);
      }

      try {
        result.deletedPaths = await this.pruneRotatedLogs();
      } catch (error) {
        result.errors.push({ stage: "prune", error });
        this.logger.error("server log pruning failed", error);
      }
    } finally {
      this.running = false;
    }
    return result;
  }

  private async ensureLogDir(): Promise<void> {
    await this.deps.mkdir(this.paths.dirPath, { recursive: true });
  }

  private async rotateActiveLogIfNeeded(): Promise<string | undefined> {
    const active = await statIfExists(this.deps, this.paths.activeLogPath);
    if (!active || active.size <= this.policy.activeMaxBytes) return undefined;

    const rotatedPath = await this.copyActiveLogToRotation();
    await this.deps.truncate(this.paths.activeLogPath, 0);
    this.logger.info?.(`server log rotated to ${rotatedPath}`);
    return rotatedPath;
  }

  private async copyActiveLogToRotation(): Promise<string> {
    const createdAt = this.clock();
    for (let sequence = 0; sequence < 10_000; sequence++) {
      const rotatedPath = join(
        this.paths.dirPath,
        formatServerLogRotationFileName(createdAt, sequence),
      );
      try {
        await this.deps.copyFile(
          this.paths.activeLogPath,
          rotatedPath,
          fsConstants.COPYFILE_EXCL,
        );
        return rotatedPath;
      } catch (error) {
        if (isNodeErrorCode(error, "EEXIST")) continue;
        throw error;
      }
    }
    throw new Error("Unable to allocate a unique server log rotation file name");
  }

  private async pruneRotatedLogs(): Promise<string[]> {
    const entries = await this.collectRotatedLogs();
    const toDelete = new Set<string>();
    const nowMs = this.clock().getTime();

    for (const entry of entries) {
      if (nowMs - entry.mtimeMs > this.policy.maxRotatedFileAgeMs) {
        toDelete.add(entry.path);
      }
    }

    const byOldest = [...entries].sort(compareRotatedLogs);
    let kept = byOldest.filter((entry) => !toDelete.has(entry.path));
    while (kept.length > this.policy.maxRotatedFiles) {
      const entry = kept.shift();
      if (!entry) break;
      toDelete.add(entry.path);
    }

    const active = await statIfExists(this.deps, this.paths.activeLogPath);
    let totalBytes = (active?.size ?? 0) + kept.reduce((sum, entry) => sum + entry.size, 0);
    while (totalBytes > this.policy.totalMaxBytes && kept.length > 0) {
      const entry = kept.shift()!;
      toDelete.add(entry.path);
      totalBytes -= entry.size;
    }

    const deleted: string[] = [];
    for (const path of toDelete) {
      try {
        await this.deps.unlink(path);
        deleted.push(path);
      } catch (error) {
        this.logger.error(`failed to delete rotated server log ${path}`, error);
      }
    }
    return deleted;
  }

  private async collectRotatedLogs(): Promise<RotatedLogEntry[]> {
    let names: string[];
    try {
      names = await this.deps.readdir(this.paths.dirPath);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return [];
      throw error;
    }

    const entries: RotatedLogEntry[] = [];
    for (const fileName of names) {
      if (!isServerLogRotationFileName(fileName)) continue;
      const path = join(this.paths.dirPath, fileName);
      try {
        const s = await this.deps.stat(path);
        entries.push({ path, fileName, size: s.size, mtimeMs: s.mtimeMs });
      } catch (error) {
        this.logger.error(`failed to stat rotated server log ${path}`, error);
      }
    }
    return entries;
  }
}

async function statIfExists(
  deps: Pick<ServerLogLifecycleDeps, "stat">,
  path: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await deps.stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function compareRotatedLogs(a: RotatedLogEntry, b: RotatedLogEntry): number {
  return a.mtimeMs - b.mtimeMs || a.fileName.localeCompare(b.fileName);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
