import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { windowsProcessPlan } from '../windows-process-plan.js';

describe.runIf(process.platform === 'win32')('Windows owned process plans', () => {
  it('按子环境查找裸命令，准确传递脚本参数且不解释元字符', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'zhixing-process-plan-'));
    try {
      const bin = path.join(directory, 'space bin'); await mkdir(bin);
      const echo = path.join(directory, 'echo.mjs');
      await writeFile(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
      await writeFile(path.join(bin, 'echo-args.cmd'), `@"${process.execPath}" "${echo}" %*\r\n`);
      const env = { ...process.env, Path: bin + ';' + path.dirname(process.execPath), PATHEXT: '.EXE;.CMD' };
      delete (env as NodeJS.ProcessEnv).PATH;
      const direct = await windowsProcessPlan('node', ['-v'], env, directory);
      expect(direct.executable.toLowerCase()).toBe(process.execPath.toLowerCase());
      expect(direct.verbatim).toBe(false);
      const args = ['hello space', '中文', 'a&b', 'a|b', '$(nothing)', '"quoted"', 'trailing\\', '', '%PATH%', 'bang!'];
      const plan = await windowsProcessPlan('echo-args', args, env, directory);
      const result = await promisify(execFile)(plan.executable, [...plan.args], {
        cwd: directory, env, windowsHide: true, windowsVerbatimArguments: plan.verbatim,
      });
      expect(JSON.parse(result.stdout)).toEqual(args);
      await expect(windowsProcessPlan('echo-args', ['line\r\nnext'], env, directory)).rejects.toThrow('terminal-helper-script-line-break');
      await expect(windowsProcessPlan('unavailable-command-123', [], env, directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
