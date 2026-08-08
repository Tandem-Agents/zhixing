import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FileArtifactStore,
  FileResumableArtifactReceiver,
  type IdentifiedPhysicalStepRunner,
} from "@zhixing/core/authority";
import { ensureDurableDirectory, syncDirectory } from "@zhixing/core/persistence";
import {
  runStorageMaintenanceStep,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import type { MeshServiceClient } from "./request-channel.js";
import type { MeshServiceRegistry } from "./service-registry.js";
import { byteDigest, canonicalize } from "./canonical.js";
import {
  assertCheckpointEnvelopeShape,
  type CheckpointPackage,
} from "./checkpoint.js";
import type { RetirableRecoveryCheckpointTarget } from "./checkpoint-target.js";

export const PAIRED_CHECKPOINT_SERVICE = "recovery.checkpoint";
const TRANSFER_PART_BYTES = 256 * 1024;

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

export class PairedRecoveryCheckpointTarget implements RetirableRecoveryCheckpointTarget {
  readonly targetId: string;
  readonly independenceDomain: string;

  constructor(private readonly options: {
    readonly homeId: string;
    readonly sourceDeviceId: string;
    readonly targetDeviceId: string;
    readonly recipientKeyId: string;
    readonly transport: PairedCheckpointTransport;
  }) {
    if (options.sourceDeviceId === options.targetDeviceId) {
      throw new TypeError("Paired recovery target must be another device");
    }
    this.targetId = `backup-device:${options.targetDeviceId}`;
    this.independenceDomain = `device:${options.targetDeviceId}`;
  }

  async writeDurable(checkpoint: CheckpointPackage): Promise<void> {
    this.#assertCheckpoint(checkpoint);
    const checkpointId = checkpoint.envelope.checkpointId;
    assertResult(await this.options.transport.request({
      ...this.#binding(),
      t: "checkpoint.begin",
      envelope: checkpoint.envelope,
    }), "checkpoint.begun", checkpointId);
    for (const descriptor of checkpoint.envelope.chunks) {
      const chunk = checkpoint.chunks.find((candidate) => candidate.seq === descriptor.seq);
      if (!chunk || chunk.bytes.byteLength !== descriptor.bytes || byteDigest(chunk.bytes) !== descriptor.digest) {
        throw new TypeError("Paired recovery checkpoint has an invalid chunk exact-set");
      }
      const progress = await this.options.transport.request({
        ...this.#binding(),
        t: "checkpoint.progress",
        checkpointId,
        seq: descriptor.seq,
      });
      assertProgress(progress, "checkpoint.progress", checkpointId, descriptor.seq, descriptor.bytes);
      let offset = progress.receivedBytes;
      while (offset < descriptor.bytes) {
        const part = chunk.bytes.subarray(offset, Math.min(offset + TRANSFER_PART_BYTES, descriptor.bytes));
        const appended = await this.options.transport.request({
          ...this.#binding(),
          t: "checkpoint.append",
          checkpointId,
          seq: descriptor.seq,
          offset,
          bytes: Buffer.from(part).toString("base64url"),
        });
        assertProgress(appended, "checkpoint.appended", checkpointId, descriptor.seq, descriptor.bytes);
        if (appended.receivedBytes <= offset) throw new TypeError("Paired recovery upload made no progress");
        offset = appended.receivedBytes;
      }
    }
    assertResult(await this.options.transport.request({
      ...this.#binding(),
      t: "checkpoint.commit",
      checkpointId,
    }), "checkpoint.stored", checkpointId);
  }

  async read(checkpointId: string): Promise<CheckpointPackage> {
    const manifest = await this.options.transport.request({
      ...this.#binding(),
      t: "checkpoint.get",
      checkpointId,
    });
    if (manifest.t !== "checkpoint.manifest" || manifest.checkpointId !== checkpointId) {
      throw new TypeError("Paired recovery target returned an unrelated manifest");
    }
    const chunks = [];
    for (const descriptor of manifest.envelope.chunks) {
      const parts: Buffer[] = [];
      let offset = 0;
      while (offset < descriptor.bytes) {
        const result = await this.options.transport.request({
          ...this.#binding(),
          t: "checkpoint.range",
          checkpointId,
          seq: descriptor.seq,
          offset,
          limit: Math.min(TRANSFER_PART_BYTES, descriptor.bytes - offset),
        });
        if (
          result.t !== "checkpoint.range" ||
          result.checkpointId !== checkpointId ||
          result.seq !== descriptor.seq ||
          result.offset !== offset
        ) throw new TypeError("Paired recovery target returned an unrelated range");
        const bytes = Buffer.from(result.bytes, "base64url");
        if (bytes.byteLength === 0 || bytes.byteLength > descriptor.bytes - offset) {
          throw new TypeError("Paired recovery target returned an invalid range");
        }
        parts.push(bytes);
        offset += bytes.byteLength;
      }
      const bytes = Buffer.concat(parts);
      if (bytes.byteLength !== descriptor.bytes || byteDigest(bytes) !== descriptor.digest) {
        throw new TypeError("Paired recovery target read-back is corrupt");
      }
      chunks.push({ seq: descriptor.seq, bytes });
    }
    const checkpoint = { envelope: manifest.envelope, chunks: Object.freeze(chunks) };
    this.#assertCheckpoint(checkpoint);
    return checkpoint;
  }

  async retire(checkpointId: string, supersededBy: string): Promise<void> {
    const result = await this.options.transport.request({
      ...this.#binding(),
      t: "checkpoint.retire",
      checkpointId,
      supersededBy,
    });
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
      checkpoint.envelope.checkpointId.length === 0 ||
      canonicalize(checkpoint.envelope.chunks.map((chunk) => chunk.seq)) !==
        canonicalize(checkpoint.chunks.map((chunk) => chunk.seq))
    ) throw new TypeError("Paired recovery checkpoint is not bound to this target");
  }
}

