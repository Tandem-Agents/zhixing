import { open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  assertDurableSchemaInventory,
  assertReleaseAdvance,
  assertStableReleaseBinding,
  byteDigest,
  compareReleaseSemver,
  decodeAndValidateStableReleaseIndex,
  validateProgramUpdateReceipt,
  type ProgramUpdateAction,
  type ProgramUpdateReceipt,
  type ProtocolSignatureVerifier,
  type ReleaseManifest,
} from "@zhixing/core/protocol";
import { createSafeFetch, safeFetch } from "@zhixing/network";
import { withProgramLock } from "./durable-file.js";
import { ProgramStore, programUpdateNoticeToken } from "./program-store.js";

const INDEX_BYTES_LIMIT = 1024 * 1024;
const DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

export interface ProgramUpdateProjection {
  readonly visible: boolean;
  readonly state?: "downloading" | "awaiting-safe-point" | "installing" | "updated" | "failed-safe" | "restored" | "action-required";
  readonly message?: string;
  readonly release?: string;
  readonly code?: string;
  readonly action?: ProgramUpdateAction;
  readonly noticeToken?: string;
}

export interface StableUpdateControllerOptions {
  readonly store: ProgramStore;
  readonly verifier: ProtocolSignatureVerifier;
  readonly indexUrl: string;
  readonly fetchDocument?: (url: string, maxBytes: number, signal?: AbortSignal) => Promise<Uint8Array>;
  readonly downloadArtifact?: (url: string, expectedBytes: number, digest: string, signal?: AbortSignal) => Promise<Uint8Array>;
  readonly handoffStaged?: (
    candidateManifestDigest: string,
    signal?: AbortSignal,
  ) => Promise<{ readonly operationId: string } | undefined>;
}

export class StableUpdateController {
  readonly #store: ProgramStore;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #indexUrl: string;
  readonly #fetchDocument: NonNullable<StableUpdateControllerOptions["fetchDocument"]>;
  readonly #downloadArtifact: NonNullable<StableUpdateControllerOptions["downloadArtifact"]>;
  readonly #handoffStaged: StableUpdateControllerOptions["handoffStaged"];

