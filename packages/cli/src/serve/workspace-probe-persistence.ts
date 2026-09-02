import type { FileAuthorityCommitLog } from "@zhixing/core/authority";
import type {
  WorkspaceProbePersistenceObservation,
  WorkspaceProbePersistencePort,
} from "@zhixing/core/environment/workspace-probe-persistence";
import {
  ensureDurableDirectory,
  syncDirectory,
} from "@zhixing/core/persistence";
import { open, stat } from "node:fs/promises";
import path from "node:path";

const WORKSPACE_PROBE_MARKER = "workspace-probe-log-v1\n";

export interface FileWorkspaceProbePersistenceOptions {
  readonly zhixingHome: string;
  readonly authorityLog: FileAuthorityCommitLog;
}

/** Owns the P07 workspace-probe directory and its shared-WAL sidecar marker. */
export class FileWorkspaceProbePersistence
  implements WorkspaceProbePersistencePort
{
  readonly #rootDir: string;
  readonly #markerPath: string;
  readonly #authorityLogPath: string;

  constructor(options: FileWorkspaceProbePersistenceOptions) {
    this.#rootDir = path.resolve(
      options.zhixingHome,
      "distributed-runtime",
      "workspace-probes",
    );
    this.#markerPath = path.join(this.#rootDir, "probe-log-established");
    this.#authorityLogPath = options.authorityLog.logPath;
  }

  async inspectEstablishment(): Promise<WorkspaceProbePersistenceObservation> {
    await ensureDurableDirectory(this.#rootDir);
    const [markerExists, authorityLogExists] = await Promise.all([
      exists(this.#markerPath),
      exists(this.#authorityLogPath),
    ]);
    return Object.freeze({
      establishmentMarker: markerExists ? "present" : "absent",
      authorityLog: authorityLogExists ? "present" : "absent",
    });
  }

  async publishEstablishment(): Promise<void> {
    await ensureDurableDirectory(this.#rootDir);
    const handle = await open(this.#markerPath, "wx", 0o600).catch(
      (error: unknown) => {
        if (isNodeError(error, "EEXIST")) return undefined;
        throw error;
      },
    );
    if (!handle) return;
    try {
      await handle.writeFile(WORKSPACE_PROBE_MARKER, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(this.#rootDir);
  }
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    (error: unknown) => {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    },
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
