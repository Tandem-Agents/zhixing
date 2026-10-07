import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { patchParserClient, patchParserWorker } from './opentui-parser-patch.js';

describe('packaged OpenTUI parser worker', () => {
  it('keeps actual worker failure and timeout settlement on the root error channel without console output', async () => {
    const source = await readFile(new URL('../node_modules/@opentui/core/chunk-bun-sjw2d9bq.js', import.meta.url), 'utf8');
    const patched = patchParserClient(source), worker = { onerror: undefined as undefined | ((error: { message: string; error: Error }) => void) };
    const client = { worker, handleWorkerFailure: vi.fn(), emitError: vi.fn(), initializeResolvers: {} as unknown };
    const start = patched.indexOf('    worker.onerror = (error) => {'), end = patched.indexOf('\n  }\n  sendWorkerMessage', start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const output = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      new Function('worker', patched.slice(start, end)).call(client, worker);
      worker.onerror!({ message: 'synthetic worker failure', error: Error('synthetic cause') });
      expect(client.handleWorkerFailure).toHaveBeenCalledOnce();
      expect(client.emitError).toHaveBeenLastCalledWith('Worker error: synthetic worker failure');
      const timeoutStart = patched.indexOf('        const error = new Error("Worker initialization timed out");');
      const timeoutEnd = patched.indexOf('\n      }, timeoutMs);', timeoutStart);
      expect(timeoutStart).toBeGreaterThan(0); expect(timeoutEnd).toBeGreaterThan(timeoutStart);
      const reject = vi.fn(); new Function('reject', patched.slice(timeoutStart, timeoutEnd)).call(client, reject);
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: 'Worker initialization timed out' }));
      expect(client.emitError).toHaveBeenLastCalledWith('Worker initialization timed out');
      expect(client.initializeResolvers).toBeUndefined(); expect(output).not.toHaveBeenCalled();
    } finally { output.mockRestore(); }
    expect(() => patchParserClient(patched)).toThrow('seam changed');
  });
  it('uses only admitted local assets and removes persistent cache operations', async () => {
    const source = await readFile(new URL('../node_modules/@opentui/core/parser.worker.js', import.meta.url), 'utf8');
    const patched = patchParserWorker(source);
    expect(patched).not.toMatch(/await (?:mkdir2?|writeFile|rm)\(/u);
    const start = patched.indexOf('function admittedParserAsset('), end = patched.indexOf('// src/lib/bunfs.ts', start);
    const read = vi.fn(async () => Buffer.from('synthetic packaged grammar'));
    const root = path.resolve('synthetic-assets');
    const utilities = new Function('readFile', 'path', 'process', `${patched.slice(start, end)}; return DownloadUtils;`)(read, path, { env: { OTUI_ASSET_ROOT: root } });
    const file = path.join(root, 'grammar.wasm');
    await expect(utilities.downloadOrLoad(file)).resolves.toMatchObject({ filePath: file });
    expect(read).toHaveBeenCalledExactlyOnceWith(file);
    for (const invalid of ['https://example.invalid/grammar.wasm', 'http://example.invalid/grammar.wasm', path.resolve('outside.wasm'), '../grammar.wasm', '//remote/share/grammar.wasm']) {
      await expect(utilities.downloadOrLoad(invalid)).rejects.toThrow();
    }
    await expect(utilities.downloadToPath(file, path.join(root, 'copy.wasm'))).rejects.toThrow('read-only');
    expect(read).toHaveBeenCalledOnce();
    expect(patched).toContain('treeWasm = admittedParserAsset(treeWasm)');
    expect(() => patchParserWorker(source + '\n')).toThrow('identity changed');
  });
});
