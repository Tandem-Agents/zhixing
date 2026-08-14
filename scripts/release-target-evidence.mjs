import { createPublicKey, verify } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  byteDigest,
  canonicalize,
  compareReleaseSemver,
  decodeAndValidateReleaseManifest,
  decodeProgramArtifact,
  protocolBytes,
} from "../packages/core/dist/protocol/index.js";
import {
  RELEASE_SMOKE_SCENARIO_CONTRACTS,
  assertCanonicalTargetSmokeReport,
  assertProgramTreeContract,
  digest,
  fingerprintPackageGraph,
  fingerprintSourceTree,
} from "./release-tooling.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const COMMAND_TIMEOUT_MS = 120_000;
const HOST_READY_TIMEOUT_MS = 120_000;
const evidenceRoot = resolve(required("--evidence"));
const target = localTarget();
const requestedTarget = optional("--target");
if (requestedTarget && requestedTarget !== target) {
  throw new Error("target evidence must run on its exact OS and architecture");
}
const targetRoot = resolve(evidenceRoot, "targets", target);
const trust = exact(await json(resolve(evidenceRoot, "release-trust.json")), ["keyId", "publicKeySpki"]);
const publicKey = createPublicKey({
  key: Buffer.from(text(trust.publicKeySpki), "base64url"),
  format: "der",
  type: "spki",
});
const verifier = {
  verify(schemaId, version, payload, signature) {
    if (signature.alg !== "ed25519" || signature.keyId !== trust.keyId ||
        !verify(null, protocolBytes(schemaId, version, payload), publicKey, Buffer.from(signature.sig, "base64url"))) {
      throw new Error("release signature verification failed");
    }
  },
};

const candidate = await loadSignedProgram("candidate", {
  manifestFile: resolve(targetRoot, "release-manifest.json"),
  artifactFile: resolve(targetRoot, "program-artifact.json"),
});
const baseline = await loadSignedProgram("baseline", {
  manifestFile: resolve(targetRoot, "baseline-release-manifest.json"),
  artifactFile: resolve(targetRoot, "baseline-program-artifact.json"),
});
if (
  compareReleaseSemver(baseline.manifest.releaseVersion, candidate.manifest.releaseVersion) >= 0 ||
  BigInt(baseline.manifest.releaseSequence) >= BigInt(candidate.manifest.releaseSequence)
) {
  throw new Error("target evidence baseline must be strictly older than the candidate");
}

const sourceTreeDigest = await fingerprintSourceTree(repositoryRoot);
const packageGraphDigest = await fingerprintPackageGraph(repositoryRoot);
const execution = await executeCandidateAndScenarios({ candidate, baseline });
await assertInputsUnchanged({ candidate, baseline, sourceTreeDigest, packageGraphDigest });
const report = assertCanonicalTargetSmokeReport({
  v: 3,
  producerVersion: 2,
  target,
  platform: process.platform,
  arch: process.arch,
  manifestDigest: candidate.manifestDigest,
  artifactDigest: candidate.artifactDigest,
  baselineManifestDigest: baseline.manifestDigest,
  baselineArtifactDigest: baseline.artifactDigest,
  sourceTreeDigest,
  packageGraphDigest,
  candidateExecutionDigest: execution.candidateExecutionDigest,
  scenarios: execution.scenarios,
}, {
  target,
  platform: process.platform,
  arch: process.arch,
  manifestDigest: candidate.manifestDigest,
  artifactDigest: candidate.artifactDigest,
  baselineManifestDigest: baseline.manifestDigest,
  baselineArtifactDigest: baseline.artifactDigest,
  sourceTreeDigest,
  packageGraphDigest,
});
await atomicFile(resolve(targetRoot, "smoke-report.json"), Buffer.from(`${canonicalize(report)}\n`, "utf8"));

async function loadSignedProgram(label, files) {
  const manifestBytes = await readFile(files.manifestFile);
  const manifest = decodeAndValidateReleaseManifest(manifestBytes, verifier);
  if (manifest.target !== target) throw new Error(`${label} manifest target does not match this machine`);
  const artifactBytes = await readFile(files.artifactFile);
  if (artifactBytes.byteLength !== manifest.artifact.bytes || byteDigest(artifactBytes) !== manifest.artifact.digest) {
    throw new Error(`${label} artifact bytes do not match the signed manifest`);
  }
  const artifact = decodeProgramArtifact(artifactBytes);
  if (artifact.target !== target || artifact.releaseVersion !== manifest.releaseVersion) {
    throw new Error(`${label} artifact identity does not match the signed manifest`);
  }
  assertProgramTreeContract(artifact.files, target);
  return Object.freeze({
    manifest,
    manifestBytes,
    manifestDigest: byteDigest(manifestBytes),
    manifestFile: files.manifestFile,
    artifact,
    artifactBytes,
    artifactDigest: byteDigest(artifactBytes),
    artifactFile: files.artifactFile,
  });
}

