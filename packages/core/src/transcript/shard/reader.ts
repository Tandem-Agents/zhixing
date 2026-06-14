/**
 * 倒读原语 —— 持久化的唯一读取入口，服务两类消费者：
 *
 *   - 上下文层启动装填：按 token 预算停（消费方自断）
 *   - 各端 UI 历史渲染：按条数停，下一页以上页最早一条的位置作 `before`
 *     游标续读更早——游标无状态，远端投影与未来检索召回同用此口
 *
 * 清空边界在原语层生效：遇 ClearRecord 即终止，任何消费者都不可能读穿
 * 清空点（"清空"对一切读取生效；其前数据物理仍在，由时间窗清理收走）。
 *
 * 实现按分片整文件读入再反向迭代——单分片字节有界，无需流式。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { toSafePathSegment } from "../../paths.js";
import type {
  RunRecord,
  RunRecordRef,
  ShardRecordLine,
  TranscriptIndex,
  TranscriptShardMeta,
} from "./types.js";
import { SHARD_FORMAT_VERSION, TRANSCRIPT_INDEX_VERSION } from "./types.js";

const SHARD_FILE_PATTERN = /^\d{6}\.jsonl$/;

export interface TranscriptReadSource {
  ensureReadableIndex(conversationId: string): Promise<TranscriptIndex | null>;
  readShardLines(
    conversationId: string,
    meta: TranscriptShardMeta,
  ): Promise<ShardRecordLine[]>;
}

export interface ReadRunsReverseOptions {
  /** 无状态分页游标：从该位置**之前**继续产出（不含该位置自身） */
  readonly before?: RunRecordRef;
}

export interface RunRecordWithRef {
  readonly record: RunRecord;
  readonly shardId: string;
}

/**
 * 从活跃分片尾部（或 before 游标处）向前逐条产出 run record，跨分片续读，
 * 遇 ClearRecord 即终止。索引 / 分片缺失时产出为空（读容错）。
 */
export async function* readRunsReverse(
  store: TranscriptReadSource,
  conversationId: string,
  options: ReadRunsReverseOptions = {},
): AsyncGenerator<RunRecordWithRef, void> {
  // 自愈版索引获取：索引缺失 / 损坏时从分片重建（分片文件在，会话就在），
  // 决不因索引层事故让完好的原文对读端失联；对话真不存在时产出为空。
  const index = await store.ensureReadableIndex(conversationId);
  if (!index) return;

  const before = options.before;
  // 游标定位：从游标所在分片开始（跳过其后的分片）；未传游标从最新分片开始
  let startShardPos = index.shards.length - 1;
  if (before) {
    const pos = index.shards.findIndex((s) => s.id === before.shardId);
    if (pos === -1) return; // 游标所指分片已被清理 → 更早内容已不存在
    startShardPos = pos;
  }

  for (let s = startShardPos; s >= 0; s--) {
    const meta = index.shards[s]!;
    const lines = await store.readShardLines(conversationId, meta);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (line.type === "clear") return; // 清空边界：到此为止
      if (line.type !== "run") continue;
      if (before && meta.id === before.shardId && line.runIndex >= before.runIndex) {
        continue; // 游标分片内跳过游标位置及其后的记录
      }
      yield { record: line, shardId: meta.id };
    }
  }
}

/**
 * 自最近清空事件以来的 run 数 —— 计数也是读路径，同守清空边界
 * （清空后对话列表显示 0 轮）。
 */
export async function countRuns(
  store: TranscriptReadSource,
  conversationId: string,
): Promise<number> {
  let count = 0;
  for await (const _ of readRunsReverse(store, conversationId)) {
    count++;
  }
  return count;
}

/**
 * 构造只读 transcript 源。它复用倒读原语，但索引缺失 / 损坏时只在内存中
 * 从分片重建投影，不写 index，不构造 Store 实例，供宿主不可用的降级读面使用。
 */
