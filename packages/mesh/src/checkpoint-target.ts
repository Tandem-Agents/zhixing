import path from "node:path";
import {
  runStorageMaintenanceStep,
  runWithMaintenanceUrgency,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import { byteDigest, canonicalize, protocolDigest } from "./canonical.js";
import {
  assertCheckpointEnvelopeShape,
  checkpointEnvelopeArtifact,
  checkpointPackageFromChunks,
  readCheckpointChunk,
  type CheckpointPackage,
} from "./checkpoint.js";
import type { RecoveryCheckpointTarget } from "./bootstrap-authority.js";
import { CheckpointDirectoryHandle } from "./checkpoint-child-bridge.js";

export interface FrozenCheckpointDirectoryIdentity {
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly dev: string;
  readonly ino: string;
  readonly handle: CheckpointDirectoryHandle;
}

interface PersistedCheckpointTargetManifest {
  readonly v: 1;
  readonly targetId: string;
  readonly checkpointId: string;
  readonly envelopeRef: { readonly digest: string; readonly bytes: number };
  readonly chunks: readonly { readonly seq: number; readonly digest: string; readonly bytes: number }[];
}

const FULL_AUTHORITY_SCOPE = Object.freeze([
  "global-authority",
  "conversation-authority",
  "conversation-content",
  "execution-assets",
] as const);
const MAX_MATERIALIZED_LEGACY_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const MAX_CHECKPOINT_INVENTORY_ENTRIES = 4096;

export interface RecoveryCheckpointInventoryEntry {
  readonly checkpointId: string;
  readonly targetId: string;
  readonly recipientKeyId: string;
  readonly envelope: CheckpointPackage["envelope"];
}

export interface RetirableRecoveryCheckpointTarget extends RecoveryCheckpointTarget {
  retire(checkpointId: string, supersededBy: string, signal?: AbortSignal): Promise<void>;
}

export interface InventoryRecoveryCheckpointTarget extends RetirableRecoveryCheckpointTarget {
  inventory(requestId: string, signal?: AbortSignal): Promise<readonly RecoveryCheckpointInventoryEntry[]>;
}

export interface FileRecoveryCheckpointTargetOptions {
  readonly targetRoot: string;
  readonly sourceRoot: string;
  readonly create?: boolean;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
}

export interface PairedFileRecoveryCheckpointTargetOptions {
  readonly targetRoot: string;
  readonly targetDeviceId: string;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
}

/** Independent-directory checkpoint target with frozen filesystem identity and atomic publication. */
export class FileRecoveryCheckpointTarget implements InventoryRecoveryCheckpointTarget {
  readonly targetId: string;
  readonly independenceDomain: string;
  readonly #root: FrozenCheckpointDirectoryIdentity;
  readonly #storageMaintenance?: StorageMaintenanceGovernorPort;

  private constructor(
    root: FrozenCheckpointDirectoryIdentity,
    targetId: string,
    independenceDomain: string,
    storageMaintenance?: StorageMaintenanceGovernorPort,
  ) {
    this.#root = root;
    this.#storageMaintenance = storageMaintenance;
    this.targetId = targetId;
    this.independenceDomain = independenceDomain;
  }

  static async open(options: FileRecoveryCheckpointTargetOptions): Promise<FileRecoveryCheckpointTarget> {
    const source = await freezeCheckpointDirectory(options.sourceRoot, false);
    try {
      const target = await freezeCheckpointDirectory(options.targetRoot, options.create ?? true);
      if (source.dev === target.dev) {
        await target.handle.close();
        throw new TypeError("Recovery checkpoint directory is not physically independent");
      }
      return new FileRecoveryCheckpointTarget(
        target,
        `backup-dir:${protocolDigest("RecoveryCheckpointDirectoryTarget", 1, {
          canonicalPathIdentity: { dev: target.dev, ino: target.ino },
        })}`,
        `filesystem:${target.dev}`,
        options.storageMaintenance,
      );
    } finally {
      await source.handle.close();
    }
  }

  static async openPaired(
    options: PairedFileRecoveryCheckpointTargetOptions,
  ): Promise<FileRecoveryCheckpointTarget> {
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(options.targetDeviceId)) {
      throw new TypeError("Paired recovery target device id is invalid");
    }
    const target = await freezeCheckpointDirectory(options.targetRoot, true);
    return new FileRecoveryCheckpointTarget(
      target,
      `backup-device:${options.targetDeviceId}`,
      `device:${options.targetDeviceId}`,
      options.storageMaintenance,
    );
  }

  async writeDurable(checkpoint: CheckpointPackage, signal?: AbortSignal): Promise<void> {
    const operationSignal = signal ?? new AbortController().signal;
    await runWithMaintenanceUrgency(() => "foreground", operationSignal, async () => {
      await this.#assertRoot();
      const checkpointId = safeCheckpointId(checkpoint.envelope.checkpointId);
      const existing = await this.#readIfPresent(checkpointId);
      if (existing) {
        if (canonicalPackage(existing) !== canonicalPackage(checkpoint)) {
          throw new TypeError("Checkpoint target already contains different content for this id");
        }
        await this.#verifyPackageContents(existing, operationSignal);
        return;
      }
      const temporaryName = `.${checkpointId}.${protocolDigest("RecoveryCheckpointStaging", 1, {
          checkpointId,
          envelopeDigest: checkpoint.envelope.digest,
        }).slice(7, 23)}.tmp`;
      await this.#removeOwnedDirectory(temporaryName, checkpoint.envelope, operationSignal, `stale-staging:${checkpointId}`);
      const temporaryBinding = await this.#step(`mkdir:${checkpointId}`, 1, operationSignal, () =>
        openOwnedCheckpointDirectory(this.#root, temporaryName, true));
      try {
        const manifest: PersistedCheckpointTargetManifest = {
          v: 1,
          targetId: this.targetId,
          checkpointId,
          envelopeRef: checkpointEnvelopeArtifact(checkpoint.envelope),
          chunks: checkpoint.envelope.chunks.map((chunk) => ({ ...chunk })),
        };
        await this.#writeFile(
          temporaryBinding,
          "envelope.json",
          Buffer.from(canonicalize(checkpoint.envelope), "utf8"), operationSignal,
        );
        for (const descriptor of checkpoint.envelope.chunks) {
          const chunk = await readCheckpointChunk(checkpoint, descriptor.seq, operationSignal);
          try {
            if (chunk.byteLength !== descriptor.bytes || byteDigest(chunk) !== descriptor.digest) {
              throw new TypeError("Checkpoint target input has an invalid chunk exact-set");
            }
            await this.#writeFile(temporaryBinding, chunkFile(descriptor.seq), chunk, operationSignal);
          } finally {
            chunk.fill(0);
          }
        }
        await this.#writeFile(
          temporaryBinding,
          "manifest.json",
          Buffer.from(canonicalize(manifest), "utf8"), operationSignal,
        );
        await this.#step(`sync-staging:${checkpointId}`, 1, operationSignal, () => temporaryBinding.handle.sync());
        await temporaryBinding.handle.close();
        await this.#step(`publish:${checkpointId}`, 1, operationSignal, async () => {
          await this.#assertRoot();
          try {
            await this.#root.handle.renameTo(temporaryName, this.#root.handle, checkpointId);
          } catch (error) {
            const concurrent = await this.#readIfPresent(checkpointId, operationSignal);
            if (!concurrent || canonicalPackage(concurrent) !== canonicalPackage(checkpoint)) throw error;
          }
          await this.#root.handle.sync();
        });
        const published = await this.read(checkpointId, operationSignal);
        if (canonicalPackage(published) !== canonicalPackage(checkpoint)) {
          throw new TypeError("Checkpoint target read-back changed after publication");
        }
        await this.#verifyPackageContents(published, operationSignal);
      } finally {
        await temporaryBinding.handle.close();
        await this.#removeOwnedDirectory(temporaryName, checkpoint.envelope, operationSignal, `cleanup-staging:${checkpointId}`);
      }
    });
  }

  async read(checkpointId: string, signal?: AbortSignal): Promise<CheckpointPackage> {
    const value = await this.#readIfPresent(safeCheckpointId(checkpointId), signal ?? new AbortController().signal);
    if (!value) throw new Error("Recovery checkpoint is not present on the configured target");
    return value;
  }

  async inventory(requestId: string, signal?: AbortSignal): Promise<readonly RecoveryCheckpointInventoryEntry[]> {
    if (!/^[A-Za-z0-9._:-]{1,192}$/u.test(requestId)) {
      throw new TypeError("Recovery checkpoint inventory request id is invalid");
    }
    const operationSignal = signal ?? new AbortController().signal;
    await this.#assertRoot();
    const entries: RecoveryCheckpointInventoryEntry[] = [];
    for (const name of await this.#root.handle.listEntries(MAX_CHECKPOINT_INVENTORY_ENTRIES)) {
      if (!/^[A-Za-z0-9_-]{1,96}$/u.test(name)) continue;
      try {
        const checkpoint = await this.#readIfPresent(name, operationSignal);
        if (!checkpoint || !isFullAuthorityEnvelope(checkpoint.envelope)) continue;
        await this.#verifyPackageContents(checkpoint, operationSignal);
        entries.push({
          checkpointId: checkpoint.envelope.checkpointId,
          targetId: this.targetId,
          recipientKeyId: checkpoint.envelope.recipientKeyId,
          envelope: checkpoint.envelope,
        });
      } catch (error) {
        if (operationSignal.aborted) throw operationSignal.reason ?? error;
        if (!isCheckpointInventoryOmission(error)) throw error;
      }
    }
    return entries.sort((left, right) =>
      right.envelope.createdAt.localeCompare(left.envelope.createdAt) ||
      left.checkpointId.localeCompare(right.checkpointId));
  }

  async retire(checkpointId: string, supersededBy: string, signal?: AbortSignal): Promise<void> {
    const operationSignal = signal ?? new AbortController().signal;
    const safeId = safeCheckpointId(checkpointId);
    if (safeId === safeCheckpointId(supersededBy)) {
      throw new TypeError("A checkpoint cannot supersede itself");
    }
    await this.#step(`retire:${safeId}:${supersededBy}`, 1, operationSignal, async () => {
      await this.#assertRoot();
      const retiredName = `.${safeId}.${safeCheckpointId(supersededBy)}.retired`;
      const checkpoint = await this.#readIfPresent(safeId, operationSignal);
      if (!checkpoint) {
        await this.#removeOwnedDirectoryUnchecked(retiredName);
        return;
      }
      await this.#removeOwnedDirectoryUnchecked(retiredName, checkpoint.envelope);
      await this.#root.handle.renameTo(safeId, this.#root.handle, retiredName);
      await this.#root.handle.sync();
      await this.#removeOwnedDirectoryUnchecked(retiredName, checkpoint.envelope);
    });
  }

  async close(): Promise<void> {
    await this.#root.handle.close();
  }

  async #readIfPresent(checkpointId: string, signal = new AbortController().signal): Promise<CheckpointPackage | undefined> {
    await this.#assertRoot();
    let binding: FrozenCheckpointDirectoryIdentity;
    try {
      binding = await openOwnedCheckpointDirectory(this.#root, checkpointId, false);
    } catch (error) {
      if (isCheckpointChildMissing(error)) return undefined;
      throw error;
    }
    try {
      let manifestText: string;
      try {
        manifestText = await this.#step(`read-manifest:${checkpointId}`, 1024 * 1024, signal, () =>
          readCheckpointFile(binding, this.#root, "manifest.json", 1024 * 1024).then((bytes) => bytes.toString("utf8")),
        );
      } catch (error) {
        if (isCheckpointChildMissing(error)) return undefined;
        throw error;
      }
      const manifest = JSON.parse(manifestText) as PersistedCheckpointTargetManifest;
      if (
        canonicalize(manifest) !== manifestText ||
        !isRecord(manifest) ||
        manifest.v !== 1 ||
        manifest.targetId !== this.targetId ||
        manifest.checkpointId !== checkpointId ||
        !Array.isArray(manifest.chunks)
      ) {
        throw new TypeError("Checkpoint target manifest is invalid");
      }
      assertExactKeys(manifest, ["checkpointId", "chunks", "envelopeRef", "targetId", "v"]);
      const envelopeText = await this.#step(`read-envelope:${checkpointId}`, manifest.envelopeRef.bytes, signal, () =>
        readCheckpointFile(binding, this.#root, "envelope.json", manifest.envelopeRef.bytes).then((bytes) => bytes.toString("utf8")),
      );
      const envelope = JSON.parse(envelopeText) as CheckpointPackage["envelope"];
      assertCheckpointEnvelopeShape(envelope);
      if (
        canonicalize(envelope) !== envelopeText ||
        canonicalize(checkpointEnvelopeArtifact(envelope)) !== canonicalize(manifest.envelopeRef) ||
        envelope.checkpointId !== checkpointId ||
        canonicalize(envelope.chunks) !== canonicalize(manifest.chunks)
      ) {
        throw new TypeError("Checkpoint target envelope is invalid");
      }
      if (!isFullAuthorityEnvelope(envelope)) {
        const totalBytes = envelope.chunks.reduce((sum, descriptor) => sum + descriptor.bytes, 0);
        if (totalBytes > MAX_MATERIALIZED_LEGACY_CHECKPOINT_BYTES) {
          throw new TypeError("Legacy checkpoint exceeds its bounded materialization limit");
        }
        const chunks: { seq: number; bytes: Buffer }[] = [];
        try {
          for (const descriptor of envelope.chunks) {
            const bytes = await this.#step(
              `read-legacy-chunk:${checkpointId}:${descriptor.seq}`,
              descriptor.bytes,
              signal,
              () => readCheckpointFileRange(
                binding,
                this.#root,
                chunkFile(descriptor.seq),
                descriptor.bytes,
                0,
                descriptor.bytes || 1,
              ),
            );
            if (bytes.byteLength !== descriptor.bytes || byteDigest(bytes) !== descriptor.digest) {
              bytes.fill(0);
              throw new TypeError("Legacy checkpoint target chunk is corrupt");
            }
            chunks.push({ seq: descriptor.seq, bytes });
          }
          return checkpointPackageFromChunks(envelope, chunks);
        } catch (error) {
          for (const chunk of chunks) chunk.bytes.fill(0);
          throw error;
        }
      }
      const expectedIdentity = binding.handle.identity;
      await this.#assertRoot();
      return {
        envelope,
        source: {
          read: async (seq, offset, limit, rangeSignal) => {
            const descriptor = envelope.chunks[seq];
            if (!descriptor || descriptor.seq !== seq) {
              throw new TypeError("Checkpoint target chunk sequence is invalid");
            }
            const current = await openOwnedCheckpointDirectory(this.#root, checkpointId, false);
            try {
              if (current.handle.identity !== expectedIdentity) {
                throw new TypeError("Recovery checkpoint changed during target read-back");
              }
              const bytes = await this.#step(
                `read-chunk:${checkpointId}:${seq}:${offset}`,
                Math.min(limit, Math.max(0, descriptor.bytes - offset)),
                rangeSignal ?? signal,
                () => readCheckpointFileRange(
                  current,
                  this.#root,
                  chunkFile(seq),
                  descriptor.bytes,
                  offset,
                  limit,
                ),
              );
              if (offset === 0 && bytes.byteLength === descriptor.bytes && byteDigest(bytes) !== descriptor.digest) {
                bytes.fill(0);
                throw new TypeError("Checkpoint target chunk is corrupt");
              }
              return bytes;
            } finally {
              await current.handle.close();
            }
          },
        },
      };
    } finally {
      await binding.handle.close();
    }
  }

  async #writeFile(directory: FrozenCheckpointDirectoryIdentity, name: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    await this.#step(`write:${name}`, bytes.byteLength, signal, () =>
      writeCheckpointFile(directory, this.#root, name, bytes));
  }

  async #verifyPackageContents(checkpoint: CheckpointPackage, signal: AbortSignal): Promise<void> {
    for (const descriptor of checkpoint.envelope.chunks) {
      const bytes = await readCheckpointChunk(checkpoint, descriptor.seq, signal);
      try {
        if (bytes.byteLength !== descriptor.bytes || byteDigest(bytes) !== descriptor.digest) {
          throw new TypeError("Checkpoint target chunk is corrupt");
        }
      } finally {
        bytes.fill(0);
      }
    }
  }

  #removeOwnedDirectory(
    name: string,
    envelope: CheckpointPackage["envelope"],
    signal: AbortSignal,
    identity: string,
  ): Promise<void> {
    return this.#step(identity, 1, signal, () => this.#removeOwnedDirectoryUnchecked(name, envelope));
  }

  async #removeOwnedDirectoryUnchecked(
    name: string,
    knownEnvelope?: CheckpointPackage["envelope"],
  ): Promise<void> {
    let binding: FrozenCheckpointDirectoryIdentity | undefined;
    try {
      binding = await openOwnedCheckpointDirectory(this.#root, name, false);
    } catch (error) {
      if (isCheckpointChildMissing(error)) return;
      throw error;
    }
    try {
      let envelope = knownEnvelope;
      if (!envelope) {
        try {
          const text = (await binding.handle.readFile("envelope.json", -1, 0, 16 * 1024 * 1024)).toString("utf8");
          const candidate = JSON.parse(text) as CheckpointPackage["envelope"];
          if (canonicalize(candidate) !== text) throw new TypeError("Checkpoint target envelope is invalid");
          envelope = candidate;
        } catch (error) {
          if (!isCheckpointChildMissing(error)) throw error;
        }
      }
      const files = [
        "envelope.json",
        "manifest.json",
        ...(envelope?.chunks.map((descriptor) => chunkFile(descriptor.seq)) ?? []),
      ];
      for (const file of files) await unlinkIfPresent(binding.handle, file, false);
      await binding.handle.sync();
    } finally {
      await binding.handle.close();
    }
    await this.#root.handle.unlink(name, true);
    await this.#root.handle.sync();
  }

  async #assertRoot(): Promise<void> {
    await this.#root.handle.assertIdentity();
  }

  #step<T>(identity: string, bytes: number, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    return runWithMaintenanceUrgency(() => "foreground", signal, () =>
      runStorageMaintenanceStep(
        this.#storageMaintenance,
        storageMaintenanceRequest(
          "authority-checkpoint",
          this.targetId,
          { identity, bytes },
          // 本步骤不持有 authority / projection / ArtifactStore 互斥；配对与恢复
          // 的前台调用可以在这里有界等待公平容量，而不是以零等待把瞬时槽位
          // 竞争升级成配对失败。AbortSignal 仍精确终结连接取消。
          { obligation: "pre-commit", maxWaitMs: 5_000 },
        ),
        operation,
      ));
  }
}

