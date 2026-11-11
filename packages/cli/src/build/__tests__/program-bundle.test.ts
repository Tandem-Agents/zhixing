import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkProgramBundle, createPackageLocator, loadCalls, PROGRAM_MODULE_URL_HELPER, rewriteImportMeta, type ProgramBundleMetafile } from '../program-bundle.js';
import { createTempDir } from '@zhixing/test-utils';
async function tree(files: Record<string, string>): Promise<string> {
  const root = await createTempDir('program-bundle');
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  return root;
}

describe('import.meta 改写', () => {
  it('cli 自身模块改写为相对包根的原始产物；其他包带运行时解析入口；字符串与注释里的同名文字不动', async () => {
    const root = await tree({
      'cli/package.json': JSON.stringify({ name: '@zhixing/cli' }),
      'other/package.json': JSON.stringify({ name: '@x/other', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } } }),
    });
    const locate = createPackageLocator();
    const cliFile = path.join(root, 'cli/dist/chunk.js');
    const cli = rewriteImportMeta('// import.meta.dirname 只在注释里\nconst a = "import.meta"; const u = new URL("./w.js", import.meta.url);', cliFile, locate)!;
    expect(cli).toContain('__zxModuleUrl("@zhixing/cli", "dist/chunk.js", null, null)');
    expect(cli).toContain('// import.meta.dirname 只在注释里');
    expect(cli).toContain('const a = "import.meta"');
    const other = rewriteImportMeta('export const u = import.meta.url;', path.join(root, 'other/dist/sub/x.js'), locate)!;
    expect(other).toContain('__zxModuleUrl("@x/other", "dist/sub/x.js", "@x/other", "dist/index.js")');
    expect(rewriteImportMeta('const a = "import.meta.url";', cliFile, locate)).toBeUndefined();
  });

  it('import.meta.dirname、resolve 或整体传递一律构建失败', async () => {
    const root = await tree({ 'cli/package.json': JSON.stringify({ name: '@zhixing/cli' }) });
    const locate = createPackageLocator(), file = path.join(root, 'cli/dist/a.js');
    for (const text of ['import.meta.dirname', 'import.meta.resolve("x")', 'use(import.meta)', 'import.meta["url"]']) {
      expect(() => rewriteImportMeta(text, file, locate), text).toThrow(/不支持的 import\.meta/u);
    }
  });

  it('运行时按真实包位置定位：cli 回到 bundle 上两级，其他包经解析反推包根，入口不符即失败', async () => {
    // 在真实 Node 子进程里跑（测试框架的模块转换不支持 import.meta.resolve）
    const root = await tree({
      'cli/package.json': JSON.stringify({ name: '@zhixing/cli', type: 'module' }),
      'cli/dist/bundle/helper.mjs': PROGRAM_MODULE_URL_HELPER,
      'cli/dist/bundle/run.mjs': `import { __zxModuleUrl } from "./helper.mjs";
const results = [__zxModuleUrl("@zhixing/cli", "dist/logging-store-worker.js", null, null),
  __zxModuleUrl("@x/other", "dist/sub/x.js", "@x/other", "dist/index.js")];
try { __zxModuleUrl("@x/mismatch", "a.js", "@x/other", "lib/main.js"); results.push("no-error"); } catch (error) { results.push(error.message); }
process.stdout.write(JSON.stringify(results));`,
      'cli/node_modules/@x/other/package.json': JSON.stringify({ name: '@x/other', type: 'module', exports: { '.': { import: './dist/index.js' } } }),
      'cli/node_modules/@x/other/dist/index.js': 'export {};',
    });
    const results = JSON.parse(execFileSync(process.execPath, [path.join(root, 'cli/dist/bundle/run.mjs')], { encoding: 'utf8' })) as string[];
    const real = (file: string) => pathToFileURL(path.join(realpathSync(root), file)).href;
    expect(results[0]).toBe(real('cli/dist/logging-store-worker.js'));
    expect(results[1]).toBe(real('cli/node_modules/@x/other/dist/sub/x.js'));
    expect(results[2]).toMatch(/program-bundle-package-root/u);
  });
});

describe('输出装入调用扫描', () => {
  it('只按语法收集真实调用：注释与字符串不算；createRequire 改名与模块 URL 规范化', () => {
    const text = [
      '// ../pkg/dist/a.js',
      '/** @type {import("../../types/x.js")} */',
      'const code = `require("ajv/dist/runtime/equal")`;',
      'await import("./chunk-AB12.js"); require("node:fs");',
      '// dist/chunk-X.js',
      'const m = createRequire2(__zxModuleUrl("@zhixing/cli", "dist/x.js", null, null))(artifact);',
      'await import(target);',
    ].join('\n');
    const calls = loadCalls(text);
    expect(calls.literal).toEqual(['./chunk-AB12.js', 'node:fs']);
    expect(calls.dynamic).toEqual([
      { module: 'dist/chunk-X.js', snippet: 'createRequire(<module-url>)(artifact)' },
      { module: 'dist/chunk-X.js', snippet: 'import(target)' },
    ]);
  });
});

describe('单份启动图闭包检查', () => {
  const root = path.resolve('/repo/packages/cli'), outdir = path.join(root, 'dist/bundle');
  const locate = () => ({ name: '@zhixing/cli' });
  const metafile = (imports: ProgramBundleMetafile['outputs'][string]['imports'] = []): ProgramBundleMetafile =>
    ({ outputs: { 'dist/bundle/index.js': { bytes: 10, imports: [{ path: 'dist/bundle/chunk-A.js', kind: 'import-statement' }, ...imports] } } });
  const site = { package: '@zhixing/cli', call: 'createRequire(<module-url>)(artifact)', count: 1, reason: '原生件' };
  const native = '// dist/x.js\ncreateRequire(__zxModuleUrl("@zhixing/cli", "dist/x.js", null, null))(artifact);';
  const check = (texts: Record<string, string>, more: Partial<Parameters<typeof checkProgramBundle>[0]> = {}) =>
    checkProgramBundle({ root, outdir, metafile: metafile(), texts: new Map(Object.entries(texts)), dynamicSites: [site], locate, ...more });

  it('评审过的原生件装入与本构建块、内置导入通过', () => {
    expect(() => check({ 'dist/bundle/index.js': `${native}\nawait import("./chunk-A.js"); require("node:path");` })).not.toThrow();
  });
  it('外部工作区包、bundle 外的导入、字面量装入第三方都失败', () => {
    expect(() => check({ 'dist/bundle/index.js': native }, { metafile: metafile([{ path: '@zhixing/core', kind: 'import-statement', external: true }]) })).toThrow(/外部导入 @zhixing\/core/u);
    expect(() => check({ 'dist/bundle/index.js': native }, { metafile: metafile([{ path: 'dist/index.js', kind: 'import-statement' }]) })).toThrow(/bundle 之外/u);
    expect(() => check({ 'dist/bundle/index.js': `${native}\nrequire("ws");` })).toThrow(/字面量装入 ws/u);
  });
  it('新增、次数变化、清单失效的动态装入都失败', () => {
    expect(() => check({ 'dist/bundle/index.js': `${native}\nawait import(target);` })).toThrow(/未评审的非字面量动态装入/u);
    expect(() => check({ 'dist/bundle/index.js': `${native}\n${native}` })).toThrow(/从评审时的 1 处变为 2 处/u);
    expect(() => check({ 'dist/bundle/index.js': 'await import("./chunk-A.js");' })).toThrow(/清单需要同步/u);
  });
});
