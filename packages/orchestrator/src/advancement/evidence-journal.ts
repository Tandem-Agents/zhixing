import fs from "node:fs/promises";
import path from "node:path";
import type {
  EvidenceExecutionResult,
  EvidenceRequest,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  evidenceRequestDigest,
  validateEvidenceBundle,
  validateEvidenceRequest,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";

const DEFAULT_RETENTION_MS = 27 * 24 * 60 * 60 * 1_000;

type EvidenceJournalRecord =
  | {
      readonly t: "pending";
      readonly at: string;
      readonly request: EvidenceRequest;
      readonly requestDigest: string;
    }
  | {
      readonly t: "completed";
      readonly at: string;
      readonly requestId: string;
      readonly requestDigest: string;
      readonly result: EvidenceExecutionResult;
    };

interface EvidenceJournalEntry {
  readonly request: EvidenceRequest;
  readonly requestDigest: string;
  readonly pendingAt: string;
  readonly result?: EvidenceExecutionResult;
  readonly completedAt?: string;
}

export interface EvidenceJournalOptions {
  readonly file: string;
  readonly verifier: ProtocolSignatureVerifier;
  readonly now?: () => string;
  readonly retentionMs?: number;
}

/** requestId 幂等账本；权威结果先落盘，调用方随后才允许返回。 */
export class EvidenceJournal {
  readonly #file: string;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #now: () => string;
  readonly #retentionMs: number;
  #entries: Map<string, EvidenceJournalEntry> | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: EvidenceJournalOptions) {
    this.#file = path.resolve(options.file);
    this.#verifier = options.verifier;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  }

  async replay(
    request: EvidenceRequest,
  ): Promise<EvidenceExecutionResult | undefined> {
    return await this.#serialized(async () => {
      const entries = await this.#load();
      const digest = evidenceRequestDigest(request);
      const existing = entries.get(request.requestId);
      if (!existing) return undefined;
      if (
        existing.requestDigest !== digest ||
        canonicalize(existing.request) !== canonicalize(request)
      ) {
        throw new TypeError("Evidence journal requestId is bound to another request");
      }
      return existing.result;
    });
  }

  async begin(
    request: EvidenceRequest,
  ): Promise<{ readonly kind: "new" } | { readonly kind: "replay"; readonly result: EvidenceExecutionResult }> {
    return await this.#serialized(async () => {
      const entries = await this.#load();
      const digest = evidenceRequestDigest(request);
      const existing = entries.get(request.requestId);
      if (existing) {
        if (
          existing.requestDigest !== digest ||
          canonicalize(existing.request) !== canonicalize(request)
        ) {
          throw new TypeError("Evidence journal requestId is bound to another request");
        }
        return existing.result
          ? { kind: "replay", result: existing.result }
          : { kind: "new" };
      }
      const at = this.#now();
      const record: EvidenceJournalRecord = {
        t: "pending",
        at,
        request,
        requestDigest: digest,
      };
      await this.#append(record);
      entries.set(request.requestId, {
        request,
        requestDigest: digest,
        pendingAt: at,
      });
      return { kind: "new" };
    });
  }

  async complete(
    request: EvidenceRequest,
    result: EvidenceExecutionResult,
  ): Promise<EvidenceExecutionResult> {
    return await this.#serialized(async () => {
      const entries = await this.#load();
      const digest = evidenceRequestDigest(request);
      const existing = entries.get(request.requestId);
      if (!existing || existing.requestDigest !== digest) {
        throw new TypeError("Evidence journal completion has no matching request");
      }
      if (existing.result) {
        if (canonicalize(existing.result) !== canonicalize(result)) {
          throw new TypeError("Evidence journal result conflicts with the durable result");
        }
        return existing.result;
      }
      if (result.kind === "bundle") {
        validateEvidenceBundle(result.bundle, this.#verifier);
        if (
          result.bundle.requestId !== request.requestId ||
          result.bundle.requestDigest !== digest ||
          result.bundle.executorId !== request.executorId
        ) {
          throw new TypeError("Evidence bundle does not bind the journal request");
        }
      }
      const at = this.#now();
      await this.#append({
        t: "completed",
        at,
        requestId: request.requestId,
        requestDigest: digest,
        result,
      });
      entries.set(request.requestId, {
        ...existing,
        result,
        completedAt: at,
      });
      return result;
    });
  }

  async compact(): Promise<number> {
    return await this.#serialized(async () => {
      const entries = await this.#load();
      const cutoff = Date.parse(this.#now()) - this.#retentionMs;
      let removed = 0;
      for (const [requestId, entry] of entries) {
        if (
          entry.result &&
          entry.completedAt &&
          Date.parse(entry.completedAt) < cutoff
        ) {
          entries.delete(requestId);
          removed += 1;
        }
      }
      if (removed === 0) return 0;
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const records: EvidenceJournalRecord[] = [];
      for (const [requestId, entry] of entries) {
        records.push({
          t: "pending",
          at: entry.pendingAt,
          request: entry.request,
          requestDigest: entry.requestDigest,
        });
        if (entry.result && entry.completedAt) {
          records.push({
            t: "completed",
            at: entry.completedAt,
            requestId,
            requestDigest: entry.requestDigest,
            result: entry.result,
          });
        }
      }
      const temporary = `${this.#file}.tmp-${process.pid}`;
      await fs.writeFile(
        temporary,
        records.length === 0
          ? ""
          : `${records.map((record) => canonicalize(record)).join("\n")}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await fs.rename(temporary, this.#file);
      return removed;
    });
  }

  async #load(): Promise<Map<string, EvidenceJournalEntry>> {
    if (this.#entries) return this.#entries;
    const entries = new Map<string, EvidenceJournalEntry>();
    let raw = "";
    try {
      raw = await fs.readFile(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error("Evidence journal is corrupt");
      }
      if (canonicalize(value) !== line || !value || typeof value !== "object") {
        throw new Error("Evidence journal is corrupt");
      }
      const record = value as Record<string, unknown>;
      if (record.t === "pending") {
        const request = validateEvidenceRequest(record.request, this.#verifier);
        const digest = evidenceRequestDigest(request);
        if (record.requestDigest !== digest || typeof record.at !== "string") {
          throw new Error("Evidence journal is corrupt");
        }
        const existing = entries.get(request.requestId);
        if (existing && canonicalize(existing.request) !== canonicalize(request)) {
          throw new Error("Evidence journal is corrupt");
        }
        entries.set(request.requestId, {
          request,
          requestDigest: digest,
          pendingAt: record.at,
          ...(existing?.result ? { result: existing.result } : {}),
          ...(existing?.completedAt ? { completedAt: existing.completedAt } : {}),
        });
        continue;
      }
      if (record.t === "completed") {
        const requestId = record.requestId;
        if (typeof requestId !== "string") {
          throw new Error("Evidence journal is corrupt");
        }
        const existing = entries.get(requestId);
        if (
          !existing ||
          record.requestDigest !== existing.requestDigest ||
          typeof record.at !== "string" ||
          !isExecutionResult(record.result)
        ) {
          throw new Error("Evidence journal is corrupt");
        }
        const result = record.result;
        if (result.kind === "bundle") {
          validateEvidenceBundle(result.bundle, this.#verifier);
        }
        entries.set(requestId, {
          ...existing,
          result,
          completedAt: record.at,
        });
        continue;
      }
      throw new Error("Evidence journal is corrupt");
    }
    this.#entries = entries;
    return entries;
  }

  async #append(record: EvidenceJournalRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    await fs.appendFile(this.#file, `${canonicalize(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

function isExecutionResult(value: unknown): value is EvidenceExecutionResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return (
    (result.kind === "capability-gap" && Object.keys(result).length === 1) ||
    (result.kind === "bundle" && Object.keys(result).length === 2 && !!result.bundle)
  );
}
