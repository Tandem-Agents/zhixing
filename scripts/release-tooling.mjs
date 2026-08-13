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

export function assertReleaseNodeVersion(value) {
  if (typeof value !== "string" || !/^22\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new Error("stable release artifacts must embed an exact Node 22 version");
  }
  return value;
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
