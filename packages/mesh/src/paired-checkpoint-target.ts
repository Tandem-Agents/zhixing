import { createHash } from "node:crypto";
import path from "node:path";
import {
  runStorageMaintenanceStep,
  runWithMaintenanceUrgency,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import type { MeshServiceClient } from "./request-channel.js";
import type { MeshServiceRegistry } from "./service-registry.js";
import type {
  HomeTrustEvent,
  HomeTrustRecord,
  RecoveryActivationPlan,
} from "@zhixing/core/contracts";
import { byteDigest, canonicalize } from "./canonical.js";
import {
  assertCheckpointEnvelopeShape,
  readCheckpointChunkRange,
  type CheckpointPackage,
} from "./checkpoint.js";
import {
  assertCheckpointDirectoryIdentity,
  freezeCheckpointDirectory,
  freezeOwnedCheckpointDirectory,
  isCheckpointChildMissing,
  readCheckpointFile,
  readCheckpointFileRange,
  removeCheckpointDirectoryExactSet,
  writeCheckpointFile,
  writeCheckpointFileRange,
  type FrozenCheckpointDirectoryIdentity,
  type InventoryRecoveryCheckpointTarget,
  type RecoveryCheckpointInventoryEntry,
} from "./checkpoint-target.js";

export const PAIRED_CHECKPOINT_SERVICE = "recovery.checkpoint";
const TRANSFER_PART_BYTES = 256 * 1024;

export const PAIRED_CHECKPOINT_RECEIVER_DESCRIPTOR = Object.freeze({
  owner: "paired-target",
  roles: Object.freeze(["onboarding", "active"]),
  phases: Object.freeze([
    "checkpoint.begin",
    "checkpoint.progress",
    "checkpoint.append",
    "checkpoint.commit",
    "checkpoint.get",
    "checkpoint.inventory",
    "checkpoint.range",
    "checkpoint.retire",
    "checkpoint.activate-root",
  ]),
  order: Object.freeze([
    "checkpoint.begin",
    "checkpoint.progress",
    "checkpoint.append",
    "checkpoint.commit",
  ]),
} as const);

export type PairedCheckpointCommand =
  | PairedBinding & { readonly t: "checkpoint.begin"; readonly envelope: CheckpointPackage["envelope"] }
  | PairedBinding & { readonly t: "checkpoint.progress"; readonly checkpointId: string; readonly seq: number }
  | PairedBinding & {
      readonly t: "checkpoint.append";
      readonly checkpointId: string;
      readonly seq: number;
      readonly offset: number;
      readonly bytes: string;
    }
  | PairedBinding & { readonly t: "checkpoint.commit"; readonly checkpointId: string }
  | PairedBinding & { readonly t: "checkpoint.get"; readonly checkpointId: string }
  | PairedBinding & {
      readonly t: "checkpoint.inventory";
      readonly requestId: string;
      readonly recipientKeyId: string;
    }
  | PairedBinding & {
      readonly t: "checkpoint.range";
      readonly checkpointId: string;
      readonly seq: number;
      readonly offset: number;
      readonly limit: number;
    }
  | PairedBinding & {
      readonly t: "checkpoint.retire";
      readonly checkpointId: string;
      readonly supersededBy: string;
    }
  | PairedBinding & {
      readonly t: "checkpoint.activate-root";
      readonly checkpointId: string;
      readonly event: HomeTrustEvent;
      readonly record: HomeTrustRecord;
    };

interface PairedBinding {
  readonly v: 1;
  readonly homeId: string;
  readonly sourceDeviceId: string;
  readonly targetDeviceId: string;
}

export type PairedCheckpointResult =
  | { readonly t: "checkpoint.begun"; readonly checkpointId: string }
  | { readonly t: "checkpoint.progress"; readonly checkpointId: string; readonly seq: number; readonly receivedBytes: number; readonly complete: boolean }
  | { readonly t: "checkpoint.appended"; readonly checkpointId: string; readonly seq: number; readonly receivedBytes: number; readonly complete: boolean }
  | { readonly t: "checkpoint.stored"; readonly checkpointId: string }
  | { readonly t: "checkpoint.manifest"; readonly checkpointId: string; readonly envelope: CheckpointPackage["envelope"] }
  | {
      readonly t: "checkpoint.inventory";
      readonly requestId: string;
      readonly targetId: string;
      readonly recipientKeyId: string;
      readonly entries: readonly {
        readonly checkpointId: string;
        readonly envelope: CheckpointPackage["envelope"];
      }[];
    }
  | { readonly t: "checkpoint.range"; readonly checkpointId: string; readonly seq: number; readonly offset: number; readonly bytes: string }
  | { readonly t: "checkpoint.retired"; readonly checkpointId: string; readonly supersededBy: string }
  | {
      readonly t: "checkpoint.root-activated";
      readonly checkpointId: string;
      readonly chainHead: HomeTrustRecord["chainHead"];
    };

export interface PairedCheckpointTransport {
  request(command: PairedCheckpointCommand, signal?: AbortSignal): Promise<PairedCheckpointResult>;
}

interface PairedStagingSession {
  readonly owner: FrozenCheckpointDirectoryIdentity;
  readonly checkpoint: FrozenCheckpointDirectoryIdentity;
  readonly envelope: CheckpointPackage["envelope"];
}

export interface RootEstablishmentCheckpointBinding {
  readonly homeId: string;
  readonly sourceDeviceId: string;
  readonly targetId: string;
  readonly checkpointId: string;
  readonly recipientKeyId: string;
}

type PairedCheckpointReceiverOptions = {
  readonly homeId: string;
  readonly sourceDeviceId: string;
  readonly targetDeviceId: string;
  readonly staging: FilePairedCheckpointStaging;
} & (
  | {
      readonly recipientKeyId: string;
      readonly rootEstablishment?: false;
      readonly rootLifecycle?: false;
      readonly replayRootActivation?: (
        input: {
          readonly checkpointId: string;
          readonly event: HomeTrustEvent;
          readonly record: HomeTrustRecord;
          readonly plan: RecoveryActivationPlan;
        },
        signal?: AbortSignal,
      ) => Promise<void>;
    }
  | {
      readonly rootEstablishment: true;
      readonly rootLifecycle?: false;
      readonly recipientKeyId?: never;
      readonly commitRootActivation: (
        input: {
          readonly checkpointId: string;
          readonly event: HomeTrustEvent;
          readonly record: HomeTrustRecord;
          readonly plan: RecoveryActivationPlan;
        },
        signal?: AbortSignal,
      ) => Promise<void>;
    }
  | {
      readonly recipientKeyId: string;
      readonly rootEstablishment?: false;
      readonly rootLifecycle: true;
      readonly commitRootActivation: (
        input: {
          readonly checkpointId: string;
          readonly event: HomeTrustEvent;
          readonly record: HomeTrustRecord;
          readonly plan: RecoveryActivationPlan;
        },
        signal?: AbortSignal,
      ) => Promise<void>;
      readonly replayRootActivation?: never;
    }
);

export class PairedRecoveryCheckpointTarget implements InventoryRecoveryCheckpointTarget {
  readonly targetId: string;
  readonly independenceDomain: string;

  constructor(private readonly options: {
    readonly homeId: string;
    readonly sourceDeviceId: string;
    readonly targetDeviceId: string;
    readonly recipientKeyId: string;
    readonly transport: PairedCheckpointTransport;
    readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  }) {
    if (options.sourceDeviceId === options.targetDeviceId) {
      throw new TypeError("Paired recovery target must be another device");
    }
    this.targetId = `backup-device:${options.targetDeviceId}`;
    this.independenceDomain = `device:${options.targetDeviceId}`;
  }

  async writeDurable(checkpoint: CheckpointPackage, signal?: AbortSignal): Promise<void> {
    this.#assertCheckpoint(checkpoint);
    const checkpointId = checkpoint.envelope.checkpointId;
    assertResult(await this.options.transport.request({
      ...this.#binding(),
      t: "checkpoint.begin",
      envelope: checkpoint.envelope,
    }, signal), "checkpoint.begun", checkpointId);
    for (const descriptor of checkpoint.envelope.chunks) {
      const progress = await this.options.transport.request({
        ...this.#binding(),
        t: "checkpoint.progress",
        checkpointId,
        seq: descriptor.seq,
      }, signal);
      assertProgress(progress, "checkpoint.progress", checkpointId, descriptor.seq, descriptor.bytes);
      const hash = createHash("sha256");
      let offset = 0;
      while (offset < descriptor.bytes) {
        const replayBoundary = progress.receivedBytes > offset
          ? progress.receivedBytes - offset
          : descriptor.bytes - offset;
        const part = await readCheckpointChunkRange(
          checkpoint,
          descriptor.seq,
          offset,
          Math.min(TRANSFER_PART_BYTES, descriptor.bytes - offset, replayBoundary),
          signal,
        );
        try {
          hash.update(part);
          if (offset >= progress.receivedBytes) {
            const appended = await this.options.transport.request({
              ...this.#binding(),
              t: "checkpoint.append",
              checkpointId,
              seq: descriptor.seq,
              offset,
              bytes: part.toString("base64url"),
            }, signal);
            assertProgress(appended, "checkpoint.appended", checkpointId, descriptor.seq, descriptor.bytes);
            if (appended.receivedBytes <= offset) throw new TypeError("Paired recovery upload made no progress");
          }
          offset += part.byteLength;
        } finally {
          part.fill(0);
        }
      }
      if (`sha256:${hash.digest("hex")}` !== descriptor.digest) {
        throw new TypeError("Paired recovery checkpoint has an invalid chunk exact-set");
      }
    }
    assertResult(await this.options.transport.request({
      ...this.#binding(),
      t: "checkpoint.commit",
      checkpointId,
    }, signal), "checkpoint.stored", checkpointId);
  }

  async read(checkpointId: string, signal?: AbortSignal): Promise<CheckpointPackage> {
    const manifest = await this.options.transport.request({
      ...this.#binding(),
      t: "checkpoint.get",
      checkpointId,
    }, signal);
    if (manifest.t !== "checkpoint.manifest" || manifest.checkpointId !== checkpointId) {
      throw new TypeError("Paired recovery target returned an unrelated manifest");
    }
    const checkpoint: CheckpointPackage = {
      envelope: manifest.envelope,
      source: {
        read: async (seq, offset, limit, rangeSignal) => {
          const descriptor = manifest.envelope.chunks[seq];
          if (!descriptor || descriptor.seq !== seq || offset < 0 || offset > descriptor.bytes) {
            throw new RangeError("Paired checkpoint range is outside the selected chunk");
          }
          const expected = Math.min(limit, descriptor.bytes - offset);
          if (expected === 0) return Buffer.alloc(0);
          const output = Buffer.allocUnsafe(expected);
          let copied = 0;
          try {
            while (copied < expected) {
              const bounded = Math.min(TRANSFER_PART_BYTES, expected - copied);
              const currentOffset = offset + copied;
              const result = await this.options.transport.request({
                ...this.#binding(),
                t: "checkpoint.range",
                checkpointId,
                seq,
                offset: currentOffset,
                limit: bounded,
              }, rangeSignal ?? signal);
              if (
                result.t !== "checkpoint.range" || result.checkpointId !== checkpointId ||
                result.seq !== seq || result.offset !== currentOffset
              ) throw new TypeError("Paired recovery target returned an unrelated range");
              const bytes = await this.#decodeRange(
                checkpointId, seq, currentOffset, bounded, result.bytes, rangeSignal ?? signal,
              );
              try {
                if (bytes.byteLength !== bounded) {
                  throw new TypeError("Paired recovery target returned a truncated range");
                }
                bytes.copy(output, copied);
                copied += bytes.byteLength;
              } finally {
                bytes.fill(0);
              }
            }
            return output;
          } catch (error) {
            output.fill(0);
            throw error;
          }
        },
      },
    };
    this.#assertCheckpoint(checkpoint);
    return checkpoint;
  }

  async inventory(requestId: string, signal?: AbortSignal): Promise<readonly RecoveryCheckpointInventoryEntry[]> {
    assertRequestId(requestId);
    const result = await this.options.transport.request({
      ...this.#binding(),
      t: "checkpoint.inventory",
      requestId,
      recipientKeyId: this.options.recipientKeyId,
    }, signal);
    if (
      result.t !== "checkpoint.inventory" ||
      result.requestId !== requestId ||
      result.targetId !== this.targetId ||
      result.recipientKeyId !== this.options.recipientKeyId
    ) throw new TypeError("Paired recovery target returned an unrelated inventory");
    const seen = new Set<string>();
    return result.entries.map((entry) => {
      assertCheckpointEnvelopeShape(entry.envelope);
      if (
        entry.checkpointId !== entry.envelope.checkpointId ||
        entry.envelope.recipientKeyId !== this.options.recipientKeyId ||
        seen.has(entry.checkpointId)
      ) throw new TypeError("Paired recovery target returned an invalid inventory entry");
      seen.add(entry.checkpointId);
      return {
        checkpointId: entry.checkpointId,
        targetId: result.targetId,
        recipientKeyId: result.recipientKeyId,
        envelope: entry.envelope,
      };
    });
  }

  async retire(checkpointId: string, supersededBy: string, signal?: AbortSignal): Promise<void> {
    const result = await this.options.transport.request({
      ...this.#binding(),
      t: "checkpoint.retire",
      checkpointId,
      supersededBy,
    }, signal);
    if (
      result.t !== "checkpoint.retired" ||
      result.checkpointId !== checkpointId ||
      result.supersededBy !== supersededBy
    ) throw new TypeError("Paired recovery target returned an unrelated retire result");
  }

  async activateRoot(input: {
    readonly checkpointId: string;
    readonly event: HomeTrustEvent;
    readonly record: HomeTrustRecord;
  }, signal?: AbortSignal): Promise<void> {
    const result = await this.options.transport.request({
      ...this.#binding(),
      t: "checkpoint.activate-root",
      checkpointId: input.checkpointId,
      event: input.event,
      record: input.record,
    }, signal);
    if (
      result.t !== "checkpoint.root-activated" ||
      result.checkpointId !== input.checkpointId ||
      canonicalize(result.chainHead) !== canonicalize(input.record.chainHead)
    ) throw new TypeError("Paired recovery target returned an unrelated root activation result");
  }

  #binding(): PairedBinding {
    return {
      v: 1,
      homeId: this.options.homeId,
      sourceDeviceId: this.options.sourceDeviceId,
      targetDeviceId: this.options.targetDeviceId,
    };
  }

  #assertCheckpoint(checkpoint: CheckpointPackage): void {
    if (
      checkpoint.envelope.recipientKeyId !== this.options.recipientKeyId ||
      checkpoint.envelope.checkpointId.length === 0
    ) throw new TypeError("Paired recovery checkpoint is not bound to this target");
  }

  #decodeRange(
    checkpointId: string,
    seq: number,
    offset: number,
    limit: number,
    encoded: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (encoded.length > Math.ceil(limit * 4 / 3)) {
      return Promise.reject(new TypeError("Paired recovery target returned an oversized range"));
    }
    const effective = signal ?? new AbortController().signal;
    return runWithMaintenanceUrgency(() => "foreground", effective, () =>
      runStorageMaintenanceStep(
        this.options.storageMaintenance,
        storageMaintenanceRequest(
          "authority-checkpoint",
          this.targetId,
          { checkpointId, step: "network-range-decode", seq, offset, bytes: limit },
          { obligation: "committed" },
        ),
        async () => {
          const bytes = Buffer.from(encoded, "base64url");
          if (bytes.byteLength === 0 || bytes.byteLength > limit) {
            bytes.fill(0);
            throw new TypeError("Paired recovery target returned an invalid range");
          }
          return bytes;
        },
      ));
  }
}