export function createReadOnlyTranscriptSource(conversationsDir: string): TranscriptReadSource {
  return new FileTranscriptReadSource(conversationsDir);
}

class FileTranscriptReadSource implements TranscriptReadSource {
  constructor(private readonly conversationsDir: string) {}

  async ensureReadableIndex(
    conversationId: string,
  ): Promise<TranscriptIndex | null> {
    const fast = await readJson<unknown>(
      path.join(this.transcriptDir(conversationId), "index.json"),
    );
    if (isReadableTranscriptIndex(fast, conversationId)) return fast;
    return this.rebuildIndex(conversationId);
  }

  async readShardLines(
    conversationId: string,
    meta: TranscriptShardMeta,
  ): Promise<ShardRecordLine[]> {
    const content = await fs
      .readFile(path.join(this.transcriptDir(conversationId), meta.file), "utf-8")
      .catch(() => "");
    return parseShardLines(content);
  }

  private async rebuildIndex(
    conversationId: string,
  ): Promise<TranscriptIndex | null> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.transcriptDir(conversationId));
    } catch {
      return null;
    }
    const shardFiles = entries.filter((e) => SHARD_FILE_PATTERN.test(e)).sort();
    if (shardFiles.length === 0) return null;

    const shards: TranscriptShardMeta[] = [];
    let lastClearAt: string | undefined;
    for (const file of shardFiles) {
      const meta: TranscriptShardMeta = {
        id: file.slice(0, -".jsonl".length),
        file,
        createdAt: new Date(0).toISOString(),
        isActive: false,
      };
      for (const line of await this.readShardLines(conversationId, meta)) {
        if (line.type === "header") {
          meta.createdAt = line.createdAt;
        } else if (
          line.type === "clear" &&
          (lastClearAt === undefined || line.timestamp > lastClearAt)
        ) {
          lastClearAt = line.timestamp;
        }
      }
      shards.push(meta);
    }
    shards[shards.length - 1]!.isActive = true;

    return {
      version: TRANSCRIPT_INDEX_VERSION,
      conversationId,
      activeShardId: shards[shards.length - 1]!.id,
      ...(lastClearAt !== undefined ? { lastClearAt } : {}),
      shards,
    };
  }

  private transcriptDir(conversationId: string): string {
    return path.join(
      this.conversationsDir,
      toSafePathSegment(conversationId),
      "transcript",
    );
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

function parseShardLines(content: string): ShardRecordLine[] {
  const lines: ShardRecordLine[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isReadableShardLine(parsed)) {
        lines.push(parsed);
      }
    } catch {
      // 读路径容错：坏行跳过，保留其它已落盘事实。
    }
  }
  return lines;
}

function isReadableTranscriptIndex(
  value: unknown,
  conversationId: string,
): value is TranscriptIndex {
  if (!isRecord(value)) return false;
  if (value.version !== TRANSCRIPT_INDEX_VERSION) return false;
  if (value.conversationId !== conversationId) return false;
  if (typeof value.activeShardId !== "string") return false;
  const shards = value.shards;
  if (!Array.isArray(shards)) return false;
  if (!shards.every(isReadableShardMeta)) return false;
  return shards.some((s) => s.id === value.activeShardId);
}

function isReadableShardMeta(value: unknown): value is TranscriptShardMeta {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.file === "string" &&
    SHARD_FILE_PATTERN.test(value.file) &&
    typeof value.createdAt === "string" &&
    typeof value.isActive === "boolean"
  );
}

function isReadableShardLine(value: unknown): value is ShardRecordLine {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "header") {
    return (
      value.version === SHARD_FORMAT_VERSION &&
      typeof value.conversationId === "string" &&
      typeof value.shardId === "string" &&
      typeof value.createdAt === "string"
    );
  }
  if (value.type === "clear") {
    return typeof value.timestamp === "string";
  }
  if (value.type === "run") {
    return (
      typeof value.runIndex === "number" &&
      typeof value.timestamp === "string" &&
      Array.isArray(value.messages)
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
