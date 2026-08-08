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
  type RetirableRecoveryCheckpointTarget,
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
    "checkpoint.range",
    "checkpoint.retire",
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
  | { readonly t: "checkpoint.range"; readonly checkpointId: string; readonly seq: number; readonly offset: number; readonly bytes: string }
  | { readonly t: "checkpoint.retired"; readonly checkpointId: string; readonly supersededBy: string };

export interface PairedCheckpointTransport {
  request(command: PairedCheckpointCommand, signal?: AbortSignal): Promise<PairedCheckpointResult>;
}

interface PairedStagingSession {
  readonly owner: FrozenCheckpointDirectoryIdentity;
  readonly checkpoint: FrozenCheckpointDirectoryIdentity;
  readonly envelope: CheckpointPackage["envelope"];
}

export class PairedRecoveryCheckpointTarget implements RetirableRecoveryCheckpointTarget {
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

  constructor(private readonly options: {
    readonly root: string;
    readonly target: RetirableRecoveryCheckpointTarget;
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
  constructor(private readonly options: {
    readonly homeId: string;
    readonly sourceDeviceId: string;
    readonly targetDeviceId: string;
    readonly recipientKeyId: string;
    readonly staging: FilePairedCheckpointStaging;
  }) {}

  async request(command: PairedCheckpointCommand, signal?: AbortSignal): Promise<PairedCheckpointResult> {
    assertPairedCommand(command);
    if (!(PAIRED_CHECKPOINT_RECEIVER_DESCRIPTOR.phases as readonly string[]).includes(command.t)) {
      throw new TypeError("Paired recovery command is outside the receiver descriptor");
    }
    this.#assertBinding(command);
    if (command.t === "checkpoint.begin") {
      if (
        command.envelope.recipientKeyId !== this.options.recipientKeyId ||
        command.envelope.manifest.scope.length === 0
      ) throw new TypeError("Paired recovery envelope is not authorized for this target");
      await this.options.staging.begin(command.envelope, signal);
      return { t: "checkpoint.begun", checkpointId: command.envelope.checkpointId };
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
    default:
      throw new TypeError("Paired recovery result type is unsupported");
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (canonicalize(Object.keys(value).sort()) !== canonicalize([...expected].sort())) {
    throw new TypeError("Paired recovery value has missing or unknown fields");
  }
}

function assertCheckpointId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,96}$/u.test(value)) {
    throw new TypeError("Paired recovery checkpoint id is invalid");
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