export class FilePairedCheckpointStaging {
  readonly #root: Promise<FrozenCheckpointDirectoryIdentity>;
  #bindingTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    readonly root: string;
    readonly target: InventoryRecoveryCheckpointTarget;
    readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  }) {
    this.#root = freezeCheckpointDirectory(options.root, true);
  }

  async begin(envelope: CheckpointPackage["envelope"], signal?: AbortSignal): Promise<void> {
    assertCheckpointEnvelopeShape(envelope);
    const rootOwner = await this.#root;
    await assertCheckpointDirectoryIdentity(rootOwner);
    await this.#step(envelope.checkpointId, { step: "stale-staging-cleanup", bytes: 1 }, signal, () =>
      this.#removeRetiredStaging(rootOwner, envelope));
    const { owner, checkpoint } = await this.#checkpointRoot(envelope.checkpointId, true, signal);
    const text = canonicalize(envelope);
    try {
      try {
        const existing = (await this.#step(
          envelope.checkpointId,
          { step: "envelope-read", bytes: 16 * 1024 * 1024 },
          signal,
          () => readCheckpointFile(checkpoint, owner, "envelope.json", 16 * 1024 * 1024),
        )).toString("utf8");
        if (existing !== text) throw new TypeError("Paired checkpoint replay changed its envelope");
        return;
      } catch (error) {
        if (!isCheckpointChildMissing(error)) throw error;
      }
      await this.#step(envelope.checkpointId, { step: "envelope", bytes: Buffer.byteLength(text) }, signal, () =>
        writeCheckpointFile(checkpoint, owner, "envelope.json", Buffer.from(text, "utf8")));
      await this.#step(envelope.checkpointId, { step: "envelope-sync", bytes: 1 }, signal, () =>
        checkpoint.handle.sync());
    } finally {
      await checkpoint.handle.close();
    }
  }

  bindRootEstablishment(
    binding: RootEstablishmentCheckpointBinding,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#serializeBinding(async () => {
      assertRootEstablishmentBinding(binding);
      const owner = await this.#root;
      await assertCheckpointDirectoryIdentity(owner);
      const expected = canonicalize(binding);
      const existing = await this.#readRootEstablishmentBinding(owner, "root-establishment.json", signal);
      if (existing !== undefined) {
        if (canonicalize(existing) !== expected) {
          throw new TypeError("Paired root establishment is already bound to another checkpoint");
        }
        return;
      }
      const pending = await this.#readRootEstablishmentBinding(
        owner,
        "root-establishment.pending.json",
        signal,
      );
      if (pending !== undefined && canonicalize(pending) !== expected) {
        throw new TypeError("Paired root establishment has a conflicting pending binding");
      }
      if (pending === undefined) {
        await this.#step(binding.checkpointId, {
          step: "root-establishment-binding",
          bytes: Buffer.byteLength(expected),
        }, signal, async () => {
          await owner.handle.writeFile("root-establishment.pending.json", Buffer.from(expected, "utf8"));
          await owner.handle.sync();
        });
      }
      await this.#step(binding.checkpointId, {
        step: "root-establishment-publish",
        bytes: 1,
      }, signal, async () => {
        await owner.handle.renameTo(
          "root-establishment.pending.json",
          owner.handle,
          "root-establishment.json",
        );
        await owner.handle.sync();
      });
      const published = await this.#readRootEstablishmentBinding(owner, "root-establishment.json", signal);
      if (canonicalize(published) !== expected) {
        throw new TypeError("Paired root establishment binding was not published durably");
      }
    });
  }

  async assertRootEstablishment(
    binding: RootEstablishmentCheckpointBinding,
    signal?: AbortSignal,
  ): Promise<void> {
    assertRootEstablishmentBinding(binding);
    const owner = await this.#root;
    const existing = await this.#readRootEstablishmentBinding(owner, "root-establishment.json", signal);
    if (!existing || canonicalize(existing) !== canonicalize(binding)) {
      throw new TypeError("Paired root establishment command changed its durable binding");
    }
  }

  async rootEstablishmentBinding(
    signal?: AbortSignal,
  ): Promise<RootEstablishmentCheckpointBinding | undefined> {
    return this.#readRootEstablishmentBinding(
      await this.#root,
      "root-establishment.json",
      signal,
    );
  }

  bindRootLifecycle(
    binding: RootEstablishmentCheckpointBinding,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#serializeBinding(async () => {
      assertRootEstablishmentBinding(binding);
      const owner = await this.#root;
      await assertCheckpointDirectoryIdentity(owner);
      const publishedName = rootLifecycleBindingName(binding.checkpointId);
      const pendingName = `${publishedName}.pending`;
      const expected = canonicalize(binding);
      const existing = await this.#readRootEstablishmentBinding(owner, publishedName, signal);
      if (existing !== undefined) {
        if (canonicalize(existing) !== expected) {
          throw new TypeError("Paired root lifecycle changed its checkpoint binding");
        }
        return;
      }
      await this.#step(binding.checkpointId, {
        step: "root-lifecycle-binding",
        bytes: Buffer.byteLength(expected),
      }, signal, async () => {
        await owner.handle.writeFile(pendingName, Buffer.from(expected, "utf8"));
        await owner.handle.sync();
        await owner.handle.renameTo(pendingName, owner.handle, publishedName);
        await owner.handle.sync();
      });
      const published = await this.#readRootEstablishmentBinding(owner, publishedName, signal);
      if (canonicalize(published) !== expected) {
        throw new TypeError("Paired root lifecycle binding was not published durably");
      }
    });
  }

  async assertRootLifecycle(
    binding: RootEstablishmentCheckpointBinding,
    signal?: AbortSignal,
  ): Promise<void> {
    assertRootEstablishmentBinding(binding);
    const existing = await this.rootLifecycleBinding(binding.checkpointId, signal);
    if (!existing || canonicalize(existing) !== canonicalize(binding)) {
      throw new TypeError("Paired root lifecycle command changed its durable binding");
    }
  }

  async rootLifecycleBinding(
    checkpointId: string,
    signal?: AbortSignal,
  ): Promise<RootEstablishmentCheckpointBinding | undefined> {
    return this.#readRootEstablishmentBinding(
      await this.#root,
      rootLifecycleBindingName(checkpointId),
      signal,
    );
  }

  async progress(checkpointId: string, seq: number, signal?: AbortSignal) {
    const session = await this.#session(checkpointId, signal);
    try {
      return await this.#chunkProgress(session, chunkRef(session.envelope, seq), signal);
    } finally {
      await session.checkpoint.handle.close();
    }
  }

  async append(checkpointId: string, seq: number, offset: number, bytes: Uint8Array, signal?: AbortSignal) {
    const session = await this.#session(checkpointId, signal);
    try {
      return await this.#appendChunk(session, chunkRef(session.envelope, seq), offset, bytes, signal);
    } finally {
      await session.checkpoint.handle.close();
    }
  }

  async commit(checkpointId: string, signal?: AbortSignal): Promise<void> {
    const session = await this.#session(checkpointId, signal);
    const { envelope } = session;
    try {
      for (const descriptor of envelope.chunks) {
        const progress = await this.#chunkProgress(session, descriptor, signal);
        if (!progress.complete) throw new Error("Paired recovery checkpoint upload is incomplete");
      }
      await this.options.target.writeDurable({
        envelope,
        source: {
          read: (seq, offset, limit) => {
            const descriptor = envelope.chunks[seq];
            if (!descriptor || descriptor.seq !== seq) {
              return Promise.reject(new TypeError("Paired staging chunk sequence is invalid"));
            }
            return readCheckpointFileRange(
              session.checkpoint,
              session.owner,
              partialFile(seq),
              descriptor.bytes,
              offset,
              limit,
            );
          },
        },
      }, signal);
      await this.#retireStaging(session, signal);
    } finally {
      await session.checkpoint.handle.close();
    }
  }

  read(checkpointId: string, signal?: AbortSignal): Promise<CheckpointPackage> {
    return this.options.target.read(checkpointId, signal);
  }

  inventory(requestId: string, signal?: AbortSignal): Promise<readonly RecoveryCheckpointInventoryEntry[]> {
    return this.options.target.inventory(requestId, signal);
  }

  retire(checkpointId: string, supersededBy: string, signal?: AbortSignal): Promise<void> {
    return this.options.target.retire(checkpointId, supersededBy, signal);
  }

  async #session(checkpointId: string, signal?: AbortSignal): Promise<PairedStagingSession> {
    const { owner, checkpoint } = await this.#checkpointRoot(checkpointId, false);
    try {
      const text = (await this.#step(
        checkpointId,
        { step: "envelope-read", bytes: 16 * 1024 * 1024 },
        signal,
        () => readCheckpointFile(checkpoint, owner, "envelope.json", 16 * 1024 * 1024),
      )).toString("utf8");
      const envelope = JSON.parse(text) as CheckpointPackage["envelope"];
      if (canonicalize(envelope) !== text || envelope.checkpointId !== checkpointId) {
        throw new TypeError("Paired recovery staging envelope is invalid");
      }
      return { owner, checkpoint, envelope };
    } catch (error) {
      await checkpoint.handle.close();
      throw error;
    }
  }

  async #checkpointRoot(checkpointId: string, create: boolean, signal?: AbortSignal): Promise<{
    owner: FrozenCheckpointDirectoryIdentity;
    checkpoint: FrozenCheckpointDirectoryIdentity;
  }> {
    if (!/^[A-Za-z0-9_-]{1,96}$/u.test(checkpointId)) throw new TypeError("Checkpoint id is invalid");
    const owner = await this.#root;
    await assertCheckpointDirectoryIdentity(owner);
    const directory = path.join(owner.canonicalPath, checkpointId);
    if (create) {
      await this.#step(checkpointId, { step: "staging-directory", bytes: 1 }, signal, async () => {
        const child = await owner.handle.openDirectory(checkpointId, true);
        await child.close();
        await owner.handle.sync();
      });
    }
    return { owner, checkpoint: await freezeOwnedCheckpointDirectory(directory, owner) };
  }

  async #chunkProgress(
    session: PairedStagingSession,
    descriptor: CheckpointPackage["envelope"]["chunks"][number],
    signal?: AbortSignal,
  ): Promise<{ receivedBytes: number; complete: boolean }> {
    let bytes: Buffer;
    try {
      bytes = await this.#step(session.envelope.checkpointId, {
        step: "chunk-progress", seq: descriptor.seq, bytes: descriptor.bytes,
      }, signal, () => readCheckpointFile(
        session.checkpoint, session.owner, partialFile(descriptor.seq), descriptor.bytes,
      ));
    } catch (error) {
      if (isCheckpointChildMissing(error)) return { receivedBytes: 0, complete: false };
      throw error;
    }
    try {
      if (bytes.byteLength === descriptor.bytes && byteDigest(bytes) !== descriptor.digest) {
        throw new TypeError("Paired recovery partial digest is invalid");
      }
      return { receivedBytes: bytes.byteLength, complete: bytes.byteLength === descriptor.bytes };
    } finally {
      bytes.fill(0);
    }
  }

  async #appendChunk(
    session: PairedStagingSession,
    descriptor: CheckpointPackage["envelope"]["chunks"][number],
    offset: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{ receivedBytes: number; complete: boolean }> {
    if (bytes.byteLength > TRANSFER_PART_BYTES || offset < 0 || offset + bytes.byteLength > descriptor.bytes) {
      throw new RangeError("Paired recovery chunk write is outside its declared range");
    }
    await this.#step(session.envelope.checkpointId, {
      step: "chunk-append", seq: descriptor.seq, offset, bytes: bytes.byteLength,
    }, signal, () => writeCheckpointFileRange(
      session.checkpoint,
      session.owner,
      partialFile(descriptor.seq),
      descriptor.bytes,
      offset,
      bytes,
    ).then(() => undefined));
    return this.#chunkProgress(session, descriptor, signal);
  }

  async #retireStaging(session: PairedStagingSession, signal?: AbortSignal): Promise<void> {
    const retired = retiredStagingName(session.envelope);
    await this.#step(session.envelope.checkpointId, { step: "staging-retire", bytes: 1 }, signal, async () => {
      await assertCheckpointDirectoryIdentity(session.checkpoint, session.owner);
      await session.checkpoint.handle.close();
      try {
        await session.owner.handle.renameTo(session.envelope.checkpointId, session.owner.handle, retired);
      } catch (error) {
        if (!isCheckpointChildMissing(error)) throw error;
      }
      await session.owner.handle.sync();
    });
    await this.#step(session.envelope.checkpointId, { step: "staging-cleanup", bytes: 1 }, signal, () =>
      this.#removeRetiredStaging(session.owner, session.envelope));
  }

  async #removeRetiredStaging(
    owner: FrozenCheckpointDirectoryIdentity,
    envelope: CheckpointPackage["envelope"],
  ): Promise<void> {
    await removeCheckpointDirectoryExactSet(owner, retiredStagingName(envelope), [
      "envelope.json",
      ...envelope.chunks.map((descriptor) => partialFile(descriptor.seq)),
    ]);
  }

  async #readRootEstablishmentBinding(
    owner: FrozenCheckpointDirectoryIdentity,
    name: string,
    signal?: AbortSignal,
  ): Promise<RootEstablishmentCheckpointBinding | undefined> {
    let bytes: Buffer;
    try {
      bytes = await this.#step("root-establishment", {
        step: "root-establishment-read",
        name,
        bytes: 8 * 1024,
      }, signal, () => owner.handle.readFile(name, -1, 0, 8 * 1024));
    } catch (error) {
      if (isCheckpointChildMissing(error)) return undefined;
      throw error;
    }
    try {
      const text = bytes.toString("utf8");
      const value = JSON.parse(text) as unknown;
      if (canonicalize(value) !== text) {
        throw new TypeError("Paired root establishment binding is not canonical");
      }
      assertRootEstablishmentBinding(value);
      return value;
    } finally {
      bytes.fill(0);
    }
  }

  #serializeBinding<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#bindingTail.then(operation, operation);
    this.#bindingTail = next.then(() => undefined, () => undefined);
    return next;
  }

  #step<T>(checkpointId: string, identity: unknown, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const effective = signal ?? new AbortController().signal;
    return runWithMaintenanceUrgency(() => "foreground", effective, () =>
      runStorageMaintenanceStep(
        this.options.storageMaintenance,
        storageMaintenanceRequest(
          "authority-checkpoint",
          this.options.target.targetId,
          { checkpointId, step: identity },
          { obligation: "committed" },
        ),
        operation,
      ));
  }
}