async function executeCandidateAndScenarios(input) {
  const scratch = await mkdtemp(join(tmpdir(), "zhixing-target-evidence-"));
  try {
    const candidateRoot = resolve(scratch, "candidate");
    await materializeProgram(candidateRoot, input.candidate.artifact);
    const candidateRuntime = resolve(candidateRoot, "runtime", target === "win32-x64" ? "node.exe" : "node");
    const candidateApp = resolve(candidateRoot, "app", "dist", "index.js");
    const candidateInstaller = resolve(candidateRoot, "app", "dist", "program-installer.js");
    const versionProbe = await runCommand({
      executable: candidateRuntime,
      args: [candidateApp, "--version"],
      environment: process.env,
      expectedStatus: 0,
    });
    if (versionProbe.stdout.trim() !== input.candidate.manifest.releaseVersion) {
      throw new Error("candidate version entry did not identify the signed release");
    }
    const scenarioRows = [];
    for (const contract of RELEASE_SMOKE_SCENARIO_CONTRACTS) {
      scenarioRows.push(await runScenario(contract, {
        scratch,
        candidateRoot,
        candidateRuntime,
        candidateApp,
        candidateInstaller,
        candidate: input.candidate,
        baseline: input.baseline,
      }));
    }
    const candidateExecutionDigest = digest(Buffer.from(canonicalize({
      versionProbe: stableCommandResult(versionProbe),
      scenarios: scenarioRows.map(({ id, executionDigest }) => ({ id, executionDigest })),
    }), "utf8"));
    return { candidateExecutionDigest, scenarios: scenarioRows };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function runScenario(contract, shared) {
  const root = resolve(shared.scratch, "scenarios", contract.id);
  const home = resolve(root, "home");
  const localAppData = resolve(root, "local-app-data");
  const stateHome = resolve(root, "state");
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ZHIXING_HOME: resolve(home, ".zhixing"),
    LOCALAPPDATA: localAppData,
    APPDATA: resolve(home, "app-data"),
    XDG_DATA_HOME: resolve(home, "data"),
    XDG_STATE_HOME: stateHome,
    XDG_CONFIG_HOME: resolve(home, "config"),
  };
  const programRoot = isolatedProgramRoot({ home, localAppData, stateHome });
  await Promise.all([mkdir(home, { recursive: true }), mkdir(resolve(programRoot, ".."), { recursive: true })]);
  const context = { ...shared, root, home, environment, programRoot, stateHome };
  let outcome;
  switch (contract.id) {
    case "clean-install": outcome = await cleanInstall(context); break;
    case "first-run": outcome = await firstRun(context); break;
    case "same-version-replay": outcome = await sameVersionReplay(context); break;
    case "no-update-silent": outcome = await noUpdateSilent(context); break;
    case "automatic-update": outcome = await upgradeJourney(context, "candidate-current-with-previous"); break;
    case "visible-update-status": outcome = await visibleUpdateStatus(context); break;
    case "safe-point-install": outcome = await upgradeJourney(context, "candidate-current-after-host-handoff"); break;
    case "automatic-restore": outcome = await automaticRestore(context); break;
    case "guided-restore": outcome = await guidedRestore(context); break;
    case "offline-doctor": outcome = await offlineDoctor(context); break;
    case "app-remove-preserves-data": outcome = await appRemove(context); break;
    case "permanent-device-remove-confirms": outcome = await permanentRemoveConfirmation(context); break;
    default: throw new Error(`target smoke scenario is not implemented: ${contract.id}`);
  }
  if (outcome.terminal.kind !== contract.terminalKind) {
    throw new Error(`target smoke ${contract.id} reached the wrong terminal`);
  }
  const expectedEntry = scenarioEntry(context, contract.entryKind);
  if (resolve(outcome.command.entry) !== resolve(expectedEntry)) {
    throw new Error(`target smoke ${contract.id} used the wrong candidate entry`);
  }
  const normalizedArgv = normalizeArgv(outcome.command.args.slice(1), context);
  if (canonicalize(normalizedArgv) !== canonicalize(contract.argvTemplate)) {
    throw new Error(`target smoke ${contract.id} used the wrong public argv`);
  }
  const entryDigest = digest(Buffer.from(canonicalize({
    runtimeDigest: byteDigest(await readFile(outcome.command.executable)),
    entryDigest: byteDigest(await readFile(outcome.command.entry)),
  }), "utf8"));
  const argvDigest = digest(Buffer.from(canonicalize(normalizedArgv), "utf8"));
  const terminalDigest = digest(Buffer.from(canonicalize(outcome.terminal), "utf8"));
  const resultDigest = digest(Buffer.from(canonicalize(outcome.result), "utf8"));
  const commandDigest = digest(Buffer.from(canonicalize({ contract, entryDigest, argvDigest }), "utf8"));
  return Object.freeze({
    id: contract.id,
    entryDigest,
    argvDigest,
    commandDigest,
    resultDigest,
    terminalDigest,
    executionDigest: digest(Buffer.from(canonicalize({ commandDigest, resultDigest, terminalDigest }), "utf8")),
  });
}

async function cleanInstall(context) {
  const command = candidateInstallCommand(context, context.candidate);
  const result = await runCommand({ ...command, environment: context.environment, expectedStatus: 0 });
  return { command, result: stableCommandResult(result), terminal: await currentTerminal(context, "candidate-current") };
}

async function firstRun(context) {
  await install(context, context.candidate);
  const command = stableLauncherCommand(context, ["--version"]);
  const result = await runCommand({ ...command, environment: context.environment, expectedStatus: 0 });
  if (result.stdout.trim() !== context.candidate.manifest.releaseVersion) throw new Error("candidate launcher version drifted");
  return {
    command,
    result: { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() },
    terminal: { kind: "candidate-version", releaseVersion: result.stdout.trim() },
  };
}

async function sameVersionReplay(context) {
  await install(context, context.candidate);
  const before = await readFile(resolve(context.programRoot, "current.json"));
  const command = stableInstallerCommand(context, context.candidate);
  const result = await runCommand({ ...command, environment: context.environment, expectedStatus: 0 });
  const after = await readFile(resolve(context.programRoot, "current.json"));
  if (!before.equals(after)) throw new Error("candidate replay changed the exact pointer");
  return {
    command,
    result: stableCommandResult(result),
    terminal: { kind: "pointer-unchanged", pointerDigest: byteDigest(after) },
  };
}

async function noUpdateSilent(context) {
  await install(context, context.candidate);
  const command = stableLauncherCommand(context, ["--version"]);
  const result = await runCommand({ ...command, environment: context.environment, expectedStatus: 0 });
  if (result.stdout.trim() !== context.candidate.manifest.releaseVersion || result.stderr.trim() !== "") {
    throw new Error("candidate no-update launch was not silent");
  }
  return {
    command,
    result: { status: result.status, stdout: result.stdout.trim(), stderr: "" },
    terminal: { kind: "no-maintenance-output", pointer: await pointerIdentity(context) },
  };
}

async function upgradeJourney(context, terminalKind) {
  const host = await installBaselineAndStartHost(context);
  try {
    const command = candidateInstallCommand(context, context.candidate);
    const result = await runCommand({ ...command, environment: context.environment, expectedStatus: 0 });
    const terminal = await currentTerminal(context, terminalKind);
    if (!terminal.previousManifestDigest) throw new Error("candidate upgrade lost its verified previous release");
    return { command, result: stableCommandResult(result), terminal };
  } finally {
    await stopHost(context, host);
  }
}

async function visibleUpdateStatus(context) {
  const host = await installBaselineAndStartHost(context);
  try {
    await install(context, context.candidate);
    const command = currentCliCommand(context, ["status"]);
    const result = await runCommand({ ...command, environment: context.environment, expectedStatus: [0, 1] });
    if (!result.stdout.includes("已更新")) throw new Error("candidate RPC status did not expose the update terminal");
    return {
      command,
      result: { status: result.status, updateVisible: true, stderr: result.stderr.trim() },
      terminal: { kind: "updated-visible", pointer: await pointerIdentity(context) },
    };
  } finally {
    await stopHost(context, host);
  }
}

async function automaticRestore(context) {
  const host = await installBaselineAndStartHost(context);
  try {
    await install(context, context.candidate);
    const command = currentCliCommand(context, ["update", "--restore-previous"]);
    const result = await runCommand({ ...command, environment: context.environment, expectedStatus: 0 });
    const pointer = await pointerIdentity(context);
    if (pointer.currentManifestDigest !== context.baseline.manifestDigest) {
      throw new Error("candidate restore did not return to the signed baseline");
    }
    return {
      command,
      result: stableCommandResult(result),
      terminal: { kind: "baseline-current", pointer },
    };
  } finally {
    await stopHost(context, host);
  }
}

async function guidedRestore(context) {
  await install(context, context.candidate);
  const receipt = {
    v: 1,
    currentManifestDigest: context.candidate.manifestDigest,
    target,
    candidateManifestDigest: context.baseline.manifestDigest,
    phase: "idle",
    notice: "action-required",
    code: "health-check-failed",
    action: "restore-previous",
  };
  await atomicFile(resolve(context.programRoot, "update-receipt.json"), Buffer.from(`${canonicalize(receipt)}\n`, "utf8"));
  const command = currentCliCommand(context, ["doctor"]);
  const result = await runCommand({ ...command, environment: context.environment, expectedStatus: 0 });
  if (!result.stdout.includes("zz update --restore-previous")) throw new Error("candidate doctor omitted the stable recovery action");
  return {
    command,
    result: { status: result.status, recoveryActionVisible: true, stderr: result.stderr.trim() },
    terminal: { kind: "single-recovery-action", receiptDigest: byteDigest(await readFile(resolve(context.programRoot, "update-receipt.json"))) },
  };
}

async function offlineDoctor(context) {
  await install(context, context.candidate);
  const before = await directorySnapshot(resolve(context.environment.ZHIXING_HOME));
  const command = currentCliCommand(context, ["doctor"]);
  const result = await runCommand({ ...command, environment: context.environment, expectedStatus: 0 });
  const after = await directorySnapshot(resolve(context.environment.ZHIXING_HOME));
  if (!result.stdout.trim()) throw new Error("candidate offline doctor produced no public result");
  if (canonicalize(before) !== canonicalize(after)) {
    throw new Error("candidate offline doctor changed the isolated home");
  }
  return {
    command,
    result: { status: result.status, lines: result.stdout.trim().split(/\r?\n/u).length, stderr: result.stderr.trim() },
    terminal: { kind: "offline-action", homeUnchanged: true },
  };
}

async function appRemove(context) {
  await install(context, context.candidate);
  const sentinel = resolve(context.home, "user-data-sentinel");
  await writeFile(sentinel, "preserve", "utf8");
  const command = currentCliCommand(context, ["app", "remove"]);
  const result = await runCommand({ ...command, environment: context.environment, expectedStatus: 0 });
  await waitUntilMissing(context.programRoot);
  if (await readFile(sentinel, "utf8") !== "preserve") throw new Error("candidate app removal changed user data");
  return {
    command,
    result: { status: result.status, removalVisible: result.stdout.includes("保留") },
    terminal: { kind: "program-removed-user-data-preserved", programRemoved: true, userDataDigest: byteDigest(await readFile(sentinel)) },
  };
}

async function permanentRemoveConfirmation(context) {
  const before = await directorySnapshot(context.home);
  const command = {
    executable: context.candidateRuntime,
    args: [context.candidateApp, "device", "remove", "Smoke target"],
    entry: context.candidateApp,
  };
  const result = await runCommand({ ...command, environment: context.environment, expectedStatus: 1 });
  if (!result.stderr.includes("--permanent")) throw new Error("candidate device removal did not require permanent confirmation");
  const after = await directorySnapshot(context.home);
  if (canonicalize(before) !== canonicalize(after)) throw new Error("rejected permanent removal changed the isolated home");
  return {
    command,
    result: { status: result.status, permanentRequired: true },
    terminal: { kind: "permanent-confirmation-required", homeUnchanged: true },
  };
}

async function installBaselineAndStartHost(context) {
  await install(context, context.baseline);
  const command = stableLauncherCommand(context, ["serve"]);
  const child = spawn(command.executable, command.args, {
    cwd: context.root,
    env: context.environment,
    stdio: "ignore",
    windowsHide: true,
  });
  await waitUntilPresent(resolve(context.environment.ZHIXING_HOME, "server.pid"), child);
  return child;
}

async function stopHost(context, child) {
  try {
    if (await stat(resolve(context.environment.ZHIXING_HOME, "server.pid")).catch(() => undefined)) {
      const command = currentCliCommand(context, ["stop"]);
      await runCommand({ ...command, environment: context.environment, expectedStatus: [0, 1] }).catch(() => undefined);
    }
    await waitForChild(child, 30_000).catch(() => undefined);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

async function install(context, release) {
  const command = candidateInstallCommand(context, release);
  await runCommand({ ...command, environment: context.environment, expectedStatus: 0 });
  await readPointer(context);
}

function candidateInstallCommand(context, release) {
  const entry = context.candidateInstaller;
  return {
    executable: context.candidateRuntime,
    args: [
      entry,
      "install",
      "--program-root",
      context.programRoot,
      "--manifest",
      release.manifestFile,
      "--artifact",
      release.artifactFile,
    ],
    entry,
  };
}

function stableInstallerCommand(context, release) {
  const entry = resolve(context.programRoot, "installer", "program-installer.js");
  return {
    executable: resolve(context.programRoot, "runtime", target === "win32-x64" ? "node.exe" : "node"),
    args: [
      entry,
      "install",
      "--program-root",
      context.programRoot,
      "--manifest",
      release.manifestFile,
      "--artifact",
      release.artifactFile,
    ],
    entry,
  };
}

function stableLauncherCommand(context, args) {
  const entry = resolve(context.programRoot, "installer", "launch.js");
  return {
    executable: resolve(context.programRoot, "runtime", target === "win32-x64" ? "node.exe" : "node"),
    args: [entry, ...args],
    entry,
  };
}

function currentCliCommand(context, args) {
  const pointer = context.lastPointer;
  if (!pointer) throw new Error("current candidate entry was requested before pointer read-back");
  const program = resolve(context.programRoot, "versions", pointer.current.directory, "program");
  const entry = resolve(program, "app", "dist", "index.js");
  return {
    executable: resolve(program, "runtime", target === "win32-x64" ? "node.exe" : "node"),
    args: [entry, ...args],
    entry,
  };
}

function scenarioEntry(context, entryKind) {
  if (entryKind === "candidate-installer") return context.candidateInstaller;
  if (entryKind === "stable-installer" || entryKind === "stable-launcher") {
    return resolve(context.programRoot, "installer", entryKind === "stable-installer" ? "program-installer.js" : "launch.js");
  }
  if (entryKind === "candidate-cli" || entryKind === "candidate-rpc") {
    return currentCliCommand(context, []).entry;
  }
  throw new Error(`target smoke entry kind is not implemented: ${entryKind}`);
}

async function currentTerminal(context, kind) {
  const pointer = await readPointer(context);
  if (pointer.current.manifestDigest !== context.candidate.manifestDigest) throw new Error("signed candidate is not current");
  return {
    kind,
    currentManifestDigest: pointer.current.manifestDigest,
    previousManifestDigest: pointer.previous?.manifestDigest,
    generation: pointer.generation,
    directory: pointer.current.directory,
  };
}

async function pointerIdentity(context) {
  const pointer = await readPointer(context);
  return {
    generation: pointer.generation,
    currentManifestDigest: pointer.current.manifestDigest,
    previousManifestDigest: pointer.previous?.manifestDigest,
    currentDirectory: pointer.current.directory,
  };
}

async function readPointer(context) {
  const pointer = exact(await json(resolve(context.programRoot, "current.json")), [
    "current", "generation", ...(await pointerHasPrevious(context) ? ["previous"] : []), "target", "v",
  ]);
  context.lastPointer = pointer;
  return pointer;
}

async function pointerHasPrevious(context) {
  const value = await json(resolve(context.programRoot, "current.json"));
  return value.previous !== undefined;
}

async function runCommand(input) {
  const result = spawnSync(input.executable, input.args, {
    cwd: input.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: input.environment,
    maxBuffer: 16 * 1024 * 1024,
    timeout: COMMAND_TIMEOUT_MS,
    shell: false,
  });
  const expected = Array.isArray(input.expectedStatus) ? input.expectedStatus : [input.expectedStatus];
  if (result.error || !expected.includes(result.status)) {
    throw new Error(`candidate command did not reach its required terminal (${input.args[0] ?? "entry"})`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function stableCommandResult(result) {
  return {
    status: result.status,
    stdoutDigest: digest(Buffer.from(result.stdout, "utf8")),
    stderrDigest: digest(Buffer.from(result.stderr, "utf8")),
  };
}

function normalizeArgv(args, context) {
  const roots = [
    [context.root, "{scenarioRoot}"],
    [context.candidateRoot, "{candidateRoot}"],
    [context.programRoot, "{programRoot}"],
    [context.candidate.manifestFile, "{candidateManifest}"],
    [context.candidate.artifactFile, "{candidateArtifact}"],
    [context.baseline.manifestFile, "{baselineManifest}"],
    [context.baseline.artifactFile, "{baselineArtifact}"],
  ].sort((left, right) => right[0].length - left[0].length);
  return args.map((argument) => {
    let normalized = resolveLike(argument);
    for (const [source, replacement] of roots) normalized = normalized.split(source).join(replacement);
    return normalized;
  });
}

function resolveLike(value) { return typeof value === "string" ? value : String(value); }

async function materializeProgram(root, artifact) {
  await mkdir(root, { recursive: true });
  for (const file of artifact.files) {
    const destination = resolve(root, ...file.path.split("/"));
    const bytes = Buffer.from(file.data, "base64url");
    if (bytes.byteLength !== file.bytes || byteDigest(bytes) !== file.digest) {
      throw new Error(`candidate program file ${file.path} changed after artifact verification`);
    }
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, bytes, { mode: file.mode });
    await chmod(destination, file.mode);
  }
}

async function assertInputsUnchanged(input) {
  if (
    byteDigest(await readFile(input.candidate.manifestFile)) !== input.candidate.manifestDigest ||
    byteDigest(await readFile(input.candidate.artifactFile)) !== input.candidate.artifactDigest ||
    byteDigest(await readFile(input.baseline.manifestFile)) !== input.baseline.manifestDigest ||
    byteDigest(await readFile(input.baseline.artifactFile)) !== input.baseline.artifactDigest ||
    await fingerprintSourceTree(repositoryRoot) !== input.sourceTreeDigest ||
    await fingerprintPackageGraph(repositoryRoot) !== input.packageGraphDigest
  ) throw new Error("release inputs drifted while target evidence was running");
}

async function waitUntilPresent(file, child) {
  const deadline = Date.now() + HOST_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await stat(file).catch(() => undefined)) return;
    if (child.exitCode !== null) throw new Error("candidate host exited before publishing its endpoint");
    await delay(100);
  }
  throw new Error("candidate host did not publish its endpoint in time");
}

async function waitUntilMissing(root) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!await stat(root).catch(() => undefined)) return;
    await delay(100);
  }
  throw new Error("candidate application removal did not remove the program root");
}

