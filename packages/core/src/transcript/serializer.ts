/**
 * JSONL 序列化器
 *
 * 负责转录记录的磁盘读写。核心设计：
 * - 追加写入：每条记录独立一行，崩溃最多丢失最后一轮
 * - 损坏隔离：单行 JSON 解析失败只跳过该行，不影响其余记录
 * - 首行即 Header：无需额外索引文件
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  CompactMarker,
  TranscriptHeader,
  TranscriptRecord,
  Turn,
} from "./types.js";

// ─── 写入 ───

/** 将一条记录追加到 JSONL 文件末尾 */
export async function appendRecord(
  filePath: string,
  record: TranscriptRecord,
): Promise<void> {
  const line = JSON.stringify(record) + "\n";
  await fs.appendFile(filePath, line, "utf-8");
}

// ─── 原子写入 ───

/**
 * 原子替换文件内容 —— 写 tmp + rename 的经典模式。
 *
 * 失败模型：
 *   - 写 tmp 失败 → 抛错，原文件不变
 *   - rename 失败 → 抛错，tmp 文件留存（orphan），原文件不变
 *   - 成功 → 原文件被 tmp 完全替代
 *
 * 平台差异：
 *   - POSIX (linux/darwin)：`rename(2)` 原子覆盖，一次调用搞定
 *   - Windows：默认走 fallback —— `unlink old → rename tmp`，避免 MoveFileExW 的
 *     边缘场景（共享驱动器、WSL、旧版 NTFS）破坏原子假设；orphan tmp 由
 *     `cleanupOrphanTmp` 启动清理
 *
 * DI：`platform` 参数供测试锚定（CLAUDE.md 要求：测试分支 process.platform 必须 DI）。
 * 不传时默认 `process.platform`。
 */
export interface WriteAtomicOptions {
  /** 平台 DI，默认 `process.platform` */
  readonly platform?: NodeJS.Platform;
}

export async function writeAtomic(
  filePath: string,
  content: string | Uint8Array,
  opts?: WriteAtomicOptions,
): Promise<void> {
  const platform = opts?.platform ?? process.platform;
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tmp = tmpPathFor(filePath);
  // string 默认按 utf-8 写;Uint8Array / Buffer 原样写 —— 二进制安全
  // (技能附属文件需逐字节保真,与 Agent Skills 生态兼容)。
  await fs.writeFile(tmp, content);

  if (platform === "win32") {
    // Windows fallback：先 unlink，再 rename
    try {
      await fs.unlink(filePath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // unlink 失败（非"文件不存在"）→ 清理 tmp 后抛错
        await fs.unlink(tmp).catch(() => {});
        throw e;
      }
    }
    try {
      await fs.rename(tmp, filePath);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  } else {
    // POSIX：rename 原子覆盖
    try {
      await fs.rename(tmp, filePath);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  }
}

/**
 * 清理目录下的孤立 .tmp 文件（来自崩溃残留）。
 *
 * 只扫 `${basename}.*.tmp` 模式 —— 不会误删用户的其他 .tmp 文件。
 * 失败静默（权限、目录不存在等）—— 清理是 best-effort，不阻塞主流程。
 */
export async function cleanupOrphanTmp(targetFilePath: string): Promise<void> {
  const dir = path.dirname(targetFilePath);
  const prefix = `${path.basename(targetFilePath)}.`;

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((e) => e.startsWith(prefix) && e.endsWith(".tmp"))
      .map((e) => fs.unlink(path.join(dir, e)).catch(() => {})),
  );
}

/**
 * 生成唯一的 tmp 文件名。格式：`{targetPath}.{pid}-{ts}-{rand}.tmp`。
 *
 * pid + 毫秒时间戳 + 随机后缀三重保证并发写不碰撞，即使同一进程内瞬时发起多次
 * commitTurn（实际被锁串行，但构造 tmp 名不依赖锁）。
 */
function tmpPathFor(filePath: string): string {
  const uniq = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${filePath}.${uniq}.tmp`;
}

// ─── 读取 ───

/**
 * 加载完整的 JSONL 文件，按类型分拣记录。
 * 跳过损坏的行（JSON 解析失败或未知 type）。
 */
export async function loadRecords(filePath: string): Promise<{
  header: TranscriptHeader | null;
  turns: Turn[];
  compacts: CompactMarker[];
  corruptedLines: number;
  turnsBeforeLastCompact: number;
}> {
  const content = await fs.readFile(filePath, "utf-8");
  return parseRecords(content);
}

/**
 * 从 JSONL 内容字符串解析所有记录。
 * 纯函数，方便测试。
 *
 * `turnsBeforeLastCompact`：文件物理顺序中、出现在**最后一个 compact 行之前**
 * 的 turn 数（无 compact 时为 0）。这是归一化判定的结构事实：健康文件由
 * 原子重写产生、compact 永远是 header 后第一行（计数 0）；turn 行出现在
 * compact 之前只可能是历史 bug 遗留的"先 append turn 再 append compact"
 * 形态。按物理顺序判而不按时间戳猜——压缩保留的近期 turns 时间戳天然早于
 * marker（marker 记压缩发生时刻），时间戳判定会把它们误杀。
 */
export function parseRecords(content: string): {
  header: TranscriptHeader | null;
  turns: Turn[];
  compacts: CompactMarker[];
  corruptedLines: number;
  turnsBeforeLastCompact: number;
} {
  const lines = content.split("\n").filter(Boolean);
  let header: TranscriptHeader | null = null;
  const turns: Turn[] = [];
  const compacts: CompactMarker[] = [];
  let corruptedLines = 0;
  let turnsBeforeLastCompact = 0;

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as unknown;
      if (isTranscriptHeader(record)) {
        header = record;
      } else if (isTurn(record)) {
        turns.push(record);
      } else if (isCompactMarker(record)) {
        compacts.push(record);
        turnsBeforeLastCompact = turns.length;
      } else {
        corruptedLines++;
      }
    } catch {
      corruptedLines++;
    }
  }

  return { header, turns, compacts, corruptedLines, turnsBeforeLastCompact };
}

// ─── 类型守卫 ───

/**
 * 判断并归一化 header。旧文件用 sessionId，新文件用 conversationId。
 * 读取时统一映射为 conversationId，写入时只写 conversationId。
 */
function isTranscriptHeader(value: unknown): value is TranscriptHeader {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Record<string, unknown>).type !== "header" ||
    typeof (value as Record<string, unknown>).version !== "number"
  ) {
    return false;
  }
  const record = value as Record<string, unknown>;
  // 旧格式迁移：sessionId → conversationId
  if (typeof record.sessionId === "string" && !record.conversationId) {
    record.conversationId = record.sessionId;
    delete record.sessionId;
  }
  return typeof record.conversationId === "string";
}

function isTurn(value: unknown): value is Turn {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).type === "turn" &&
    typeof (value as Record<string, unknown>).turnIndex === "number"
  );
}

function isCompactMarker(value: unknown): value is CompactMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).type === "compact" &&
    typeof (value as Record<string, unknown>).summary === "string"
  );
}

// ─── 辅助工具 ───

/** 统计 JSONL 文件中的 turn 数量 */
export async function countTurns(filePath: string): Promise<number> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");
    let count = 0;
    for (const line of lines) {
      if (line.includes('"type":"turn"') || line.includes('"type": "turn"')) {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}
