/**
 * 知行无法进入可写对话时的只读事实面。
 *
 * 降级态只消费 Conversation 拥有的只读目录/历史投影；物理文件 reader 由
 * 进程组合边界提供。启动失败时给用户看见最近上下文与修复入口，然后退出写模式。
 */

import chalk from "chalk";
import type {
  ConversationDirectoryStorage,
} from "@zhixing/core/conversation/application";
import type { RunRecord } from "@zhixing/core/transcript";
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
  readonly storage: Pick<ConversationDirectoryStorage, "list" | "readHistory">;
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
  opts.writer.line(
    chalk.red(`${layout.contentPrefix}知行暂时无法启动，已打开最近对话供查看。`),
  );
  opts.writer.line(chalk.dim(`${layout.contentPrefix}对话写入与新请求已暂停；按 Enter 可重试。`));
  opts.writer.line("");

  const conversations = (await opts.storage.list()).slice(0, maxConversations);
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
        `${layout.contentPrefix}${conversation.name} (${conversation.conversationId})${
          when ? chalk.dim(` · ${when}`) : ""
        }`,
      ),
    );
    const runs = await readRecentRuns(
      opts.storage,
      conversation.conversationId,
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

async function readRecentRuns(
  storage: Pick<ConversationDirectoryStorage, "readHistory">,
  conversationId: string,
  limit: number,
): Promise<RunRecord[]> {
  if (limit <= 0) return [];
  const page = await storage.readHistory(conversationId, { limit });
  return page.runs.map(({ record }) => record);
}

function formatMaybeRelative(iso: string): string | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : formatRelativeTime(date);
}

function renderRepairHint(writer: CliWriter): void {
  writer.line(
    chalk.dim(
      `${layout.contentPrefix}需要排查时，可运行 zz status 查看运行状态，或用 zz serve logs 查看日志。`,
    ),
  );
  writer.line("");
}
