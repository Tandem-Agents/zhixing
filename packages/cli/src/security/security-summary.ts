/**
 * /security 的语义投影：把宿主的安全快照整理成“范围、内置规则分档、信任规则、允许累计、调用频率”，
 * 只给文字与语气，不带颜色或排版。终端信息页、规则说明页与旧文本出口共用这一份投影，各端陈述同样的事实。
 *
 * 只陈述快照能证明的事：快照给出已启用的规则与范围，不给“整体是否安全”的结论；
 * 允许累计没有时间窗口，来源也不只是用户本人；调用频率才按当前窗口统计。
 */

import type { SessionSecurityResult } from "@zhixing/rpc";
import {
  TERMINAL_SUMMARY_LIMITS,
  type TerminalSummary,
  type TerminalSummaryRow,
  type TerminalSummarySection,
  type TerminalSummaryText,
} from "@zhixing/terminal-ui/protocol";
import { fitSummary, paginateSummary, summaryText, SUMMARY_PAGES_BYTES } from "../summary-projection.js";

type Snapshot = SessionSecurityResult;
type BuiltinRule = Snapshot["builtinRules"][number];
type ContextId = Snapshot["contextId"];
type Risk = Snapshot["confirmations"][number]["highestRisk"];

/** 概览里每个列表最多显示的条数；超出写明“另有 N 项”，全部条目在规则说明页 */
export const SECURITY_OVERVIEW_ROWS = 8;

/** 与终端旧文本收集同一条清洗规则（见 summary-projection.ts） */
export const securityText = summaryText;

type Tier = "block" | "locked" | "confirm" | "audit";
/** 分档只看与信任规则的关系：block 与权限规则无关；不可覆盖的确认不能被允许规则跳过；其余确认可被放行 */
const TIERS: readonly { tier: Tier; title: string; aside: string }[] = [
  { tier: "block", title: "直接拦截", aside: "信任规则不能放行" },
  { tier: "locked", title: "每次确认", aside: "信任规则不能免除确认" },
  { tier: "confirm", title: "需要确认", aside: "可用信任规则放行" },
  { tier: "audit", title: "只记录", aside: "不拦截" },
];
function tierOf(rule: BuiltinRule): Tier {
  if (rule.action === "block") return "block";
  if (rule.action === "audit") return "audit";
  return rule.bypassImmune ? "locked" : "confirm";
}
function activeRules(snapshot: Snapshot): readonly BuiltinRule[] {
  return snapshot.builtinRules.filter((rule) => rule.enabled !== false);
}
function grouped(snapshot: Snapshot): { tier: (typeof TIERS)[number]; rules: BuiltinRule[] }[] {
  const rules = activeRules(snapshot);
  return TIERS.map((tier) => ({ tier, rules: rules.filter((rule) => tierOf(rule) === tier.tier) }))
    .filter((group) => group.rules.length > 0);
}

const RISK: Readonly<Record<Risk, string>> = { low: "低", medium: "中", high: "高", critical: "极高" };
const riskLabel = (risk: string) => RISK[risk as Risk] ?? securityText(risk);

/** 范围按实际类型称呼：主模式、工作区、工作场景；需要区分两份范围时附快照里已有的标识（不另查名称） */
function scopeKind(contextId: ContextId | undefined): string {
  if (!contextId) return "未知范围";
  return contextId.kind === "main" ? "主模式" : contextId.kind === "workspace" ? "工作区" : "工作场景";
}
function scopeName(contextId: ContextId | undefined, withId: boolean): string {
  const id = !withId || !contextId ? undefined
    : contextId.kind === "workspace" ? securityText(contextId.hash).slice(0, 8) : contextId.kind === "scene" ? securityText(contextId.sceneId) : undefined;
  return id ? `${scopeKind(contextId)}（标识 ${id}）` : scopeKind(contextId);
}
function sameScope(a: ContextId | undefined, b: ContextId | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "workspace" && b.kind === "workspace") return a.hash === b.hash;
  if (a.kind === "scene" && b.kind === "scene") return a.sceneId === b.sceneId;
  return true;
}

function builtinLine(snapshot: Snapshot): TerminalSummaryText[] {
  const groups = grouped(snapshot), total = activeRules(snapshot).length;
  const parts = groups.map((group) => `${group.tier.title} ${group.rules.length}`).join(" · ");
  return [{ text: total ? `内置规则 ${total} 条：${parts}` : "当前没有启用的内置规则" }];
}

function lead(snapshot: Snapshot): TerminalSummaryText[][] {
  const lines: TerminalSummaryText[][] = [];
  const run = snapshot.scope?.kind === "run" ? snapshot.scope : undefined;
  const locked = run ? ` · 使用开始时锁定的 ${run.permissionRules.length} 条信任规则` : "";
  if (run && sameScope(run.contextId, snapshot.contextId)) {
    lines.push([{ text: "本次运行：" }, { text: scopeKind(run.contextId), tone: "accent" }, { text: `（与本对话的默认范围相同）${locked}` }]);
  } else if (run) {
    // 两份范围不同：都附标识，读者能分清运行用的是哪一份
    lines.push([{ text: "本次运行：" }, { text: scopeName(run.contextId, true), tone: "accent" }, { text: locked }]);
    lines.push([{ text: `本对话的默认范围：${scopeName(snapshot.contextId, true)}`, tone: "dim" }]);
  } else {
    lines.push([{ text: scopeKind(snapshot.contextId), tone: "accent" }, { text: " · 本对话的默认范围" }]);
  }
  // 快照里的路径属于对话的默认范围，不是运行范围的路径
  if (snapshot.workspacePath) lines.push([{ text: `默认范围路径：${securityText(snapshot.workspacePath)}`, tone: "dim" }]);
  lines.push(builtinLine(snapshot));
  return lines;
}