export class FilePairedCheckpointStaging {
  constructor(private readonly options: {
    readonly root: string;
    readonly target: RetirableRecoveryCheckpointTarget;
    readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  }) {}

  async begin(envelope: CheckpointPackage["envelope"]): Promise<void> {
    assertCheckpointEnvelopeShape(envelope);
    const root = await this.#checkpointRoot(envelope.checkpointId);
    const file = path.join(root, "envelope.json");
    const text = canonicalize(envelope);
    try {
      const existing = await readFile(file, "utf8");
      if (existing !== text) throw new TypeError("Paired checkpoint replay changed its envelope");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(file, text, { flag: "wx", mode: 0o600 });
    await syncDirectory(root);
  }

  async progress(checkpointId: string, seq: number) {
    const { envelope, receiver } = await this.#session(checkpointId);
    return receiver.progress(chunkRef(envelope, seq), this.#physicalStep(checkpointId));
  }

  async append(checkpointId: string, seq: number, offset: number, bytes: Uint8Array) {
    const { envelope, receiver } = await this.#session(checkpointId);
    return receiver.append(chunkRef(envelope, seq), offset, bytes, this.#physicalStep(checkpointId));
  }

  async commit(checkpointId: string): Promise<void> {
    const { root, envelope, store, receiver } = await this.#session(checkpointId);
    const chunks = [];
    for (const descriptor of envelope.chunks) {
      const progress = await receiver.progress(descriptor, this.#physicalStep(checkpointId));
      if (!progress.complete) throw new Error("Paired recovery checkpoint upload is incomplete");
      chunks.push({ seq: descriptor.seq, bytes: await store.get(descriptor) });
    }
    await this.options.target.writeDurable({ envelope, chunks: Object.freeze(chunks) });
    await rm(root, { recursive: true, force: true });
    await syncDirectory(this.options.root);
  }

  read(checkpointId: string): Promise<CheckpointPackage> {
    return this.options.target.read(checkpointId);
  }

  retire(checkpointId: string, supersededBy: string): Promise<void> {
    return this.options.target.retire(checkpointId, supersededBy);
  }

  async #session(checkpointId: string) {
    const root = await this.#checkpointRoot(checkpointId);
    const text = await readFile(path.join(root, "envelope.json"), "utf8");
    const envelope = JSON.parse(text) as CheckpointPackage["envelope"];
    if (canonicalize(envelope) !== text || envelope.checkpointId !== checkpointId) {
      throw new TypeError("Paired recovery staging envelope is invalid");
    }
    const store = new FileArtifactStore(path.join(root, "artifacts"));
    return {
      root,
      envelope,
      store,
      receiver: new FileResumableArtifactReceiver(store, path.join(root, "partials"), {
        maxArtifactBytes: 2 * 1024 * 1024,
        maxChunkBytes: TRANSFER_PART_BYTES,
      }),
    };
  }

  async #checkpointRoot(checkpointId: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]{1,96}$/u.test(checkpointId)) throw new TypeError("Checkpoint id is invalid");
    await ensureDurableDirectory(this.options.root);
    const root = path.join(this.options.root, checkpointId);
    await mkdir(root, { recursive: true });
    return root;
  }

  #physicalStep(checkpointId: string): IdentifiedPhysicalStepRunner {
    return (identity, operation) => runStorageMaintenanceStep(
      this.options.storageMaintenance,
      storageMaintenanceRequest(
        "authority-checkpoint",
        this.options.target.targetId,
        { checkpointId, step: identity },
        { obligation: "committed" },
      ),
      operation,
    );
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

  async request(command: PairedCheckpointCommand): Promise<PairedCheckpointResult> {
    assertPairedCommand(command);
    this.#assertBinding(command);
    if (command.t === "checkpoint.begin") {
      if (
        command.envelope.recipientKeyId !== this.options.recipientKeyId ||
        command.envelope.manifest.scope.length === 0
      ) throw new TypeError("Paired recovery envelope is not authorized for this target");
      await this.options.staging.begin(command.envelope);
      return { t: "checkpoint.begun", checkpointId: command.envelope.checkpointId };
    }
    if (command.t === "checkpoint.progress") {
      const progress = await this.options.staging.progress(command.checkpointId, command.seq);
      return { t: "checkpoint.progress", checkpointId: command.checkpointId, seq: command.seq, ...progress };
    }
    if (command.t === "checkpoint.append") {
      const bytes = Buffer.from(command.bytes, "base64url");
      if (bytes.byteLength > TRANSFER_PART_BYTES) throw new RangeError("Paired checkpoint part is too large");
      const progress = await this.options.staging.append(command.checkpointId, command.seq, command.offset, bytes);
      return { t: "checkpoint.appended", checkpointId: command.checkpointId, seq: command.seq, ...progress };
    }
    if (command.t === "checkpoint.commit") {
      await this.options.staging.commit(command.checkpointId);
      return { t: "checkpoint.stored", checkpointId: command.checkpointId };
    }
    if (command.t === "checkpoint.get") {
      const checkpoint = await this.options.staging.read(command.checkpointId);
      return { t: "checkpoint.manifest", checkpointId: command.checkpointId, envelope: checkpoint.envelope };
    }
    if (command.t === "checkpoint.range") {
      if (command.limit < 1 || command.limit > TRANSFER_PART_BYTES) throw new RangeError("Paired checkpoint range limit is invalid");
      const checkpoint = await this.options.staging.read(command.checkpointId);
      const chunk = checkpoint.chunks.find((candidate) => candidate.seq === command.seq);
      if (!chunk || command.offset < 0 || command.offset > chunk.bytes.byteLength) {
        throw new RangeError("Paired checkpoint range is outside the selected chunk");
      }
      return {
        t: "checkpoint.range",
        checkpointId: command.checkpointId,
        seq: command.seq,
        offset: command.offset,
        bytes: Buffer.from(chunk.bytes.subarray(command.offset, command.offset + command.limit)).toString("base64url"),
      };
    }
    await this.options.staging.retire(command.checkpointId, command.supersededBy);
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
    assertPairedResult(value);
    return value;
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

function assertPairedResult(value: unknown): asserts value is PairedCheckpointResult {
  if (!isRecord(value) || typeof value.t !== "string") {
    throw new TypeError("Paired recovery result is invalid");
  }
  switch (value.t) {
    case "checkpoint.begun":
    case "checkpoint.stored":
      assertExactKeys(value, ["checkpointId", "t"]);
      assertCheckpointId(value.checkpointId);
      return;
    case "checkpoint.progress":
    case "checkpoint.appended":
      assertExactKeys(value, ["checkpointId", "complete", "receivedBytes", "seq", "t"]);
      assertCheckpointId(value.checkpointId);
      assertSequence(value.seq, true);
      assertSequence(value.receivedBytes, true);
      if (typeof value.complete !== "boolean") throw new TypeError("Paired recovery progress is invalid");
      return;
    case "checkpoint.manifest":
      assertExactKeys(value, ["checkpointId", "envelope", "t"]);
      assertCheckpointId(value.checkpointId);
      assertCheckpointEnvelopeShape(value.envelope);
      return;
    case "checkpoint.range":
      assertExactKeys(value, ["bytes", "checkpointId", "offset", "seq", "t"]);
      assertCheckpointId(value.checkpointId);
      assertSequence(value.seq, true);
      assertSequence(value.offset, true);
      if (!base64url(value.bytes)) throw new TypeError("Paired recovery range is invalid");
      return;
    case "checkpoint.retired":
      assertExactKeys(value, ["checkpointId", "supersededBy", "t"]);
      assertCheckpointId(value.checkpointId);
      assertCheckpointId(value.supersededBy);
      return;
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
