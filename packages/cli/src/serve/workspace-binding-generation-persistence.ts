import type { FileAuthorityCommitLog } from "@zhixing/core/authority";
import { workspaceCatalogGenerationStorageKey } from "@zhixing/core/environment";
import type {
  WorkspaceBindingGenerationPersistenceObservation,
  WorkspaceBindingGenerationPersistencePort,
} from "@zhixing/core/environment/workspace-binding-generation-persistence";
import {
  ensureDurableDirectory,
  syncDirectory,
} from "@zhixing/core/persistence";
import { open, stat } from "node:fs/promises";
import path from "node:path";

const WORKSPACE_BINDING_GENERATION_MARKER =
  "workspace-binding-directory-v1\n";

export interface FileWorkspaceBindingGenerationPersistenceFactoryOptions {
  readonly zhixingHome: string;
}

/** Owns the physical generation marker and its pairing to one concrete WAL. */
export class FileWorkspaceBindingGenerationPersistenceFactory {
  readonly #workspaceBindingsRoot: string;

  constructor(options: FileWorkspaceBindingGenerationPersistenceFactoryOptions) {
    this.#workspaceBindingsRoot = path.resolve(
      options.zhixingHome,
      "distributed-runtime",
      "workspace-bindings",
    );
  }

  create(
    catalogGeneration: string,
    authorityLog: FileAuthorityCommitLog,
  ): WorkspaceBindingGenerationPersistencePort {
    return new FileWorkspaceBindingGenerationPersistence({
      generationRoot: path.join(
        this.#workspaceBindingsRoot,
        "generations",
        workspaceCatalogGenerationStorageKey(catalogGeneration),
      ),
      authorityLogPath: authorityLog.logPath,
    });
  }
}

interface FileWorkspaceBindingGenerationPersistenceOptions {
  readonly generationRoot: string;
  readonly authorityLogPath: string;
}

class FileWorkspaceBindingGenerationPersistence
  implements WorkspaceBindingGenerationPersistencePort
{
  readonly #rootDir: string;
  readonly #markerPath: string;
  readonly #authorityLogPath: string;

  constructor(options: FileWorkspaceBindingGenerationPersistenceOptions) {
    this.#rootDir = path.resolve(options.generationRoot);
    this.#markerPath = path.join(this.#rootDir, "directory-established");
    this.#authorityLogPath = path.resolve(options.authorityLogPath);
  }

  async inspectEstablishment(): Promise<WorkspaceBindingGenerationPersistenceObservation> {
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
      await handle.writeFile(WORKSPACE_BINDING_GENERATION_MARKER, "utf8");
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
