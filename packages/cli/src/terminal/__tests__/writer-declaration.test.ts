import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connect } from 'node:net';
import { LogFilesProcess } from '../../logging/files-process.js';
import { declareLogWriter, writerEndpoint, writerRootKey } from '../../logging/writer-admission.js';
import { terminalWriterDeclarationFactory } from '../writer-declaration.js';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPlatformSecretStore } from '@zhixing/secrets';

describe.skipIf(process.platform !== 'win32')('terminal native log declaration', () => {
  it('matches existing lock births and round-trips current-user DPAPI without shell-owned secrets', async () => {
    const artifact = fileURLToPath(new URL('../../../../terminal-ui/dist/win32-x64/foreground.node', import.meta.url));
    const native = createRequire(import.meta.url)(artifact) as { processIdentity(pid: number): { kind: string; birth?: string }; protectKey(mode: string, input: Buffer): Promise<Buffer> };
    const actual = native.processIdentity(process.pid);
    const expected = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().Ticks`], { windowsHide: true });
    expect(actual).toEqual({ kind: 'present', birth: `win32:${expected.stdout.trim()}` });
    for (const pid of [0, -1, 1.5, Number.NaN, 2 ** 32]) expect(native.processIdentity(pid).kind).toBe('unknown');
    const original = Buffer.alloc(32, 91), protectedKey = await native.protectKey('protect', original);
    expect(protectedKey.equals(original)).toBe(false);
    const pending = native.protectKey('unprotect', protectedKey); protectedKey.fill(0);
    const unprotected = await pending; expect(unprotected).toEqual(original);
    await expect(native.protectKey('unprotect', Buffer.alloc(32))).rejects.toThrow('terminal-credential-protection-failed');
    expect(() => native.protectKey('protect', Buffer.alloc(33))).toThrow('terminal-credential-input-invalid');
    expect(() => native.protectKey('protect\0extra', Buffer.alloc(32))).toThrow('terminal-credential-input-invalid');
    original.fill(0); unprotected.fill(0);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'terminal-native-vault-'));
    try {
      const options = { homeDir: directory, processIdentityResolver: { read: async () => actual as { kind: 'present'; birth: string } } };
      const nativeOptions = { ...options, windowsProtection: (mode: 'protect' | 'unprotect', input: Uint8Array) => native.protectKey(mode, Buffer.from(input)) };
      const ref = { kind: 'provider' as const, bindingId: 'synthetic' };
      const nativeStore = createPlatformSecretStore(nativeOptions);
      await nativeStore.put(ref, 'test-value');
      expect(await createPlatformSecretStore(options).get(ref)).toBe('test-value');
      // Conversely, initialize through the original implementation and reopen
      // through the native port; persisted user stores need no migration.
      const second = { ...options, homeDir: path.join(directory, 'legacy') };
      await createPlatformSecretStore(second).put(ref, 'legacy-value');
      expect(await createPlatformSecretStore({ ...nativeOptions, homeDir: second.homeDir }).get(ref)).toBe('legacy-value');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 15000);
  it('proves the current OS peer during a blocked JS loop and releases/reopens its endpoint', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'terminal-log-proof-'));
    const artifact = fileURLToPath(new URL('../../../../terminal-ui/dist/win32-x64/foreground.node', import.meta.url));
    const create = terminalWriterDeclarationFactory(artifact)!;
    const files = new LogFilesProcess(home);
    let declaration = declareLogWriter(home, undefined, create);
    try {
      await declaration.ready; await files.open(false);
      for (let round = 0; round < 2; round++) {
        const proof = files.readLocalProcessDeclaration(writerEndpoint(process.pid), process.pid);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
        await expect(proof.then(JSON.parse), `busy loop ${round}`).resolves.toEqual({ protocol: 2, root: writerRootKey(home), pid: process.pid });
      }
      await expect(files.readLocalProcessDeclaration(writerEndpoint(process.pid), process.pid + 1)).rejects.toThrow('peer mismatch');
      // An idle peer cannot keep a native slot forever or block close.
      const peers = Array.from({ length: 8 }, () => connect(writerEndpoint(process.pid)));
      for (const peer of peers) peer.on('error', () => {});
      try {
        await new Promise(resolve => setTimeout(resolve, 650));
        await expect(files.readLocalProcessDeclaration(writerEndpoint(process.pid), process.pid), 'after occupied clients').resolves.toContain(writerRootKey(home));
        await declaration.close(); await declaration.close();
      } finally { for (const peer of peers) peer.destroy(); }
      // The already open verifier can connect before the native service thread
      // gets its first turn. Do not discard this first connected client.
      for (let round = 0; round < 16; round++) {
        declaration = declareLogWriter(home, undefined, create);
        await declaration.ready;
        await expect(files.readLocalProcessDeclaration(writerEndpoint(process.pid), process.pid), `after reopen ${round}`).resolves.toContain('"protocol":2');
        await declaration.close();
      }
    } finally { await declaration.close(); await files.close(); await rm(home, { recursive: true, force: true }); }
  }, 15000);
});
