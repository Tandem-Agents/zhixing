import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createGrepSearchPlan,
  executeGrepSearch,
  formatGrepSearchError,
  formatGrepToolResult,
  isRipgrepAvailable,
  nodeGrepSearchExecutor,
  ripgrepSearchExecutor,
  type GrepQuery,
  type GrepSearchExecution,
  type GrepSearchExecutor,
  type GrepSearchResult,
} from "../grep/core.js";

describe("grep search executors", () => {
  it("normalizes CRLF lines and context in the Node executor", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(workspace, "src/app.txt", "before\r\nfoo\r\nafter\r\n");

      const result = await expectOk(
        await executeWithNode(baseQuery(workspace, {
          contextLines: 1,
          pattern: "foo$",
        })),
      );

      expect(result.files).toHaveLength(1);
      expect(result.files[0]?.matches[0]).toMatchObject({
        line: 2,
        text: { text: "foo", truncated: false },
        contextBefore: [{ line: 1, text: { text: "before", truncated: false } }],
        contextAfter: [{ line: 3, text: { text: "after", truncated: false } }],
      });
    });
  });

  it("decodes UTF-16 BOM files in the Node executor", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(
        workspace,
        "utf16.txt",
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from("alpha\r\nfoo\r\nomega", "utf16le"),
        ]),
      );

      const result = await expectOk(
        await executeWithNode(baseQuery(workspace, { pattern: "foo" })),
      );

      expect(result.matchedLineCount).toBe(1);
      expect(result.files[0]?.matches[0]?.text).toEqual({
        text: "foo",
        truncated: false,
      });
    });
  });

  it("sorts files by displayPath and applies collection-time match budgets", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(workspace, "b.txt", "foo\n");
      await writeFile(workspace, "a.txt", "foo\n");

      const sorted = await expectOk(
        await executeWithNode(baseQuery(workspace, { pattern: "foo" })),
      );
      expect(sorted.files.map((file) => file.displayPath)).toEqual([
        "a.txt",
        "b.txt",
      ]);

      const truncated = await expectOk(
        await executeWithNode(baseQuery(workspace, {
          maxMatchedLines: 1,
          pattern: "foo",
        })),
      );
      expect(truncated.matchedLineCount).toBe(1);
      expect(truncated.truncated).toBe(true);

      const tooSmall = await expectOk(
        await executeWithNode(baseQuery(workspace, {
          maxResultChars: 1,
          pattern: "foo",
        })),
      );
      expect(tooSmall.files).toEqual([]);
      expect(tooSmall.truncated).toBe(true);
    });
  });

  it("formats content, files, count, line truncation, and errors in one core formatter", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(workspace, "src/app.txt", `foo-${"x".repeat(20)}\n`);

      const content = await expectOk(
        await executeWithNode(baseQuery(workspace, {
          maxLineChars: 8,
          pattern: "foo",
        })),
      );
      expect(formatGrepToolResult(content).content).toContain(
        "[line truncated:",
      );

      const files = await expectOk(
        await executeWithNode(baseQuery(workspace, {
          outputMode: "files",
          pattern: "foo",
        })),
      );
      expect(formatGrepToolResult(files).content).toContain("src/app.txt");

      const count = await expectOk(
        await executeWithNode(baseQuery(workspace, {
          outputMode: "count",
          pattern: "foo",
        })),
      );
      expect(formatGrepToolResult(count).content).toContain("src/app.txt:1");

      expect(formatGrepSearchError({
        code: "invalid-query",
        message: "bad query",
      })).toEqual({ content: "bad query", isError: true });
    });
  });

  it("falls back to Node when ripgrep cannot satisfy the scan budget", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(workspace, "src/app.txt", "foo\n");

      const result = await expectOk(
        await executeGrepSearch(baseQuery(workspace, {
          maxScannedFiles: 100,
          pattern: "foo",
        })),
      );

      expect(result.diagnostics.executor).toBe("node");
    });
  });

  it("treats glob as a directory traversal filter, not an explicit file veto", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(workspace, "src/app.txt", "foo\n");

      const query = baseQuery(workspace, {
        glob: "*.md",
        pattern: "foo",
        searchPath: "src/app.txt",
      });
      const node = await expectOk(await executeWithNode(query));
      expect(node.matchedLineCount).toBe(1);

      if (await isRipgrepAvailable()) {
        const ripgrep = await expectOk(await executeWithRipgrep(query));
        expect(projectResult(ripgrep)).toEqual(projectResult(node));
      }
    });
  });

  it("reports abort and timeout distinctly", async () => {
    await withWorkspace(async (workspace) => {
      await writeFile(workspace, "src/app.txt", "foo\n");

      const controller = new AbortController();
      controller.abort();
      const aborted = await executeWithNode(
        baseQuery(workspace, { pattern: "foo" }),
        controller.signal,
      );
      expect(aborted).toMatchObject({
        ok: false,
        error: { code: "aborted" },
      });

      const timedOut = await executeWithNode(baseQuery(workspace, {
        pattern: "foo",
        timeoutMs: 0,
      }));
      expect(timedOut).toMatchObject({
        ok: false,
        error: { code: "timeout" },
      });
    });
  });

  it("keeps ripgrep aligned with Node on the portable contract when ripgrep is available", async () => {
    if (!(await isRipgrepAvailable())) return;

    await withWorkspace(async (workspace) => {
      await writeFile(workspace, "src/b.txt", "before\r\nfoo\r\nafter\r\n");
      await writeFile(workspace, "src/a.txt", "foobar\nfoo\n");

      const query = baseQuery(workspace, {
        contextLines: 1,
        glob: "src/*.txt",
        pattern: "\\bfoo\\b",
      });
      const node = await expectOk(await executeWithNode(query));
      const ripgrep = await expectOk(await executeWithRipgrep(query));

      expect(projectResult(ripgrep)).toEqual(projectResult(node));
      expect(ripgrep.diagnostics.executor).toBe("ripgrep");
      expect(ripgrep.diagnostics.scannedFileCount).toBeGreaterThanOrEqual(2);
    });
  });

  it("keeps ripgrep aligned with Node for isolated CR logical lines", async () => {
    if (!(await isRipgrepAvailable())) return;

    await withWorkspace(async (workspace) => {
      await writeFile(workspace, "cr.txt", "foo\rother");

      const query = baseQuery(workspace, {
        pattern: "^other$",
      });
      const node = await expectOk(await executeWithNode(query));
      const ripgrep = await expectOk(await executeWithRipgrep(query));

      expect(projectResult(ripgrep)).toEqual(projectResult(node));
      expect(ripgrep.files[0]?.matches[0]).toMatchObject({
        line: 2,
        text: { text: "other", truncated: false },
      });
    });
  });
});

