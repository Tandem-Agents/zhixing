import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export const RELEASE_TARGETS = Object.freeze([
  "win32-x64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
]);

export const RELEASE_SMOKE_SCENARIOS = Object.freeze([
  "clean-install",
  "first-run",
  "same-version-replay",
  "no-update-silent",
  "automatic-update",
  "visible-update-status",
  "safe-point-install",
  "automatic-restore",
  "guided-restore",
  "offline-doctor",
  "app-remove-preserves-data",
  "permanent-device-remove-confirms",
]);

export const RELEASE_ACCEPTANCE_IDS = Object.freeze([
  ...Array.from({ length: 18 }, (_, index) => `invariant-${String(index + 1).padStart(2, "0")}`),
  "fault-executor-crash",
  "fault-owner-crash",
  "fault-cancel-race",
  "fault-path-partition",
  "fault-transfer-interruption",
  "fault-storage",
  "fault-revocation",
  "fault-retry",
  "fault-version-clock",
  "fault-update",
  "security-pairing",
  "security-certificate-ticket",
  "security-permission-snapshot",
  "security-revocation",
  "security-blind-relay",
  "security-confirmation",
  "security-authority",
  "security-resource",
  "topology-single-machine",
  "topology-paired-devices",
  "journey-first-run",
  "journey-pair-ready",
  "journey-daily-local",
  "journey-offline",
  "journey-uncertain",
  "journey-transfer-recovery",
  "journey-stop-remove",
  "journey-auto-update",
  "journey-update-recovery",
  "journey-app-remove",
  "journey-offline-doctor",
  "journey-release-matrix",
]);

export function assertExactStringSet(input, expected, label) {
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  const actual = [...input].sort();
  const fields = [...expected].sort();
  if (
    new Set(actual).size !== actual.length ||
    actual.length !== fields.length ||
    actual.some((value, index) => value !== fields[index])
  ) {
    throw new Error(`${label} is not the canonical exact-set`);
  }
  return input;
}

export function assertReleaseNodeVersion(value) {
  if (typeof value !== "string" || !/^22\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error("stable release artifacts must embed an exact Node 22 version");
  }
  return value;
}

export function stableProgramLoaderSource(target, entry) {
  if (!RELEASE_TARGETS.includes(target)) throw new Error("program loader target is outside the stable exact-set");
  if (entry !== "app/dist/index.js" && entry !== "app/dist/program-installer.js") {
    throw new Error("program loader entry is outside the stable exact-set");
  }
  const runtime = target === "win32-x64" ? "node.exe" : "node";
  const entryParts = entry.split("/").map((part) => JSON.stringify(part)).join(",");
  return `import { spawn } from "node:child_process";\nimport { readFile } from "node:fs/promises";\nimport { resolve } from "node:path";\nconst root=resolve(import.meta.dirname,"..");\nconst value=JSON.parse(await readFile(resolve(root,"current.json"),"utf8"));\nconst directory=value?.current?.directory;\nif(typeof directory!=="string"||!/^[0-9A-Za-z._-]+$/u.test(directory))throw new Error("Installed program pointer is invalid");\nconst versionRoot=resolve(root,"versions",directory,"program");\nconst child=spawn(resolve(versionRoot,"runtime",${JSON.stringify(runtime)}),[resolve(versionRoot,${entryParts}),...process.argv.slice(2)],{stdio:"inherit",windowsHide:true});\nconst result=await new Promise((resolveResult,reject)=>{child.once("error",reject);child.once("exit",(code,signal)=>resolveResult({code,signal}));});\nif(result.signal){try{process.kill(process.pid,result.signal);}catch{process.exitCode=1;}}else{process.exitCode=result.code??1;}\n`;
}

export function assertExactBooleanMatrix(input, expected, label) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  const actual = Object.keys(input).sort();
  const fields = [...expected].sort();
  if (actual.length !== fields.length || actual.some((field, index) => field !== fields[index])) {
    throw new Error(`${label} is incomplete or has unknown rows`);
  }
  if (fields.some((field) => input[field] !== true)) throw new Error(`${label} has a failed row`);
  return input;
}

