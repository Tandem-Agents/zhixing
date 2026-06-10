/**
 * SnapshotStore —— 派生摘要快照的读写件。
 *
 * 目录形态：`<conversationsDir>/<conversationId>/snapshots/<createdAt-ISO-safe>.json`
 * 每快照一个独立文件——owner 只写新文件、清理只删整文件，永不重写既有
 * 内容（与分片同纪律）。文件名只是落点，时间真相在内容 `createdAt`。
 *
 * 读容错：单文件损坏（半写 / 坏块）跳过即可——快照是纯派生缓存，缺失的
 * 代价只是启动连贯性降级，绝不让一个坏文件阻塞装填。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { toSafePathSegment } from "../../paths.js";
import { writeAtomic } from "../serializer.js";
import {
  SNAPSHOT_FILE_VERSION,
  type SegmentSnapshotFile,
  type SnapshotInput,
} from "./types.js";

export interface SnapshotStoreOptions {
  /** 平台 DI（原子写的 rename 策略），默认 process.platform */
  readonly platform?: NodeJS.Platform;
}

export class SnapshotStore {
  private readonly conversationsDir: string;
  private readonly platform?: NodeJS.Platform;

  constructor(conversationsDir: string, options?: SnapshotStoreOptions) {
    this.conversationsDir = conversationsDir;
    this.platform = options?.platform;
  }

  private snapshotsDir(conversationId: string): string {
    return path.join(
      this.conversationsDir,
      toSafePathSegment(conversationId),
      "snapshots",
    );
  }

  /** 写一个新快照文件，createdAt 在写入时定格并返回完整记录 */
  async write(
    conversationId: string,
    input: SnapshotInput,
  ): Promise<SegmentSnapshotFile> {
    const snapshot: SegmentSnapshotFile = {
      version: SNAPSHOT_FILE_VERSION,
      conversationId,
      createdAt: new Date().toISOString(),
      coveredThroughRunIndex: input.coveredThroughRunIndex,
      structuredSummary: input.structuredSummary,
      tokensBefore: input.tokensBefore,
      tokensAfter: input.tokensAfter,
    };
    const file = path.join(
      this.snapshotsDir(conversationId),
      `${snapshot.createdAt.replace(/[:.]/g, "-")}.json`,
    );
    await writeAtomic(file, `${JSON.stringify(snapshot, null, 2)}\n`, {
      platform: this.platform,
    });
    return snapshot;
  }

  /**
   * 列出全部可读快照，按 `createdAt` 降序（最新在前）。
   * 目录不存在 → 空；单文件解析失败 → 跳过（读容错）。
   */
  async list(conversationId: string): Promise<SegmentSnapshotFile[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.snapshotsDir(conversationId));
    } catch {
      return [];
    }

    const snapshots: SegmentSnapshotFile[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(
          path.join(this.snapshotsDir(conversationId), entry),
          "utf-8",
        );
        const parsed = JSON.parse(raw) as SegmentSnapshotFile;
        if (
          parsed.version === SNAPSHOT_FILE_VERSION &&
          typeof parsed.createdAt === "string" &&
          typeof parsed.coveredThroughRunIndex === "number" &&
          parsed.structuredSummary !== undefined
        ) {
          snapshots.push(parsed);
        }
      } catch {
        // 坏文件跳过 —— 快照是派生缓存，缺一个只是连贯性降级
      }
    }
    snapshots.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return snapshots;
  }
}
