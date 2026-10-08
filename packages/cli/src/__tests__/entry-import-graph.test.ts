import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const ENTRY_FILE = path.join(SRC_DIR, "index.ts");
// Structural import checks own a bounded child process. Let its timeout clean up
// before Vitest ends the test; startup performance has a separate real-entry gate.
const IMPORT_CHECK_TIMEOUT_MS = 20_000;

const LIGHTWEIGHT_RUNTIME_IMPORTS = new Set([
  "node:fs",
  "node:path",
  "node:url",
  "chalk",
  "commander",
  "./screen/cli-writer.js",
  "./serve/log-line-count.js",
  "./version.js",
  "./command-gate.js",
  "./runtime-support.js",
  "./logging/entry-mode.js",
  "./logging/bootstrap.js",
  "./logging/runtime-source.js",
  "./terminal/command-route.js",
]);

function collectRuntimeStaticImports(sourceText: string): string[] {
  const source = ts.createSourceFile(
    ENTRY_FILE,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports: string[] = [];

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.importClause?.isTypeOnly) continue;
    imports.push(statement.moduleSpecifier.text);
  }

  return imports;
}

describe("CLI entry import graph", () => {
  it('keeps the built foreground supervisor graph in one CLI module', async () => {
    const dist = path.resolve(SRC_DIR, '../dist');
    const index = await readFile(path.join(dist, 'index.js'), 'utf8');
    const entry = index.match(/import\("(\.\/launch-[A-Z0-9]+\.js)"\)/u)?.[1];
    expect(entry).toBeDefined();
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', String.raw`
      import { registerHooks } from 'node:module';
      const modules = new Set();
      registerHooks({ load(url, context, next) { modules.add(url); return next(url, context); } });
      const entry = await import(${JSON.stringify(pathToFileURL(path.join(dist, entry!)).href)});
      process.stdout.write(JSON.stringify({ exported: typeof entry.launchTerminal, modules: [...modules] }));
    `], { timeout: 15_000, windowsHide: true });
    const loaded = JSON.parse(stdout) as { exported: string; modules: string[] };
    expect(loaded.exported).toBe('function');
    expect(loaded.modules.filter(url => url.startsWith(pathToFileURL(`${dist}${path.sep}`).href))).toHaveLength(1);
    expect(loaded.modules.filter(url => /packages\/(owner-kernel|executor|orchestrator|runtime-host|mcp|tools-builtin)\/dist\//u.test(url))).toEqual([]);
  }, IMPORT_CHECK_TIMEOUT_MS);
  it("keeps configuration descriptions and headless notices free of network and syntax-highlighting implementations", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import=tsx/esm", "--input-type=module", "-e", String.raw`
      import { registerHooks } from 'node:module';
      const modules = new Set();
      registerHooks({ load(url, context, next) { modules.add(url); return next(url, context); } });
      await import('@zhixing/network/proxy');
      await import(${JSON.stringify(pathToFileURL(path.join(SRC_DIR, "render-events.ts")).href)});
      process.stdout.write(JSON.stringify([...modules].filter(url => /undici|cli-highlight|highlight\.js/u.test(url))));
    `], { timeout: 15000, windowsHide: true });
    expect(JSON.parse(stdout)).toEqual([]);
  }, IMPORT_CHECK_TIMEOUT_MS);
  it.each(["application", "text-session"])("loads built %s without the backend execution stack", async (surface) => {
    const dist = path.resolve(SRC_DIR, "../dist");
    const entry = (await readdir(dist)).find(name => new RegExp(`^${surface}-[A-Z0-9]+\\.js$`, "u").test(name));
    expect(entry, "Build the CLI before checking its actual import graph").toBeDefined();
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", String.raw`
      import { registerHooks } from 'node:module';
      const modules = new Set();
      registerHooks({ load(url, context, next) { modules.add(url); return next(url, context); } });
      await import(${JSON.stringify(pathToFileURL(path.join(dist, entry!)).href)});
      process.stdout.write(JSON.stringify([...modules].filter(url => /packages\/(owner-kernel|executor|orchestrator|runtime-host|mcp|tools-builtin)\/dist\//u.test(url))));
    `], { timeout: 15_000, windowsHide: true });
    expect(JSON.parse(stdout)).toEqual([]);
  }, IMPORT_CHECK_TIMEOUT_MS);

  it("keeps metadata commands on the lightweight static import path", async () => {
    const sourceText = await readFile(ENTRY_FILE, "utf-8");
    const runtimeImports = collectRuntimeStaticImports(sourceText);
    const unexpected = runtimeImports.filter(
      (specifier) => !LIGHTWEIGHT_RUNTIME_IMPORTS.has(specifier),
    );

    expect(unexpected).toEqual([]);
    const routes = await readFile(path.join(SRC_DIR, "terminal/command-route.ts"), "utf8");
    expect(collectRuntimeStaticImports(routes)).toEqual([]);
  });
});
