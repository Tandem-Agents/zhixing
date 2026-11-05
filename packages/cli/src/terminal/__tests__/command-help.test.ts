import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS } from '../../commands/builtin-definitions.js';
import { commandHelpSummary } from '../command-help.js';

const helpOne = (...args: Parameters<typeof commandHelpSummary>) => { const pages = commandHelpSummary(...args); expect(pages).toHaveLength(1); return pages[0]!; };

describe('command help summary', () => {
  it('groups commands by their registered category in declaration order, keeping registry order and descriptions', () => {
    const summary = helpOne([
      { name: 'status', description: '运行状态', category: 'info' },
      { name: 'new', description: '新建对话', category: 'session' },
      { name: 'config', description: '配置', category: 'config' },
      { name: 'work', description: '工作场景 ↑↓ 选择 · Enter 进入', category: 'tools' },
      { name: 'help', description: '命令帮助', category: 'info' },
      { name: 'debug', description: '调试', category: 'debug' },
      { name: 'ext', description: '扩展命令', category: 'plugin' },
    ]);
    expect(summary.lead).toEqual([]);
    expect(summary.sections.map(section => section.title)).toEqual(['对话', '配置与安全', '状态与信息', '工具与任务', '调试', '扩展']);
    expect(summary.sections[2]!.rows).toEqual([{ label: '/status', value: '运行状态' }, { label: '/help', value: '命令帮助' }]);
    expect(summary.sections[3]!.rows).toEqual([{ label: '/work', value: '工作场景 ↑↓ 选择 · Enter 进入' }]);
  });
  it('keeps commands of an unknown or hidden category under “其他” instead of dropping them', () => {
    const summary = helpOne([
      { name: 'odd', description: '未知类别', category: 'future' as never },
      { name: 'secret', description: '隐藏类别', category: 'hidden' },
      { name: 'new', description: '新建对话', category: 'session' },
    ]);
    expect(summary.sections.map(section => section.title)).toEqual(['对话', '其他']);
    expect(summary.sections[1]!.rows).toEqual([{ label: '/odd', value: '未知类别' }, { label: '/secret', value: '隐藏类别' }]);
  });
  it('covers every built-in command exactly once', () => {
    const commands = Object.values(BUILTIN_COMMANDS);
    const rows = helpOne(commands).sections.flatMap(section => section.rows ?? []);
    expect(rows.map(row => row.label).sort()).toEqual(commands.map(command => `/${command.name}`).sort());
    expect(helpOne(commands).sections.some(section => section.title === '其他')).toBe(false);
  });
  it('cleans control characters out of descriptions', () => {
    const row = helpOne([{ name: 'x', description: 'a\nb\x1b[31mc', category: 'info' }]).sections[0]!.rows![0]!;
    expect(row.value).toBe('a bc');
  });
  it('pages a long command list (skills and extensions grow it) so every command stays reachable', () => {
    const commands = Array.from({ length: 1200 }, (_, index) => ({ name: `skill-${index}`, description: `技能 ${index} 的说明`, category: 'tools' as const }));
    const pages = commandHelpSummary(commands);
    expect(pages.length).toBeGreaterThan(1);
    const rows = pages.flatMap(page => page.sections).flatMap(section => section.rows ?? []);
    expect(rows).toHaveLength(1200); expect(rows.at(-1)!.label).toBe('/skill-1199');
    expect(pages.flatMap(page => page.sections).map(section => section.title).slice(0, 2)).toEqual(['工具与任务', '工具与任务（续）']);
  });
});