  constructor(options: StableUpdateControllerOptions) {
    this.#store = options.store;
    this.#verifier = options.verifier;
    this.#indexUrl = options.indexUrl;
    this.#fetchDocument = options.fetchDocument ?? fetchDocument;
    this.#downloadArtifact = options.downloadArtifact ?? ((url, bytes, digest, signal) =>
      downloadArtifact(this.#store.root, url, bytes, digest, signal));
    this.#handoffStaged = options.handoffStaged;
  }

  async check(signal?: AbortSignal): Promise<ProgramUpdateReceipt> {
    const outcome = await withProgramLock(this.#store.root, async () => {
      const current = await this.#store.loadCurrentManifest(this.#verifier);
      if (!current) throw new ProgramUpdateError("not-installed", "contact-support");
      const previousReceipt = await this.#store.loadReceipt().catch(() => undefined);
      if (
        previousReceipt?.notice !== "action-required" ||
        previousReceipt.currentManifestDigest !== current.digest
      ) {
        await this.#store.writeReceipt(receipt(current.digest, this.#store.target, "checking", "none"));
      }
      const indexBytes = await this.#fetchDocument(this.#indexUrl, INDEX_BYTES_LIMIT, signal);
      const index = decodeAndValidateStableReleaseIndex(indexBytes, this.#verifier);
      const target = index.targets.find((entry) => entry.target === this.#store.target);
      if (!target) throw new ProgramUpdateError("target-unavailable", "contact-support");
      const manifestBytes = await this.#fetchDocument(target.manifest.url, target.manifest.bytes, signal);
      const manifest = assertStableReleaseBinding(index, this.#store.target, manifestBytes, this.#verifier);
      const advance = assertReleaseAdvance(current.manifest, manifest);
      if (advance === "replay") {
        const idle = receipt(current.digest, this.#store.target, "idle", "none");
        await this.#store.writeReceipt(idle);
        return idle;
      }
      assertCompatibleUpgrade(current.manifest, manifest);
      const candidateDigest = byteDigest(manifestBytes);
      await this.#store.ensureDownloadCapacity(manifest.artifact.bytes);
      await this.#store.writeReceipt(receipt(
        current.digest,
        this.#store.target,
        "downloading",
        "none",
        { candidateManifestDigest: candidateDigest },
      ));
      const artifactBytes = await this.#downloadArtifact(
        target.artifactUrl,
        manifest.artifact.bytes,
        manifest.artifact.digest,
        signal,
      );
      if (artifactBytes.byteLength !== manifest.artifact.bytes || byteDigest(artifactBytes) !== manifest.artifact.digest) {
        throw new ProgramUpdateError("artifact-mismatch", "retry-update");
      }
      await this.#store.stage(manifest, manifestBytes, artifactBytes);
      const staged = receipt(
        current.digest,
        this.#store.target,
        "staged",
        "none",
        { candidateManifestDigest: candidateDigest },
      );
      await this.#store.writeReceipt(staged);
      return staged;
    });
    return this.#handoff(outcome, signal);
  }

  async checkFailSafe(signal?: AbortSignal): Promise<ProgramUpdateReceipt | undefined> {
    try {
      return await this.check(signal);
    } catch (error) {
      const current = await this.#store.loadReceipt().catch(() => undefined);
      if (!current) return undefined;
      // A lost handoff response must not demote an already accepted durable operation.
      if (current.phase === "handed-off") return current;
      const classified = classifyUpdateError(error);
      if (current.notice === "action-required" && classified.action === "retry-update") {
        return current;
      }
      const failed = receipt(
        current.currentManifestDigest,
        current.target,
        "idle",
        classified.action === "retry-update" ? "failed-safe" : "action-required",
        {
          ...(classified.action !== "retry-update" && current.candidateManifestDigest
            ? { candidateManifestDigest: current.candidateManifestDigest }
            : {}),
          code: classified.code,
          action: classified.action,
        },
      );
      await this.#store.writeReceipt(failed).catch(() => undefined);
      return failed;
    }
  }

  async restorePrevious(signal?: AbortSignal): Promise<ProgramUpdateReceipt> {
    const staged = await withProgramLock(this.#store.root, async () => {
      const pointer = await this.#store.loadPointer();
      const current = await this.#store.loadCurrentManifest(this.#verifier);
      const previous = await this.#store.loadPreviousManifest(this.#verifier);
      if (!pointer?.previous || !current || !previous) {
        throw new ProgramUpdateError("previous-unavailable", "contact-support");
      }
      assertCompatibleUpgrade(previous.manifest, current.manifest);
      const candidate = await this.#store.stageInstalled(pointer.previous, this.#verifier);
      if (candidate.digest !== previous.digest) {
        throw new ProgramUpdateError("previous-identity-changed", "contact-support");
      }
      const outcome = receipt(current.digest, pointer.target, "staged", "none", {
        candidateManifestDigest: candidate.digest,
      });
      await this.#store.writeReceipt(outcome);
      return outcome;
    });
    return this.#handoff(staged, signal);
  }

  async #handoff(
    outcome: ProgramUpdateReceipt,
    signal?: AbortSignal,
  ): Promise<ProgramUpdateReceipt> {
    if (outcome.phase !== "staged" || !outcome.candidateManifestDigest || !this.#handoffStaged) {
      return outcome;
    }
    const handoff = await this.#handoffStaged(outcome.candidateManifestDigest, signal);
    if (!handoff) throw new ProgramUpdateError("host-unavailable", "retry-update");
    const handedOff = receipt(
      outcome.currentManifestDigest,
      outcome.target,
      "handed-off",
      "none",
      {
        candidateManifestDigest: outcome.candidateManifestDigest,
        operationId: handoff.operationId,
      },
    );
    await this.#store.writeReceipt(handedOff);
    return handedOff;
  }
}

