/**
 * 单份启动图：以已产出的 dist/index.js（entry.ts）为入口，把整个程序重新打包到 dist/bundle。
 * 静态依赖进入入口块与共享块，动态导入目标成为同一次构建的按需块；工作区包与第三方全部内联，
 * 只有 node 内置与原生件留在外部。S 用它拉起宿主与 N，进程里只装这一份代码。
 *
 * 每个输入模块的 import.meta.url 改写为“该模块原始产物文件”的 URL：cli 自身模块相对 bundle 目录
 * 回到 dist；其他包在运行时经 Node 解析该包的真实位置（仓库与 npm 安装两种布局都成立）。
 * 构建后对实际输出做闭包检查，任何能在运行时装入 bundle 之外代码的位置都必须在评审清单里。
 *
 * esbuild 由调用方传入（tsup 自带），本模块不直接依赖它。
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

export const PROGRAM_BUNDLE_HELPER = 'zhixing:program-module-url';
const HELPER_NAMESPACE = 'zhixing-program-module-url';
const CLI_PACKAGE = '@zhixing/cli';

/** 运行时可能装入 bundle 之外代码的位置（非字面量 import()/require()/__require()/require.resolve()/createRequire(...)(x)）。
 * 逐条评审：按所属包与规范化后的调用文本归属（产物块名带哈希、每次构建都变，不作键），次数必须完全一致；
 * 新增或变化即构建失败。 */
export interface ProgramBundleDynamicSite { readonly package: string; readonly call: string; readonly count: number; readonly reason: string }

export interface ProgramBundleOptions {
  readonly cliRoot: string;
  readonly build: (options: Record<string, unknown>) => Promise<{ metafile?: ProgramBundleMetafile; warnings?: readonly unknown[] }>;
  readonly dynamicSites: readonly ProgramBundleDynamicSite[];
  /** 允许留在外部的非内置说明符（只限运行时可缺省的可选依赖）。 */
  readonly optionalExternals?: readonly string[];
}

export interface ProgramBundleMetafile {
  readonly outputs: Record<string, { readonly bytes: number; readonly imports: readonly { readonly path: string; readonly kind: string; readonly external?: boolean }[] }>;
}

export interface ProgramBundleReport {
  readonly chunks: number;
  readonly entryClosureChunks: number;
  readonly entryClosureBytes: number;
  readonly rewrittenModules: number;
}

const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
export function isNodeBuiltin(specifier: string): boolean {
  return builtins.has(specifier) || (specifier.startsWith('node:') && builtins.has(specifier.slice(5)));
}

interface PackageLocation { readonly name: string; readonly root: string; readonly specifier: string | null; readonly target: string | null }

/** 条件导出按 Node ESM 解析在本进程里的条件次序取第一个能命中的字符串目标。 */
function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) { const target = exportTarget(item); if (target) return target; }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'node' || key === 'import' || key === 'default') { const target = exportTarget(item); if (target) return target; }
    }
  }
  return undefined;
}

/** 包的一个可解析入口与它在包内的相对路径：运行时据此从解析结果反推包根。 */
function packageEntry(manifest: { exports?: unknown; module?: string; main?: string }): { specifier: string; target: string } | undefined {
  const exports = manifest.exports;
  if (exports !== undefined) {
    const root = typeof exports === 'string' || Array.isArray(exports) || Object.keys(exports as object).some(key => !key.startsWith('.'))
      ? exportTarget(exports) : exportTarget((exports as Record<string, unknown>)['.']);
    if (root) return { specifier: '', target: root };
    for (const [key, item] of Object.entries(exports as Record<string, unknown>)) {
      if (!key.startsWith('./') || key.includes('*')) continue;
      const target = exportTarget(item);
      if (target) return { specifier: key.slice(1), target };
    }
    return undefined;
  }
  return { specifier: '', target: manifest.main ?? 'index.js' };
}

