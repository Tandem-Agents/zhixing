import { expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { LogDraft } from '@zhixing/core/logging';
import { nativeSecretPlatform } from './secret-platform.js';

vi.mock('../cli-entry.js', () => ({ resolveCliEntry: () => fileURLToPath(new URL('../../dist/index.js', import.meta.url)) }));

it.skipIf(process.platform !== 'win32')('uses the verified shipped adapter for PID identity and CurrentUser protection', async () => {
  const events: LogDraft[] = [];
  const platform = nativeSecretPlatform(() => ({ record: draft => events.push(typeof draft === 'function' ? draft() : draft) }));
  const identity = await platform.processIdentityResolver!.read(process.pid);
  expect(identity.kind).toBe('present');
  expect(await platform.processIdentityResolver!.read(process.pid)).toEqual(identity);
  await Promise.all(Array.from({ length: 32 }, () => platform.processIdentityResolver!.read(process.pid)));
  expect(events.map(event => [event.event, event.data?.phase])).toEqual([
    ['phaseStarted', 'platform.native-adapter'], ['phaseFinished', 'platform.native-adapter'],
  ]);
  const synthetic = Buffer.alloc(32, 7);
  const protectedValue = await platform.windowsProtection!('protect', synthetic);
  try {
    expect(protectedValue.equals(synthetic)).toBe(false);
    const restored = await platform.windowsProtection!('unprotect', protectedValue);
    expect(restored.equals(synthetic)).toBe(true);
    restored.fill(0);
    expect(events.filter(event => event.data?.phase === 'platform.protect-key' && event.event === 'phaseFinished').map(event => event.result)).toEqual(['success', 'success']);
  } finally { synthetic.fill(0); protectedValue.fill(0); }
});
