import { createHash } from 'node:crypto';

const WORKER_SHA256 = 'cc39e6ba6470c793fa7de1b81888185c1a152904f116a0bb106b5f15276181d9';
const once = (source: string, before: string, after: string) => {
  if (source.split(before).length !== 2) throw Error('Fixed OpenTUI parser asset seam changed');
  return source.replace(before, after);
};

/** One packaged parser set serves both the executable and native fixtures.
 * Remove upstream embedded fallbacks, including its unpatched worker. */
export function patchParserAssets(source: string): string {
  const replaceBlock = (start: string, end: string, sha256: string, replacement: string) => {
    const begin = source.indexOf(start), finish = source.indexOf(end, begin);
    if (begin < 0 || finish < begin) throw Error('Fixed OpenTUI parser asset seam changed');
    const before = source.slice(begin, finish);
    if (createHash('sha256').update(before).digest('hex') !== sha256) throw Error('Fixed OpenTUI parser asset identity changed');
    source = once(source, before, replacement);
  };
  const keys = [
    'assets/javascript/highlights.scm', 'assets/javascript/tree-sitter-javascript.wasm',
    'assets/typescript/highlights.scm', 'assets/typescript/tree-sitter-typescript.wasm',
    'assets/markdown/highlights.scm', 'assets/markdown/tree-sitter-markdown.wasm', 'assets/markdown/injections.scm',
    'assets/markdown_inline/highlights.scm', 'assets/markdown_inline/tree-sitter-markdown_inline.wasm',
    'assets/zig/highlights.scm', 'assets/zig/tree-sitter-zig.wasm',
  ];
  replaceBlock('var bundledAssetLoaders = {', '// src/node-asset-target.ts',
    '016083bfe023196d794dc5ca2ef9681bbe3044c0fdb9af35b88427933aea0ab4',
    `var packagedParserAssets = new Set(${JSON.stringify(keys)});
function resolveBundledDefaultParserAsset(relativePath) {
  if (!packagedParserAssets.has(relativePath)) throw new Error("Unknown OpenTUI default parser asset");
  return resolveAssetPath("@opentui/core/" + relativePath);
}

`);
  replaceBlock('var bundledTreeSitterWorkerPath = await', 'async function resolveNativeLibraryPath() {',
    '8500183580410db96193cc8f0fcc5ec274678773bb060bbf3dfdeaeef7ec9a5a',
    `function resolveDefaultParserAsset(relativePath) {
  return resolveBundledDefaultParserAsset(relativePath);
}
function resolveDefaultTreeSitterWorkerPath() {
  return resolveAssetPath(PARSER_WORKER_ASSET_KEY);
}
function resolveTreeSitterWasm() {
  return resolveAssetPath(TREE_SITTER_WASM_ASSET_KEY);
}
`);
  return source;
}

/** Parser failures use the existing error channel; only the UI root writes
 * the active terminal. Keep the original failure/initialization settlement. */
export function patchParserClient(source: string): string {
  source = once(source, '      console.error("TreeSitter worker error:", error.message);\n', '');
  return once(source, '        console.error("TreeSitter client:", error.message);', '        this.emitError(error.message);');
}

/** The fixed worker reads packaged assets. U owns no cache directory and may
 * not download grammars or perform mkdir/rm through the library's defaults. */
export function patchParserWorker(source: string): string {
  if (createHash('sha256').update(source).digest('hex') !== WORKER_SHA256) throw Error('Fixed OpenTUI parser worker identity changed');
  source = once(source, 'import { mkdir as mkdir2 } from "fs/promises";\n', '');
  source = once(source, 'import { mkdir, readFile, writeFile } from "fs/promises";', 'import { readFile } from "fs/promises";');
  source = once(source, 'class DownloadUtils {', `function admittedParserAsset(source) {
  const root = process.env.OTUI_ASSET_ROOT;
  if (!root || typeof source !== "string" || !path.isAbsolute(source) || source.startsWith("\\\\\\\\") || source.startsWith("//")) throw new Error("Packaged parser asset required");
  const filePath = path.resolve(source);
  const relative = path.relative(path.resolve(root), filePath);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Parser asset is outside admitted distribution");
  return filePath;
}
class DownloadUtils {`);
  const begin = source.indexOf('  static async downloadOrLoad('), end = source.indexOf('  static async fetchHighlightQueries(', begin);
  if (begin < 0 || end < begin) throw Error('Fixed OpenTUI parser download seam changed');
  source = source.slice(0, begin) + `  static async downloadOrLoad(source) {
    const filePath = admittedParserAsset(source);
    const content = await readFile(filePath);
    return { content, filePath };
  }
  static async downloadToPath() { throw new Error("Parser assets are read-only"); }
` + source.slice(end);
  source = once(source, '      await mkdir2(path2.join(this.tsDataPath, "languages"), { recursive: true });\n      await mkdir2(path2.join(this.tsDataPath, "queries"), { recursive: true });\n      let treeWasm', '      let treeWasm');
  source = once(source, '      await Parser.init({\n        locateFile()', '      treeWasm = admittedParserAsset(treeWasm);\n      await Parser.init({\n        locateFile()');
  const update = source.indexOf('  async updateDataPath(dataPath) {'), finish = source.indexOf('\n}\nfunction logMessage(', update);
  if (update < 0 || finish < update) throw Error('Fixed OpenTUI parser cache seam changed');
  source = source.slice(0, update) + `  async updateDataPath(dataPath) {
    this.dataPath = dataPath;
    this.tsDataPath = path2.join(dataPath, "tree-sitter");
  }
  async clearCache() { throw new Error("Parser assets are read-only"); }` + source.slice(finish);
  return source;
}