function isFullAuthorityEnvelope(envelope: CheckpointPackage["envelope"]): boolean {
  return canonicalize(envelope.manifest.scope) === canonicalize(FULL_AUTHORITY_SCOPE);
}

export async function freezeCheckpointDirectory(directory: string, create: boolean): Promise<FrozenCheckpointDirectoryIdentity> {
  const lexicalPath = path.resolve(directory);
  const handle = await CheckpointDirectoryHandle.openPath(lexicalPath, create);
  const [dev, ino] = splitDirectoryIdentity(handle.identity);
  return {
    lexicalPath,
    canonicalPath: lexicalPath,
    dev,
    ino,
    handle,
  };
}

export async function freezeOwnedCheckpointDirectory(
  directory: string,
  owner: FrozenCheckpointDirectoryIdentity,
): Promise<FrozenCheckpointDirectoryIdentity> {
  const lexicalPath = path.resolve(directory);
  if (path.dirname(lexicalPath) !== owner.lexicalPath && path.dirname(lexicalPath) !== owner.canonicalPath) {
    throw new TypeError("Recovery checkpoint directory left its owned root");
  }
  return openOwnedCheckpointDirectory(owner, path.basename(lexicalPath), false);
}

export async function writeCheckpointFile(
  directory: FrozenCheckpointDirectoryIdentity,
  owner: FrozenCheckpointDirectoryIdentity,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  await assertCheckpointDirectoryIdentity(owner);
  await assertCheckpointDirectoryIdentity(directory, owner);
  await directory.handle.writeFile(checkpointChildName(name), bytes);
  await assertCheckpointDirectoryIdentity(directory, owner);
}

