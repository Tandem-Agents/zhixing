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

const LIGHTWEIGHT_RUNTIME_IMPORTS = new Set([
  "node:fs",
  "node:path",
  "node:url",
  "chalk",
  "commander",
  "./screen/cli-writer.js",
  "./screen/startup-progress.js",
  "./serve/log-line-count.js",
  "./version.js",
  "./command-gate.js",
  "./runtime-support.js",
  "./logging/entry-mode.js",
  "./logging/bootstrap.js",
  "./logging/runtime-source.js",
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
  it("keeps configuration descriptions and headless notices free of network and syntax-highlighting implementations", async () => {
    const dist = path.resolve(SRC_DIR, "../dist");
    const chunks = (await readdir(dist)).filter(name => name.endsWith(".js"));
    const candidates = await Promise.all(chunks.map(async name => ({ name, source: await readFile(path.join(dist, name), "utf8") })));
    const notices = candidates.find(item => item.source.includes("function createRunEventSubscribers("));
    expect(notices).toBeDefined();
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", String.raw`
      import { registerHooks } from 'node:module';
      const modules = new Set();
      registerHooks({ load(url, context, next) { modules.add(url); return next(url, context); } });
      await import('@zhixing/network/proxy');
      await import(${JSON.stringify(pathToFileURL(path.join(dist, notices!.name)).href)});
      process.stdout.write(JSON.stringify([...modules].filter(url => /undici|cli-highlight|highlight\.js/u.test(url))));
    `], { timeout: 15000, windowsHide: true });
    expect(JSON.parse(stdout)).toEqual([]);
  });
  it("loads the built interactive surface without the backend execution stack", async () => {
    const dist = path.resolve(SRC_DIR, "../dist");
    const entry = (await readdir(dist)).find(name => /^repl-[A-Z0-9]+\.js$/u.test(name));
    expect(entry, "Build the CLI before checking its actual import graph").toBeDefined();
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", String.raw`
      import { registerHooks } from 'node:module';
      const modules = new Set();
      registerHooks({ load(url, context, next) { modules.add(url); return next(url, context); } });
      await import(${JSON.stringify(pathToFileURL(path.join(dist, entry!)).href)});
      process.stdout.write(JSON.stringify([...modules].filter(url => /packages\/(owner-kernel|executor|orchestrator|runtime-host|mcp|tools-builtin)\/dist\//u.test(url))));
    `], { timeout: 15_000, windowsHide: true });
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it("keeps metadata commands on the lightweight static import path", async () => {
    const sourceText = await readFile(ENTRY_FILE, "utf-8");
    const runtimeImports = collectRuntimeStaticImports(sourceText);
    const unexpected = runtimeImports.filter(
      (specifier) => !LIGHTWEIGHT_RUNTIME_IMPORTS.has(specifier),
    );

    expect(unexpected).toEqual([]);
  });
});