export async function collectProgramFiles(programRoot) {
  const root = resolve(programRoot);
  const files = [];
  await walk(root, async (path, entry) => {
    if (entry.isSymbolicLink()) throw new Error(`release package cannot contain symlinks: ${path}`);
    if (!entry.isFile()) return;
    const name = relative(root, path).split(sep).join("/");
    if (name.endsWith(".map") || /(^|\/)(__tests__|test|tests)(\/|$)/u.test(name) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(name)) {
      throw new Error(`release package contains a development asset: ${name}`);
    }
    if (/(^|\/)(?:\.env|credentials\.json)(?:$|\.)/u.test(name)) throw new Error(`release package contains a secret-bearing path: ${name}`);
    const bytes = await readFile(path);
    files.push(Object.freeze({
      path: name,
      mode: process.platform === "win32" ? 0o755 : ((await lstat(path)).mode & 0o111 ? 0o755 : 0o644),
      digest: digest(bytes),
      bytes: bytes.byteLength,
      data: bytes.toString("base64url"),
    }));
  });
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) throw new Error("release program directory is empty");
  return Object.freeze(files);
}

export function programTreeDigest(files) {
  return digest(Buffer.from(canonicalize(files.map(({ path, mode, digest, bytes }) => ({ path, mode, digest, bytes }))), "utf8"));
}

export function assertProgramTreeContract(files, target) {
  if (!RELEASE_TARGETS.includes(target)) throw new Error("program tree target is outside the stable exact-set");
  const names = new Set(files.map((file) => file.path));
  const runtime = target === "win32-x64" ? "runtime/node.exe" : "runtime/node";
  const launcher = target === "win32-x64" ? "bin/zz.cmd" : "bin/zz";
  const alias = target === "win32-x64" ? "bin/zhixing.cmd" : "bin/zhixing";
  for (const required of [
    runtime,
    launcher,
    alias,
    "installer/launch.js",
    "installer/program-installer.js",
    "app/package.json",
    "app/dist/index.js",
    "app/dist/program-installer.js",
    "program-tree-receipt.json",
  ]) {
    if (!names.has(required)) throw new Error(`program tree is missing ${required}`);
  }
  const allowedRoots = new Set(["app", "bin", "installer", "runtime"]);
  for (const file of files) {
    const [root] = file.path.split("/");
    if (file.path !== "program-tree-receipt.json" && !allowedRoots.has(root)) {
      throw new Error(`program tree contains an unmanaged root: ${file.path}`);
    }
  }
  return files;
}

export async function fingerprintSourceTree(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const rows = [];
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json"]) {
    const bytes = await readFile(resolve(root, name));
    rows.push({ path: name, digest: digest(bytes), bytes: bytes.byteLength });
  }
  for (const packageEntry of await readdir(resolve(root, "packages"), { withFileTypes: true })) {
    if (!packageEntry.isDirectory()) continue;
    await collectBuildInputs(root, resolve(root, "packages", packageEntry.name), rows);
  }
  rows.sort((left, right) => left.path.localeCompare(right.path));
  return digest(Buffer.from(canonicalize(rows), "utf8"));
}

export async function fingerprintPackageGraph(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const rows = [];
  await walk(resolve(root, "packages"), async (path, entry) => {
    if (entry.isSymbolicLink()) throw new Error(`package graph cannot contain symlinks: ${path}`);
    if (entry.isFile() && path.endsWith(`${sep}package.json`)) {
      const bytes = await readFile(path);
      rows.push({ path: relative(root, path).split(sep).join("/"), digest: digest(bytes), bytes: bytes.byteLength });
    }
  });
  for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    const bytes = await readFile(resolve(root, name));
    rows.push({ path: name, digest: digest(bytes), bytes: bytes.byteLength });
  }
  rows.sort((left, right) => left.path.localeCompare(right.path));
  return digest(Buffer.from(canonicalize(rows), "utf8"));
}

export function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new TypeError("canonical JSON rejects this value");
}

export function digest(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

async function collectBuildInputs(root, packageRoot, rows) {
  await walk(packageRoot, async (path, entry) => {
    if (entry.isSymbolicLink()) throw new Error(`source tree cannot contain symlinks: ${path}`);
    if (!entry.isFile()) return;
    const name = relative(root, path).split(sep).join("/");
    if (!/(?:^|\/)(?:src\/.*\.[cm]?[jt]sx?|package\.json|tsconfig\.json|tsup\.config\.ts)$/u.test(name)) return;
    if (/(?:^|\/)(__tests__|test|tests)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(name)) return;
    const bytes = await readFile(path);
    rows.push({ path: name, digest: digest(bytes), bytes: bytes.byteLength });
  });
}

async function walk(root, visit) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    await visit(path, entry);
    if (entry.isDirectory()) await walk(path, visit);
  }
}