export function projectProgramUpdate(
  receipt: ProgramUpdateReceipt | undefined,
  candidateRelease?: string,
): ProgramUpdateProjection {
  if (!receipt) return { visible: false };
  if (receipt.phase === "downloading") {
    return { visible: true, state: "downloading", message: "正在下载更新", ...(candidateRelease ? { release: candidateRelease } : {}) };
  }
  if (receipt.phase === "staged") {
    return { visible: true, state: "awaiting-safe-point", message: "将在当前工作完成后更新", ...(candidateRelease ? { release: candidateRelease } : {}) };
  }
  if (receipt.phase === "handed-off") {
    return { visible: true, state: "installing", message: "正在更新", ...(candidateRelease ? { release: candidateRelease } : {}) };
  }
  if (receipt.notice === "updated") {
    return {
      visible: true,
      state: "updated",
      message: "已更新",
      noticeToken: programUpdateNoticeToken(receipt),
    };
  }
  if (receipt.notice === "restored") {
    return {
      visible: true,
      state: "restored",
      message: "更新未完成，已恢复上一版本",
      noticeToken: programUpdateNoticeToken(receipt),
    };
  }
  if (receipt.notice === "failed-safe") {
    return {
      visible: true,
      state: "failed-safe",
      message: "自动更新失败，仍在使用原版本",
      code: receipt.code,
      action: receipt.action,
    };
  }
  if (receipt.notice === "action-required") {
    return {
      visible: true,
      state: "action-required",
      message: receipt.action === "restore-previous" ? "需要恢复上一个可用版本" : "更新需要你处理",
      code: receipt.code,
      action: receipt.action,
    };
  }
  return { visible: false };
}

export function assertCompatibleUpgrade(current: ReleaseManifest, candidate: ReleaseManifest): void {
  assertDurableSchemaInventory(current.durableSchemas);
  assertDurableSchemaInventory(candidate.durableSchemas);
  if (
    compareReleaseSemver(current.releaseVersion, candidate.minimumRollbackVersion) < 0 ||
    compareReleaseSemver(candidate.minimumRollbackVersion, candidate.releaseVersion) > 0
  ) {
    throw new ProgramUpdateError("rollback-incompatible", "contact-support");
  }
  assertRangeContains(candidate.protocolRange, current.protocolRange.writeVersion, "Candidate protocol reader");
  assertRangeContains(current.protocolRange, candidate.protocolRange.writeVersion, "Rollback protocol reader");
  const currentSchemas = new Map(current.durableSchemas.map((row) => [row.schemaId, row]));
  const candidateSchemas = new Map(candidate.durableSchemas.map((row) => [row.schemaId, row]));
  if (currentSchemas.size !== candidateSchemas.size) throw new ProgramUpdateError("schema-incompatible", "contact-support");
  for (const [schemaId, oldSchema] of currentSchemas) {
    const nextSchema = candidateSchemas.get(schemaId);
    if (!nextSchema) throw new ProgramUpdateError("schema-incompatible", "contact-support");
    assertRangeContains(nextSchema, oldSchema.writeVersion, `${schemaId} candidate reader`);
    assertRangeContains(oldSchema, nextSchema.writeVersion, `${schemaId} rollback reader`);
  }
}

export class ProgramUpdateError extends Error {
  constructor(
    readonly code: string,
    readonly action: ProgramUpdateAction,
  ) {
    super(code);
    this.name = "ProgramUpdateError";
  }
}

async function fetchDocument(url: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const result = await safeFetch(url, {
    allowedProtocols: ["https"],
    maxBodyBytes: maxBytes,
    redirectPolicy: "same-host-only",
    timeoutMs: 30_000,
  }, { abortSignal: signal });
  if ("kind" in result) throw new ProgramUpdateError(networkCode(result.kind), "retry-update");
  return result.body;
}

