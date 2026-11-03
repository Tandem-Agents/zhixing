import type { Command } from 'commander';

/**
 * commander 的参数错误（缺必填选项、未知选项、缺参数、取值缺失或无效、参数过多、未知命令）按有限已知格式
 * 译成中文；其他格式给通用中文说明，不把英文原文给用户。
 */
export function localizeCommanderError(text: string): string {
  const line = text.trim().split('\n')[0]!.replace(/^error:\s*/u, '');
  const suggestion = /\(Did you mean (\S+?)\?\)/u.exec(text)?.[1];
  const hint = suggestion ? `是否想用 ${suggestion}？` : '';
  const help = '可加 --help 查看用法。';
  let match: RegExpExecArray | null;
  if ((match = /^required option '(.+)' not specified/u.exec(line))) return `缺少必填参数 ${match[1]}。${help}\n`;
  if ((match = /^unknown option '(.+?)'/u.exec(line))) return `不认识的参数 ${match[1]}。${hint}${help}\n`;
  if ((match = /^missing required argument '(.+?)'/u.exec(line))) return `缺少参数 ${match[1]}。${help}\n`;
  if ((match = /^option '(.+)' argument missing/u.exec(line))) return `参数 ${match[1]} 缺少取值。${help}\n`;
  if ((match = /^option '(.+)' argument '(.+)' is invalid/u.exec(line))) return `参数 ${match[1]} 的取值 ${match[2]} 无效。${help}\n`;
  if ((match = /^too many arguments(?: for '(.+?)')?/u.exec(line))) return `参数过多${match[1] ? `（${match[1]}）` : ''}。${help}\n`;
  if ((match = /^unknown command '(.+?)'/u.exec(line))) return `没有命令 ${match[1]}。${hint}可用 zz --help 查看全部命令。\n`;
  return `命令参数有误。${help}\n`;
}

/** 给命令树的每一层挂上中文错误输出；子命令各自持有输出配置，需逐层设置 */
export function localizeCommanderErrors(command: Command): void {
  command.configureOutput({ outputError: (text, write) => write(localizeCommanderError(text)) });
  for (const child of command.commands) localizeCommanderErrors(child);
}