export class PairedCheckpointReceiver implements PairedCheckpointTransport {
  constructor(private readonly options: PairedCheckpointReceiverOptions) {}

  async request(command: PairedCheckpointCommand, signal?: AbortSignal): Promise<PairedCheckpointResult> {
    assertPairedCommand(command);
    if (!(PAIRED_CHECKPOINT_RECEIVER_DESCRIPTOR.phases as readonly string[]).includes(command.t)) {
      throw new TypeError("Paired recovery command is outside the receiver descriptor");
    }
    this.#assertBinding(command);
    if (command.t === "checkpoint.begin") {
      if (
        (!this.options.rootEstablishment && !this.options.rootLifecycle &&
          command.envelope.recipientKeyId !== this.options.recipientKeyId) ||
        command.envelope.manifest.scope.length === 0
      ) throw new TypeError("Paired recovery envelope is not authorized for this target");
      if (this.options.rootLifecycle && command.envelope.manifest.purpose.kind !== "root-activation") {
        throw new TypeError("Paired root lifecycle accepts only root activation checkpoints");
      }
      if (this.options.rootEstablishment) {
        await this.options.staging.bindRootEstablishment({
          homeId: command.homeId,
          sourceDeviceId: command.sourceDeviceId,
          targetId: `backup-device:${command.targetDeviceId}`,
          checkpointId: command.envelope.checkpointId,
          recipientKeyId: command.envelope.recipientKeyId,
        }, signal);
      } else if (this.options.rootLifecycle) {
        await this.options.staging.bindRootLifecycle({
          homeId: command.homeId,
          sourceDeviceId: command.sourceDeviceId,
          targetId: `backup-device:${command.targetDeviceId}`,
          checkpointId: command.envelope.checkpointId,
          recipientKeyId: command.envelope.recipientKeyId,
        }, signal);
      }
      await this.options.staging.begin(command.envelope, signal);
      return { t: "checkpoint.begun", checkpointId: command.envelope.checkpointId };
    }
    if (command.t === "checkpoint.inventory") {
      if (this.options.rootEstablishment || command.recipientKeyId !== this.options.recipientKeyId) {
        throw new TypeError("Checkpoint inventory is not authorized for this target generation");
      }
      const entries = await this.options.staging.inventory(command.requestId, signal);
      return {
        t: "checkpoint.inventory",
        requestId: command.requestId,
        targetId: `backup-device:${command.targetDeviceId}`,
        recipientKeyId: command.recipientKeyId,
        entries: entries.map((entry) => ({
          checkpointId: entry.checkpointId,
          envelope: entry.envelope,
        })),
      };
    }
    if (this.options.rootEstablishment || this.options.rootLifecycle) {
      const binding = {
        homeId: command.homeId,
        sourceDeviceId: command.sourceDeviceId,
        targetId: `backup-device:${command.targetDeviceId}`,
        checkpointId: command.checkpointId,
        recipientKeyId: await this.#rootActivationRecipient(command.checkpointId, signal),
      };
      if (this.options.rootEstablishment) {
        await this.options.staging.assertRootEstablishment(binding, signal);
      } else {
        await this.options.staging.assertRootLifecycle(binding, signal);
      }
    }
    if (command.t === "checkpoint.progress") {
      const progress = await this.options.staging.progress(command.checkpointId, command.seq, signal);
      return { t: "checkpoint.progress", checkpointId: command.checkpointId, seq: command.seq, ...progress };
    }
    if (command.t === "checkpoint.append") {
      const bytes = Buffer.from(command.bytes, "base64url");
      if (bytes.byteLength > TRANSFER_PART_BYTES) throw new RangeError("Paired checkpoint part is too large");
      const progress = await this.options.staging.append(command.checkpointId, command.seq, command.offset, bytes, signal);
      return { t: "checkpoint.appended", checkpointId: command.checkpointId, seq: command.seq, ...progress };
    }
    if (command.t === "checkpoint.commit") {
      await this.options.staging.commit(command.checkpointId, signal);
      return { t: "checkpoint.stored", checkpointId: command.checkpointId };
    }
    if (command.t === "checkpoint.get") {
      const checkpoint = await this.options.staging.read(command.checkpointId, signal);
      return { t: "checkpoint.manifest", checkpointId: command.checkpointId, envelope: checkpoint.envelope };
    }
    if (command.t === "checkpoint.range") {
      if (command.limit < 1 || command.limit > TRANSFER_PART_BYTES) throw new RangeError("Paired checkpoint range limit is invalid");
      const checkpoint = await this.options.staging.read(command.checkpointId, signal);
      const descriptor = checkpoint.envelope.chunks[command.seq];
      if (!descriptor || descriptor.seq !== command.seq || command.offset < 0 || command.offset >= descriptor.bytes) {
        throw new RangeError("Paired checkpoint range is outside the selected chunk");
      }
      const bytes = await readCheckpointChunkRange(
        checkpoint,
        command.seq,
        command.offset,
        Math.min(command.limit, descriptor.bytes - command.offset),
        signal,
      );
      try {
        return {
          t: "checkpoint.range",
          checkpointId: command.checkpointId,
          seq: command.seq,
          offset: command.offset,
          bytes: bytes.toString("base64url"),
        };
      } finally {
        bytes.fill(0);
      }
    }
    if (command.t === "checkpoint.activate-root") {
      const checkpoint = await this.options.staging.read(command.checkpointId, signal);
      const binding = this.options.rootLifecycle
        ? await this.options.staging.rootLifecycleBinding(command.checkpointId, signal)
        : await this.options.staging.rootEstablishmentBinding(signal);
      if (
        !binding ||
        binding.checkpointId !== command.checkpointId ||
        binding.recipientKeyId !== checkpoint.envelope.recipientKeyId
      ) throw new TypeError("Paired root activation is not durably bound to this checkpoint");
      if (!this.options.rootEstablishment && !this.options.rootLifecycle && !this.options.replayRootActivation) {
        throw new TypeError("Root activation is only available during root establishment");
      }
      const purpose = checkpoint.envelope.manifest.purpose;
      if (
        purpose.kind !== "root-activation" ||
        (!this.options.rootLifecycle && purpose.plan.kind !== "establish") ||
        canonicalize(purpose.plan.rootEvent) !== canonicalize(command.event)
      ) {
        throw new TypeError("Paired root activation does not match the durably stored checkpoint");
      }
      const operation = this.options.rootEstablishment || this.options.rootLifecycle
        ? this.options.commitRootActivation
        : this.options.replayRootActivation!;
      await operation({
        checkpointId: command.checkpointId,
        event: command.event,
        record: command.record,
        plan: purpose.plan,
      }, signal);
      return {
        t: "checkpoint.root-activated",
        checkpointId: command.checkpointId,
        chainHead: command.record.chainHead,
      };
    }
    await this.options.staging.retire(command.checkpointId, command.supersededBy, signal);
    return { t: "checkpoint.retired", checkpointId: command.checkpointId, supersededBy: command.supersededBy };
  }

