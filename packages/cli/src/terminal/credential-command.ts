import type { PlatformSecretStoreOptions } from '@zhixing/secrets';
import { createTerminalOwnedProcessFactory } from './host-launch.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import { resolveCliEntry } from '../cli-entry.js';

/** N already loads this same-release native asset for its writer declaration.
 * Only read-only process identity is projected into the vault's FileLock port. */
export function terminalSecretPlatform(): Pick<PlatformSecretStoreOptions, 'processIdentityResolver' | 'windowsProtection'> {
  if (process.platform !== 'win32') return {};
  let native: { processIdentity(pid: number): Awaited<ReturnType<NonNullable<PlatformSecretStoreOptions['processIdentityResolver']>['read']>>;
    protectKey(mode: string, input: Buffer): Promise<Buffer> } | undefined;
  const load = () => native ??= createRequire(import.meta.url)(path.join(path.dirname(resolveCliEntry()), 'terminal', `${process.platform}-${process.arch}`, 'foreground.node')) as NonNullable<typeof native>;
  return { processIdentityResolver: { read: async pid => load().processIdentity(pid) },
    windowsProtection: (mode, input) => load().protectKey(mode, Buffer.from(input.buffer, input.byteOffset, input.byteLength)) };
}

/** The terminal's native creation owner already isolates slow process creation.
 * Use the SecretStore's existing runner port; no unmanaged intermediary fork
 * is needed. Only the private owner/helper lanes carry credential bytes. */
export function createTerminalCredentialRunner(signal: AbortSignal): NonNullable<PlatformSecretStoreOptions['commandRunner']> {
  const create = createTerminalOwnedProcessFactory('credential');
  return async (command, args, input) => {
    signal.throwIfAborted();
    const deadline = Date.now() + 10_000;
    const env = { ...process.env };
    for (const key of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
    const owner = create(command, args, { env, signal, deadline: Math.min(deadline, Date.now() + 5000) });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const copiedInput = input ? Buffer.from(input) : undefined;
    let bytes = 0, failure: string | undefined, completionKnown = false;
    const fail = (reason: string): void => { failure ??= reason; owner.child.kill('SIGTERM'); };
    const collect = (chunks: Buffer[]) => (chunk: Buffer): void => {
      bytes += chunk.length;
      if (failure || bytes > 1024 * 1024) { chunk.fill(0); fail('output exceeded limit'); }
      else chunks.push(chunk);
    };
    owner.child.stdout.on('data', collect(stdout)); owner.child.stderr.on('data', collect(stderr));
    owner.child.stdin.on('error', () => fail('input failed'));
    owner.child.once('error', () => { failure ??= 'could not start'; });
    const timer = setTimeout(() => fail('timed out'), Math.max(1, deadline - Date.now()));
    try {
      try { await owner.ready; owner.child.stdin.end(copiedInput); }
      catch { fail('could not start'); }
      // Includes actual process exit and all private stdio, not just EOF or a
      // kill request. Unknown completion rejects while S retains ownership.
      const result = await owner.closed;
      completionKnown = true;
      if (signal.aborted || failure) throw Error(`SecretStore credential command ${failure ?? 'cancelled'}`);
      return { code: result.code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
    } finally {
      clearTimeout(timer);
      // A rejected receipt is unknown completion, not proof that native IO
      // released its borrowed buffers. S keeps that process charged.
      if (completionKnown) {
        copiedInput?.fill(0);
        for (const chunk of [...stdout, ...stderr]) chunk.fill(0);
      }
    }
  };
}
