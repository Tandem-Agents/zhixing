import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const update = process.argv.includes("--update");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const pnpmEntry = process.env.npm_execpath;
const command = pnpmEntry ? process.execPath : pnpm;
const environment = update
  ? { ...process.env, ZHIXING_UPDATE_GOLDENS: "1" }
  : process.env;

const commands = [
  ["--filter", "@zhixing/test-utils", "build"],
  ["--filter", "@zhixing/owner-kernel", "build"],
  ["--filter", "@zhixing/rpc", "build"],
  ["--filter", "@zhixing/server", "build"],
  ["runtime:package-exports"],
  ["--filter", "@zhixing/server", "exec", "vitest", "run", "src/__tests__/distributed-runtime-golden.test.ts"],
  ["--filter", "@zhixing/cli", "exec", "vitest", "run", "src/serve/__tests__/distributed-runtime-golden.test.ts"],
  ["--filter", "@zhixing/server", "exec", "vitest", "run", "src/__tests__/distributed-runtime-structure.test.ts"],
];

const fixtures = [
  "packages/server/src/__tests__/__goldens__/distributed-runtime-behavior.golden.json",
  "packages/cli/src/serve/__tests__/__goldens__/runtime-lifecycle.golden.json",
  "packages/server/src/__tests__/__goldens__/distributed-runtime-structure.golden.json",
].map((file) => resolve(process.cwd(), file));
const snapshots = update
  ? new Map(
      await Promise.all(
        fixtures.map(async (file) => {
          try {
            return [file, await readFile(file)];
          } catch (error) {
            if (error.code === "ENOENT") return [file, null];
            throw error;
          }
        }),
      ),
    )
  : new Map();

let failure;

for (const args of commands) {
  const result = spawnSync(command, pnpmEntry ? [pnpmEntry, ...args] : args, {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    failure = result.error ?? result.status ?? 1;
    break;
  }
}

if (failure !== undefined) {
  await Promise.all(
    [...snapshots].map(([file, content]) =>
      content === null ? rm(file, { force: true }) : writeFile(file, content),
    ),
  );
  if (failure instanceof Error) throw failure;
  process.exit(failure);
}
