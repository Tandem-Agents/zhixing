import path from "node:path";
import type { Dir } from "node:fs";
import { lstat, opendir, rmdir, unlink } from "node:fs/promises";
import type { SecretStorePort } from "@zhixing/core/contracts";
import { protocolDigest, type DeviceLifecycleEvidenceRef } from "@zhixing/core/protocol";
import {
  runStorageMaintenanceStep,
  runWithMaintenanceUrgency,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import { cleanupRemovedDeviceSecrets } from "./device-removal.js";
import type { DisasterRecoveryStagingArea } from "./disaster-recovery-staging.js";

export async function cleanupExecutorDeviceLocalState(input: {
  readonly zhixingHome: string;
  readonly secretStore: SecretStorePort;
  readonly deviceKey: DeviceKey;
  readonly storageGovernor?: StorageMaintenanceGovernorPort;
  readonly disasterRecoveryStaging: DisasterRecoveryStagingArea;
  readonly signal?: AbortSignal;
  readonly unregisterFuture: () => Promise<void>;
}): Promise<readonly DeviceLifecycleEvidenceRef[]> {
  const home = path.resolve(input.zhixingHome);
  const distributed = path.join(home, "distributed-runtime");
  const removable = [
    path.join(home, "runtime"),
    path.join(distributed, "capacity"),
    path.join(distributed, "derived"),
    path.join(distributed, "execution-assets.json"),
    path.join(distributed, "executor-capability-directory.json"),
    path.join(distributed, "executor-snapshot-version.json"),
    path.join(distributed, "mesh-artifact-partials"),
    path.join(distributed, "mesh-bootstrap-completions.json"),
    path.join(distributed, "mesh-endpoints.json"),
    path.join(distributed, "mesh-peers.json"),
    path.join(distributed, "permission-snapshots"),
    path.join(distributed, "recovery-checkpoint-incoming"),
    path.join(distributed, "surface-asset-partials"),
    path.join(distributed, "surface-asset-temporary"),
    path.join(distributed, "workspace-bindings"),
    path.join(distributed, "workspace-probes"),
  ].map((entry) => assertOwnedPath(home, entry));

  await runWithMaintenanceUrgency(
    () => "recovery",
    input.signal ?? new AbortController().signal,
    async () => {
      for (const [index, entry] of removable.entries()) {
        const walker = new BoundedRemovalWalker(entry);
        let batchIndex = 0;
        try {
          while (true) {
            const result = await runStorageMaintenanceStep(
              input.storageGovernor,
              storageMaintenanceRequest(
                "device-lifecycle-cleanup",
                entry,
                protocolDigest("ExecutorRemovalCleanupPathBatch", 1, {
                  home,
                  entry,
                  batchIndex,
                }),
                { obligation: "pre-commit", maxWaitMs: 5_000 },
              ),
              () => walker.step(128),
            );
            if (result.done) break;
            batchIndex += 1;
          }
        } finally {
          await walker.close();
        }
        if (index === 2) {
          await input.disasterRecoveryStaging.cleanupCurrentDevice(input.signal);
        }
      }
    },
  );
  await input.unregisterFuture();
  const secretEvidence = await cleanupRemovedDeviceSecrets({
    store: input.secretStore,
    deviceKey: input.deviceKey,
    preserveDeviceKey: true,
  });
  return Object.freeze([
    {
      kind: "cleanup",
      digest: protocolDigest("ExecutorRemovalLocalCleanup", 1, {
        home,
        removed: [
          ...removable.slice(0, 3)
            .map((entry) => path.relative(home, entry).replaceAll("\\", "/")),
          "distributed-runtime/disaster-recovery-staging",
          ...removable.slice(3)
            .map((entry) => path.relative(home, entry).replaceAll("\\", "/")),
        ],
      }),
    },
    ...secretEvidence,
  ]);
}

interface RemovalFrame {
  readonly path: string;
  readonly directory: Dir;
  pendingChild?: string;
}

class BoundedRemovalWalker {
  readonly #stack: RemovalFrame[] = [];
  #initialized = false;
  #fileRoot = false;
  #done = false;

  constructor(private readonly root: string) {}

  async step(limit: number): Promise<{ readonly done: boolean }> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("Removal walker limit must be a positive integer");
    }
    if (this.#done) return { done: true };
    if (!this.#initialized) await this.#initialize();
    let operations = 0;
    if (this.#fileRoot) {
      await unlink(this.root).catch(ignoreMissing);
      this.#fileRoot = false;
      this.#done = true;
      return { done: true };
    }
    while (operations < limit && this.#stack.length > 0) {
      const frame = this.#stack.at(-1)!;
      if (frame.pendingChild) {
        const child = frame.pendingChild;
        frame.pendingChild = undefined;
        const directory = await openDirectory(child);
        if (directory) this.#stack.push({ path: child, directory });
        continue;
      }
      const entry = await frame.directory.read();
      if (entry) {
        const child = path.join(frame.path, entry.name);
        operations += 1;
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          if (operations >= limit) frame.pendingChild = child;
          else {
            const directory = await openDirectory(child);
            if (directory) this.#stack.push({ path: child, directory });
          }
        } else {
          await unlink(child).catch(ignoreMissing);
        }
        continue;
      }
      await frame.directory.close();
      this.#stack.pop();
      operations += 1;
      if (!(await removeDirectory(frame.path))) {
        const directory = await openDirectory(frame.path);
        if (directory) this.#stack.push({ path: frame.path, directory });
      }
    }
    this.#done = this.#stack.length === 0;
    return { done: this.#done };
  }

  async close(): Promise<void> {
    while (this.#stack.length > 0) {
      const frame = this.#stack.pop()!;
      await frame.directory.close().catch(ignoreClosedDirectory);
    }
  }

  async #initialize(): Promise<void> {
    this.#initialized = true;
    let stat;
    try {
      stat = await lstat(this.root);
    } catch (error) {
      ignoreMissing(error);
      this.#done = true;
      return;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      this.#fileRoot = true;
      return;
    }
    const directory = await openDirectory(this.root);
    if (directory) this.#stack.push({ path: this.root, directory });
    else this.#done = true;
  }
}

function ignoreMissing(error: unknown): void {
  if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
  throw error;
}

async function openDirectory(directory: string): Promise<Dir | undefined> {
  try {
    return await opendir(directory, { bufferSize: 1 });
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function removeDirectory(directory: string): Promise<boolean> {
  try {
    await rmdir(directory);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    if (hasCode(error, "ENOTEMPTY") || hasCode(error, "EEXIST")) return false;
    throw error;
  }
}

function ignoreClosedDirectory(error: unknown): void {
  if (
    hasCode(error, "ERR_DIR_CLOSED") ||
    hasCode(error, "ENOENT")
  ) return;
  throw error;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

function assertOwnedPath(home: string, candidate: string): string {
  const resolved = path.resolve(candidate);
  const relative = path.relative(home, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Device removal cleanup path escapes the current home");
  }
  return resolved;
}