  #assertBinding(command: PairedCheckpointCommand): void {
    if (
      command.v !== 1 ||
      command.homeId !== this.options.homeId ||
      command.sourceDeviceId !== this.options.sourceDeviceId ||
      command.targetDeviceId !== this.options.targetDeviceId
    ) throw new TypeError("Paired recovery command is not authorized for this device pair");
  }

  async #rootActivationRecipient(
    checkpointId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const binding = this.options.rootLifecycle
      ? await this.options.staging.rootLifecycleBinding(checkpointId, signal)
      : await this.options.staging.rootEstablishmentBinding(signal);
    if (!binding || binding.checkpointId !== checkpointId) {
      throw new TypeError("Paired root establishment checkpoint is not durably bound");
    }
    return binding.recipientKeyId;
  }
}

export class MeshPairedCheckpointTransport implements PairedCheckpointTransport {
  constructor(private readonly client: MeshServiceClient) {}

  async request(command: PairedCheckpointCommand, signal?: AbortSignal): Promise<PairedCheckpointResult> {
    const response = await this.client.request(
      PAIRED_CHECKPOINT_SERVICE,
      Buffer.from(canonicalize(command), "utf8"),
      signal,
    );
    const text = Buffer.from(response).toString("utf8");
    const value = JSON.parse(text) as unknown;
    if (canonicalize(value) !== text) throw new TypeError("Paired recovery response is not canonical");
    return decodePairedCheckpointResult(value);
  }
}

