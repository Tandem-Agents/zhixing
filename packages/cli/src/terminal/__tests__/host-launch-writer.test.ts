import { describe, expect, it, vi } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { TerminalPrivateEndpoint } from '../../../../terminal-ui/src/parent-transport.js';
import { TerminalForegroundProcesses, type TerminalForegroundChild } from '../foreground-process.js';
import { TerminalWindowsWriterAdmission, createTerminalOwnedProcessFactory } from '../host-launch.js';

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('writer fixture actual close unknown')), 8000); })]); }
  finally { clearTimeout(timer); }
}

describe.skipIf(process.platform !== 'win32')('production Windows filesystem gate', () => {
  it('binds the suspended target, preserves private arguments, and fences cancellation, expiry and revocation', async () => {
    const artifact = process.env.ZHIXING_FOREGROUND_NATIVE_TEST_ARTIFACT ?? fileURLToPath(new URL('../../../../terminal-ui/dist/win32-x64/foreground.node', import.meta.url));
    const processes = new TerminalForegroundProcesses(artifact);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zhixing-writer-gate-'));
    const children: Promise<void>[] = [];
    try {
      for (const mode of ['permit', 'cancel', 'expired', 'malformed', 'revoked', 'filesystem', 'powershell']) {
        const endpoint = new TerminalPrivateEndpoint(), sockets = new Set<Socket>();
        const ownerToken = randomUUID(), marker = path.join(directory, mode);
        let gate!: TerminalForegroundChild, admission!: TerminalWindowsWriterAdmission;
        let published!: () => void, bound!: () => void, requested!: () => void, identified!: () => void;
        const intent = new Promise<void>(resolve => { published = resolve; });
        const binding = new Promise<void>(resolve => { bound = resolve; });
        const requestReady = new Promise<void>(resolve => { requested = resolve; });
        const targetReady = new Promise<void>(resolve => { identified = resolve; });
        let actual!: { pid: number; birth: string }, request!: Record<string, unknown>;
        let creationTimer: ReturnType<typeof setTimeout> | undefined;
        const server = createServer(socket => {
          sockets.add(socket); socket.on('error', () => {});
          socket.once('close', () => { if (gate && !gate.exited) gate.kill(); });
          let buffer = '';
          socket.on('data', data => {
            buffer += data.toString();
            for (;;) {
              const end = buffer.indexOf('\n'); if (end < 0) return;
              const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
              if (request) { gate.kill(); continue; }
              request = value; const id = String(request.id), deadline = Number(request.deadline);
              const send = (event: string, code?: number, identity?: { pid: number; birth: string }) => socket.write(JSON.stringify({ event, code, ...identity, deadline }) + '\n');
              gate = processes.create(processes.gate, [
                String(request.endpoint), String(request.token), String(deadline), id], process.env, false, false,
              { scope: 'execution', pipeEnvironment: 'ZHIXING_TERMINAL_WRITER_PIPE', frameBytes: 1024, creationPermit: intent });
              gate.on('error', () => gate.kill());
              admission = new TerminalWindowsWriterAdmission(id, deadline, {
                live: () => !processes.sealed && !gate.cancelled && !gate.exited && !socket.destroyed,
                verify: (pid, birth) => gate.verifyTarget(pid, birth),
                bind: async identity => { actual = identity; identified(); await binding; },
                permit: identity => new Promise<void>((resolve, reject) => gate.send({ type: 'permit', id, ...identity,
                  ...(mode === 'malformed' ? { birth: '1' } : {}) }, error => error ? reject(error) : resolve())),
                ready: identity => { clearTimeout(creationTimer); send('created', undefined, identity); },
                stop: () => gate.kill(),
              });
              gate.on('message', value => admission.accept(value)); gate.once('disconnect', () => admission.close());
              let exitCode = 71;
              gate.once('exit', code => { exitCode = code; send('exit', code); });
              children.push(new Promise<void>(resolve => gate.once('close', () => {
                admission.close(); clearTimeout(creationTimer); send('closed', exitCode); socket.end(); resolve();
              })));
              creationTimer = setTimeout(() => admission.close(), Math.max(0, deadline - Date.now()));
              void gate.created.then(() => { send('gate-ready'); gate.resume(); }).catch(() => gate.kill());
              requested();
            }
          });
        });
        await endpoint.listen(server);
        vi.stubEnv('ZHIXING_TERMINAL_CREATE_PIPE', endpoint.address); vi.stubEnv('ZHIXING_TERMINAL_CREATE_TOKEN', ownerToken);
        try {
          const privateArgs = ['', 'a b', 'quote"slash\\', '汉字🙂', 'tail\\'];
          const bridge = fileURLToPath(new URL('../../../../mesh/build/prebuilt/win32-x64/checkpoint_child_bridge.exe', import.meta.url));
          const binaryInput = Buffer.from([0, 1, 2, 128, 255, 13, 10]);
          const executable = mode === 'powershell' ? path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe') : mode === 'filesystem' ? bridge : process.execPath;
          const owner = createTerminalOwnedProcessFactory('filesystem')(executable, mode === 'powershell' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
            '$ErrorActionPreference="Stop";$m=New-Object IO.MemoryStream;[Console]::OpenStandardInput().CopyTo($m);$b=$m.ToArray();[Console]::OpenStandardOutput().Write($b,0,$b.Length);[Console]::Error.Write("private-error")'] : mode === 'filesystem' ? [] : ['-e',
            'require("node:assert/strict").deepEqual(process.argv.slice(2),JSON.parse(process.env.EXPECTED_ARGS));require("node:fs").writeFileSync(process.argv[1],"executed");let text="";process.stdin.setEncoding("utf8");process.stdin.on("data",part=>text+=part);process.stdin.on("end",()=>{process.stdout.write(text);process.stderr.write("private-error");});', marker, ...privateArgs],
          { cwd: directory, env: { SystemRoot: process.env.SystemRoot, FIXTURE_PRIVATE: 'kept-at-owner', EXPECTED_ARGS: JSON.stringify(privateArgs) }, deadline: Date.now() + (mode === 'expired' ? 2500 : 5000) });
          let output = '', error = '', ready = false;
          const binaryOutput: Buffer[] = [];
          owner.child.stdout.on('data', data => { output += data.toString(); binaryOutput.push(Buffer.from(data)); }); owner.child.stderr.on('data', data => { error += data.toString(); });
          void owner.ready.then(() => { ready = true; }, () => {});
          await bounded(requestReady); await new Promise(resolve => setTimeout(resolve, 20));
          expect(gate.pid).toBeUndefined(); expect(processes.children.size).toBe(1);
          expect(JSON.stringify(request)).not.toContain('kept-at-owner'); expect(JSON.stringify(request)).not.toContain(marker);
          published(); await bounded(targetReady);
          expect(actual.pid).not.toBe(gate.pid); expect(actual.birth).toMatch(/^[1-9][0-9]*$/u);
          expect(() => gate.verifyTarget(actual.pid, '1')).toThrow('not-owned');
          expect(() => gate.verifyTarget(process.pid, actual.birth)).toThrow('not-owned');
          expect(gate.verifyTarget(actual.pid, actual.birth)).toEqual(actual);
          expect(owner.child.pid).toBeUndefined(); expect(ready).toBe(false);
          await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' }); expect(output).toBe('');
          if (mode === 'cancel') { admission.close(Error('fixture-cancel')); bound(); await expect(admission.done).rejects.toThrow(); }
          else if (mode === 'expired') {
            await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(request.deadline) - Date.now()) + 20));
            bound(); await expect(admission.done).rejects.toThrow();
          } else if (mode === 'malformed') { bound(); await expect(admission.done).rejects.toThrow(); }
          else {
            bound(); await bounded(owner.ready); expect(owner.child.pid).toBe(actual.pid);
            await bounded(admission.done);
            if (mode === 'revoked') {
              await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('executed'));
              admission.close(Error('fixture-revoked'));
            } else if (mode === 'powershell') owner.child.stdin.end(binaryInput);
            else if (mode === 'filesystem') owner.child.stdin.end([
              { id: 1, op: 'openPath', path: path.join(directory, 'files'), create: true },
              { id: 2, op: 'writeFile', parent: 1, name: '中文🙂.txt', data: Buffer.from('私有 UTF-8 🙂').toString('base64') },
              { id: 3, op: 'close', handle: 1 },
            ].map(value => JSON.stringify(value) + '\n').join(''));
            else owner.child.stdin.end('私有 "quoted" stdin');
          }
          await bounded(owner.closed); await bounded(children[children.length - 1]!);
          if (mode === 'powershell') {
            expect(Buffer.concat(binaryOutput)).toEqual(binaryInput);
            expect(error).toBe('private-error');
          } else if (mode === 'filesystem') {
            expect(error).toBe('');
            expect(output.trim().split('\n').map(line => JSON.parse(line))).toEqual([
              { id: 1, ok: true, value: 1 }, { id: 2, ok: true, value: true }, { id: 3, ok: true, value: true },
            ]);
            expect(await readFile(path.join(directory, 'files', '中文🙂.txt'), 'utf8')).toBe('私有 UTF-8 🙂');
          } else if (!['permit', 'revoked'].includes(mode)) await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
          else if (mode === 'revoked') expect(await readFile(marker, 'utf8')).toBe('executed');
          else { expect(await readFile(marker, 'utf8')).toBe('executed'); expect(output).toBe('私有 "quoted" stdin'); expect(error).toBe('private-error'); }
          expect(processes.children.size).toBe(0);
        } finally {
          published(); bound(); if (gate && !gate.exited) gate.kill();
          await bounded(Promise.all(children)); clearTimeout(creationTimer);
          for (const socket of sockets) socket.destroy(); await endpoint.close(); vi.unstubAllEnvs();
        }
      }
    } finally {
      processes.terminateExecution(); await bounded(Promise.all(children)); processes.finish();
      const root = path.resolve(os.tmpdir()) + path.sep;
      if (!path.resolve(directory).startsWith(root)) throw Error('writer fixture cleanup outside temp root');
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});
