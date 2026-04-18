/**
 * TranscriptStore — 转录持久化存储
 *
 * 核心设计：
 * - 无独立索引：按需扫描 JSONL 文件 + 读首行 header
 * - 项目隔离：SHA-256(绝对路径) 前 12 位 hex 作为项目目录
 * - Turn 级粒度：一轮要么完整保存要么不保存
 * - 人类友好 ID：YYYYMMDD-xxxx 格式，比 UUID 好记
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Message } from "../types/messages.js";
import {
  appendRecord,
  countTurns,
  loadRecords,
  readHeader,
  writeHeader,
} from "./serializer.js";
import type {
  CreateTranscriptOptions,
  ITranscriptStore,
  LoadedTranscript,
  CompactMarker,
  TranscriptHeader,
  TranscriptInfo,
  Turn,
} from "./types.js";
import { TRANSCRIPT_FORMAT_VERSION } from "./types.js";

// ─── 路径工具 ───

/** 计算项目 ID：SHA-256(路径归一化) 前 12 位 hex */
export function getProjectId(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, "/").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

/** 生成人类友好的 Transcript ID：YYYYMMDD-xxxx */
export function generateTranscriptId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
  return `${date}-${rand}`;
}

/** 知行数据根目录 */
function getZhixingHome(): string {
  return (
    process.env.ZHIXING_HOME ??
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".zhixing")
  );
}

// ─── TranscriptStore 实现 ───

export class TranscriptStore implements ITranscriptStore {
  private readonly projectPath: string;
  private readonly projectId: string;
  private readonly sessionsDir: string;
  private readonly projectMetaPath: string;

  constructor(projectPath: string) {
    this.projectPath = path.resolve(projectPath);
    this.projectId = getProjectId(this.projectPath);
    const projectDir = path.join(
      getZhixingHome(),
      "projects",
      this.projectId,
    );
    this.sessionsDir = path.join(projectDir, "sessions");
    this.projectMetaPath = path.join(projectDir, "project.json");
  }

  /** 确保目录结构存在，并更新项目元数据 */
  private async ensureProjectDir(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    try {
      const existing = JSON.parse(
        await fs.readFile(this.projectMetaPath, "utf-8"),
      ) as Record<string, unknown>;
      existing.lastAccessedAt = new Date().toISOString();
      await fs.writeFile(
        this.projectMetaPath,
        JSON.stringify(existing, null, 2),
        "utf-8",
      );
    } catch {
      await fs.writeFile(
        this.projectMetaPath,
        JSON.stringify(
          {
            path: this.projectPath,
            createdAt: new Date().toISOString(),
            lastAccessedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf-8",
      );
    }
  }

  private sessionFile(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  async create(options: CreateTranscriptOptions): Promise<TranscriptHeader> {
    await this.ensureProjectDir();

    const sessionId = generateTranscriptId();
    const header: TranscriptHeader = {
      type: "header",
      version: TRANSCRIPT_FORMAT_VERSION,
      sessionId,
      name: options.name ?? null,
      projectPath: this.projectPath,
      createdAt: new Date().toISOString(),
      model: options.model,
      provider: options.provider,
    };

    await writeHeader(this.sessionFile(sessionId), header);
    return header;
  }

  async appendTurn(sessionId: string, turn: Turn): Promise<void> {
    const file = this.sessionFile(sessionId);
    await this.assertFileExists(file, sessionId);
    await appendRecord(file, turn);
  }

  async appendCompact(
    sessionId: string,
    compact: CompactMarker,
  ): Promise<void> {
    const file = this.sessionFile(sessionId);
    await this.assertFileExists(file, sessionId);
    await appendRecord(file, compact);
  }

  async load(sessionId: string): Promise<LoadedTranscript> {
    const file = this.sessionFile(sessionId);
    const { header, turns, compacts } = await loadRecords(file);

    if (!header) {
      throw new Error(`Session ${sessionId}: JSONL 文件缺少 header 行`);
    }

    const messages = rebuildMessages(turns, compacts);
    return { header, messages, turnCount: turns.length };
  }

  async list(): Promise<TranscriptInfo[]> {
    try {
      const entries = await fs.readdir(this.sessionsDir);
      const transcripts: TranscriptInfo[] = [];

      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;

        const filePath = path.join(this.sessionsDir, entry);
        const header = await readHeader(filePath);
        if (!header) continue;

        const stat = await fs.stat(filePath);
        const turnCount = await countTurns(filePath);

        transcripts.push({
          sessionId: header.sessionId,
          name: header.name,
          createdAt: header.createdAt,
          model: header.model,
          provider: header.provider,
          lastAccessedAt: stat.mtime,
          turnCount,
        });
      }

      return transcripts.sort(
        (a, b) => b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime(),
      );
    } catch {
      return [];
    }
  }

  async rename(sessionId: string, name: string): Promise<void> {
    const file = this.sessionFile(sessionId);
    const content = await fs.readFile(file, "utf-8");
    const lines = content.split("\n");

    if (lines.length === 0 || !lines[0]) {
      throw new Error(`Session ${sessionId}: JSONL 文件为空`);
    }

    try {
      const header = JSON.parse(lines[0]) as TranscriptHeader;
      header.name = name;
      lines[0] = JSON.stringify(header);
      await fs.writeFile(file, lines.join("\n"), "utf-8");
    } catch {
      throw new Error(`Session ${sessionId}: 无法更新 header`);
    }
  }

  async delete(sessionId: string): Promise<void> {
    const file = this.sessionFile(sessionId);
    await fs.unlink(file);
  }

  /**
   * 查找当前项目最近的转录（供 --continue 使用）。
   * 返回最近修改的 session ID，无转录时返回 null。
   */
  async findLatest(): Promise<string | null> {
    const transcripts = await this.list();
    const latest = transcripts[0];
    return latest ? latest.sessionId : null;
  }

  private async assertFileExists(
    file: string,
    sessionId: string,
  ): Promise<void> {
    try {
      await fs.access(file);
    } catch {
      throw new Error(`Session ${sessionId} 不存在`);
    }
  }
}

// ─── 消息重建 ───

/**
 * 从持久化的 turns 和 compacts 重建 Agent Loop 可用的 Message[]。
 *
 * 策略：找最近的 compact，用其 summary 作为上下文前缀，
 * 然后只加载 compact 之后的 turns。
 */
function rebuildMessages(
  turns: Turn[],
  compacts: CompactMarker[],
): Message[] {
  const messages: Message[] = [];
  const lastCompact = compacts.length > 0 ? compacts[compacts.length - 1] : null;

  if (lastCompact) {
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `[对话已压缩] 以下是之前对话的摘要：\n\n${lastCompact.summary}`,
        },
      ],
    });
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: "已了解之前的对话上下文，请继续。" },
      ],
    });

    const compactTime = new Date(lastCompact.timestamp).getTime();
    const recentTurns = turns.filter(
      (t) => new Date(t.timestamp).getTime() > compactTime,
    );
    for (const turn of recentTurns) {
      messages.push(turn.userMessage, turn.assistantMessage);
    }
  } else {
    for (const turn of turns) {
      messages.push(turn.userMessage, turn.assistantMessage);
    }
  }

  return messages;
}