export function registerPairedCheckpointMeshService(
  registry: MeshServiceRegistry,
  receiver: PairedCheckpointReceiver,
  authorizePeer: (deviceId: string) => boolean,
): () => void {
  return registry.register(PAIRED_CHECKPOINT_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    authorize: (connection) => authorizePeer(connection.peer.deviceId),
    handler: async (payload) => {
      const text = Buffer.from(payload).toString("utf8");
      const command = JSON.parse(text) as unknown;
      if (canonicalize(command) !== text) throw new TypeError("Paired recovery command is not canonical");
      assertPairedCommand(command);
      return Buffer.from(canonicalize(await receiver.request(command)), "utf8");
    },
  });
}

function chunkRef(envelope: CheckpointPackage["envelope"], seq: number) {
  const ref = envelope.chunks.find((candidate) => candidate.seq === seq);
  if (!ref) throw new TypeError("Paired checkpoint chunk is not declared by the envelope");
  return ref;
}

function partialFile(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new TypeError("Paired checkpoint chunk sequence is invalid");
  return `chunk-${String(seq).padStart(10, "0")}.partial`;
}

function retiredStagingName(envelope: CheckpointPackage["envelope"]): string {
  return `.${envelope.checkpointId}.${byteDigest(Buffer.from(canonicalize(envelope), "utf8")).slice(7, 23)}.retired`;
}

