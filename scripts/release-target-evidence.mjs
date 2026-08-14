import { createPublicKey, verify } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  byteDigest,
  canonicalize,
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
const CANDIDATE_COMMAND_TIMEOUT_MS = 60_000;
const SCENARIO_TIMEOUT_MS = 120_000;
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
const manifestBytes = await readFile(resolve(targetRoot, "release-manifest.json"));
const manifest = decodeAndValidateReleaseManifest(manifestBytes, verifier);
if (manifest.target !== target) throw new Error("candidate manifest target does not match this machine");
const artifactBytes = await readFile(resolve(targetRoot, "program-artifact.json"));
if (artifactBytes.byteLength !== manifest.artifact.bytes || byteDigest(artifactBytes) !== manifest.artifact.digest) {
  throw new Error("candidate artifact bytes do not match the signed manifest");
}
const artifact = decodeProgramArtifact(artifactBytes);
if (artifact.target !== target || artifact.releaseVersion !== manifest.releaseVersion) {
  throw new Error("candidate artifact identity does not match the signed manifest");
}
assertProgramTreeContract(artifact.files, target);

const sourceTreeDigest = await fingerprintSourceTree(repositoryRoot);
const packageGraphDigest = await fingerprintPackageGraph(repositoryRoot);
const execution = await executeCandidateAndScenarios({
  artifact,
  manifest,
  manifestFile: resolve(targetRoot, "release-manifest.json"),
  artifactFile: resolve(targetRoot, "program-artifact.json"),
});
const report = assertCanonicalTargetSmokeReport({
  v: 2,
  producerVersion: 1,
  target,
  platform: process.platform,
  arch: process.arch,
  manifestDigest: byteDigest(manifestBytes),
  artifactDigest: byteDigest(artifactBytes),
  sourceTreeDigest,
  packageGraphDigest,
  candidateExecutionDigest: execution.candidateExecutionDigest,
  scenarios: execution.scenarios,
}, {
  target,
  platform: process.platform,
  arch: process.arch,
  manifestDigest: byteDigest(manifestBytes),
  artifactDigest: byteDigest(artifactBytes),
  sourceTreeDigest,
  packageGraphDigest,
});
await atomicFile(resolve(targetRoot, "smoke-report.json"), Buffer.from(`${canonicalize(report)}\n`, "utf8"));