export async function readCheckpointFile(
  directory: FrozenCheckpointDirectoryIdentity,
  owner: FrozenCheckpointDirectoryIdentity,
  name: string,
  maximumBytes: number,
): Promise<Buffer> {
  await assertCheckpointDirectoryIdentity(owner);
  await assertCheckpointDirectoryIdentity(directory, owner);
  const bytes = await directory.handle.readFile(checkpointChildName(name), -1, 0, maximumBytes);
  await assertCheckpointDirectoryIdentity(directory, owner);
  return bytes;
}

export async function readCheckpointFileRange(
  directory: FrozenCheckpointDirectoryIdentity,
  owner: FrozenCheckpointDirectoryIdentity,
  name: string,
  declaredBytes: number,
  offset: number,
  limit: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError("Recovery checkpoint file range is invalid");
  }
  await assertCheckpointDirectoryIdentity(owner);
  await assertCheckpointDirectoryIdentity(directory, owner);
  const bytes = await directory.handle.readFile(checkpointChildName(name), declaredBytes, offset, limit);
  await assertCheckpointDirectoryIdentity(directory, owner);
  return bytes;
}

export async function assertCheckpointDirectoryIdentity(
  binding: FrozenCheckpointDirectoryIdentity,
  owner?: FrozenCheckpointDirectoryIdentity,
): Promise<void> {
  await binding.handle.assertIdentity();
  if (owner && (binding.dev !== owner.dev || path.dirname(binding.lexicalPath) !== owner.lexicalPath)) {
    throw new TypeError("Recovery checkpoint directory identity changed");
  }
}

