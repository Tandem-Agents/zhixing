import { open, stat, type FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
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
  /** 载荷所在的字节块与块内偏移：只引用视图已保留的那一份核验字节，不另存副本。 */
  readonly chunk: number;
  readonly payloadStart: number;
  readonly payloadBytes: number;
  readonly singleStream?: string;
  /** 认证帧索引给出的流标记（只有标记、没有流名时）。 */
  readonly streamTag?: bigint;
  /** 认证帧索引给出的多流布隆位图。 */
  readonly streamBloom?: bigint;
}

export interface VerifiedWalView {
  readonly tail: VerifiedWalTail;
  /**
   * 从文件起点连续覆盖到 `tail.bytes` 的已核验字节块。追加只在末尾多一块，块数组与帧数组在
   * 视图之间共享，各视图只看自己的前 `chunkCount`、`frameCount` 项，追加不再复制既有内容。
   */
  readonly chunks: readonly Buffer[];
  readonly chunkCount: number;
  readonly frames: readonly VerifiedWalFrame[];
  readonly frameCount: number;
}

/** 帧载荷在视图中的那份字节。 */
export function verifiedViewPayload(view: VerifiedWalView, frame: VerifiedWalFrame): Buffer {
  return view.chunks[frame.chunk]!.subarray(frame.payloadStart, frame.payloadStart + frame.payloadBytes);
}

/**
 * 以刚耐久写入的一帧延伸视图。共享数组只在它仍以本视图结尾时原地追加；否则（另一份视图已从
 * 同一前缀延伸过）复制前缀后再追加，旧视图看到的内容始终不变。
 */
export function extendVerifiedWalView(
  view: VerifiedWalView,
  tail: VerifiedWalTail,
  frameBytes: Buffer,
  frame: Omit<VerifiedWalFrame, "chunk">,
): VerifiedWalView {
  const chunks = (view.chunks.length === view.chunkCount ? view.chunks : view.chunks.slice(0, view.chunkCount)) as Buffer[];
  const frames = (view.frames.length === view.frameCount ? view.frames : view.frames.slice(0, view.frameCount)) as VerifiedWalFrame[];
  chunks.push(frameBytes);
  frames.push({ ...frame, chunk: chunks.length - 1 });
  return { tail, chunks, chunkCount: chunks.length, frames, frameCount: frames.length };
}

export interface WalFileVersion { dev: bigint; ino: bigint; size: number; mtimeNs: bigint; ctimeNs: bigint }

// 每个 WAL 路径上按路径 stat 与 fstat 是否给出同一份元数据：未定时按路径读版本仍打开后 fstat，并同时按路径 stat 比对；
// 一次比对全部字段相等且卷号非 0 即定为一致，之后该路径按路径 stat，不再为取元数据而打开文件（打开在部分环境下代价高）。
// 卷号不同或为 0（Node 24.0 在 Windows 上按路径会报 dev=0）定为不一致，该路径一直打开后 fstat；其余字段不同只当作两次读
// 之间文件被改动，不下结论、下次再比。版本只是复用前的预筛，复用仍须比对实际字节，取值来源不改变核验语义。
// 结论按路径记，最多 64 条；超出的路径不记结论，照原样打开后 fstat。
const MAX_PATH_STAT_AGREEMENTS = 64;
const pathStatAgreements = new Map<string, boolean>();

/** Preserve filesystem timestamp precision; millisecond floats can alias fast rewrites. */
export async function readWalVersion(file: string | FileHandle): Promise<WalFileVersion> {
  if (typeof file === "string") {
    const agreement = pathStatAgreements.get(file);
    if (agreement) return walVersion(await stat(file, { bigint: true }));
    // Node 24.0 on Windows can report dev=0 through path stat while fstat
    // reports the real volume ID. All WAL proofs must use the same API.
    const handle = await open(file, "r");
    let version: WalFileVersion;
    try {
      version = await readWalVersion(handle);
    } catch (error) {
      try { await handle.close(); }
      catch (closeError) {
        throw new AggregateError([error, closeError], "Authority WAL metadata read and handle close failed", { cause: error });
      }
      throw error;
    }
    await handle.close();
    if (agreement === undefined && pathStatAgreements.size < MAX_PATH_STAT_AGREEMENTS) {
      const byPath = await stat(file, { bigint: true }).then(walVersion, () => undefined);
      if (byPath && (byPath.dev === 0n || byPath.dev !== version.dev)) pathStatAgreements.set(file, false);
      else if (byPath && byPath.ino === version.ino && byPath.size === version.size &&
        byPath.mtimeNs === version.mtimeNs && byPath.ctimeNs === version.ctimeNs) pathStatAgreements.set(file, true);
    }
    return version;
  }
  return walVersion(await file.stat({ bigint: true }));
}

function walVersion(value: BigIntStats): WalFileVersion {
  const size = Number(value.size);
  if (!Number.isSafeInteger(size)) throw new RangeError("Authority WAL exceeds safe byte addressing");
  return { dev: value.dev, ino: value.ino, size, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs };
}

/** 只供测试：清空各路径“按路径 stat 与 fstat 是否一致”的结论。 */
export function resetWalPathStatAgreementForTesting(): void {
  pathStatAgreements.clear();
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
export const VERIFIED_WAL_FRAME_RETAINED_BYTES = 208;

/** 单个视图的保留上限。启动必经的主日志可放宽，其余日志沿用默认值。 */
export interface VerifiedWalViewLimits {
  readonly bytes: number;
  readonly frames: number;
}
export const DEFAULT_VERIFIED_WAL_VIEW_LIMITS: VerifiedWalViewLimits = {
  bytes: MAX_VERIFIED_WAL_VIEW_BYTES,
  frames: MAX_VERIFIED_WAL_VIEW_FRAMES,
};

export class VerifiedWalViews {
  readonly #views = new Map<string, { view: VerifiedWalView; bytes: number }>();
  #bytes = 0;
  constructor(private readonly budget = 96 * 1024 * 1024) {}

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

  put(file: string, view: VerifiedWalView, limits: VerifiedWalViewLimits = DEFAULT_VERIFIED_WAL_VIEW_LIMITS): void {
    this.delete(file);
    const bytes = 256 + view.tail.bytes + view.frameCount * VERIFIED_WAL_FRAME_RETAINED_BYTES;
    if (bytes > Math.min(this.budget, limits.bytes) ||
        view.frameCount > limits.frames) return;
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