async function waitForChild(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolveChild) => child.once("exit", resolveChild)),
    delay(timeoutMs).then(() => { throw new Error("candidate host did not exit in time"); }),
  ]);
}

async function directorySnapshot(root) {
  const snapshot = [];
  await walk(root);
  return snapshot.sort((left, right) => left.path.localeCompare(right.path, "en-US"));

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink()) throw new Error("isolated evidence home contains a symbolic link");
      if (entry.isDirectory()) {
        snapshot.push({ path: name, kind: "directory" });
        await walk(path);
      } else if (entry.isFile()) {
        snapshot.push({ path: name, kind: "file", digest: byteDigest(await readFile(path)) });
      } else {
        throw new Error("isolated evidence home contains an unsupported entry");
      }
    }
  }
}

function isolatedProgramRoot(input) {
  if (process.platform === "win32") return resolve(input.localAppData, "Zhixing");
  if (process.platform === "darwin") return resolve(input.home, "Library", "Application Support", "Zhixing");
  return resolve(input.home, "data", "zhixing");
}

function localTarget() {
  const value = `${process.platform}-${process.arch}`;
  if (["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"].includes(value)) return value;
  throw new Error("this machine is outside the stable release target set");
}

function required(flag) {
  const value = optional(flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}
function optional(flag) {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}
async function json(file) { return JSON.parse(await readFile(file, "utf8")); }
function exact(input, fields) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Error("release evidence has unknown or missing fields");
  }
  return input;
}
function text(value) {
  if (typeof value !== "string" || !value) throw new Error("release trust text is invalid");
  return value;
}
async function atomicFile(file, bytes) {
  await mkdir(resolve(file, ".."), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}
