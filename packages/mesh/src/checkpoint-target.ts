import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ensureDurableDirectory, syncDirectory } from "@zhixing/core/persistence";
import {
  runStorageMaintenanceStep,
  runWithMaintenanceUrgency,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import { byteDigest, canonicalize, protocolDigest } from "./canonical.js";
import {
  checkpointEnvelopeArtifact,
  type CheckpointPackage,
} from "./checkpoint.js";
import type { RecoveryCheckpointTarget } from "./bootstrap-authority.js";

export interface FrozenCheckpointDirectoryIdentity {
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly dev: string;
  readonly ino: string;
}

interface PersistedCheckpointTargetManifest {
  readonly v: 1;
  readonly targetId: string;
  readonly checkpointId: string;
  readonly envelopeRef: { readonly digest: string; readonly bytes: number };
  readonly chunks: readonly { readonly seq: number; readonly digest: string; readonly bytes: number }[];
}

export interface RetirableRecoveryCheckpointTarget extends RecoveryCheckpointTarget {
  retire(checkpointId: string, supersededBy: string, signal?: AbortSignal): Promise<void>;
}

export interface FileRecoveryCheckpointTargetOptions {
  readonly targetRoot: string;
  readonly sourceRoot: string;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
}

export interface PairedFileRecoveryCheckpointTargetOptions {
  readonly targetRoot: string;
  readonly targetDeviceId: string;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
}

/** Independent-directory checkpoint target with frozen filesystem identity and atomic publication. */
export class FileRecoveryCheckpointTarget implements RetirableRecoveryCheckpointTarget {
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
    const target = await freezeCheckpointDirectory(options.targetRoot, true);
    if (
      source.dev === target.dev ||
      isContainedPath(source.canonicalPath, target.canonicalPath) ||
      isContainedPath(target.canonicalPath, source.canonicalPath)
    ) {
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
      const finalDir = path.join(this.#root.canonicalPath, checkpointId);
      const existing = await this.#readIfPresent(checkpointId);
      if (existing) {
        if (canonicalPackage(existing) !== canonicalPackage(checkpoint)) {
          throw new TypeError("Checkpoint target already contains different content for this id");
        }
        return;
      }
      const temporary = path.join(this.#root.canonicalPath,
        `.${checkpointId}.${protocolDigest("RecoveryCheckpointStaging", 1, {
          checkpointId,
          envelopeDigest: checkpoint.envelope.digest,
        }).slice(7, 23)}.tmp`);
      await this.#removeOwnedDirectory(temporary, operationSignal, `stale-staging:${checkpointId}`);
      await this.#step(`mkdir:${checkpointId}`, 1, operationSignal, () => mkdir(temporary, { recursive: false }));
      try {
        const temporaryBinding = await freezeOwnedCheckpointDirectory(temporary, this.#root);
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
          const chunk = checkpoint.chunks.find((candidate) => candidate.seq === descriptor.seq);
          if (
            !chunk ||
            chunk.bytes.byteLength !== descriptor.bytes ||
            byteDigest(chunk.bytes) !== descriptor.digest
          ) {
            throw new TypeError("Checkpoint target input has an invalid chunk exact-set");
          }
          await this.#writeFile(temporaryBinding, chunkFile(descriptor.seq), chunk.bytes, operationSignal);
        }
        if (checkpoint.chunks.length !== checkpoint.envelope.chunks.length) {
          throw new TypeError("Checkpoint target input has duplicate or undeclared chunks");
        }
        await this.#writeFile(
          temporaryBinding,
          "manifest.json",
          Buffer.from(canonicalize(manifest), "utf8"), operationSignal,
        );
        await this.#step(`sync-staging:${checkpointId}`, 1, operationSignal, () =>
          syncDirectory(temporaryBinding.canonicalPath));
        await this.#step(`publish:${checkpointId}`, 1, operationSignal, async () => {
          await this.#assertRoot();
          try {
            await rename(temporary, finalDir);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
          await syncDirectory(this.#root.canonicalPath);
        });
        const published = await this.read(checkpointId, operationSignal);
        if (canonicalPackage(published) !== canonicalPackage(checkpoint)) {
          throw new TypeError("Checkpoint target read-back changed after publication");
        }
      } finally {
        await this.#removeOwnedDirectory(temporary, operationSignal, `cleanup-staging:${checkpointId}`);
      }
    });
  }

  async read(checkpointId: string, signal?: AbortSignal): Promise<CheckpointPackage> {
    const value = await this.#readIfPresent(safeCheckpointId(checkpointId), signal ?? new AbortController().signal);
    if (!value) throw new Error("Recovery checkpoint is not present on the configured target");
    return value;
  }

  async retire(checkpointId: string, supersededBy: string, signal?: AbortSignal): Promise<void> {
    const operationSignal = signal ?? new AbortController().signal;
    const safeId = safeCheckpointId(checkpointId);
    if (safeId === safeCheckpointId(supersededBy)) {
      throw new TypeError("A checkpoint cannot supersede itself");
    }
    await this.#step(`retire:${safeId}:${supersededBy}`, 1, operationSignal, async () => {
      await this.#assertRoot();
      const directory = path.join(this.#root.canonicalPath, safeId);
      const retired = path.join(this.#root.canonicalPath, `.${safeId}.${safeCheckpointId(supersededBy)}.retired`);
      try {
        await freezeOwnedCheckpointDirectory(directory, this.#root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          await this.#removeOwnedDirectoryUnchecked(retired);
          return;
        }
        throw error;
      }
      await this.#removeOwnedDirectoryUnchecked(retired);
      await rename(directory, retired);
      const retiredBinding = await freezeOwnedCheckpointDirectory(retired, this.#root);
      if (retiredBinding.dev !== this.#root.dev) {
        throw new TypeError("Recovery checkpoint retirement left its owned root");
      }
      await syncDirectory(this.#root.canonicalPath);
      await rm(retiredBinding.canonicalPath, { recursive: true, force: false });
      await syncDirectory(this.#root.canonicalPath);
    });
  }

  async #readIfPresent(checkpointId: string, signal = new AbortController().signal): Promise<CheckpointPackage | undefined> {
    await this.#assertRoot();
    const directory = path.join(this.#root.canonicalPath, checkpointId);
    let binding: FrozenCheckpointDirectoryIdentity;
    try {
      binding = await freezeOwnedCheckpointDirectory(directory, this.#root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let manifestText: string;
    try {
      manifestText = await this.#step(`read-manifest:${checkpointId}`, 1024 * 1024, signal, () =>
        readCheckpointFile(binding, this.#root, "manifest.json", 1024 * 1024).then((bytes) => bytes.toString("utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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
    if (
      canonicalize(envelope) !== envelopeText ||
      canonicalize(checkpointEnvelopeArtifact(envelope)) !== canonicalize(manifest.envelopeRef) ||
      envelope.checkpointId !== checkpointId ||
      canonicalize(envelope.chunks) !== canonicalize(manifest.chunks)
    ) {
      throw new TypeError("Checkpoint target envelope is invalid");
    }
    const chunks = [];
    for (const descriptor of envelope.chunks) {
      const bytes = await this.#step(`read-chunk:${checkpointId}:${descriptor.seq}`, descriptor.bytes, signal, () =>
        readCheckpointFile(binding, this.#root, chunkFile(descriptor.seq), descriptor.bytes),
      );
      if (bytes.byteLength !== descriptor.bytes || byteDigest(bytes) !== descriptor.digest) {
        throw new TypeError("Checkpoint target chunk is corrupt");
      }
      chunks.push({ seq: descriptor.seq, bytes });
    }
    const finalBinding = await freezeOwnedCheckpointDirectory(directory, this.#root);
    if (canonicalize(finalBinding) !== canonicalize(binding)) {
      throw new TypeError("Recovery checkpoint changed during target read-back");
    }
    await this.#assertRoot();
    return { envelope, chunks: Object.freeze(chunks) };
  }

  async #writeFile(directory: FrozenCheckpointDirectoryIdentity, name: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    await this.#step(`write:${name}`, bytes.byteLength, signal, () =>
      writeCheckpointFile(directory, this.#root, name, bytes));
  }

  #removeOwnedDirectory(directory: string, signal: AbortSignal, identity: string): Promise<void> {
    return this.#step(identity, 1, signal, () => this.#removeOwnedDirectoryUnchecked(directory));
  }

  async #removeOwnedDirectoryUnchecked(directory: string): Promise<void> {
    try {
      const binding = await freezeOwnedCheckpointDirectory(directory, this.#root);
      await rm(binding.canonicalPath, { recursive: true, force: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await syncDirectory(this.#root.canonicalPath);
  }

  async #assertRoot(): Promise<void> {
    const current = await freezeCheckpointDirectory(this.#root.lexicalPath, false);
    if (canonicalize(current) !== canonicalize(this.#root)) {
      throw new TypeError("Recovery checkpoint directory identity changed");
    }
  }

  #step<T>(identity: string, bytes: number, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    return runWithMaintenanceUrgency(() => "foreground", signal, () =>
      runStorageMaintenanceStep(
        this.#storageMaintenance,
        storageMaintenanceRequest(
          "authority-checkpoint",
          this.targetId,
          { identity, bytes },
          { obligation: "pre-commit" },
        ),
        operation,
      ));
  }
}

export async function freezeCheckpointDirectory(directory: string, create: boolean): Promise<FrozenCheckpointDirectoryIdentity> {
  const lexicalPath = path.resolve(directory);
  if (create) await ensureDurableDirectory(lexicalPath);
  const first = await lstat(lexicalPath);
  if (!first.isDirectory() || first.isSymbolicLink()) {
    throw new TypeError("Recovery checkpoint root must be a real directory");
  }
  const canonicalPath = await realpath(lexicalPath);
  const canonical = await stat(canonicalPath);
  const second = await lstat(lexicalPath);
  if (
    !second.isDirectory() ||
    second.isSymbolicLink() ||
    String(first.dev) !== String(second.dev) ||
    String(first.ino) !== String(second.ino) ||
    String(second.dev) !== String(canonical.dev) ||
    String(second.ino) !== String(canonical.ino)
  ) {
    throw new TypeError("Recovery checkpoint root identity is unstable");
  }
  return {
    lexicalPath,
    canonicalPath,
    dev: String(canonical.dev),
    ino: String(canonical.ino),
  };
}

export async function freezeOwnedCheckpointDirectory(
  directory: string,
  owner: FrozenCheckpointDirectoryIdentity,
): Promise<FrozenCheckpointDirectoryIdentity> {
  const binding = await freezeCheckpointDirectory(directory, false);
  if (!isContainedPath(owner.canonicalPath, binding.lexicalPath) ||
    !isContainedPath(owner.canonicalPath, binding.canonicalPath) || binding.dev !== owner.dev) {
    throw new TypeError("Recovery checkpoint directory left its owned root");
  }
  return binding;
}

export async function writeCheckpointFile(
  directory: FrozenCheckpointDirectoryIdentity,
  owner: FrozenCheckpointDirectoryIdentity,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const filePath = checkpointChildPath(directory, name);
  await assertCheckpointDirectoryIdentity(owner);
  await assertCheckpointDirectoryIdentity(directory, owner);
  const handle = await open(
    filePath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new TypeError("Recovery checkpoint target file is not regular");
    await handle.writeFile(bytes);
    await handle.sync();
    const after = await handle.stat();
    const lexical = await lstat(filePath);
    if (
      lexical.isSymbolicLink() || !lexical.isFile() ||
      String(after.dev) !== String(lexical.dev) || String(after.ino) !== String(lexical.ino) ||
      String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino) ||
      after.nlink !== 1 || lexical.nlink !== 1 ||
      after.size !== bytes.byteLength
    ) throw new TypeError("Recovery checkpoint target file identity changed during write");
  } finally {
    await handle.close();
  }
  await assertCheckpointDirectoryIdentity(directory, owner);
}

export async function readCheckpointFile(
  directory: FrozenCheckpointDirectoryIdentity,
  owner: FrozenCheckpointDirectoryIdentity,
  name: string,
  maximumBytes: number,
): Promise<Buffer> {
  const filePath = checkpointChildPath(directory, name);
  await assertCheckpointDirectoryIdentity(owner);
  await assertCheckpointDirectoryIdentity(directory, owner);
  const lexical = await lstat(filePath);
  const resolved = await realpath(filePath);
  if (lexical.isSymbolicLink() || !lexical.isFile() || !isContainedPath(directory.canonicalPath, resolved)) {
    throw new TypeError("Recovery checkpoint target file left its owned directory");
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || lexical.nlink !== 1 || String(before.dev) !== String(lexical.dev) ||
      String(before.ino) !== String(lexical.ino) || before.size > maximumBytes) {
      throw new TypeError("Recovery checkpoint target file identity is invalid");
    }
    const bytes = await handle.readFile();
    const [after, finalLexical, finalResolved] = await Promise.all([
      handle.stat(), lstat(filePath), realpath(filePath),
    ]);
    if (String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino) ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.nlink !== 1 || finalLexical.nlink !== 1 ||
      finalLexical.isSymbolicLink() || !finalLexical.isFile() ||
      String(after.dev) !== String(finalLexical.dev) || String(after.ino) !== String(finalLexical.ino) ||
      !isContainedPath(directory.canonicalPath, finalResolved)) {
      throw new TypeError("Recovery checkpoint target file changed during read-back");
    }
    await assertCheckpointDirectoryIdentity(directory, owner);
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function assertCheckpointDirectoryIdentity(
  binding: FrozenCheckpointDirectoryIdentity,
  owner?: FrozenCheckpointDirectoryIdentity,
): Promise<void> {
  const current = await freezeCheckpointDirectory(binding.lexicalPath, false);
  if (canonicalize(current) !== canonicalize(binding) ||
    (owner && (!isContainedPath(owner.canonicalPath, current.canonicalPath) || current.dev !== owner.dev))) {
    throw new TypeError("Recovery checkpoint directory identity changed");
  }
}

function checkpointChildPath(directory: FrozenCheckpointDirectoryIdentity, name: string): string {
  if (!/^[A-Za-z0-9._-]{1,160}$/u.test(name)) throw new TypeError("Recovery checkpoint file name is invalid");
  return path.join(directory.canonicalPath, name);
}

function isContainedPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
  return canonicalize({
    envelope: checkpoint.envelope,
    chunks: checkpoint.chunks.map((chunk) => ({
      seq: chunk.seq,
      digest: byteDigest(chunk.bytes),
      bytes: chunk.bytes.byteLength,
    })),
  });
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (canonicalize(Object.keys(value).sort()) !== canonicalize([...expected].sort())) {
    throw new TypeError("Recovery checkpoint target value has missing or unknown fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
