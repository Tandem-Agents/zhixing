import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const quote = (value: string): string => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('Windows native fixture completion unknown');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe.skipIf(process.platform !== 'win32')('Windows actual writer admission', () => {
  it.each([false, true])('retains actual identity and private stdio before permit; cancel=%s', async cancel => {
    const artifact = process.env.ZHIXING_FOREGROUND_NATIVE_TEST_ARTIFACT ?? fileURLToPath(new URL('../../../../terminal-ui/dist/win32-x64/foreground.node', import.meta.url));
    const native = createRequire(import.meta.url)(artifact);
    // An old dist is a test failure, never an unsupported-platform skip.
    expect(typeof native.createPrivate).toBe('function'); expect(typeof native.verifyTarget).toBe('function');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zhixing-windows-writer-'));
    const marker = path.join(directory, 'executed');
    const endpoint = `\\\\.\\pipe\\zhixing-terminal-${randomUUID()}`;
    const controlEndpoint = `\\\\.\\pipe\\zhixing-terminal-${randomUUID()}`;
    const token = randomUUID(), sockets = new Set<Socket>(), lanes = new Map<string, Socket>();
    const packets: { type: string; id: number; pid: number; birth: string; repeated?: boolean }[] = [];
    let control: Socket | undefined, output = '', error = '';
    const privateServer = createServer(socket => {
      sockets.add(socket); socket.on('error', () => {});
      let hello = '';
      const handshake = (data: Buffer) => {
        hello += data.toString(); const end = hello.indexOf('\n'); if (end < 0) return;
        const [received, kind] = hello.slice(0, end).split(' ');
        expect(received).toBe(token); expect(['input', 'output', 'error']).toContain(kind);
        socket.removeListener('data', handshake); lanes.set(kind!, socket);
        if (kind === 'output') socket.on('data', bytes => { output += bytes.toString(); });
        if (kind === 'error') socket.on('data', bytes => { error += bytes.toString(); });
        expect(hello.slice(end + 1)).toBe(''); // suspended target cannot have emitted output
      };
      socket.on('data', handshake);
    });
    const controlServer = createServer(socket => {
      control = socket; sockets.add(socket); socket.on('error', () => {});
      let pending = '';
      socket.on('data', data => {
        pending += data;
        for (;;) { const end = pending.indexOf('\n'); if (end < 0) return; packets.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1); }
      });
    });
    await Promise.all([new Promise<void>(resolve => privateServer.listen(endpoint, resolve)),
      new Promise<void>(resolve => controlServer.listen(controlEndpoint, resolve))]);
    const environment = Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${value}`).join('\0') + '\0\0';
    const command = [process.execPath, fileURLToPath(new URL('./fixtures/windows-private-native-gate.cjs', import.meta.url)),
      artifact, controlEndpoint, endpoint, token, marker].map(quote).join(' ');
    let id: number | undefined, reaped = false;
    try {
      id = native.create(process.execPath, command, environment, process.cwd(), false, 1);
      await until(() => native.snapshot(id).ready);
      native.resume(id);
      await until(() => packets.some(packet => packet.type === 'target') && lanes.size === 3);
      const target = packets.find(packet => packet.type === 'target')!;
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(output).toBe(''); expect(error).toBe('');
      expect(() => native.verifyTarget(id, target.pid, '1')).toThrow('not-owned');
      expect(() => native.verifyTarget(id, process.pid, target.birth)).toThrow('not-owned');
      expect(native.verifyTarget(id, target.pid, target.birth)).toEqual({ pid: target.pid, birth: target.birth });
      if (cancel) native.stop(id);
      else {
        control!.write(JSON.stringify({ type: 'permit', id: target.id }) + '\n');
        await until(() => packets.some(packet => packet.type === 'resumed'));
        expect(packets.find(packet => packet.type === 'resumed')!.repeated).toBe(true);
        lanes.get('input')!.end('私有 stdin "quoted"');
      }
      await until(() => { const state = native.snapshot(id); return state.creationExited && state.exited && state.branchActive === 0; });
      if (cancel) await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      else {
        await until(() => output === '私有 stdin "quoted"' && error === 'fixture-error');
        expect(await readFile(marker, 'utf8')).toBe('target-ran');
      }
      native.release(id); reaped = true;
    } finally {
      if (id !== undefined && !reaped) {
        native.stop(id);
        await until(() => { const state = native.snapshot(id); return state.creationExited && state.exited && state.branchActive === 0; });
        native.release(id); reaped = true;
      }
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise<void>(resolve => privateServer.close(() => resolve())),
        new Promise<void>(resolve => controlServer.close(() => resolve()))]);
      if (id === undefined || reaped) {
        const root = path.resolve(os.tmpdir()) + path.sep;
        if (!path.resolve(directory).startsWith(root)) throw Error('Fixture cleanup escaped temp root');
        await rm(directory, { recursive: true, force: true });
      }
    }
  }, 15000);
});
