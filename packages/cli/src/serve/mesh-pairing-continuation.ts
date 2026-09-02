import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalize } from "@zhixing/core/protocol";
import {
  acquireFileLock,
  ensureDurableDirectory,
  syncDirectory,
} from "@zhixing/core/persistence";
import {
  projectMeshPairingContinuationRepository,
  type MeshPairingContinuationRepository,
  type PairingContinuation,
} from "./mesh-pairing-continuation-repository.js";

class FileMeshPairingContinuationStore
  implements MeshPairingContinuationRepository
{
  readonly #filePath: string;
  readonly #lockPath: string;

  constructor(rootDir: string) {
    const distributedRoot = path.join(path.resolve(rootDir), "distributed-runtime");
    this.#filePath = path.join(distributedRoot, "mesh-pairing-continuation.json");
    this.#lockPath = `${this.#filePath}.lock`;
  }

  async load(): Promise<PairingContinuation | undefined> {
    const release = await acquireFileLock(this.#lockPath, {
      staleMs: 30_000,
      waitMs: 5_000,
    });
    try {
      return await this.#read();
    } finally {
      await release();
    }
  }

  async save(state: PairingContinuation): Promise<void> {
    assertContinuationShape(state);
    const release = await acquireFileLock(this.#lockPath, {
      staleMs: 30_000,
      waitMs: 5_000,
    });
    try {
      await writeDurableJson(this.#filePath, state);
    } finally {
      await release();
    }
  }

  async clear(expectedOfferId: string): Promise<void> {
    const release = await acquireFileLock(this.#lockPath, {
      staleMs: 30_000,
      waitMs: 5_000,
    });
    try {
      const current = await this.#read();
      if (!current) return;
      const offerId = current.invitation.offer.offerId;
      if (offerId !== expectedOfferId) {
        throw new Error("Pairing continuation belongs to another offer");
      }
      await rm(this.#filePath, { force: true });
      await syncDirectory(path.dirname(this.#filePath));
    } finally {
      await release();
    }
  }

  async #read(): Promise<PairingContinuation | undefined> {
    let text: string;
    try {
      text = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const value = JSON.parse(text) as unknown;
    if (canonicalize(value) !== text) {
      throw new Error("Pairing continuation is not canonical");
    }
    assertContinuationShape(value);
    return value;
  }
}

export function createFileMeshPairingContinuationRepository(
  rootDir: string,
): MeshPairingContinuationRepository {
  return projectMeshPairingContinuationRepository(
    new FileMeshPairingContinuationStore(rootDir),
  );
}

function assertContinuationShape(value: unknown): asserts value is PairingContinuation {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.invitation) && value.side === "issuer") {
    throw new Error("Pairing continuation is invalid");
  }
  if (
    value.side === "issuer" &&
    (value.phase === "offer-secret-pending" ||
      value.phase === "offered" ||
      value.phase === "secret-pending" ||
      value.phase === "commit-ready") &&
    isRecord(value.invitation) &&
    isRecord(value.invitation.offer) &&
    typeof value.invitation.offer.offerId === "string"
  ) {
    return;
  }
  if (
    value.side === "joiner" &&
    (value.phase === "secret-pending" ||
      value.phase === "proof-ready" ||
      value.phase === "bootstrap-ready") &&
    isRecord(value.invitation) &&
    isRecord(value.invitation.offer) &&
    typeof value.invitation.offer.offerId === "string" &&
    isRecord(value.invitation.issuer) &&
    typeof value.localDeviceId === "string"
  ) {
    return;
  }
  throw new Error("Pairing continuation is invalid");
}

async function writeDurableJson(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDurableDirectory(directory);
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, canonicalize(value), { encoding: "utf8", flag: "wx" });
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
