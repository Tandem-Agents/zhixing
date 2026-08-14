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

export const RELEASE_SMOKE_SCENARIO_CONTRACTS = Object.freeze([
  ["clean-install", "installer install", "signed candidate becomes the exact current program", "src/update/update-controller.test.ts", "installs, exactly replays and preserves a program-root-external anti-downgrade receipt"],
  ["first-run", "launcher --version", "the exact candidate runtime starts the exact candidate application", "src/serve/__tests__/distributed-runtime-golden.test.ts", "matches registration and cleanup order"],
  ["same-version-replay", "installer install", "the exact installed identity is unchanged", "src/update/update-controller.test.ts", "installs, exactly replays and preserves a program-root-external anti-downgrade receipt"],
  ["no-update-silent", "zz update", "the verified current release remains usable without a newer release", "src/update/runtime.test.ts", "never waits for the network and coalesces failures inside the controller"],
  ["automatic-update", "managed update schedule", "a newer signed release is downloaded and handed to the current host", "src/update/runtime.test.ts", "runs a bounded managed schedule without creating a daemon"],
  ["visible-update-status", "server.update.status", "the current authority projects one stable user-visible state", "src/update/update-controller.test.ts", "reads public update status from the verified current program facts"],
  ["safe-point-install", "server.update.prepare", "accepted work is settled before the pointer changes", "src/update/upgrade-lifecycle.test.ts", "settles exact accepted work before switching and verifies the target on a successor"],
  ["automatic-restore", "upgrade successor health", "an unhealthy candidate restores the verified previous release", "src/update/upgrade-lifecycle.test.ts", "settles exact accepted work before switching and verifies the target on a successor"],
  ["guided-restore", "zz update --restore-previous", "the user receives one stable recovery action", "src/update/doctor.test.ts", "uses the shared update projection and exposes one stable action without raw errors"],
  ["offline-doctor", "zz doctor", "offline inspection is effect-free and produces one next action", "src/update/doctor.test.ts", "reports an incomplete installation without touching managed or checkpoint state"],
  ["app-remove-preserves-data", "zz app remove", "only the program root is handed to the installer after safe stop", "src/update/app-remove.test.ts", "stops safely and only hands the program root to the installer"],
  ["permanent-device-remove-confirms", "zz device remove --permanent", "non-interactive removal requires explicit irreversible confirmation", "src/runtime/device-removal-command.test.ts", "uses the unique display name and keeps internal device identities out of the command"],
].map(([id, entry, terminal, testFile, testName]) => Object.freeze({ id, entry, terminal, testFile, testName })));

export const RELEASE_SMOKE_SCENARIOS = Object.freeze(
  RELEASE_SMOKE_SCENARIO_CONTRACTS.map((contract) => contract.id),
);

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
  const followPointer = entry === "app/dist/index.js";
  return `import { spawn } from "node:child_process";\nimport { readFile } from "node:fs/promises";\nimport { resolve } from "node:path";\nconst root=resolve(import.meta.dirname,"..");\nconst readPointer=async()=>{const value=JSON.parse(await readFile(resolve(root,"current.json"),"utf8"));const directory=value?.current?.directory;const generation=value?.generation;if(typeof directory!=="string"||!/^[0-9A-Za-z._-]+$/u.test(directory)||!Number.isSafeInteger(generation)||generation<1)throw new Error("Installed program pointer is invalid");return{directory,generation};};\nlet pointer=await readPointer();\nwhile(true){const versionRoot=resolve(root,"versions",pointer.directory,"program");const child=spawn(resolve(versionRoot,"runtime",${JSON.stringify(runtime)}),[resolve(versionRoot,${entryParts}),...process.argv.slice(2)],{stdio:"inherit",windowsHide:true});const result=await new Promise((resolveResult,reject)=>{child.once("error",reject);child.once("exit",(code,signal)=>resolveResult({code,signal}));});${followPointer ? "const next=await readPointer();if(next.generation!==pointer.generation){pointer=next;continue;}" : ""}if(result.signal){try{process.kill(process.pid,result.signal);}catch{process.exitCode=1;}}else{process.exitCode=result.code??1;}break;}\n`;
}

export function assertCanonicalTargetSmokeReport(input, expected) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new Error("target smoke report must be a plain object");
  }
  const fields = ["arch", "artifactDigest", "candidateExecutionDigest", "manifestDigest", "packageGraphDigest", "platform", "producerVersion", "scenarios", "sourceTreeDigest", "target", "v"];
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(fields.sort())) {
    throw new Error("target smoke report has unknown or missing fields");
  }
  if (input.v !== 2 || input.producerVersion !== 1 || input.target !== expected.target ||
      input.platform !== expected.platform || input.arch !== expected.arch ||
      input.manifestDigest !== expected.manifestDigest || input.artifactDigest !== expected.artifactDigest ||
      input.sourceTreeDigest !== expected.sourceTreeDigest || input.packageGraphDigest !== expected.packageGraphDigest ||
      typeof input.candidateExecutionDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input.candidateExecutionDigest) ||
      !Array.isArray(input.scenarios)) {
    throw new Error("target smoke report identity is invalid");
  }
  const rows = new Map(input.scenarios.map((row) => [row?.id, row]));
  if (rows.size !== RELEASE_SMOKE_SCENARIO_CONTRACTS.length) {
    throw new Error("target smoke report scenario set is incomplete");
  }
  for (const contract of RELEASE_SMOKE_SCENARIO_CONTRACTS) {
    const row = rows.get(contract.id);
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(["candidateExecutionDigest", "commandDigest", "id", "resultDigest", "tests"].sort()) ||
        row.commandDigest !== digest(Buffer.from(canonicalize(contract), "utf8")) ||
        row.candidateExecutionDigest !== input.candidateExecutionDigest ||
        typeof row.resultDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(row.resultDigest) ||
        !Number.isSafeInteger(row.tests) || row.tests < 1) {
      throw new Error(`target smoke report row ${contract.id} is invalid`);
    }
  }
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
  for (const name of [
    "scripts/release-tooling.mjs",
    "scripts/release-target-evidence.mjs",
    "scripts/release-check.mjs",
    "research/design/modules/distributed-runtime/release-and-maintenance-guide.md",
    "research/design/modules/distributed-runtime/unit-38-final-acceptance-ledger.json",
  ]) {
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