async function downloadArtifact(
  root: string,
  url: string,
  expectedBytes: number,
  expectedDigest: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const downloads = path.join(root, "downloads");
  const partial = path.join(downloads, `${expectedDigest.slice("sha256:".length)}.partial`);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(downloads, { recursive: true, mode: 0o700 }));
  let offset = await stat(partial).then((entry) => entry.size).catch(() => 0);
  if (offset > expectedBytes) {
    await rm(partial, { force: true });
    offset = 0;
  }
  const fetch = createSafeFetch({ allowedProtocols: ["https"], timeoutMs: 30_000 });
  try {
    while (offset < expectedBytes) {
      const end = Math.min(expectedBytes - 1, offset + DOWNLOAD_CHUNK_BYTES - 1);
      const response = await fetch(url, {
        headers: { Range: `bytes=${offset}-${end}` },
        redirect: "error",
        signal,
      });
      if (response.status !== 206 && !(response.status === 200 && offset === 0)) {
        throw new ProgramUpdateError("download-unavailable", "retry-update");
      }
      const allowed = response.status === 206 ? end - offset + 1 : expectedBytes;
      const chunk = await readBoundedResponse(response, allowed);
      if (response.status === 206) {
        const expectedRange = `bytes ${offset}-${offset + chunk.byteLength - 1}/${expectedBytes}`;
        if (response.headers.get("content-range") !== expectedRange || chunk.byteLength !== allowed) {
          throw new ProgramUpdateError("download-range-mismatch", "retry-update");
        }
      } else if (chunk.byteLength !== expectedBytes) {
        throw new ProgramUpdateError("download-size-mismatch", "retry-update");
      }
      const handle = await open(partial, "a", 0o600);
      try {
        await handle.writeFile(chunk);
        await handle.sync();
      } finally {
        await handle.close();
      }
      offset += chunk.byteLength;
    }
  } catch (error) {
    if (!(error instanceof ProgramUpdateError)) throw new ProgramUpdateError("download-unavailable", "retry-update");
    throw error;
  } finally {
    await fetch.close();
  }
  const bytes = await readFile(partial);
  if (bytes.byteLength !== expectedBytes || byteDigest(bytes) !== expectedDigest) {
    await rm(partial, { force: true });
    throw new ProgramUpdateError("artifact-mismatch", "retry-update");
  }
  await rm(partial, { force: true });
  return bytes;
}

async function readBoundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new ProgramUpdateError("download-too-large", "retry-update");
    }
    chunks.push(next.value);
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function receipt(
  currentManifestDigest: string,
  target: ProgramUpdateReceipt["target"],
  phase: ProgramUpdateReceipt["phase"],
  notice: ProgramUpdateReceipt["notice"],
  extra: Partial<Pick<ProgramUpdateReceipt, "candidateManifestDigest" | "operationId" | "code" | "action">> = {},
): ProgramUpdateReceipt {
  return validateProgramUpdateReceipt({ v: 1, currentManifestDigest, target, phase, notice, ...extra });
}

function assertRangeContains(
  range: { readonly readMin: string; readonly readMax: string },
  version: string,
  label: string,
): void {
  if (BigInt(version) < BigInt(range.readMin) || BigInt(version) > BigInt(range.readMax)) {
    throw new ProgramUpdateError("schema-incompatible", "contact-support");
  }
  void label;
}

function classifyUpdateError(error: unknown): ProgramUpdateError {
  if (error instanceof ProgramUpdateError) return error;
  if (error instanceof TypeError) return new ProgramUpdateError("release-invalid", "retry-update");
  return new ProgramUpdateError("update-unavailable", "retry-update");
}

function networkCode(kind: string): string {
  if (kind === "too-large") return "download-too-large";
  if (kind === "http-error") return "release-unavailable";
  return "network-unavailable";
}
