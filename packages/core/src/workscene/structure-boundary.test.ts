import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const packagesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
let sources: ReadonlyMap<string, string>;

describe("workscene authority structure boundary", () => {
  beforeAll(async () => {
    sources = await productionSources(packagesRoot);
  }, 120_000);

  it("keeps new authority and projection constructors inside the global adapter", async () => {
    expect(matches(sources, /\bnew\s+AnchorWorksceneRegistry\s*\(/gu)).toEqual([
      "core/src/workscene/global-state-adapter.ts",
    ]);
    expect(
      matches(
        sources,
        /\bnew\s+IncrementalWorksceneActivityProjection\s*\(/gu,
      ),
    ).toEqual(["core/src/workscene/global-state-adapter.ts"]);
  });

  it("keeps the legacy registry out of production construction and public exports", async () => {
    expect(matches(sources, /\bnew\s+FsWorkSceneRegistry\s*\(/gu)).toEqual([]);
    const worksceneIndex = await readFile(
      path.join(packagesRoot, "core/src/workscene/index.ts"),
      "utf8",
    );
    expect(worksceneIndex).not.toMatch(/\bFsWorkSceneRegistry\b/u);
    expect(worksceneIndex).not.toMatch(/\bWorksceneActivityProjection\b/u);
  });
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
        if (entry.name !== "__tests__") await visit(absolute);
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

function matches(
  sources: ReadonlyMap<string, string>,
  pattern: RegExp,
): string[] {
  const result: string[] = [];
  for (const [file, source] of sources) {
    pattern.lastIndex = 0;
    if (pattern.test(source)) result.push(file);
  }
  return result.sort();
}
