import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('terminal original POSIX recovery', () => {
  it.each(['restore', 'eof'])('uses only its owned PTY and preserves the %s handoff boundary', async scenario => {
    const recovery = fileURLToPath(new URL(`../../../../terminal-ui/dist/${process.platform}-${process.arch}/recovery`, import.meta.url));
    const fixture = fileURLToPath(new URL('./fixtures/recovery-posix-fixture.py', import.meta.url));
    const child = spawn('python3', [fixture, recovery, scenario], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data.toString(); if (stdout.length > 65536) child.kill('SIGKILL'); });
    child.stderr.on('data', data => { stderr += data.toString(); if (stderr.length > 65536) child.kill('SIGKILL'); });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    expect(result, stderr).toEqual({ code: 0, signal: null });
    expect(JSON.parse(stdout)).toMatchObject({ scenario, exit: scenario === 'eof' ? 74 : 0 });
  }, 30_000);
});
