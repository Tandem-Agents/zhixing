import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

const packagesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
let sources: ReadonlyMap<string, string>;
let syntaxTrees: ReadonlyMap<string, ts.SourceFile>;

describe("workscene authority structure boundary", () => {
  beforeAll(async () => {
    sources = await productionSources(packagesRoot);
    syntaxTrees = new Map(
      [...sources].map(([file, source]) => [
        file,
        ts.createSourceFile(
          file,
          source,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        ),
      ]),
    );
  }, 120_000);

  it(
    "keeps new authority and projection symbols reachable only by the global adapter",
    () => {
      expect(
        symbolReferences(syntaxTrees, "AnchorWorksceneRegistry", {
          definition: "core/src/workscene/authority-registry.ts",
        }),
      ).toEqual(["core/src/workscene/global-state-adapter.ts"]);
      expect(
        symbolReferences(
          syntaxTrees,
          "IncrementalWorksceneActivityProjection",
          {
            definition: "core/src/workscene/activity-projection.ts",
          },
        ),
      ).toEqual(["core/src/workscene/global-state-adapter.ts"]);
    },
    120_000,
  );

  it(
    "keeps the legacy registry and projection out of production reachability",
    () => {
      expect(
        symbolReferences(syntaxTrees, "FsWorkSceneRegistry", {
          definition: "core/src/workscene/registry.ts",
        }),
      ).toEqual([]);
      expect(
        symbolReferences(syntaxTrees, "WorksceneActivityProjection", {
          definition: "core/src/workscene/activity-projection.ts",
        }),
      ).toEqual([]);
    },
    120_000,
  );
});

async function productionSources(
  root: string,
): Promise<ReadonlyMap<string, string>> {
  const result = new Map<string, string>();
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "test-support") {
          await visit(absolute);
        }
        continue;
      }
      if (
        !entry.name.endsWith(".ts") ||
        entry.name.endsWith(".test.ts") ||
        entry.name.endsWith(".spec.ts")
      ) {
        continue;
      }
      result.set(
        path.relative(root, absolute).replaceAll(path.sep, "/"),
        await readFile(absolute, "utf8"),
      );
    }
  }
  await visit(root);
  return result;
}

function symbolReferences(
  trees: ReadonlyMap<string, ts.SourceFile>,
  symbol: string,
  options: { readonly definition: string },
): string[] {
  const files = new Set<string>();
  for (const [file, sourceFile] of trees) {
    if (file === options.definition) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        node.text === symbol &&
        !isPropertyName(node)
      ) {
        files.add(file);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...files].sort();
}

function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isMethodSignature(parent) && parent.name === node)
  );
}
