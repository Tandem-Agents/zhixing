import { spawn } from "node:child_process";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "../..");
const sourceEntry = pathToFileURL(path.join(packageRoot, "src", "index.ts")).href;

describe("Glob and Grep brace expansion safety", () => {
  it.each(["glob", "grep"] as const)(
    "%s completes the production brace expansion adversarial case within its resource boundary",
    async (mode) => {
      const result = await runConstrainedTool(mode);

      expect(result.timedOut).toBe(false);
      expect(result.signal).toBeNull();
      expect(result.code, result.stderr).toBe(0);
    },
    20_000,
  );
});

function runConstrainedTool(mode: "glob" | "grep"): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly timedOut: boolean;
}> {
  const script = [
    `const { createGlobTool, createGrepTool } = await import(${JSON.stringify(sourceEntry)});`,
    'const part = "{" + "0".repeat(50) + "1..100000}";',
    'const bracePattern = "{" + Array(400).fill(part).join(",") + "}";',
    "const context = { workingDirectory: process.cwd() };",
    "const mode = process.argv[1];",
    'const result = mode === "glob"',
    "  ? await createGlobTool().call({ pattern: bracePattern }, context)",
    '  : await createGrepTool().call({ pattern: "release-p07-no-match", glob: bracePattern }, context);',
    "if (result.isError) throw new Error(result.content);",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=64",
        "--import=tsx/esm",
        "--input-type=module",
        "--eval",
        script,
        "--",
        mode,
      ],
      {
        cwd: packageRoot,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    let timedOut = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 15_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr, timedOut });
    });
  });
}
