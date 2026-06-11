/**
 * 历史尾巴渲染 —— "回到工位"的用户侧一半。
 *
 * 启动 / 切换对话 / 进入工作场景时经倒读原语取最近几轮，渲染为屏上变暗
 * 的对话摘录：agent 侧经启动装填"全记得"，用户侧打开即见最近上下文，
 * 信息对称。标题携最近一轮的相对时间——"回到工位"先知道离开了多久。
 *
 * 数据纪律：
 *   - 唯一读取通道是 readRunsReverse（UI 渲染不绕开持久层另立读取）；
 *     清空边界在原语层生效——/clear 后倒读即空，尾巴自然不渲染。
 *   - 投影只取 run 两端：用户原文 = messages[0]（持久化不变量：恒为用户
 *     原文）、最终回复 = 末条 assistant 的文本；中间的工具往返不进尾巴
 *     ——尾巴是"瞥一眼桌面"，不是完整回放（完整历史躺在磁盘，可分页倒读）。
 *     run 无最终回复（中断等）时渲染低调占位——不拿中间过程文本冒充
 *     回复，也不留白让用户误以为提问被无视。
 *
 * 视觉纪律：与实时对话同锚（用户 ❯ / AI ◆）、整体 dim——历史长得像
 * "变暗的对话"，不发明新格式；每条折叠为单行并按可见宽度截断（中文安全），
 * 遵守全局 contentPrefix 缩进合约。输出落 scrollback，与实时对话同生命
 * 周期（resize 整屏重建后不复现，与屏内对话同等待遇，有 resize 提示兜底）。
 */

import chalk from "chalk";
import {
  extractText,
  readRunsReverse,
  type Message,
  type RunRecord,
  type ShardedTranscriptStore,
} from "@zhixing/core";
import { layout } from "./tui/style.js";
import { clampLine } from "./tui/line-width.js";
import { ANCHOR_AI_DONE } from "./output/speaker-state.js";
import { formatRelativeTime } from "./commands/format.js";
import type { CliWriter } from "./screen/index.js";

/** 默认渲染的最近 run 数 —— 尾巴要短：唤起上下文即可，不是回放全史 */
export const DEFAULT_TAIL_RUNS = 3;

export interface HistoryTailEntry {
  /** 用户原文（折叠为单行） */
  userText: string;
  /** 最终回复文本（折叠为单行）；run 无 assistant 文本（中断等）时缺省 */
  assistantText?: string;
}

export interface HistoryTail {
  /** 时间正序的尾巴条目；空 = 无历史（新对话 / 刚清空） */
  entries: HistoryTailEntry[];
  /** 最近一条 run 的时刻（ISO）—— 标题相对时间锚的来源 */
  latestAt?: string;
}

/**
 * 倒读最近 maxRuns 条 run 并投影为尾巴（条目时间正序）。
 * 对话不存在 / 空 / 刚清空 → 空 entries（调用方零渲染）。
 */
export async function loadHistoryTail(
  store: ShardedTranscriptStore,
  conversationId: string,
  maxRuns: number = DEFAULT_TAIL_RUNS,
): Promise<HistoryTail> {
  const recent: RunRecord[] = [];
  for await (const { record } of readRunsReverse(store, conversationId)) {
    recent.push(record);
    if (recent.length >= maxRuns) break;
  }
  if (recent.length === 0) return { entries: [] };
  const latestAt = recent[0]!.timestamp;
  recent.reverse();
  return { entries: recent.map(projectEntry), latestAt };
}

function projectEntry(record: RunRecord): HistoryTailEntry {
  const userText = collapseToLine(extractText(record.messages[0]!));
  const lastAssistant = findLastAssistantText(record.messages);
  return lastAssistant !== undefined
    ? { userText, assistantText: lastAssistant }
    : { userText };
}

function findLastAssistantText(
  messages: readonly Message[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "assistant") continue;
    const text = collapseToLine(extractText(msg));
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

/** 多行/多空白折叠为单行 —— 尾巴每条一行，换行语义让位于扫读密度 */
function collapseToLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * 产出尾巴的渲染行（纯函数）。空条目 → 空数组（无标题无占位）。
 * width 为终端可见列数，每行按可见宽度截断（保 ANSI、防颜色溢出）。
 */
export function renderHistoryTailLines(
  tail: HistoryTail,
  width: number,
): string[] {
  if (tail.entries.length === 0) return [];
  const prefix = layout.contentPrefix;
  const maxVisible = Math.max(8, width - 1);

  const when = relativeTimeOf(tail.latestAt);
  const title = when ? `── 最近对话 · ${when}` : "── 最近对话";
  const lines: string[] = [
    clampLine(chalk.dim(`${prefix}${title}`), maxVisible),
  ];

  for (const entry of tail.entries) {
    lines.push(
      clampLine(chalk.dim(`${prefix}❯ ${entry.userText}`), maxVisible),
    );
    if (entry.assistantText !== undefined) {
      lines.push(
        clampLine(
          chalk.dim(`${prefix}${ANCHOR_AI_DONE} ${entry.assistantText}`),
          maxVisible,
        ),
      );
    } else {
      // 中断 / 失败的 run：占位而非留白——用户不该误以为提问被无视；
      // 无锚字符（这不是一条回复），缩进对齐回复文本列
      lines.push(
        clampLine(chalk.dim(`${prefix}  (此轮未生成回复)`), maxVisible),
      );
    }
  }
  lines.push("");
  return lines;
}

/** ISO 时刻 → 相对人读时间；无效输入返回 undefined（标题省略时间锚） */
function relativeTimeOf(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : formatRelativeTime(d);
}

/**
 * 组合入口：读取 + 产行 + 写出。空历史零输出。
 * 读取失败静默跳过——尾巴是纯增益展示，绝不因它阻塞启动 / 切换。
 */
export async function renderHistoryTail(opts: {
  store: ShardedTranscriptStore;
  conversationId: string;
  writer: CliWriter;
  width?: number;
  maxRuns?: number;
}): Promise<void> {
  let tail: HistoryTail;
  try {
    tail = await loadHistoryTail(opts.store, opts.conversationId, opts.maxRuns);
  } catch {
    return;
  }
  const width = opts.width ?? process.stdout.columns ?? 80;
  for (const line of renderHistoryTailLines(tail, width)) {
    opts.writer.line(line);
  }
}
