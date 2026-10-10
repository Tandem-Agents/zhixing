import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { PlatformSecretStoreOptions } from '@zhixing/secrets';
import { resolveCliEntry } from '../cli-entry.js';
import { observeLogPhase, type LogRecordPort } from '@zhixing/core/logging';

/** Composition-root adapter shared by Host and terminal application. Core and
 * Secrets only receive their existing identity/protection ports. */
export function nativeSecretPlatform(records?: () => LogRecordPort | undefined): Pick<PlatformSecretStoreOptions, 'processIdentityResolver' | 'windowsProtection'> {
  if (process.platform !== 'win32') return {};
  const directory = path.join(path.dirname(resolveCliEntry()), 'terminal', `${process.platform}-${process.arch}`);
  const filename = path.join(directory, 'foreground.node');
  // Source-only/unsupported distributions retain the existing portable adapter.
  // A present but corrupt native asset must fail closed, not silently fall back.
  if (!existsSync(filename)) return {};
  type Native = { processIdentity(pid: number): Awaited<ReturnType<NonNullable<PlatformSecretStoreOptions['processIdentityResolver']>['read']>>;
    protectKey(mode: string, input: Buffer): Promise<Buffer> };
  let loaded: Promise<Native> | undefined;
  const load = () => loaded ??= observeLogPhase(records?.(), 'platform.native-adapter', async () => {
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as { artifacts?: { name: string; bytes: number; sha256: string }[] };
    const artifact = manifest.artifacts?.find(item => item.name === 'foreground.node');
    if (!artifact || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 5 * 1024 * 1024 || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw Error('platform-native-manifest');
    const handle = await open(filename, 'r');
    try {
      if ((await handle.stat()).size !== artifact.bytes) throw Error('platform-native-integrity');
      const bytes = Buffer.alloc(artifact.bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw Error('platform-native-integrity');
        offset += bytesRead;
      }
      if ((await handle.stat()).size !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw Error('platform-native-integrity');
    } finally { await handle.close(); }
    return createRequire(import.meta.url)(filename) as Native;
  });
  return {
    // Identity reads are synchronous native calls inside the already observed
    // Authority lock stage. Two critical phase records per lock amplify log
    // publication work during startup. Observe adapter loading once; preserve
    // per-operation lock timing/failure in AuthorityWorkObserver.
    processIdentityResolver: { read: async pid => (await load()).processIdentity(pid) },
    windowsProtection: (mode, input) => observeLogPhase(records?.(), 'platform.protect-key', async () => (await load()).protectKey(mode, Buffer.from(input.buffer, input.byteOffset, input.byteLength))),
  };
}