export async function writeCheckpointFileRange(
  directory: FrozenCheckpointDirectoryIdentity,
  owner: FrozenCheckpointDirectoryIdentity,
  name: string,
  maximumBytes: number,
  offset: number,
  bytes: Uint8Array,
): Promise<number> {
  await assertCheckpointDirectoryIdentity(owner);
  await assertCheckpointDirectoryIdentity(directory, owner);
  const durableBytes = await directory.handle.writeRange(
    checkpointChildName(name), maximumBytes, offset, bytes,
  );
  await assertCheckpointDirectoryIdentity(directory, owner);
  return durableBytes;
}

export async function removeCheckpointDirectoryExactSet(
  owner: FrozenCheckpointDirectoryIdentity,
  directoryName: string,
  fileNames: readonly string[],
): Promise<void> {
  let directory: FrozenCheckpointDirectoryIdentity;
  try {
    directory = await openOwnedCheckpointDirectory(owner, directoryName, false);
  } catch (error) {
    if (isCheckpointChildMissing(error)) return;
    throw error;
  }
  try {
    for (const name of fileNames) await unlinkIfPresent(directory.handle, checkpointChildName(name), false);
    await directory.handle.sync();
  } finally {
    await directory.handle.close();
  }
  await owner.handle.unlink(checkpointChildName(directoryName), true);
  await owner.handle.sync();
}

