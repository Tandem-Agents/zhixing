/**
 * 信息页语义投影的公共部分：文本清洗、一页的字节上界、跨页拆分与文字出口。
 * 各页（安全状态、运行状态、用量、上下文、命令帮助、任务推进）只给语义，不带颜色或排版；
 * 终端信息页与旧文本出口共用同一份投影，各端陈述同样的事实。
 */

import {
  TERMINAL_SUMMARY_LIMITS,
  type TerminalSummary,
  type TerminalSummaryRow,
  type TerminalSummarySection,
  type TerminalSummaryText,
} from "@zhixing/terminal-ui/protocol";
import { stripAnsi } from "./tui/ansi.js";

/** 去掉 ANSI、控制字符与双向覆写字符，另把换行与制表符换成空格：
 *  信息页的每段文字都是单行语义，换行由公共组件按宽度决定。按上界截断 */
export function summaryText(value: unknown): string {
  const text = stripAnsi(String(value ?? "")).replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/gu, " ");
  return text.length > TERMINAL_SUMMARY_LIMITS.text ? `${text.slice(0, TERMINAL_SUMMARY_LIMITS.text - 1)}…` : text;
}

const omittedNote = (count: number) => `另有 ${count} 项未能显示（超出展示容量）`;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) + 1;

/** 守住一页的上界：每区块的行数与并列条目数不超过协议上限，整页不超过字节预算。
 *  超出时从条目最多的列表（行或并列条目）尾部裁掉，并在该区块写明未能显示的条数。
 *  只剩无法裁剪的内容仍超出时抛出 overflow */
export function fitSummary(summary: TerminalSummary, overflow: string): TerminalSummary {
  const bytes = (value: TerminalSummary) => Buffer.byteLength(JSON.stringify(value));
  const counted = summary.sections.every((section) => (section.rows?.length ?? 0) <= TERMINAL_SUMMARY_LIMITS.rows
    && (section.items?.length ?? 0) <= TERMINAL_SUMMARY_LIMITS.items);
  if (counted && bytes(summary) <= TERMINAL_SUMMARY_LIMITS.bytes) return summary;
  const dropped = new Map<number, number>();
  const sections = summary.sections.map((section, index) => {
    const rows = section.rows?.slice(0, TERMINAL_SUMMARY_LIMITS.rows), items = section.items?.slice(0, TERMINAL_SUMMARY_LIMITS.items);
    const cut = (section.rows?.length ?? 0) - (rows?.length ?? 0) + (section.items?.length ?? 0) - (items?.length ?? 0);
    if (cut > 0) dropped.set(index, cut);
    return { ...section, rows, items };
  });
  const current = (): TerminalSummary => ({
    lead: summary.lead,
    sections: sections.map((section, index) => dropped.has(index)
      ? { ...section, notes: [...(section.notes ?? []), omittedNote(dropped.get(index)!)].slice(-TERMINAL_SUMMARY_LIMITS.notes) }
      : section),
  });
  const length = (section: (typeof sections)[number]) => Math.max(section.rows?.length ?? 0, section.items?.length ?? 0);
  while (bytes(current()) > TERMINAL_SUMMARY_LIMITS.bytes) {
    let longest = -1;
    sections.forEach((section, index) => { if (length(section) > (longest < 0 ? 0 : length(sections[longest]!))) longest = index; });
    if (longest < 0) throw Error(overflow);
    const target = sections[longest]!;
    if ((target.rows?.length ?? 0) >= (target.items?.length ?? 0)) target.rows!.pop(); else target.items!.pop();
    dropped.set(longest, (dropped.get(longest) ?? 0) + 1);
  }
  return current();
}

/** 多页信息的整体容量：所有页合计不超过它（选择页整体上限 2 MiB 之内），超出部分写明未能显示的条数 */
export const SUMMARY_PAGES_BYTES = 1536 * 1024;

/** 按页拆分：每页不超过一页的内容预算，一页合计不超过一个区块的行数上限（页面保持轻量，与原先的文字分页相当），
 *  区块跨页时标题加“（续）”，区块说明放在该区块最后一段；
 *  所有页合计超过 totalBytes 时停止，并在最后一个区块写明未能显示的条数，不伪称完整 */
export function paginateSummary(lead: TerminalSummaryText[][], sections: readonly TerminalSummarySection[], totalBytes = SUMMARY_PAGES_BYTES): TerminalSummary[] {
  const budget = TERMINAL_SUMMARY_LIMITS.bytes - 1024;
  const pages: { lead: TerminalSummaryText[][]; sections: TerminalSummarySection[] }[] = [];
  let page = { lead, sections: [] as TerminalSummarySection[] }, used = size(lead), total = 0, pageRows = 0;
  const open = () => { pages.push(page); };
  open();
  let omitted = 0, last: TerminalSummarySection | undefined;
  for (const section of sections) {
    const rows = section.rows ?? [];
    const { notes, ...rest } = section;
    const header = (continued: boolean): TerminalSummarySection => continued
      ? { title: `${section.title}（续）`, rows: [] }
      : { ...rest, rows: [] };
    let chunk = header(false);
    const startChunk = (continued: boolean) => {
      chunk = header(continued);
      const cost = size(chunk);
      if (used + cost > budget || page.sections.length >= TERMINAL_SUMMARY_LIMITS.sections || pageRows >= TERMINAL_SUMMARY_LIMITS.rows) {
        page = { lead: [], sections: [] }; used = size(page.lead); pageRows = 0; open();
      }
      page.sections.push(chunk); used += cost; total += cost; last = chunk;
    };
    if (total + size(chunk) > totalBytes) { omitted += rows.length; continue; }
    startChunk(false);
    for (const row of rows) {
      const cost = size(row);
      if (total + cost > totalBytes) { omitted++; continue; }
      if (used + cost > budget || pageRows >= TERMINAL_SUMMARY_LIMITS.rows) startChunk(true);
      (chunk.rows as TerminalSummaryRow[]).push(row); used += cost; total += cost; pageRows++;
    }
    // 区块说明是“区块末尾的弱化说明”：放在该区块的最后一段，跨页时不提前出现在第一页
    if (notes?.length) {
      const cost = size(notes);
      if (used + cost > budget) startChunk(true);
      (chunk as { notes?: readonly string[] }).notes = notes; used += cost; total += cost;
    }
  }
  if (omitted && last) (last as { notes?: string[] }).notes = [...(last.notes ?? []), omittedNote(omitted)];
  return pages;
}

/** 旧文本出口：与终端信息页同一份投影，逐行输出 */
export function summaryLines(summary: TerminalSummary): string[] {
  const lines = summary.lead.map((parts) => parts.map((part) => part.text).join(""));
  for (const section of summary.sections) {
    lines.push("", `▎ ${section.title}${section.aside ? `（${section.aside}）` : ""}`);
    if (section.items?.length) lines.push(`  ${section.items.join(" · ")}`);
    for (const row of section.rows ?? []) {
      lines.push(`  ${row.label}  ${row.value}`);
      if (row.note) lines.push(`    ${row.note}`);
    }
    if (!section.items?.length && !section.rows?.length && section.empty) lines.push(`  ${section.empty}`);
    for (const note of section.notes ?? []) lines.push(`  ${note}`);
  }
  return lines;
}
