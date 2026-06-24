import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const ENTRY_FILE = path.join(SRC_DIR, "index.ts");

const LIGHTWEIGHT_RUNTIME_IMPORTS = new Set([
  "chalk",
  "commander",
  "./screen/cli-writer.js",
  "./serve/log-line-count.js",
  "./version.js",
  "./command-gate.js",
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
  it("keeps metadata commands on the lightweight static import path", async () => {
    const sourceText = await readFile(ENTRY_FILE, "utf-8");
    const runtimeImports = collectRuntimeStaticImports(sourceText);
    const unexpected = runtimeImports.filter(
      (specifier) => !LIGHTWEIGHT_RUNTIME_IMPORTS.has(specifier),
    );

    expect(unexpected).toEqual([]);
  });
});
