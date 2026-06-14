/**
 * 宿主不可用时的只读事实面。
 *
 * 这里故意不用 ConversationRepository / ShardedTranscriptStore：降级态只能读
 * 磁盘事实，不能持有任何带写能力的实例。列表与尾巴都从文件级 reader 读出，
 * 启动失败时给用户看见最近上下文与修复入口，然后退出写模式。
 */

import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import {
  createReadOnlyTranscriptSource,
  conversationsDir,
  readRunsReverse,
  type Conversation,
  type RunRecord,
} from "@zhixing/core";
import {
  projectHistoryTail,
  renderHistoryTailLines,
} from "../history-tail.js";
import { formatRelativeTime } from "../commands/format.js";
import type { CliWriter } from "../screen/index.js";
import { layout } from "../tui/style.js";

export interface ReadOnlyConversationBrowserOptions {
  readonly writer: CliWriter;
  readonly error: unknown;
  readonly maxConversations?: number;
  readonly maxRunsPerConversation?: number;
  readonly width?: number;
}

export interface ReadOnlyConversationBrowserResult {
  readonly conversations: number;
  readonly renderedRuns: number;
}

export async function renderReadOnlyConversationBrowser(
  opts: ReadOnlyConversationBrowserOptions,
): Promise<ReadOnlyConversationBrowserResult> {
  const maxConversations = opts.maxConversations ?? 5;
  const maxRunsPerConversation = opts.maxRunsPerConversation ?? 1;
  const width = opts.width ?? process.stdout.columns ?? 80;
  const reason = opts.error instanceof Error ? opts.error.message : String(opts.error);

  opts.writer.line(
    chalk.red(`${layout.contentPrefix}核心宿主不可用，已进入只读浏览。`),
  );
  opts.writer.line(chalk.dim(`${layout.contentPrefix}${reason}`));
  opts.writer.line(
    chalk.dim(
      `${layout.contentPrefix}对话写入与新请求已暂停；下面只读取本机已落盘的最近对话。`,
    ),
  );
  opts.writer.line("");

  const root = conversationsDir({ kind: "user" });
  const transcriptSource = createReadOnlyTranscriptSource(root);
  const conversations = (await readConversations(root)).slice(0, maxConversations);
  if (conversations.length === 0) {
    opts.writer.line(chalk.dim(`${layout.contentPrefix}没有可显示的本地对话。`));
    renderRepairHint(opts.writer);
    return { conversations: 0, renderedRuns: 0 };
  }

  let renderedRuns = 0;
  for (const conversation of conversations) {
    const when = formatMaybeRelative(conversation.lastActiveAt);
    opts.writer.line(
      chalk.cyan(
        `${layout.contentPrefix}${conversation.name} (${conversation.id})${
          when ? chalk.dim(` · ${when}`) : ""
        }`,
      ),
    );
    const runs = await readRecentRuns(
      transcriptSource,
      conversation.id,
      maxRunsPerConversation,
    );
    renderedRuns += runs.length;
    const lines = renderHistoryTailLines(
      projectHistoryTail(runs, maxRunsPerConversation),
      width,
    );
    if (lines.length === 0) {
      opts.writer.line(chalk.dim(`${layout.contentPrefix}  暂无可显示的最近轮次。`));
      opts.writer.line("");
      continue;
    }
    for (const line of lines) opts.writer.line(line);
  }

  renderRepairHint(opts.writer);
  return { conversations: conversations.length, renderedRuns };
}

async function readConversations(root: string): Promise<Conversation[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }

  const conversations: Conversation[] = [];
  for (const entry of entries) {
    const meta = await readJson<Conversation>(path.join(root, entry, "meta.json"));
    if (!meta || meta.archived) continue;
    if (
      typeof meta.id !== "string" ||
      typeof meta.name !== "string" ||
      typeof meta.lastActiveAt !== "string"
    ) {
      continue;
    }
    conversations.push(meta);
  }

  return conversations.sort(
    (a, b) =>
      new Date(b.lastActiveAt).getTime() -
      new Date(a.lastActiveAt).getTime(),
  );
}

async function readRecentRuns(
  transcriptSource: ReturnType<typeof createReadOnlyTranscriptSource>,
  conversationId: string,
  limit: number,
): Promise<RunRecord[]> {
  if (limit <= 0) return [];
  const runs: RunRecord[] = [];
  for await (const { record } of readRunsReverse(transcriptSource, conversationId)) {
    runs.push(record);
    if (runs.length >= limit) break;
  }
  return runs;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

function formatMaybeRelative(iso: string): string | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : formatRelativeTime(date);
}

function renderRepairHint(writer: CliWriter): void {
  writer.line(
    chalk.dim(
      `${layout.contentPrefix}修复建议：运行 zhixing serve status 查看状态，或用 zhixing serve logs 查看宿主日志。`,
    ),
  );
  writer.line("");
}
