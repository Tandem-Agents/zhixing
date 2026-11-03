import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { localizeCommanderError, localizeCommanderErrors } from './commander-errors.js';

describe('commander argument errors in Chinese', () => {
  it('translates the known formats and never passes English through', () => {
    expect(localizeCommanderError("error: required option '--approval <code>' not specified\n")).toBe('缺少必填参数 --approval <code>。可加 --help 查看用法。\n');
    expect(localizeCommanderError("error: unknown option '--limt'\n(Did you mean --limit?)\n")).toBe('不认识的参数 --limt。是否想用 --limit？可加 --help 查看用法。\n');
    expect(localizeCommanderError("error: missing required argument 'device-name'\n")).toBe('缺少参数 device-name。可加 --help 查看用法。\n');
    expect(localizeCommanderError("error: something unexpected\n")).toBe('命令参数有误。可加 --help 查看用法。\n');
  });

  it('applies to nested commands that commander reports from', async () => {
    const program = new Command().exitOverride();
    const errors: string[] = [];
    program.configureOutput({ writeErr: text => errors.push(text) });
    const backup = program.command('backup');
    const root = backup.command('root');
    root.command('reset').requiredOption('--approval <code>', '确认码').action(() => {});
    for (const command of [program, backup, root, ...root.commands]) command.exitOverride().configureOutput({ writeErr: text => errors.push(text) });
    localizeCommanderErrors(program);
    await expect(program.parseAsync(['node', 'zz', 'backup', 'root', 'reset'])).rejects.toThrow();
    expect(errors).toEqual(['缺少必填参数 --approval <code>。可加 --help 查看用法。\n']);
  });
});
