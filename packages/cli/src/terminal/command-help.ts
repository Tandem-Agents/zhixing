import type { CommandDef } from '@zhixing-ai/core/typeahead';
import type { TerminalSummary } from '@zhixing-ai/terminal-ui/protocol';
import { paginateSummary, summaryText } from '../summary-projection.js';

/** 命令注册表 category 的中文标题；顺序沿用 CommandCategory 的声明顺序。不在表里的类别进“其他” */
const CATEGORY_TITLES: readonly (readonly [string, string])[] = [
  ['session', '对话'], ['config', '配置与安全'], ['info', '状态与信息'], ['tools', '工具与任务'], ['debug', '调试'], ['plugin', '扩展'],
];

/** 命令帮助：按命令自身声明的类别分区，每区“/名称 → 说明”两列；名称、说明与顺序都来自注册表 */
export function commandHelpSummary(commands: readonly Pick<CommandDef, 'name' | 'description' | 'category'>[]): TerminalSummary[] {
  const groups = new Map<string, { title: string; rows: { label: string; value: string }[] }>();
  for (const [category, title] of CATEGORY_TITLES) groups.set(category, { title, rows: [] });
  const other = { title: '其他', rows: [] as { label: string; value: string }[] };
  for (const command of commands) {
    const row = { label: summaryText(`/${command.name}`), value: summaryText(command.description) };
    (groups.get(command.category) ?? other).rows.push(row);
  }
  const sections = [...groups.values(), other].filter(group => group.rows.length > 0);
  // 命令随技能与扩展增长：按页拆分，整体容量内全部可达
  return paginateSummary([], sections);
}
