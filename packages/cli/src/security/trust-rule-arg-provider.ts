/**
 * /trust 命令的 typeahead args provider —— 与 /work workSceneArgProvider 同构。
 *
 * 用户从命令面板 accept /trust 后，typeahead 自动进入 args 输入态、立即调
 * provider.list("") 把所有用户/管家沉淀规则映射成候选 dropdown。
 *
 * 候选行 description 单行紧凑展示「生效范围 · contributors token · 匹配次数」；
 * inlineActions 声明 delete 启用 Ctrl+D 双击撤销协议（与 /work /resume 一致）；
 * emptyHint 空态文案引导用户触发 confirm 创建规则。
 *
 * builtin 系统防护规则不归用户管，归 /security 查看，此处过滤。
 */

import type {
  ArgChoice,
  ArgChoiceProvider,
  ArgQueryContext,
  PermissionContextId,
  PermissionRule,
  SecurityPipeline,
  TrustContribution,
} from "@zhixing/core";

export function createTrustRuleArgProvider(
  pipeline: SecurityPipeline,
): ArgChoiceProvider {
  return {
    // 管理面板：列出已沉淀规则做就地撤销，无"选中给业务"语义；Enter 在面板内
    // no-op、footer 不显 Enter，状态机由 inline 操作主导（Ctrl+D 双击撤销 / Esc 退出）。
    mode: "management",
    async list(
      ctx: ArgQueryContext,
      signal: AbortSignal,
    ): Promise<readonly ArgChoice[]> {
      const store = pipeline.getPermissionStore();
      const contextId = pipeline.getContextId();
      const rules = store
        .list(contextId)
        .filter((r) => r.scope !== "builtin");
      if (signal.aborted) return [];

      const query = ctx.query.toLowerCase();
      const choices: ArgChoice[] = [];
      for (const rule of rules) {
        if (query) {
          const haystack =
            `${rule.pattern.tool} ${rule.pattern.argument} ${rule.id}`.toLowerCase();
          if (!haystack.includes(query)) continue;
        }
        choices.push({
          value: rule.id,
          label: `${rule.pattern.tool} ${rule.pattern.argument}`,
          description: formatRuleDescription(rule),
        });
      }
      return choices;
    },
    inlineActions: { delete: true },
    emptyHint:
      "暂无信任规则，触发 confirm 时选 [a]/[g] 显式创建，或同模式累计达阈值自动建立",
  };
}

// ─── description 紧凑信息：生效范围 · contributors · 匹配次数 ───

function formatRuleDescription(rule: PermissionRule): string {
  const scope = formatScope(rule);
  const contributors = formatContributorsList(rule.contributors);
  const matched =
    rule.matchCount > 0 ? `${rule.matchCount} 次` : "未匹配";
  return `${scope} · ${contributors} · ${matched}`;
}

function formatScope(rule: PermissionRule): string {
  if (rule.scope === "global") return "全局";
  if (rule.scope === "session") return "本次会话";
  if (rule.scope === "context") {
    return formatContextKindLabel(rule.contextId);
  }
  return "builtin";
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
  if (!contributors || contributors.length === 0) return "[—]";
  const tokens = contributors.map((c) =>
    c.origin === "user" ? "你" : "助理",
  );
  return `[${tokens.join(" ")}]`;
}
