/**
 * 信任规则的展示格式化 —— /trust 各 cli 前端共用（typeahead 面板候选行 + 命令行文本列表）。
 *
 * 单行紧凑展示「生效范围 · contributors token · 匹配次数」。纯展示，不含数据选择逻辑——
 * "哪些规则归用户管"由 Trust Administration 应用单一定义。
 */

import type {
  TrustAdministrationContext,
  TrustAdministrationContribution,
  TrustAdministrationRule,
} from "@zhixing/core/trust-administration";

/** 「生效范围 · contributors · 匹配次数」三段紧凑信息。 */
export function formatRuleDescription(rule: TrustAdministrationRule): string {
  const scope = formatScope(rule);
  const contributors = formatContributorsList(rule.contributors);
  return `${scope} · ${contributors} · ${formatMatchCount(rule.matchCount)}`;
}

/** 其他范围的规则行：范围段由分组名取代（分组名已说明是哪个范围、是否生效）。 */
export function formatGroupedRuleDescription(groupLabel: string, rule: TrustAdministrationRule): string {
  return `${groupLabel} · ${formatContributorsList(rule.contributors)} · ${formatMatchCount(rule.matchCount)}`;
}

/**
 * 匹配次数是从开始记录起累计的实际命中，不追溯此前的历史：0 只表示没有记录到匹配，
 * 不断言从未匹配。
 */
function formatMatchCount(count: number): string {
  return count > 0 ? `已记录 ${count} 次` : "暂无匹配记录";
}

function formatScope(rule: TrustAdministrationRule): string {
  if (rule.scope === "global") return "全局";
  return formatContextKindLabel(rule.contextId);
}

function formatContextKindLabel(
  contextId: TrustAdministrationContext | undefined,
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
  contributors: readonly TrustAdministrationContribution[] | undefined,
): string {
  if (!contributors || contributors.length === 0) return "[—]";
  const tokens = contributors.map((c) => (c.origin === "user" ? "你" : "助理"));
  return `[${tokens.join(" ")}]`;
}
