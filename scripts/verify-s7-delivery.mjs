import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const temporary = await mkdtemp(path.join(os.tmpdir(), "zhixing-s7-verify-"));
const baselineCapture = path.join(temporary, "baseline.json");
const currentCapture = path.join(temporary, "current.json");
try {
  const baselineRevision = await output("git", ["-C", args.baseline, "rev-parse", "HEAD"]);
  const currentRevision = await output("git", ["-C", args.current, "rev-parse", "HEAD"]);
  if (baselineRevision !== "d9283db480b48dd009947750e14698a31295594f") {
    throw new Error("S1 worktree is not at the frozen baseline revision");
  }
  await run("pnpm", ["build"], args.baseline);
  await run("pnpm", ["build"], args.current);
  await capture(args.current, args.baseline, args.baselineAdapter, baselineCapture, baselineRevision);
  await capture(args.current, args.current, args.currentAdapter, currentCapture, currentRevision);
  await run("pnpm", ["s7:registry-golden"], args.current);
  await run("pnpm", [
    "--filter", "@zhixing/core", "exec", "vitest", "run",
    "src/contracts/workspace-binding-contract-drift.test.ts",
    "src/environment/workspace-bindings.test.ts",
    "src/environment/workspace-binding-catalog.test.ts",
    "src/environment/workspace-probe.test.ts",
    "src/workscene/global-state-adapter.test.ts",
  ], args.current);
  await run("pnpm", [
    "--filter", "@zhixing/owner-kernel", "exec", "vitest", "run",
    "src/__tests__/control-admission.test.ts",
  ], args.current);
  await run("pnpm", [
    "--filter", "@zhixing/cli", "exec", "vitest", "run",
    "src/serve/__tests__/workscene-legacy-migration.test.ts",
    "src/serve/s7-durable-contract-ledger.test.ts",
    "src/serve/s7-environment-conformance.test.ts",
    "src/serve/s7-performance-gate.test.ts",
  ], args.current);
  await run("pnpm", [
    "--filter", "@zhixing/server", "exec", "vitest", "run",
    "src/__tests__/distributed-runtime-golden.test.ts",
  ], args.current);
  await run(process.execPath, ["--import=tsx/esm", path.join(args.current, "scripts/compare-s7-terminal-performance.mjs"), baselineCapture, currentCapture], args.current);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function capture(current, target, adapter, outputPath, revision) {
  return run(process.execPath, [
    path.join(current, "scripts/capture-s7-terminal-performance.mjs"),
    "--target", target,
    "--adapter", adapter,
    "--output", outputPath,
    "--revision", revision,
  ], current);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("S7 verification arguments are incomplete");
    result[key.slice(2)] = path.resolve(value);
  }
  for (const key of ["baseline", "current", "baselineAdapter", "currentAdapter"]) {
    if (!result[key]) throw new Error(`Missing --${key}`);
  }
  return result;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true, shell: process.platform === "win32" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`)));
  });
}

async function output(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    let value = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { value += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(value.trim()) : reject(new Error(`${command} failed (${code})`)));
  });
}