function trustSection(snapshot: Snapshot): TerminalSummarySection {
  const rules = snapshot.permissionRules;
  const count = (scope: string) => rules.filter((rule) => rule.scope === scope).length;
  const builtin = count("builtin"), denied = rules.filter((rule) => rule.decision === "deny").length;
  const run = snapshot.scope?.kind === "run";
  return {
    title: `${run ? "对话默认范围的信任规则" : "信任规则"} · 共 ${rules.length} 条`,
    items: [`本对话 ${count("session")}`, `当前范围 ${count("context")}`, `所有范围 ${count("global")}`,
      ...(builtin ? [`内置 ${builtin}`] : [])],
    notes: [...(denied ? [`其中拒绝 ${denied} 条`] : []), "浏览与撤销：在输入框输入 /trust 后加空格"],
  };
}

function confirmationKey(key: string): string {
  const at = key.indexOf("::");
  return securityText(at > 0 ? `${key.slice(0, at)} · ${key.slice(at + 2)}` : key);
}
function confirmationRows(snapshot: Snapshot): TerminalSummaryRow[] {
  return [...snapshot.confirmations]
    .sort((a, b) => b.count - a.count)
    .map((entry) => ({ label: confirmationKey(entry.key), value: `已允许 ${entry.count} 次 · 最高风险 ${riskLabel(entry.highestRisk)}` }));
}
function rateRows(snapshot: Snapshot): TerminalSummaryRow[] {
  const ratio = (entry: Snapshot["rateLimits"][number]) => (entry.limit > 0 ? entry.used / entry.limit : 0);
  return [...snapshot.rateLimits]
    .sort((a, b) => ratio(b) - ratio(a))
    .map((entry) => ratio(entry) > 0.8
      ? { label: securityText(entry.key), value: `${entry.used} / ${entry.limit} · 接近上限`, tone: "warn" as const }
      : { label: securityText(entry.key), value: `${entry.used} / ${entry.limit}` });
}

function listSection(title: string, rows: TerminalSummaryRow[], empty: string, limit: number, more: string): TerminalSummarySection {
  const shown = rows.slice(0, limit), rest = rows.length - shown.length;
  return { title, rows: shown, empty, ...(rest > 0 ? { notes: [`另有 ${rest} 项${more}`] } : {}) };
}

const SEDIMENT_NOTE =
  "同类操作的允许累计达到当次审批风险对应的次数（低、中风险 3 次，高风险 10 次）后，会尝试提交为当前范围的信任规则；最高风险不会。实际是否形成规则，以信任规则列表为准。";

/** 概览：范围与内置规则分档、信任规则、允许累计、当前窗口的调用频率 */
export function securityOverview(snapshot: Snapshot): TerminalSummary {
  return fitSummary({
    lead: lead(snapshot),
    sections: [
      ...grouped(snapshot).map(({ tier, rules }) => {
        const shown = rules.slice(0, TERMINAL_SUMMARY_LIMITS.items), rest = rules.length - shown.length;
        return { title: `${tier.title} · ${rules.length} 项`, aside: tier.aside, items: shown.map((rule) => securityText(rule.name)),
          ...(rest > 0 ? { notes: [`另有 ${rest} 项，见规则说明`] } : {}) };
      }),
      trustSection(snapshot),
      listSection("允许累计", confirmationRows(snapshot), "暂无", SECURITY_OVERVIEW_ROWS, "，见规则说明"),
      listSection("调用频率（当前窗口）", rateRows(snapshot), "当前窗口暂无调用记录", SECURITY_OVERVIEW_ROWS, "，见规则说明"),
    ],
  }, "安全状态超过当前展示容量。");
}

/** 规则说明的总容量：所有页合计不超过它（选择页整体上限 2 MiB 之内），超出部分写明未能显示的条数 */
export const SECURITY_DETAIL_BYTES = SUMMARY_PAGES_BYTES;

/**
 * 规则说明：每条内置规则的档位、严重程度、规则标识、是否不可覆盖与描述，以及允许累计与调用频率的全部条目。
 * 按页拆分：每页不超过一页的内容预算与行数上限，区块跨页时标题加“（续）”；
 * 所有页合计超过总容量时停止，并在最后一页写明未能显示的条数，不伪称完整。
 */
export function securityRulesDetail(snapshot: Snapshot): TerminalSummary[] {
  const sections: TerminalSummarySection[] = [
    ...grouped(snapshot).map(({ tier, rules }) => ({
      title: `${tier.title} · ${rules.length} 项`, aside: tier.aside,
      rows: rules.map((rule) => ({
        label: securityText(rule.name),
        value: `风险 ${riskLabel(rule.severity)} · ${securityText(rule.id)}${rule.bypassImmune ? " · 不可覆盖" : ""}`,
        ...(rule.description ? { note: securityText(rule.description) } : {}),
      })),
    })),
    { title: "允许累计", rows: confirmationRows(snapshot), empty: "暂无", notes: [SEDIMENT_NOTE] },
    { title: "调用频率（当前窗口）", rows: rateRows(snapshot), empty: "当前窗口暂无调用记录" },
  ];
  return paginateSummary([builtinLine(snapshot)], sections, SECURITY_DETAIL_BYTES);
}
