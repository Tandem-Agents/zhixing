/**
 * /trust 面板渲染 —— state → 终端行数组的纯函数。
 *
 * 渲染契约：
 * - 所有行以 `layout.contentPrefix` 起首，对齐 zhixing 既有"内容左边距"统一规约。
 * - state 未携带的运行时上下文（agent displayName / 当前时间）由 caller 显式注入
 *   `RenderContext`，渲染函数本身无副作用。
 * - selectedIndex 标 `> `；deletePendingRuleId 命中行整行红底白字。
 * - 详情区与列表共享同一选中规则；rules 为空时显示引导文案。
 */

import chalk from "chalk";
import type { PermissionContextId, PermissionRule, TrustContribution } from "@zhixing/core";
import { tone, layout } from "../../tui/style.js";
import { padEndDisplay } from "../../tui/line-width.js";
import { stripAnsi } from "../../tui/ansi.js";

// ─── 列宽 token ───
// 单一来源；调宽某列只改这里。display-width（CJK 全角算 2 列）口径。
const COL = {
  cursor: 2,        // "> " 或 "  "
  id: 10,
  scope: 14,
  contributors: 18,
  tool: 10,
  pattern: 24,
  matched: 16,
} as const;

export interface RenderContext {
  /** 当前 agent 显示名（来自 getAgentIdentity()），用于空态 Tip 文案 */
  readonly agentDisplayName: string;
  /** 当前时间戳（ms），用于相对时间渲染。测试时可注入固定值 */
  readonly now: number;
}

export interface RenderState {
  readonly rules: ReadonlyArray<PermissionRule>;
  readonly selectedIndex: number;
  readonly deletePendingRuleId: string | null;
}

export function renderState(state: RenderState, ctx: RenderContext): string[] {
  if (state.rules.length === 0) {
    return renderEmpty(ctx);
  }
  return [
    ...renderTitle(),
    "",
    ...renderList(state, ctx),
    "",
    renderSeparator(),
    ...renderDetail(state, ctx),
    "",
    renderFooter(),
  ];
}

// ─── 标题 / 分隔线 / footer ───

function renderTitle(): string[] {
  return [`${layout.contentPrefix}${tone.bold("已沉淀信任规则")}`];
}

function renderSeparator(): string {
  return `${layout.contentPrefix}${tone.dim("─".repeat(72))}`;
}

function renderFooter(): string {
  return `${layout.contentPrefix}${tone.dim("(↑↓ 选 · d 撤销·再按一次确认 · ESC 退出)")}`;
}

// ─── 列表 ───

function renderList(state: RenderState, ctx: RenderContext): string[] {
  const lines: string[] = [renderColumnHeader()];
  state.rules.forEach((rule, idx) => {
    const isSelected = idx === state.selectedIndex;
    const isPending =
      state.deletePendingRuleId !== null &&
      rule.id === state.deletePendingRuleId;
    lines.push(renderRuleRow(rule, ctx, { isSelected, isPending }));
  });
  return lines;
}

function renderColumnHeader(): string {
  const header =
    padEndDisplay("", COL.cursor) +
    padEndDisplay("id", COL.id) +
    padEndDisplay("生效范围", COL.scope) +
    padEndDisplay("contributors", COL.contributors) +
    padEndDisplay("工具", COL.tool) +
    padEndDisplay("pattern", COL.pattern) +
    "匹配";
  return `${layout.contentPrefix}${tone.dim(header)}`;
}

function renderRuleRow(
  rule: PermissionRule,
  ctx: RenderContext,
  flags: { isSelected: boolean; isPending: boolean },
): string {
  const row = buildRowContent(rule, ctx, flags.isSelected);
  const decorated = flags.isPending ? decorateAsPending(row) : row;
  return `${layout.contentPrefix}${decorated}`;
}

/**
 * 单源真相 —— 一行规则的所有列结构与色彩在这里一次构造。
 * pending 装饰路径通过 stripAnsi 复用同一份列布局，杜绝"双轨拼接"导致的列错位。
 */
function buildRowContent(
  rule: PermissionRule,
  ctx: RenderContext,
  isSelected: boolean,
): string {
  const cursor = padEndDisplay(isSelected ? tone.brand.bold(">") : "", COL.cursor);
  const id = padEndDisplay(tone.dim(rule.id.slice(0, 8)), COL.id);
  const scope = padEndDisplay(formatScope(rule), COL.scope);
  const contributors = padEndDisplay(
    formatContributorsList(rule.contributors),
    COL.contributors,
  );
  const tool = padEndDisplay(tone.brand(rule.pattern.tool), COL.tool);
  const pattern = padEndDisplay(rule.pattern.argument, COL.pattern);
  const matched = formatMatched(rule, ctx.now);
  return `${cursor}${id}${scope}${contributors}${tool}${pattern}${matched}`;
}