async function openOwnedCheckpointDirectory(
  owner: FrozenCheckpointDirectoryIdentity,
  name: string,
  create: boolean,
): Promise<FrozenCheckpointDirectoryIdentity> {
  await owner.handle.assertIdentity();
  const childName = checkpointChildName(name);
  const handle = await owner.handle.openDirectory(childName, create);
  const [dev, ino] = splitDirectoryIdentity(handle.identity);
  if (dev !== owner.dev) {
    await handle.close();
    throw new TypeError("Recovery checkpoint directory left its owned root");
  }
  const lexicalPath = path.join(owner.lexicalPath, childName);
  return { lexicalPath, canonicalPath: lexicalPath, dev, ino, handle };
}

async function unlinkIfPresent(
  directory: CheckpointDirectoryHandle,
  name: string,
  isDirectory: boolean,
): Promise<void> {
  try {
    await directory.unlink(name, isDirectory);
  } catch (error) {
    if (!isCheckpointChildMissing(error)) throw error;
  }
}

export function isCheckpointChildMissing(error: unknown): boolean {
  return error instanceof Error && error.message.includes("checkpoint-child-missing");
}

function splitDirectoryIdentity(identity: string): readonly [string, string] {
  const separator = identity.indexOf(":");
  if (separator <= 0 || separator === identity.length - 1) {
    throw new TypeError("Checkpoint directory handle identity is invalid");
  }
  return [identity.slice(0, separator), identity.slice(separator + 1)];
}

function checkpointChildName(name: string): string {
  if (!/^[A-Za-z0-9._-]{1,160}$/u.test(name) || name === "." || name === "..") {
    throw new TypeError("Recovery checkpoint file name is invalid");
  }
  return name;
}

function safeCheckpointId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,96}$/u.test(value)) {
    throw new TypeError("Checkpoint id is not safe for target storage");
  }
  return value;
}

function chunkFile(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new TypeError("Checkpoint chunk sequence is invalid");
  return `chunk-${String(seq).padStart(10, "0")}.bin`;
}

function canonicalPackage(checkpoint: CheckpointPackage): string {
  return canonicalize(checkpoint.envelope);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (canonicalize(Object.keys(value).sort()) !== canonicalize([...expected].sort())) {
    throw new TypeError("Recovery checkpoint target value has missing or unknown fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCheckpointInventoryOmission(error: unknown): boolean {
  return error instanceof TypeError || isCheckpointChildMissing(error);
}
