/**
 * TranscriptStore — append-only 内容日志
 *
 * 存储路径：<conversationsDir>/<conversationId>/transcript.jsonl
 *
 * 职责边界（ADR-CM-015）：
 * - TranscriptStore 只负责内容的写入和读取
 * - 身份操作（list / rename / delete / findLatest）由 ConversationRepository 负责
 * - 两者互不依赖，由调用方（CLI / ConversationManager）协调
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Message } from "../types/messages.js";
import {
  appendRecord,
  countTurns as countTurnsFromFile,
  loadRecords,
  writeHeader,
} from "./serializer.js";
import type {
  InitTranscriptOptions,
  ITranscriptStore,
  LoadedTranscript,
  CompactMarker,
  TranscriptHeader,
  Turn,
} from "./types.js";
import { TRANSCRIPT_FORMAT_VERSION } from "./types.js";

export { getZhixingHome, getProjectId } from "../paths.js";
import { toSafePathSegment } from "../paths.js";

// ─── TranscriptStore 实现 ───

export class TranscriptStore implements ITranscriptStore {
  private readonly conversationsDir: string;
  private readonly projectPath: string;

  constructor(conversationsDir: string, projectPath: string) {
    this.conversationsDir = conversationsDir;
    this.projectPath = path.resolve(projectPath);
  }

  private transcriptFile(conversationId: string): string {
    return path.join(this.conversationsDir, toSafePathSegment(conversationId), "transcript.jsonl");
  }

  async init(
    conversationId: string,
    options: InitTranscriptOptions,
  ): Promise<void> {
    const file = this.transcriptFile(conversationId);
    await fs.mkdir(path.dirname(file), { recursive: true });

    const header: TranscriptHeader = {
      type: "header",
      version: TRANSCRIPT_FORMAT_VERSION,
      conversationId,
      name: null,
      projectPath: this.projectPath,
      createdAt: new Date().toISOString(),
      model: options.model,
      provider: options.provider,
    };

    await writeHeader(file, header);
  }

  async appendTurn(conversationId: string, turn: Turn): Promise<void> {
    const file = this.transcriptFile(conversationId);
    await this.assertFileExists(file, conversationId);
    await appendRecord(file, turn);
  }

  async appendCompact(
    conversationId: string,
    compact: CompactMarker,
  ): Promise<void> {
    const file = this.transcriptFile(conversationId);
    await this.assertFileExists(file, conversationId);
    await appendRecord(file, compact);
  }

  async load(conversationId: string): Promise<LoadedTranscript> {
    const file = this.transcriptFile(conversationId);
    const { header, turns, compacts } = await loadRecords(file);

    if (!header) {
      throw new Error(`Transcript ${conversationId}: JSONL 文件缺少 header 行`);
    }

    const messages = rebuildMessages(turns, compacts);
    return { header, messages, turnCount: turns.length };
  }

  async countTurns(conversationId: string): Promise<number> {
    const file = this.transcriptFile(conversationId);
    return countTurnsFromFile(file);
  }

  async exists(conversationId: string): Promise<boolean> {
    const file = this.transcriptFile(conversationId);
    try {
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  }

  private async assertFileExists(
    file: string,
    id: string,
  ): Promise<void> {
    try {
      await fs.access(file);
    } catch {
      throw new Error(`Transcript ${id} 不存在`);
    }
  }
}

// ─── 消息重建 ───

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