function baseQuery(
  workspace: string,
  overrides: Partial<GrepQuery> = {},
): GrepQuery {
  return {
    workingDirectory: workspace,
    pattern: "foo",
    searchPath: ".",
    outputMode: "content",
    regexDialect: "line-regexp",
    caseSensitivity: "sensitive",
    contextLines: 0,
    maxResultChars: 10_000,
    maxLineChars: 120,
    ...overrides,
  };
}

async function executeWithNode(
  query: GrepQuery,
  abortSignal?: AbortSignal,
): Promise<GrepSearchExecution> {
  return executeWithExecutor(nodeGrepSearchExecutor, query, abortSignal);
}

async function executeWithRipgrep(
  query: GrepQuery,
): Promise<GrepSearchExecution> {
  return executeWithExecutor(ripgrepSearchExecutor, query);
}

async function executeWithExecutor(
  executor: GrepSearchExecutor,
  query: GrepQuery,
  abortSignal?: AbortSignal,
): Promise<GrepSearchExecution> {
  const plan = await createGrepSearchPlan(query);
  if (!plan.ok) return { ok: false, error: plan.error };
  return executor.search(plan.plan, { abortSignal });
}

async function expectOk(
  execution: GrepSearchExecution,
): Promise<GrepSearchResult> {
  expect(execution.ok).toBe(true);
  if (!execution.ok) throw new Error(execution.error.message);
  return execution.result;
}

function projectResult(result: GrepSearchResult) {
  return {
    files: result.files.map((file) => ({
      displayPath: file.displayPath,
      matches: file.matches.map((match) => ({
        line: match.line,
        text: match.text,
        contextBefore: match.contextBefore,
        contextAfter: match.contextAfter,
      })),
    })),
    matchedFileCount: result.matchedFileCount,
    matchedLineCount: result.matchedLineCount,
    truncated: result.truncated,
  };
}

async function withWorkspace(
  callback: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-grep-"));
  try {
    await callback(workspace);
  } finally {
    await fs.rm(workspace, { force: true, recursive: true });
  }
}

async function writeFile(
  workspace: string,
  relativePath: string,
  content: string | Buffer,
): Promise<void> {
  const filePath = path.join(workspace, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}
