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
 *   - 投影取首条输入、带身份的追加输入与末条 assistant 文本；
 *     通信投递保留去向及回执，中间的其它工具往返不进尾巴
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
import { extractText } from "@zhixing/core/types";
import { conversationStateLabel } from "./conversation-state-label.js";
import { type RunRecord } from "@zhixing/core/transcript";
import type { ConversationMessageStatus } from "@zhixing/core/conversation/application";
import { ADVANCEMENT_TURN_LABEL } from "./advancement-presentation.js";
import { layout } from "./tui/style.js";
import { clampLine } from "./tui/line-width.js";
import { ANCHOR_AI_DONE } from "./output/speaker-state.js";
import { formatRelativeTime } from "./commands/format.js";
import type { CliWriter } from "./screen/index.js";

export { projectHistoryTail, DEFAULT_TAIL_RUNS, type HistoryTail, type HistoryTailEntry } from "./runtime/conversation-history-projection.js";
import { projectHistoryTail, collapseToLine, type HistoryTail } from "./runtime/conversation-history-projection.js";

/**
 * 产出尾巴的渲染行（纯函数）。空条目 → 空数组（无标题无占位）。
 * width 为终端可见列数，每行按可见宽度截断（保 ANSI、防颜色溢出）。
 */
export function renderHistoryTailLines(
  tail: HistoryTail,
  width: number,
): string[] {
  if (tail.entries.length === 0 && !tail.outsideInputs?.length) return [];
  const prefix = layout.contentPrefix;
  const maxVisible = Math.max(8, width - 1);

  const when = relativeTimeOf(tail.latestAt);
  const title = when ? `── 最近对话 · ${when}` : "── 最近对话";
  const lines: string[] = [
    clampLine(chalk.dim(`${prefix}${title}`), maxVisible),
  ];

  for (const entry of tail.entries) {
    // 来源标记与实时旁观同源：代理续推的首行不是用户说的话，
    // 明说来源，与真实用户轮（❯）视觉区分。
    const userLine = entry.sourceConversationId
      ? `${prefix}◇ 来自对话 ${entry.sourceConversationId}: ${entry.userText}`
      : entry.fromAdvancement
      ? `${prefix}◇ ${ADVANCEMENT_TURN_LABEL}: ${entry.userText}`
      : `${prefix}❯ ${entry.userText}`;
    lines.push(clampLine(chalk.dim(userLine), maxVisible));
    for (const input of entry.inputs ?? []) {
      lines.push(clampLine(chalk.dim(`${prefix}${input.sourceConversationId ? `◇ 来自对话 ${input.sourceConversationId}:` : "❯"} ${input.text}`), maxVisible));
    }
    for (const sent of entry.sent ?? []) lines.push(clampLine(chalk.dim(`${prefix}${sent}`), maxVisible));
    if (entry.assistantText !== undefined) {
      const assistantPrefix = entry.perspectiveCount
        ? `${ANCHOR_AI_DONE} 多视角评议 · ${entry.perspectiveCount} 视角:`
        : ANCHOR_AI_DONE;
      lines.push(
        clampLine(
          chalk.dim(`${prefix}${assistantPrefix} ${entry.assistantText}`),
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
  for (const input of tail.outsideInputs ?? []) {
    const source = input.message.inputIdentity?.source;
    const label = source?.kind === "conversation" ? `来自对话 ${source.conversationId}` : "用户消息";
    const state = conversationStateLabel(input.state);
    const status = input.disposition === "stopped" ? "已停止、未消费"
      : input.consumed ? `已进入运行输入${state ? ` · ${state}` : ""}` : "已接纳、待处理";
    lines.push(clampLine(chalk.dim(`${prefix}◇ ${label} · ${status}: ${collapseToLine(extractText(input.message))}`), maxVisible));
  }
  if (tail.outsideInputsTruncated) lines.push(chalk.dim(`${prefix}… 尚有更早的未入历史消息，可按消息标识查询。`));
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
 * 组合入口：投影 + 产行 + 写出。空历史零输出。
 * runs 为倒序(新→旧)run 记录——调用方经 RPC history 取得;记录形状以
 * RunRecord 为准(带索引引用的扩展字段不参与投影)。
 */
export function renderHistoryTail(opts: {
  runs: readonly RunRecord[];
  writer: CliWriter;
  width?: number;
  maxRuns?: number;
  inputsOutsideHistory?: readonly ConversationMessageStatus[];
  inputsOutsideHistoryTruncated?: boolean;
}): void {
  const tail = projectHistoryTail(opts.runs, opts.maxRuns);
  tail.outsideInputs = opts.inputsOutsideHistory;
  tail.outsideInputsTruncated = opts.inputsOutsideHistoryTruncated;
  const width = opts.width ?? process.stdout.columns ?? 80;
  for (const line of renderHistoryTailLines(tail, width)) {
    opts.writer.line(line);
  }
}
