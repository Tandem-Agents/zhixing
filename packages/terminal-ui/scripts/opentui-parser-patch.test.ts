import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { patchParserAssets, patchParserClient, patchParserWorker } from './opentui-parser-patch.js';

describe('packaged OpenTUI parser worker', () => {
  it('resolves every grammar, worker and wasm only through the existing packaged asset boundary', async () => {
    const source = await readFile(new URL('../node_modules/@opentui/core/chunk-bun-sjw2d9bq.js', import.meta.url), 'utf8');
    const patched = patchParserAssets(source);
    const resolverStart = patched.indexOf('function resolveAssetPath(');
    const resolver = patched.slice(resolverStart, patched.indexOf('// src/platform/runtime.ts', resolverStart));
    const grammar = patched.slice(patched.indexOf('var packagedParserAssets ='), patched.indexOf('// src/node-asset-target.ts'));
    const runtime = patched.slice(patched.indexOf('var CORE_ASSET_PREFIX ='), patched.indexOf('async function resolveNativeLibraryPath()'));
    const env = { OTUI_ASSET_ROOT: path.resolve('synthetic-assets') as string | undefined }, stat = vi.fn(() => ({ isFile: () => true }));
    const api = new Function('process', 'isAbsolute', 'join', 'statSync', `${resolver}\n${grammar}\n${runtime}
      return { keys: [...packagedParserAssets], grammar: resolveDefaultParserAsset, worker: resolveDefaultTreeSitterWorkerPath, wasm: resolveTreeSitterWasm };`
    )({ env }, path.isAbsolute, path.join, stat);
    expect(api.keys).toHaveLength(11);
    for (const key of api.keys) expect(await api.grammar(key, 'forbidden-fallback')).toBe(path.join(env.OTUI_ASSET_ROOT!, '@opentui/core', key));
    expect(api.worker('forbidden-fallback')).toBe(path.join(env.OTUI_ASSET_ROOT!, '@opentui/core/parser.worker.js'));
    expect(api.wasm()).toBe(path.join(env.OTUI_ASSET_ROOT!, 'web-tree-sitter/tree-sitter.wasm'));
    expect(stat).toHaveBeenCalledTimes(13);
    expect(() => api.grammar('../escape.wasm')).toThrow('Unknown');
    expect(grammar + runtime).not.toContain('import(');
    expect(grammar + runtime).not.toContain('resolveBundledFilePath');
    for (const operation of [() => api.grammar(api.keys[0], 'forbidden-fallback'), () => api.worker('forbidden-fallback'), () => api.wasm()]) {
      env.OTUI_ASSET_ROOT = undefined; expect(operation).toThrow('no package-relative fallback');
      env.OTUI_ASSET_ROOT = 'relative-root'; expect(operation).toThrow('absolute directory');
      env.OTUI_ASSET_ROOT = path.resolve('missing-root'); stat.mockReturnValue({ isFile: () => false });
      expect(operation).toThrow('Missing OpenTUI asset'); stat.mockReturnValue({ isFile: () => true });
    }
    expect(() => patchParserAssets(source.replace('"assets/zig/highlights.scm":', '"assets/other/highlights.scm":'))).toThrow('identity changed');
    expect(() => patchParserAssets(source.replace('useAssetRoot: false', 'useAssetRoot: true'))).toThrow('identity changed');
    expect(() => patchParserAssets(patched)).toThrow('seam changed');
  });
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
