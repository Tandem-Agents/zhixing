/**
 * /trust 命令的 typeahead args provider —— 命令的"渐进增强"前端（浏览 + Ctrl+D 撤销）。
 *
 * 用户从命令面板 accept /trust 后，typeahead 自动进入 args 输入态、立即调 provider.list("")
 * 把规则映射成候选 dropdown。数据取自 core 的 listUserTrustRules（"哪些规则归用户管"的单一
 * 定义），候选行 description 用共享的 formatRuleDescription 渲染；inlineActions 声明 delete
 * 启用 Ctrl+D 双击撤销（与 /work /resume 一致）。命令本身的 list/revoke 由 handleTrustCommand
 * 在所有模式可达，此 provider 仅是 typeahead 下的增强。
 */

import {
  listUserTrustRules,
  type ArgChoice,
  type ArgChoiceProvider,
  type ArgQueryContext,
  type SecurityPipeline,
} from "@zhixing/core";
import { formatRuleDescription } from "./trust-rule-format.js";

/**
 * `getPipeline` 是 getter 而非快照 —— securityPipeline 随 session reload / 模式切换被
 * swap，provider 在 startup 构造一次、却要在每次 list() 调用时反映当前 pipeline，故按调用
 * 时读取（值捕获会停留在构造期的旧实例，工作区路径变化后列出过时规则）。
 */
export function createTrustRuleArgProvider(
  getPipeline: () => SecurityPipeline,
): ArgChoiceProvider {
  return {
    // 管理面板：列出已沉淀规则做就地撤销，无"选中给业务"语义；Enter 在面板内
    // no-op、footer 不显 Enter，状态机由 inline 操作主导（Ctrl+D 双击撤销 / Esc 退出）。
    mode: "management",
    async list(
      ctx: ArgQueryContext,
      signal: AbortSignal,
    ): Promise<readonly ArgChoice[]> {
      const pipeline = getPipeline();
      const rules = listUserTrustRules(pipeline);
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
