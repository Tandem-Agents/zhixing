import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureBuiltinRegistryDescriptor } from "../packages/server/src/rpc/methods/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "packages/server/src/__tests__/__goldens__/canonical-registry.golden.json");

export function captureCanonicalRegistryGolden() {
  const hosted = captureBuiltinRegistryDescriptor();
  return {
    version: 1,
    roleConfigurations: {
      "anchor-executor": hosted,
      "anchor-surface": hosted,
      "executor-only": [],
    },
    retiredMethods: ["workspace.binding.admin", "workspace.binding.reset"],
  };
}

const expected = `${JSON.stringify(captureCanonicalRegistryGolden(), null, 2)}\n`;
if (process.argv.includes("--write")) {
  await writeFile(target, expected, "utf8");
} else if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== expected) {
    console.error("Canonical server registry golden is stale; run pnpm s7:registry-golden:write");
    process.exitCode = 1;
  }
} else {
  throw new Error("Expected --write or --check");
}