function assertResult(
  result: PairedCheckpointResult,
  type: PairedCheckpointResult["t"],
  checkpointId: string,
): void {
  if (result.t !== type || !("checkpointId" in result) || result.checkpointId !== checkpointId) {
    throw new TypeError("Paired recovery target returned an unrelated result");
  }
}

function assertProgress(
  result: PairedCheckpointResult,
  type: "checkpoint.progress" | "checkpoint.appended",
  checkpointId: string,
  seq: number,
  total: number,
): asserts result is Extract<PairedCheckpointResult, { t: typeof type }> {
  if (
    result.t !== type ||
    result.checkpointId !== checkpointId ||
    result.seq !== seq ||
    !Number.isSafeInteger(result.receivedBytes) ||
    result.receivedBytes < 0 ||
    result.receivedBytes > total ||
    result.complete !== (result.receivedBytes === total)
  ) throw new TypeError("Paired recovery target returned invalid progress");
}

function assertPairedCommand(value: unknown): asserts value is PairedCheckpointCommand {
  if (!isRecord(value) || typeof value.t !== "string") {
    throw new TypeError("Paired recovery command is invalid");
  }
  const common = ["homeId", "sourceDeviceId", "t", "targetDeviceId", "v"];
  if (
    value.v !== 1 ||
    !nonEmptyString(value.homeId) ||
    !nonEmptyString(value.sourceDeviceId) ||
    !nonEmptyString(value.targetDeviceId)
  ) throw new TypeError("Paired recovery command binding is invalid");
  switch (value.t) {
    case "checkpoint.begin":
      assertExactKeys(value, [...common, "envelope"]);
      assertCheckpointEnvelopeShape(value.envelope);
      return;
    case "checkpoint.commit":
    case "checkpoint.get":
      assertExactKeys(value, [...common, "checkpointId"]);
      assertCheckpointId(value.checkpointId);
      return;
    case "checkpoint.inventory":
      assertExactKeys(value, [...common, "recipientKeyId", "requestId"]);
      assertRequestId(value.requestId);
      if (!nonEmptyString(value.recipientKeyId)) {
        throw new TypeError("Paired recovery inventory generation is invalid");
      }
      return;
    case "checkpoint.progress":
      assertExactKeys(value, [...common, "checkpointId", "seq"]);
      assertCheckpointId(value.checkpointId);
      assertSequence(value.seq, true);
      return;
    case "checkpoint.append":
      assertExactKeys(value, [...common, "bytes", "checkpointId", "offset", "seq"]);
      assertCheckpointId(value.checkpointId);
      assertSequence(value.seq, true);
      assertSequence(value.offset, true);
      if (!base64url(value.bytes)) throw new TypeError("Paired recovery command bytes are invalid");
      return;
    case "checkpoint.range":
      assertExactKeys(value, [...common, "checkpointId", "limit", "offset", "seq"]);
      assertCheckpointId(value.checkpointId);
      assertSequence(value.seq, true);
      assertSequence(value.offset, true);
      assertSequence(value.limit, false);
      return;
    case "checkpoint.retire":
      assertExactKeys(value, [...common, "checkpointId", "supersededBy"]);
      assertCheckpointId(value.checkpointId);
      assertCheckpointId(value.supersededBy);
      return;
    case "checkpoint.activate-root":
      assertExactKeys(value, [...common, "checkpointId", "event", "record"]);
      assertCheckpointId(value.checkpointId);
      assertRootActivationPayload(value.event, value.record);
      return;
    default:
      throw new TypeError("Paired recovery command type is unsupported");
  }
}

