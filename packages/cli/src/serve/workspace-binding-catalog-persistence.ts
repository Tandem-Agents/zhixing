import type {
  WorkspaceBindingCatalogPersistencePort,
  WorkspaceBindingCatalogRootCommit,
  WorkspaceBindingCatalogRootDocument,
} from "@zhixing/core/environment/workspace-binding-catalog-persistence";
import {
  acquireFileLock,
  ensureDurableDirectory,
  syncDirectory,
} from "@zhixing/core/persistence";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import path from "node:path";

export interface FileWorkspaceBindingCatalogPersistenceOptions {
  readonly zhixingHome: string;
}

/** Owns the canonical Workspace catalog root manifest and its durable CAS. */
export class FileWorkspaceBindingCatalogPersistence
  implements WorkspaceBindingCatalogPersistencePort
{
  readonly #rootDir: string;
  readonly #manifestPath: string;

  constructor(options: FileWorkspaceBindingCatalogPersistenceOptions) {
    this.#rootDir = path.resolve(
      options.zhixingHome,
      "distributed-runtime",
      "workspace-bindings",
    );
    this.#manifestPath = path.join(this.#rootDir, "root-manifest.json");
  }

  async load(): Promise<WorkspaceBindingCatalogRootDocument | undefined> {
    await ensureDurableDirectory(this.#rootDir);
    const bytes = await readFile(this.#manifestPath, "utf8").catch(
      (error: unknown) => {
        if (isNodeError(error, "ENOENT")) return undefined;
        throw error;
      },
    );
    return bytes === undefined
      ? undefined
      : Object.freeze({ bytes, snapshotToken: snapshotToken(bytes) });
  }

  async compareAndSwap(input: {
    readonly expectedSnapshotToken: string | undefined;
    readonly replacementBytes: string;
  }): Promise<WorkspaceBindingCatalogRootCommit> {
    await ensureDurableDirectory(this.#rootDir);
    const release = await acquireFileLock(`${this.#manifestPath}.lock`, {
      staleMs: 30_000,
      waitMs: 10_000,
      resourceName: "Workspace catalog root manifest",
    });
    try {
      const current = await this.load();
      if (current?.snapshotToken !== input.expectedSnapshotToken) {
        return { kind: "conflict" };
      }
      const temp = `${this.#manifestPath}.tmp-${process.pid}-${randomUUID()}`;
      const handle = await open(temp, "w", 0o600);
      try {
        await handle.writeFile(input.replacementBytes, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.#manifestPath);
      await syncDirectory(this.#rootDir);
      return {
        kind: "committed",
        snapshotToken: snapshotToken(input.replacementBytes),
      };
    } finally {
      await release();
    }
  }
}

function snapshotToken(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
