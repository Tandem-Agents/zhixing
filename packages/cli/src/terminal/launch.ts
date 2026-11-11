import path from 'node:path';
import { programBundleEntry, resolveCliEntry } from '../cli-entry.js';
import { getZhixingHome } from '@zhixing-ai/core/paths';
import { beginEntryLogging } from '../logging/bootstrap.js';
import { beginRuntimeLogging, recordRuntimeFailure } from '../logging/runtime.js';
import { runTerminalSupervisor } from './supervisor.js';
import { TERMINAL_LOG_EXIT_RESERVE_MS } from './close-budget.js';
import { clearStartupHint } from './startup-hint.js';

/** 已知关闭原因给用户的说明；未列出的原因仍指向运行日志 */
const MODE_INCOMPATIBLE = '这个终端窗口的显示模式与知行不兼容（常见于其他程序或上次异常结束留下的状态），知行无法在这里启动；请新开一个终端窗口后再运行 zz。';
const TERMINAL_CLOSE_NOTICES: Readonly<Record<string, string>> = {
  'terminal-mode-query-timeout': '当前终端窗口没有及时回应终端模式查询，知行未能启动；请重试，仍不行时新开一个终端窗口。',
  'terminal-original-modes-unavailable': MODE_INCOMPATIBLE,
  'terminal-original-modes-contradictory': MODE_INCOMPATIBLE,
  'terminal-mode-query-contradictory': MODE_INCOMPATIBLE,
  'terminal-tty-required': '知行终端需要在交互式终端窗口中运行。',
};

export function terminalExitNotice(result: number, reason: string | undefined): string | undefined {
  // 独立命令自己失败结束时已写出结果与下一步（拒绝、取消或失败说明），不是意外结束
  if (result === 0 || result === 130 || reason === 'command-failed') return undefined;
  const notice = reason === undefined ? undefined : TERMINAL_CLOSE_NOTICES[reason];
  return notice ? `${notice}（退出码 ${result}）\n` : `知行终端意外结束（退出码 ${result}）；请用 zz logs 查看此次记录。\n`;
}

/** No stdin or screen access: the original R owns restoration through return. */
export async function launchTerminal(args: readonly string[], entryTiming?: {
  entryMs: number; prepareMs: number; loadMs: number; processCpuUserMs: number; processCpuSystemMs: number;
}): Promise<number> {
  const home = getZhixingHome();
  const entry = resolveCliEntry();
  const mode = args.length ? 'independent-command' : 'repl';
  const early = beginEntryLogging(mode);
  try { if (entryTiming) early.records.record({ event: 'terminalEntry', data: entryTiming }); }
  catch { /* A timing observation cannot reject the interactive entry. */ }
  let logging: ReturnType<typeof beginRuntimeLogging> | undefined;
  let result = 1;
  let closeReason: string | undefined;
  const output: { stream: 'stdout' | 'stderr'; text: string }[] = [];
  let outputBytes = 0;
  try {
    result = await runTerminalSupervisor({ home, entry, programEntry: programBundleEntry(entry), args, distribution: path.join(path.dirname(entry), 'terminal'), records: early.records,
      commandOutput: (stream, text) => {
        outputBytes += Buffer.byteLength(text);
        if (outputBytes > 1024 * 1024) throw Error('terminal-command-output-capacity');
        output.push({ stream, text });
      },
      admitted: async (createStore, capacity) => { logging = beginRuntimeLogging(home, mode, undefined, createStore, capacity, { requireCompleteClose: true }); },
      drain: async (deadline, code) => { await logging?.finish(code === 0 ? 'success' : 'failure', 'terminal-closing', Math.max(0, deadline - Date.now() - TERMINAL_LOG_EXIT_RESERVE_MS)); },
      closed: reason => { closeReason ??= reason; },
    });
  } catch (error) {
    if (logging) recordRuntimeFailure(logging.records, error, 'terminal-startup-failed');
  }
  // R has restored the original terminal before ordinary command results are written.
  // 没进入界面就结束（启动失败、取消）时，启动提示仍在原屏：先清掉，再写结果
  clearStartupHint();
  const notice = terminalExitNotice(result, closeReason);
  if (notice) process.stderr.write(notice);
  for (const item of output) await new Promise<void>((resolve, reject) => process[item.stream].write(item.text, error => error ? reject(error) : resolve()));
  return result;
}
