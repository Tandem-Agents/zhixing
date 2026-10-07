import path from 'node:path';
import { getZhixingHome } from '@zhixing/core/paths';
import { beginEntryLogging } from '../logging/bootstrap.js';
import { beginRuntimeLogging, recordRuntimeFailure } from '../logging/runtime.js';
import { runTerminalSupervisor } from './supervisor.js';
import { TERMINAL_LOG_EXIT_RESERVE_MS } from './close-budget.js';

/** No stdin or screen access: the original R owns restoration through return. */
export async function launchTerminal(args: readonly string[]): Promise<number> {
  const home = getZhixingHome();
  const entry = path.resolve(process.argv[1]!);
  const mode = args.length ? 'independent-command' : 'repl';
  const early = beginEntryLogging(mode);
  let logging: ReturnType<typeof beginRuntimeLogging> | undefined;
  let result = 1;
  const output: { stream: 'stdout' | 'stderr'; text: string }[] = [];
  let outputBytes = 0;
  try {
    result = await runTerminalSupervisor({ home, entry, args, distribution: path.join(path.dirname(entry), 'terminal'), records: early.records,
      commandOutput: (stream, text) => {
        outputBytes += Buffer.byteLength(text);
        if (outputBytes > 1024 * 1024) throw Error('terminal-command-output-capacity');
        output.push({ stream, text });
      },
      admitted: async (createStore, capacity) => { logging = beginRuntimeLogging(home, mode, undefined, createStore, capacity, { requireCompleteClose: true }); },
      drain: async (deadline, code) => { await logging?.finish(code === 0 ? 'success' : 'failure', 'terminal-closing', Math.max(0, deadline - Date.now() - TERMINAL_LOG_EXIT_RESERVE_MS)); },
    });
  } catch (error) {
    if (logging) recordRuntimeFailure(logging.records, error, 'terminal-startup-failed');
    process.stderr.write('知行交互终端未能启动或安全完成；请用 zz logs 查看记录。\n');
  }
  // R has restored the original terminal before ordinary command results are written.
  for (const item of output) await new Promise<void>((resolve, reject) => process[item.stream].write(item.text, error => error ? reject(error) : resolve()));
  return result;
}
