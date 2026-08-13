import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = rootPackage.version;
if (typeof version !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(version)) {
  throw new Error("root package.json.version must be canonical SemVer");
}

const packageFiles = await collectPackageFiles(join(root, "packages"));
const mismatches = [];
for (const file of packageFiles) {
  const value = JSON.parse(await readFile(file, "utf8"));
  if (value.version !== version) mismatches.push(`${file}: ${String(value.version)}`);
}

const generatedPath = join(root, "packages", "cli", "src", "generated", "release-version.ts");
const generated = `export const ZHIXING_RELEASE_VERSION = ${JSON.stringify(version)};\n`;
if (process.argv.includes("--write")) {
  if (mismatches.length > 0) {
    throw new Error(`workspace package versions must be changed from the root version source:\n${mismatches.join("\n")}`);
  }
  await writeFile(generatedPath, generated, "utf8");
} else {
  const current = await readFile(generatedPath, "utf8");
  if (mismatches.length > 0 || current !== generated) {
    throw new Error(`release version projections are stale; run pnpm release:version:sync\n${mismatches.join("\n")}`);
  }
}

async function collectPackageFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectPackageFiles(path));
    else if (entry.isFile() && entry.name === "package.json") result.push(path);
  }
  return result.sort();
}