async function executeCandidateAndScenarios(input) {
  const scratch = await mkdtemp(join(tmpdir(), "zhixing-target-evidence-"));
  try {
    const candidateRoot = resolve(scratch, "candidate");
    const programRoot = resolve(scratch, "program");
    const home = resolve(scratch, "home");
    const localAppData = resolve(scratch, "local-app-data");
    const stateHome = resolve(scratch, "state");
    await Promise.all([mkdir(candidateRoot, { recursive: true }), mkdir(home, { recursive: true })]);
    for (const file of input.artifact.files) {
      const destination = resolve(candidateRoot, ...file.path.split("/"));
      const bytes = Buffer.from(file.data, "base64url");
      if (bytes.byteLength !== file.bytes || byteDigest(bytes) !== file.digest) {
        throw new Error(`candidate program file ${file.path} changed after artifact verification`);
      }
      await mkdir(resolve(destination, ".."), { recursive: true });
      await writeFile(destination, bytes, { mode: file.mode });
      await chmod(destination, file.mode);
    }
    const runtime = resolve(candidateRoot, "runtime", target === "win32-x64" ? "node.exe" : "node");
    const appEntry = resolve(candidateRoot, "app", "dist", "index.js");
    const installerEntry = resolve(candidateRoot, "app", "dist", "program-installer.js");
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
    const sentinel = resolve(home, "user-data-sentinel");
    await writeFile(sentinel, "preserve", "utf8");
    const probes = [];
    probes.push(runExact(runtime, [appEntry, "--version"], environment, 0, input.manifest.releaseVersion));
    probes.push(runExact(runtime, [
      installerEntry,
      "install",
      "--program-root",
      programRoot,
      "--manifest",
      input.manifestFile,
      "--artifact",
      input.artifactFile,
    ], environment));
    const stableRuntime = resolve(programRoot, "runtime", target === "win32-x64" ? "node.exe" : "node");
    const stableLauncher = resolve(programRoot, "installer", "launch.js");
    const stableInstaller = resolve(programRoot, "installer", "program-installer.js");
    probes.push(runExact(stableRuntime, [stableLauncher, "--version"], environment, 0, input.manifest.releaseVersion));
    const pointerBeforeReplay = await readFile(resolve(programRoot, "current.json"));
    probes.push(runExact(stableRuntime, [
      stableInstaller,
      "install",
      "--program-root",
      programRoot,
      "--manifest",
      input.manifestFile,
      "--artifact",
      input.artifactFile,
    ], environment));
    const pointerAfterReplay = await readFile(resolve(programRoot, "current.json"));
    if (!pointerBeforeReplay.equals(pointerAfterReplay)) {
      throw new Error("same-version candidate replay changed the installed pointer");
    }
    const scenarioResults = RELEASE_SMOKE_SCENARIO_CONTRACTS.map((contract) =>
      runScenario(contract, runtime, environment));
    probes.push(runExact(stableRuntime, [
      stableInstaller,
      "remove",
      "--program-root",
      programRoot,
      "--preserve-user-data",
    ], environment));
    await waitUntilMissing(programRoot);
    if ((await readFile(sentinel, "utf8")) !== "preserve") {
      throw new Error("candidate application removal changed isolated user data");
    }
    const installationReceipt = installationReceiptPath({ home, localAppData, stateHome });
    const receiptBytes = await readFile(installationReceipt);
    const candidateExecutionDigest = digest(Buffer.from(canonicalize({
      probes,
      pointerDigest: byteDigest(pointerAfterReplay),
      receiptDigest: byteDigest(receiptBytes),
      programRemoved: true,
      userDataPreserved: true,
    }), "utf8"));
    return {
      candidateExecutionDigest,
      scenarios: scenarioResults.map(({ contract, result }) => ({
        id: contract.id,
        commandDigest: digest(Buffer.from(canonicalize(contract), "utf8")),
        resultDigest: digest(Buffer.from(canonicalize(result.evidence), "utf8")),
        tests: result.tests,
        candidateExecutionDigest,
      })),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function runScenario(contract, runtime, environment) {
  const vitest = resolve(repositoryRoot, "packages/cli/node_modules/vitest/vitest.mjs");
  const result = spawnSync(runtime, [
    vitest,
    "run",
    contract.testFile,
    "-t",
    contract.testName,
    "--reporter=json",
  ], {
    cwd: resolve(repositoryRoot, "packages/cli"),
    encoding: "utf8",
    env: { ...environment, ZHIXING_RELEASE_TARGET: target },
    maxBuffer: 16 * 1024 * 1024,
    timeout: SCENARIO_TIMEOUT_MS,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`target smoke ${contract.id} failed`);
  }
  const evidence = JSON.parse(result.stdout);
  if (evidence.numFailedTests !== 0 || !Number.isSafeInteger(evidence.numPassedTests) || evidence.numPassedTests < 1) {
    throw new Error(`target smoke ${contract.id} did not produce a passing terminal`);
  }
  return { contract, result: {
    tests: evidence.numPassedTests,
    evidence: {
      numPassedTests: evidence.numPassedTests,
      numPendingTests: evidence.numPendingTests ?? 0,
      testResults: evidence.testResults?.map((file) => ({
        assertionResults: file.assertionResults?.map((assertion) => ({
          fullName: assertion.fullName,
          status: assertion.status,
        })),
      })),
    },
  }};
}

function runExact(executable, args, environment, expectedStatus = 0, expectedOutput) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
    timeout: CANDIDATE_COMMAND_TIMEOUT_MS,
    shell: false,
  });
  if (result.error || result.status !== expectedStatus ||
      (expectedOutput && result.stdout.trim() !== expectedOutput)) {
    throw new Error(`candidate command ${args[0]} did not reach its required terminal`);
  }
  return {
    executableDigest: digest(Buffer.from(executable, "utf8")),
    argsDigest: digest(Buffer.from(canonicalize(args), "utf8")),
    status: result.status,
    stdoutDigest: digest(Buffer.from(result.stdout, "utf8")),
    stderrDigest: digest(Buffer.from(result.stderr, "utf8")),
  };
}

async function waitUntilMissing(root) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!await stat(root).catch(() => undefined)) return;
    await delay(100);
  }
  throw new Error("candidate application removal did not remove the program root");
}

function installationReceiptPath(input) {
  if (process.platform === "win32") {
    return resolve(input.localAppData, "ZhixingInstaller", "installation-receipt.json");
  }
  if (process.platform === "darwin") {
    return resolve(input.home, "Library", "Application Support", "ZhixingInstaller", "installation-receipt.json");
  }
  return resolve(input.stateHome, "zhixing-installer", "installation-receipt.json");
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