/**
 * pending 装饰器 —— stripAnsi 去除列内原色（红底白字会覆盖原色，留着无意义），
 * padEndDisplay 写入的空白字符在 stripAnsi 后保留，列对齐与非 pending 路径
 * 字符级一致。chalk.bgRed.white.bold 整行套红底白字粗体。
 */
function decorateAsPending(row: string): string {
  return chalk.bgRed.white.bold(stripAnsi(row));
}

// ─── 详情区 ───

function renderDetail(state: RenderState, ctx: RenderContext): string[] {
  const rule = state.rules[state.selectedIndex];
  if (!rule) return [];
  const lines: string[] = [
    `${layout.contentPrefix}${tone.bold("详情")} ${tone.dim(rule.id.slice(0, 8))}`,
    "",
    detailLine("操作", `${tone.brand(rule.pattern.tool)} ${rule.pattern.argument}`),
    detailLine("生效范围", formatScope(rule)),
  ];
  if (rule.contextPath) {
    lines.push(detailLine("工作目录", tone.dim(rule.contextPath)));
  }
  lines.push(detailLine("匹配", formatDetailMatched(rule, ctx.now)));
  if (rule.contributors && rule.contributors.length > 0) {
    lines.push("");
    lines.push(`${layout.contentPrefix}  ${tone.dim("累计放行记录（按时间顺序）：")}`);
    rule.contributors.forEach((c, i) => {
      const role = c.origin === "user" ? "你" : "安全助理";
      lines.push(
        `${layout.contentPrefix}    ${tone.dim(`${i + 1}.`)} [${role}]  ${tone.dim(formatAbsoluteTime(c.timestamp))}`,
      );
    });
  }
  return lines;
}

function detailLine(label: string, value: string): string {
  return `${layout.contentPrefix}  ${tone.dim(`${label}：`)} ${value}`;
}

// ─── 空态 ───

function renderEmpty(ctx: RenderContext): string[] {
  return [
    ...renderTitle(),
    "",
    `${layout.contentPrefix}  ${tone.dim("当前上下文与全局都没有建立信任规则")}`,
    `${layout.contentPrefix}  ${tone.dim(`Tip: ${ctx.agentDisplayName} 触发 confirm 时选 [a]/[g] 显式创建，或同模式累计达阈值自动建立`)}`,
    "",
    `${layout.contentPrefix}${tone.dim("(ESC 退出)")}`,
  ];
}

// ─── 字段格式化 ───

function formatScope(rule: PermissionRule): string {
  if (rule.scope === "global") return chalk.magenta("全局");
  if (rule.scope === "session") return tone.dim("本次会话");
  if (rule.scope === "context") {
    return tone.brand(formatContextKindLabel(rule.contextId));
  }
  return tone.dim("builtin");
}

function formatContextKindLabel(
  contextId: PermissionContextId | undefined,
): string {
  if (!contextId) return "(unknown context)";
  switch (contextId.kind) {
    case "main":
      return "主模式";
    case "workspace":
    case "scene":
      return "当前工作场景";
  }
}

function formatContributorsList(
  contributors: ReadonlyArray<TrustContribution> | undefined,
): string {
  if (!contributors || contributors.length === 0) return tone.dim("[—]");
  const tokens = contributors.map((c) => (c.origin === "user" ? "你" : "助理"));
  return `[${tokens.join(" ")}]`;
}

function formatMatched(rule: PermissionRule, now: number): string {
  if (rule.matchCount <= 0) return tone.dim("未匹配");
  return tone.dim(`${rule.matchCount} 次 (${formatRelativeMs(rule.lastMatchedAt, now)})`);
}

function formatDetailMatched(rule: PermissionRule, now: number): string {
  if (rule.matchCount <= 0) return "未匹配";
  return `${rule.matchCount} 次（最近 ${formatRelativeMs(rule.lastMatchedAt, now)}）`;
}

function formatRelativeMs(timestamp: number, now: number): string {
  if (timestamp <= 0) return "—";
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h 前`;
  const days = Math.floor(hours / 24);
  if (days < 2) return "昨天";
  return `${days}d 前`;
}

function formatAbsoluteTime(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

