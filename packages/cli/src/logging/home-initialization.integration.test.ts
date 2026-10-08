import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createTempDir } from '@zhixing/test-utils';
import { LogFilesProcess } from './files-process.js';

describe('native log home initialization', () => {
  it('creates absent writable ancestors without waiting for product setup', async () => {
    const parent = await createTempDir('log-native-fresh');
    const home = path.join(parent, 'absent-parent', 'absent-home');
    await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    const files = new LogFilesProcess(home);
    try {
      await files.open(false);
      expect((await stat(path.join(home, 'logs', 'runtime'))).isDirectory()).toBe(true);
      expect(await files.list(16)).toEqual([]);
    } finally { await files.close(); }
  }, 15_000);

  it('does not create the home or log directories for read-only access', async () => {
    const parent = await createTempDir('log-native-read-only');
    const home = path.join(parent, 'absent-home');
    const files = new LogFilesProcess(home);
    try {
      // Existing platform adapters may accept an absent legacy-only store or
      // reject an unavailable root. Neither result authorizes creating it.
      await Promise.allSettled([files.open(true)]);
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(parent)).toEqual([]);
    } finally { await files.close(); }
  }, 15_000);

  it('refuses an existing file at the home boundary without replacing it', async () => {
    const parent = await createTempDir('log-native-file-root');
    const home = path.join(parent, 'home');
    await writeFile(home, 'synthetic boundary');
    const files = new LogFilesProcess(home);
    try {
      await expect(files.open(false)).rejects.toThrow();
      expect(await readFile(home, 'utf8')).toBe('synthetic boundary');
    } finally { await files.close(); }
  }, 15_000);
});
