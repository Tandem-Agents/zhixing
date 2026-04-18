/**
 * JSONL 序列化器
 *
 * 负责转录记录的磁盘读写。核心设计：
 * - 追加写入：每条记录独立一行，崩溃最多丢失最后一轮
 * - 损坏隔离：单行 JSON 解析失败只跳过该行，不影响其余记录
 * - 首行即 Header：无需额外索引文件，readHeader 只读一行
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

/** 创建 JSONL 文件并写入 header 作为首行 */
export async function writeHeader(
  filePath: string,
  header: TranscriptHeader,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify(header) + "\n";
  await fs.writeFile(filePath, line, "utf-8");
}

// ─── 读取 ───

/** 只读取 JSONL 首行，解析为 TranscriptHeader。文件不存在或首行非 header 返回 null */
export async function readHeader(
  filePath: string,
): Promise<TranscriptHeader | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const newlineIdx = content.indexOf("\n");
    const firstLine = newlineIdx === -1 ? content.trim() : content.slice(0, newlineIdx).trim();
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as unknown;
    if (isTranscriptHeader(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * 加载完整的 JSONL 文件，按类型分拣记录。
 * 跳过损坏的行（JSON 解析失败或未知 type）。
 */
export async function loadRecords(filePath: string): Promise<{
  header: TranscriptHeader | null;
  turns: Turn[];
  compacts: CompactMarker[];
  corruptedLines: number;
}> {
  const content = await fs.readFile(filePath, "utf-8");
  return parseRecords(content);
}

/**
 * 从 JSONL 内容字符串解析所有记录。
 * 纯函数，方便测试。
 */
export function parseRecords(content: string): {
  header: TranscriptHeader | null;
  turns: Turn[];
  compacts: CompactMarker[];
  corruptedLines: number;
} {
  const lines = content.split("\n").filter(Boolean);
  let header: TranscriptHeader | null = null;
  const turns: Turn[] = [];
  const compacts: CompactMarker[] = [];
  let corruptedLines = 0;

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as unknown;
      if (isTranscriptHeader(record)) {
        header = record;
      } else if (isTurn(record)) {
        turns.push(record);
      } else if (isCompactMarker(record)) {
        compacts.push(record);
      } else {
        corruptedLines++;
      }
    } catch {
      corruptedLines++;
    }
  }

  return { header, turns, compacts, corruptedLines };
}

// ─── 类型守卫 ───

function isTranscriptHeader(value: unknown): value is TranscriptHeader {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).type === "header" &&
    typeof (value as Record<string, unknown>).sessionId === "string" &&
    typeof (value as Record<string, unknown>).version === "number"
  );
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