export function decodePairedCheckpointResult(value: unknown): PairedCheckpointResult {
  if (!isRecord(value) || typeof value.t !== "string") {
    throw new TypeError("Paired recovery result is invalid");
  }
  switch (value.t) {
    case "checkpoint.begun":
    case "checkpoint.stored":
      assertExactKeys(value, ["checkpointId", "t"]);
      assertCheckpointId(value.checkpointId);
      return value as Extract<PairedCheckpointResult, { t: "checkpoint.begun" | "checkpoint.stored" }>;
    case "checkpoint.progress":
    case "checkpoint.appended":
      assertExactKeys(value, ["checkpointId", "complete", "receivedBytes", "seq", "t"]);
      assertCheckpointId(value.checkpointId);
      assertSequence(value.seq, true);
      assertSequence(value.receivedBytes, true);
      if (typeof value.complete !== "boolean") throw new TypeError("Paired recovery progress is invalid");
      return value as Extract<PairedCheckpointResult, { t: "checkpoint.progress" | "checkpoint.appended" }>;
    case "checkpoint.manifest":
      assertExactKeys(value, ["checkpointId", "envelope", "t"]);
      assertCheckpointId(value.checkpointId);
      assertCheckpointEnvelopeShape(value.envelope);
      return value as Extract<PairedCheckpointResult, { t: "checkpoint.manifest" }>;
    case "checkpoint.inventory": {
      assertExactKeys(value, ["entries", "recipientKeyId", "requestId", "t", "targetId"]);
      assertRequestId(value.requestId);
      if (!nonEmptyString(value.targetId) || !nonEmptyString(value.recipientKeyId) || !Array.isArray(value.entries)) {
        throw new TypeError("Paired recovery inventory is invalid");
      }
      const seen = new Set<string>();
      for (const entry of value.entries) {
        if (!isRecord(entry)) throw new TypeError("Paired recovery inventory entry is invalid");
        assertExactKeys(entry, ["checkpointId", "envelope"]);
        assertCheckpointId(entry.checkpointId);
        assertCheckpointEnvelopeShape(entry.envelope);
        if (entry.envelope.checkpointId !== entry.checkpointId || seen.has(entry.checkpointId)) {
          throw new TypeError("Paired recovery inventory entry is not uniquely bound");
        }
        seen.add(entry.checkpointId);
      }
      return value as Extract<PairedCheckpointResult, { t: "checkpoint.inventory" }>;
    }
    case "checkpoint.range":
      assertExactKeys(value, ["bytes", "checkpointId", "offset", "seq", "t"]);
      assertCheckpointId(value.checkpointId);
      assertSequence(value.seq, true);
      assertSequence(value.offset, true);
      if (!base64url(value.bytes)) throw new TypeError("Paired recovery range is invalid");
      return value as Extract<PairedCheckpointResult, { t: "checkpoint.range" }>;
    case "checkpoint.retired":
      assertExactKeys(value, ["checkpointId", "supersededBy", "t"]);
      assertCheckpointId(value.checkpointId);
      assertCheckpointId(value.supersededBy);
      return value as Extract<PairedCheckpointResult, { t: "checkpoint.retired" }>;
    case "checkpoint.root-activated":
      assertExactKeys(value, ["chainHead", "checkpointId", "t"]);
      assertCheckpointId(value.checkpointId);
      assertChainHead(value.chainHead);
      return value as Extract<PairedCheckpointResult, { t: "checkpoint.root-activated" }>;
    default:
      throw new TypeError("Paired recovery result type is unsupported");
  }
}