export function createPackageLocator(): (file: string) => PackageLocation {
  const cache = new Map<string, PackageLocation>();
  return (file: string) => {
    for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
      const cached = cache.get(directory);
      if (cached) return cached;
      const manifestFile = path.join(directory, 'package.json');
      if (existsSync(manifestFile)) {
        const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { name?: string; exports?: unknown; main?: string };
        if (typeof manifest.name === 'string') {
          let location: PackageLocation;
          if (manifest.name === CLI_PACKAGE) location = { name: manifest.name, root: directory, specifier: null, target: null };
          else {
            const entry = packageEntry(manifest);
            if (!entry) throw Error(`program-bundle：包 ${manifest.name} 没有可解析的导出，无法在运行时定位 import.meta.url`);
            location = { name: manifest.name, root: directory, specifier: manifest.name + entry.specifier, target: path.posix.normalize(entry.target.replace(/^\.\//u, '')) };
          }
          cache.set(directory, location);
          return location;
        }
      }
      if (path.dirname(directory) === directory) throw Error(`program-bundle：找不到 ${file} 所属的包`);
    }
  };
}

/** 按语法找出模块里真实的 import.meta 用法（字符串、注释里的同名文字不算）。只支持 import.meta.url。 */
function importMetaUrlRanges(contents: string, file: string): { start: number; end: number }[] {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const ranges: { start: number; end: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      const parent = node.parent;
      if (!parent || !ts.isPropertyAccessExpression(parent) || parent.expression !== node || parent.name.text !== 'url') {
        throw Error(`program-bundle：${file} 使用了不支持的 import.meta 形态（只允许 import.meta.url）`);
      }
      ranges.push({ start: parent.getStart(source), end: parent.getEnd() });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return ranges;
}

/** 改写一个输入模块的 import.meta.url；其他 import.meta 形态一律构建失败。 */
export function rewriteImportMeta(contents: string, file: string, locate: (file: string) => PackageLocation): string | undefined {
  if (!contents.includes('import.meta')) return undefined;
  const ranges = importMetaUrlRanges(contents, file);
  if (!ranges.length) return undefined;
  const location = locate(file);
  const relative = path.relative(location.root, file).split(path.sep).join('/');
  if (relative.startsWith('..')) throw Error(`program-bundle：${file} 不在其包目录内`);
  const call = `__zxModuleUrl(${JSON.stringify(location.name)}, ${JSON.stringify(relative)}, ${JSON.stringify(location.specifier)}, ${JSON.stringify(location.target)})`;
  let rewritten = contents;
  for (const range of ranges.sort((a, b) => b.start - a.start)) rewritten = rewritten.slice(0, range.start) + call + rewritten.slice(range.end);
  // 导入声明放在文件末尾：ESM 导入照常提升，原有行号不变
  return rewritten + `\nimport { __zxModuleUrl } from ${JSON.stringify(PROGRAM_BUNDLE_HELPER)};\n`;
}

/** 运行时定位：cli 自身回到 bundle 的上两级（包根）；其他包由 import.meta.resolve 解析主入口后反推包根。 */
export const PROGRAM_MODULE_URL_HELPER = `import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const bundleDirectory = path.dirname(fileURLToPath(import.meta.url));
const roots = new Map();
export function __zxModuleUrl(name, relative, specifier, target) {
  let root = roots.get(name);
  if (root === undefined) {
    if (specifier === null) root = path.resolve(bundleDirectory, "..", "..");
    else {
      const resolved = fileURLToPath(import.meta.resolve(specifier));
      const suffix = path.sep + path.join(...target.split("/"));
      if (!resolved.endsWith(suffix)) throw new Error("program-bundle-package-root: " + name);
      root = resolved.slice(0, resolved.length - suffix.length);
    }
    roots.set(name, root);
  }
  return pathToFileURL(path.join(root, ...relative.split("/"))).href;
}
`;

function moduleUrlPlugin(counter: { rewritten: number }) {
  const locate = createPackageLocator();
  return {
    name: 'zhixing-program-module-url',
    setup(build: { onResolve: Function; onLoad: Function }) {
      // 插件过滤正则交给 esbuild 的 Go 正则引擎，不能带 u 标志
      build.onResolve({ filter: /^zhixing:program-module-url$/ }, () => ({ path: PROGRAM_BUNDLE_HELPER, namespace: HELPER_NAMESPACE }));
      build.onLoad({ filter: /.*/, namespace: HELPER_NAMESPACE }, () => ({ contents: PROGRAM_MODULE_URL_HELPER, loader: 'js', resolveDir: process.cwd() }));
      build.onLoad({ filter: /\.[cm]?js$/ }, async (args: { path: string }) => {
        const contents = await readFile(args.path, 'utf8');
        const rewritten = rewriteImportMeta(contents, args.path, locate);
        if (rewritten === undefined) return undefined;
        counter.rewritten++;
        return { contents: rewritten, loader: 'js', resolveDir: path.dirname(args.path) };
      });
    },
  };
}

/**
 * 按语法收集一个输出文件里所有装入调用：import(...)、require(...)、require.resolve(...)。
 * 参数是字面量的给出目标；不是字面量的给出所属输入模块（esbuild 在每个模块代码前写 // <输入路径>）。
 * 注释与字符串里的同名文字不算。
 */
export function loadCalls(text: string, file = 'bundle.js'): { literal: string[]; dynamic: { module: string; snippet: string }[] } {
  const markers: { at: number; module: string }[] = [];
  for (const match of text.matchAll(/^\/\/ (\S+\.[cm]?[jt]s)$/gmu)) markers.push({ at: match.index!, module: match[1]! });
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const literal: string[] = [], dynamic: { module: string; snippet: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // 也算：esbuild 包装的 __require(x)，以及 createRequire(...)(x)（原生件按已核验路径装入走这里；esbuild 会把
      // 导入名改成 createRequire2 之类）
      const loads = callee.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(callee) && (callee.text === 'require' || callee.text === '__require'))
        || (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'require' && callee.name.text === 'resolve')
        || (ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && /^(?:__zx)?[cC]reateRequire\d*$/u.test(callee.expression.text));
      if (loads) {
        const argument = node.arguments[0];
        if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) literal.push(argument.text);
        else {
          const at = node.getStart(source);
          const owner = markers.filter(marker => marker.at < at).at(-1)?.module ?? '(bundle prelude)';
          const call = node.getText(source).replace(/__zxModuleUrl\([^)]*\)/gu, '<module-url>').replace(/\b((?:__zx)?[cC]reateRequire)\d+\(/gu, '$1(')
            .replace(/\s+/gu, ' ').slice(0, 160);
          dynamic.push({ module: owner.split('\\').join('/'), snippet: call });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { literal, dynamic };
}

export function checkProgramBundle(input: {
  /** metafile 里的路径相对于构建工作目录（cli 包根）。 */
  readonly root: string;
  readonly metafile: ProgramBundleMetafile; readonly outdir: string; readonly texts: ReadonlyMap<string, string>;
  readonly dynamicSites: readonly ProgramBundleDynamicSite[]; readonly optionalExternals?: readonly string[];
  /** 输出里的模块路径到所属包；缺省按磁盘上的 package.json 定位。 */
  readonly locate?: (file: string) => { readonly name: string };
}): void {
  const problems: string[] = [];
  const optional = new Set(input.optionalExternals ?? []);
  for (const [output, info] of Object.entries(input.metafile.outputs)) {
    if (!output.endsWith('.js')) continue;
    for (const item of info.imports) {
      if (item.external) {
        if (!isNodeBuiltin(item.path) && !optional.has(item.path)) problems.push(`${output} 外部导入 ${item.path}（只允许 node 内置）`);
      } else if (path.relative(input.outdir, path.resolve(input.root, item.path)).startsWith('..')) problems.push(`${output} 导入了 bundle 之外的 ${item.path}`);
    }
  }
  const locate = input.locate ?? createPackageLocator();
  const found = new Map<string, number>();
  for (const [output, text] of input.texts) {
    const calls = loadCalls(text, output);
    for (const target of calls.literal) {
      if (isNodeBuiltin(target) || optional.has(target)) continue;
      if (/^\.\/[\w.-]+\.js$/u.test(target)) continue;
      problems.push(`${output} 字面量装入 ${target}（只允许本构建块或 node 内置）`);
    }
    for (const site of calls.dynamic) {
      const owner = site.module === '(bundle prelude)' ? site.module : locate(path.resolve(input.root, site.module)).name;
      const key = `${owner} :: ${site.snippet}`;
      found.set(key, (found.get(key) ?? 0) + 1);
    }
  }
  const expected = new Map(input.dynamicSites.map(site => [`${site.package} :: ${site.call}`, site.count]));
  for (const [key, count] of found) {
    const allowed = expected.get(key);
    if (allowed === undefined) problems.push(`未评审的非字面量动态装入：${key}（${count} 处）`);
    else if (allowed !== count) problems.push(`${key} 从评审时的 ${allowed} 处变为 ${count} 处`);
  }
  for (const key of expected.keys()) if (!found.has(key)) problems.push(`评审清单里的 ${key} 在输出中已不存在，清单需要同步`);
  if (problems.length) throw Error(`单份启动图闭包检查未通过：\n${problems.join('\n')}`);
}

export async function bundleProgram(options: ProgramBundleOptions): Promise<ProgramBundleReport> {
  const dist = path.join(options.cliRoot, 'dist');
  const outdir = path.join(dist, 'bundle');
  await rm(outdir, { recursive: true, force: true });
  const counter = { rewritten: 0 };
  const result = await options.build({
    absWorkingDir: options.cliRoot,
    entryPoints: { index: path.join(dist, 'index.js') },
    outdir, entryNames: '[name]', chunkNames: 'chunk-[hash]',
    bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node24',
    mainFields: ['module', 'main'], conditions: ['import'],
    external: ['*.node', ...builtins, ...(options.optionalExternals ?? [])],
    define: { __ZHIXING_PROGRAM_BUNDLE__: 'true' },
    // 打包进来的 CommonJS 依赖装 node 内置时需要真实的 require
    banner: { js: 'import { createRequire as __zxCreateRequire } from "node:module"; const require = __zxCreateRequire(import.meta.url);' },
    plugins: [moduleUrlPlugin(counter)],
    metafile: true, sourcemap: true, logLevel: 'error',
  });
  const metafile = result.metafile;
  if (!metafile) throw Error('program-bundle：esbuild 未返回 metafile');
  const texts = new Map<string, string>();
  for (const output of Object.keys(metafile.outputs)) {
    if (output.endsWith('.js')) texts.set(output, await readFile(path.resolve(options.cliRoot, output), 'utf8'));
  }
  checkProgramBundle({ root: options.cliRoot, metafile, outdir, texts, dynamicSites: options.dynamicSites, optionalExternals: options.optionalExternals });
  const entry = Object.keys(metafile.outputs).find(name => name.endsWith('/index.js') && path.resolve(options.cliRoot, name) === path.join(outdir, 'index.js'));
  if (!entry) throw Error('program-bundle：找不到入口输出');
  const closure = new Set<string>();
  const visit = (name: string) => {
    if (closure.has(name)) return;
    closure.add(name);
    for (const item of metafile.outputs[name]!.imports) if (item.kind === 'import-statement' && !item.external) visit(item.path);
  };
  visit(entry);
  return {
    chunks: [...texts.keys()].length,
    entryClosureChunks: closure.size,
    entryClosureBytes: [...closure].reduce((sum, name) => sum + metafile.outputs[name]!.bytes, 0),
    rewrittenModules: counter.rewritten,
  };
}
