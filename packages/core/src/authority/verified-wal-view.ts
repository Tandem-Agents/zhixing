import { stat, type FileHandle } from "node:fs/promises";
import type { Hash } from "node:crypto";

export interface VerifiedWalTail {
  readonly logId: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly bytes: number;
  readonly modifiedAt: bigint | undefined;
  readonly changedAt: bigint | undefined;
  readonly lastLsn: number;
  readonly prefixDigest: string;
  readonly physicalHash?: Hash;
}

export interface VerifiedWalFrame {
  readonly lsn: number;
  readonly frameEndOffset: number;
  readonly prefixDigest: string;
  /** Serialized, validated bytes; never a caller's mutable envelope or reducer state. */
  readonly payload: string;
  readonly singleStream?: string;
}

export interface VerifiedWalView {
  readonly tail: VerifiedWalTail;
  readonly physicalBytes: Buffer;
  readonly frames: readonly VerifiedWalFrame[];
}

export interface WalFileVersion { dev: bigint; ino: bigint; size: number; mtimeNs: bigint; ctimeNs: bigint }

/** Preserve filesystem timestamp precision; millisecond floats can alias fast rewrites. */
export async function readWalVersion(file: string | FileHandle): Promise<WalFileVersion> {
  const value = await (typeof file === "string" ? stat(file, { bigint: true }) : file.stat({ bigint: true }));
  const size = Number(value.size);
  if (!Number.isSafeInteger(size)) throw new RangeError("Authority WAL exceeds safe byte addressing");
  return { dev: value.dev, ino: value.ino, size, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs };
}

export function matchesWalVersion(tail: VerifiedWalTail, metadata: WalFileVersion): boolean {
  return tail.device === metadata.dev && tail.inode === metadata.ino &&
    tail.bytes === metadata.size && tail.modifiedAt === metadata.mtimeNs &&
    tail.changedAt === metadata.ctimeNs;
}

// A process-local physical read cache, not a second authority. Every reuse must
// establish identity/version AND compare actual bytes; timestamps are only a prefilter.
// Changes by another process invalidate it; our own durable appends can extend
// a proven view. Both total retention and one scan's capture are bounded.
export const MAX_VERIFIED_WAL_VIEW_BYTES = 8 * 1024 * 1024;
export const MAX_VERIFIED_WAL_VIEW_FRAMES = 16_384;

export class VerifiedWalViews {
  readonly #views = new Map<string, { view: VerifiedWalView; bytes: number }>();
  #bytes = 0;
  constructor(private readonly budget = 32 * 1024 * 1024) {}

  get(file: string, logId: string, metadata: WalFileVersion): VerifiedWalView | undefined {
    const entry = this.#views.get(file);
    if (!entry) return undefined;
    if (entry.view.tail.logId !== logId || !matchesWalVersion(entry.view.tail, metadata)) {
      this.delete(file);
      return undefined;
    }
    this.#views.delete(file);
    this.#views.set(file, entry);
    return entry.view;
  }

  put(file: string, view: VerifiedWalView): void {
    this.delete(file);
    const bytes = view.frames.reduce((total, frame) => total + frame.payload.length * 2 + 192, 256 + view.physicalBytes.byteLength);
    if (bytes > Math.min(this.budget, MAX_VERIFIED_WAL_VIEW_BYTES) ||
        view.frames.length > MAX_VERIFIED_WAL_VIEW_FRAMES) return;
    while (this.#views.size && (this.#bytes + bytes > this.budget || this.#views.size >= 32)) {
      this.delete(this.#views.keys().next().value!);
    }
    this.#views.set(file, { view, bytes });
    this.#bytes += bytes;
  }

  delete(file: string): void {
    const entry = this.#views.get(file);
    if (entry) this.#bytes -= entry.bytes;
    this.#views.delete(file);
  }
}

export const verifiedWalViews = new VerifiedWalViews();