function assertRootActivationPayload(
  event: unknown,
  record: unknown,
): asserts event is HomeTrustEvent {
  if (!isRecord(event) || !isRecord(event.body)) {
    throw new TypeError("Paired root activation event is invalid");
  }
  assertExactKeys(event, [
    "at",
    "body",
    "homeId",
    "prevEventDigest",
    "seq",
    "signature",
    "trustEpoch",
    "v",
  ]);
  assertExactKeys(event.body, [
    "backupPublicKey",
    "op",
    "rootProof",
    "rootPublicKey",
    "signedBy",
    "t",
  ]);
  if (
    event.v !== 1 ||
    !nonEmptyString(event.homeId) ||
    !Number.isSafeInteger(event.seq) || Number(event.seq) < 1 ||
    !nonEmptyString(event.prevEventDigest) ||
    !Number.isSafeInteger(event.trustEpoch) || Number(event.trustEpoch) < 1 ||
    !nonEmptyString(event.at) ||
    event.body.t !== "recovery-root" ||
    !(
      (event.body.op === "establish" && event.body.signedBy === "issuer") ||
      (event.body.op === "rotate" && event.body.signedBy === "recovery-root")
    ) ||
    !nonEmptyString(event.body.rootPublicKey) ||
    !nonEmptyString(event.body.backupPublicKey) ||
    !isRecord(event.signature) ||
    !isRecord(event.body.rootProof)
  ) throw new TypeError("Paired root activation event is invalid");
  assertSignature(event.signature);
  assertSignature(event.body.rootProof);
  assertHomeTrustRecord(record);
}

function assertHomeTrustRecord(value: unknown): asserts value is HomeTrustRecord {
  if (!isRecord(value)) throw new TypeError("Paired root activation record is invalid");
  assertExactKeys(value, [
    "chainHead",
    "homeId",
    "issuer",
    "members",
    "recoveryBackupPublicKey",
    "recoveryRootPublicKey",
    "signature",
    "trustEpoch",
    "v",
  ]);
  if (
    value.v !== 1 ||
    !nonEmptyString(value.homeId) ||
    !Number.isSafeInteger(value.trustEpoch) || Number(value.trustEpoch) < 1 ||
    !isRecord(value.issuer) ||
    !nonEmptyString(value.issuer.deviceId) ||
    !nonEmptyString(value.issuer.issuerKeyId) ||
    !Array.isArray(value.members) ||
    !nonEmptyString(value.recoveryRootPublicKey) ||
    !nonEmptyString(value.recoveryBackupPublicKey) ||
    !isRecord(value.signature)
  ) throw new TypeError("Paired root activation record is invalid");
  assertExactKeys(value.issuer, ["deviceId", "issuerKeyId"]);
  assertSignature(value.signature);
  assertChainHead(value.chainHead);
}

function assertSignature(value: Record<string, unknown>): void {
  assertExactKeys(value, ["alg", "keyId", "sig"]);
  if (
    !nonEmptyString(value.alg) ||
    !nonEmptyString(value.keyId) ||
    !nonEmptyString(value.sig)
  ) throw new TypeError("Paired root activation signature is invalid");
}

function assertChainHead(value: unknown): asserts value is HomeTrustRecord["chainHead"] {
  if (!isRecord(value)) throw new TypeError("Paired root activation chain head is invalid");
  assertExactKeys(value, ["eventDigest", "seq"]);
  if (
    !Number.isSafeInteger(value.seq) || Number(value.seq) < 0 ||
    !nonEmptyString(value.eventDigest)
  ) throw new TypeError("Paired root activation chain head is invalid");
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (canonicalize(Object.keys(value).sort()) !== canonicalize([...expected].sort())) {
    throw new TypeError("Paired recovery value has missing or unknown fields");
  }
}

function assertRootEstablishmentBinding(
  value: unknown,
): asserts value is RootEstablishmentCheckpointBinding {
  if (!isRecord(value)) throw new TypeError("Paired root establishment binding is invalid");
  assertExactKeys(value, [
    "checkpointId",
    "homeId",
    "recipientKeyId",
    "sourceDeviceId",
    "targetId",
  ]);
  if (
    !nonEmptyString(value.homeId) ||
    !nonEmptyString(value.sourceDeviceId) ||
    !nonEmptyString(value.targetId) ||
    !nonEmptyString(value.recipientKeyId)
  ) {
    throw new TypeError("Paired root establishment binding identity is invalid");
  }
  assertCheckpointId(value.checkpointId);
}

function rootLifecycleBindingName(checkpointId: string): string {
  assertCheckpointId(checkpointId);
  return `root-lifecycle-${checkpointId}.json`;
}

function assertCheckpointId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(value)) {
    throw new TypeError("Paired recovery checkpoint id is invalid");
  }
}

function assertRequestId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,192}$/u.test(value)) {
    throw new TypeError("Paired recovery inventory request id is invalid");
  }
}

function assertSequence(value: unknown, zeroAllowed: boolean): asserts value is number {
  if (!Number.isSafeInteger(value) || (zeroAllowed ? Number(value) < 0 : Number(value) < 1)) {
    throw new TypeError("Paired recovery numeric field is invalid");
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function base64url(value: unknown): value is string {
  return typeof value === "string" && /^(?:[A-Za-z0-9_-]{2,})?$/u.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
