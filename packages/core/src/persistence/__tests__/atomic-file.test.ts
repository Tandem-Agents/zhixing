import { afterEach, describe, expect, it, vi } from 'vitest';
import { rename } from 'node:fs/promises';
import { replaceFile } from '../atomic-file.js';
vi.mock('node:fs/promises', () => ({ rename: vi.fn() }));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.resetAllMocks(); });
const conflict = () => Object.assign(new Error('sharing conflict'), { code: 'EPERM', syscall: 'rename' });
function windows() { Object.defineProperty(process, 'platform', { ...platform, value: 'win32' }); }
describe('atomic file replacement', () => {
  it('retries the same closed source and destination only, and accounts for each attempt', async () => {
    windows(); const error = conflict(), beforeAttempt = vi.fn();
    vi.mocked(rename).mockRejectedValueOnce(error).mockResolvedValue(undefined);
    await replaceFile('temporary', 'target', { beforeAttempt });
    expect(rename).toHaveBeenCalledTimes(2); expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(vi.mocked(rename).mock.calls).toEqual([['temporary', 'target'], ['temporary', 'target']]);
  });
  it('bounds persistent Windows sharing failure and preserves the original OS cause', async () => {
    windows(); const error = conflict(); vi.mocked(rename).mockRejectedValue(error);
    const started = performance.now();
    await expect(replaceFile('temporary', 'target')).rejects.toMatchObject({ message: 'Atomic file replacement failed', cause: error });
    expect(performance.now() - started).toBeLessThan(1800); expect(vi.mocked(rename).mock.calls.length).toBeGreaterThan(1); expect(vi.mocked(rename).mock.calls.length).toBeLessThanOrEqual(11);
  });
  it.each(['EIO', 'ENOENT'])('does not retry permanent %s failures', async code => {
    windows(); const error = Object.assign(new Error(code), { code }); vi.mocked(rename).mockRejectedValue(error);
    await expect(replaceFile('temporary', 'target')).rejects.toMatchObject({ cause: error }); expect(rename).toHaveBeenCalledOnce();
  });
  it('propagates cancellation between attempts without publishing a replacement', async () => {
    windows(); const controller = new AbortController();
    vi.mocked(rename).mockImplementation(async () => { controller.abort(new Error('owner stopped')); throw conflict(); });
    await expect(replaceFile('temporary', 'target', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(rename).toHaveBeenCalledOnce();
  });
  it('does not reinterpret POSIX permission failures as sharing conflicts', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    const error = conflict(); vi.mocked(rename).mockRejectedValue(error);
    await expect(replaceFile('temporary', 'target')).rejects.toMatchObject({ cause: error }); expect(rename).toHaveBeenCalledOnce();
  });
});
