import { createPublicKey, verify } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  STABLE_RELEASE_TARGETS,
  assertStableReleaseBinding,
  byteDigest,
  canonicalize,
  decodeAndValidateStableReleaseIndex,
  decodeProgramArtifact,
  protocolBytes,
} from "../packages/core/dist/protocol/index.js";
import {
  RELEASE_ACCEPTANCE_IDS,
  assertCanonicalTargetSmokeReport,
  assertExactStringSet,
  assertProgramTreeContract,
  assertReleaseNodeVersion,
  fingerprintPackageGraph,
  fingerprintSourceTree,
} from "./release-tooling.mjs";

const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(required("--evidence"));
const rootPackage = await json(resolve(root, "package.json"));
const acceptanceLedger = await validateAcceptanceLedger(resolve(
  root,
  "research/design/modules/distributed-runtime/unit-38-final-acceptance-ledger.json",
), rootPackage.version);
const maintenanceGuide = await readFile(resolve(
  root,
  "research/design/modules/distributed-runtime/release-and-maintenance-guide.md",
));
if (!maintenanceGuide.toString("utf8").startsWith(`# 知行 ${rootPackage.version} 安装、更新与维护\n`)) {
  throw new Error("release maintenance guide version does not match the canonical release");
}
const trust = exact(await json(resolve(evidenceRoot, "release-trust.json")), ["keyId", "publicKeySpki"]);
const publicKey = createPublicKey({ key: Buffer.from(text(trust.publicKeySpki), "base64url"), format: "der", type: "spki" });
const verifier = {
  verify(schemaId, version, payload, signature) {
    if (signature.alg !== "ed25519" || signature.keyId !== trust.keyId || !verify(null, protocolBytes(schemaId, version, payload), publicKey, Buffer.from(signature.sig, "base64url"))) {
      throw new Error("release signature verification failed");
    }
  },
};

for (const args of [["lint"], ["test"], ["build"]]) runPnpm(args);

const sourceTreeDigest = await fingerprintSourceTree(root);
const packageGraphDigest = await fingerprintPackageGraph(root);
const indexBytes = await readFile(resolve(evidenceRoot, "stable-index.json"));
const index = decodeAndValidateStableReleaseIndex(indexBytes, verifier);
if (canonicalize(index) !== indexBytes.toString("utf8")) throw new Error("stable index is not canonical");
if (index.releaseVersion !== rootPackage.version) throw new Error("stable index version does not match the canonical workspace release");

const reports = [];
for (const target of STABLE_RELEASE_TARGETS) {
  const targetRoot = resolve(evidenceRoot, "targets", target);
  const manifestBytes = await readFile(resolve(targetRoot, "release-manifest.json"));
  const manifest = assertStableReleaseBinding(index, target, manifestBytes, verifier);
  assertReleaseNodeVersion(manifest.nodeVersion);
  if (manifest.sourceTreeDigest !== sourceTreeDigest || manifest.packageGraphDigest !== packageGraphDigest) {
    throw new Error(`${target} manifest does not bind the current build input closure`);
  }
  const artifactBytes = await readFile(resolve(targetRoot, "program-artifact.json"));
  if (artifactBytes.byteLength !== manifest.artifact.bytes || byteDigest(artifactBytes) !== manifest.artifact.digest) {
    throw new Error(`${target} final artifact bytes drifted after signing`);
  }
  const artifact = decodeProgramArtifact(artifactBytes);
  if (artifact.target !== target || artifact.releaseVersion !== index.releaseVersion) throw new Error(`${target} artifact identity is inconsistent`);
  assertProgramTreeContract(artifact.files, target);
  const platformBytes = await readFile(resolve(targetRoot, "platform-evidence.json"));
  const platformEvidence = exact(JSON.parse(platformBytes), ["artifactDigest", "passed", "target", "v"]);
  if (platformEvidence.v !== 1 || platformEvidence.passed !== true || platformEvidence.target !== target || platformEvidence.artifactDigest !== manifest.artifact.digest) {
    throw new Error(`${target} platform signing/notarization evidence is not bound to final bytes`);
  }
  const smokeBytes = await readFile(resolve(targetRoot, "smoke-report.json"));
  const [platform, arch] = target.split("-");
  const smoke = assertCanonicalTargetSmokeReport(JSON.parse(smokeBytes), {
    target,
    platform,
    arch,
    manifestDigest: byteDigest(manifestBytes),
    artifactDigest: byteDigest(artifactBytes),
    sourceTreeDigest,
    packageGraphDigest,
  });
  if (smokeBytes.toString("utf8") !== `${canonicalize(smoke)}\n`) {
    throw new Error(`${target} smoke report is not canonical producer output`);
  }
  reports.push({
    target,
    manifestDigest: byteDigest(manifestBytes),
    artifactDigest: manifest.artifact.digest,
    platformEvidenceDigest: byteDigest(platformBytes),
    smokeEvidenceDigest: byteDigest(smokeBytes),
  });
}

if (
  await fingerprintSourceTree(root) !== sourceTreeDigest ||
  await fingerprintPackageGraph(root) !== packageGraphDigest
) throw new Error("release inputs drifted while target evidence was being verified");

const report = {
  v: 1,
  releaseVersion: index.releaseVersion,
  releaseSequence: index.releaseSequence,
  sourceTreeDigest,
  packageGraphDigest,
  indexDigest: byteDigest(indexBytes),
  acceptanceLedgerDigest: byteDigest(acceptanceLedger.bytes),
  maintenanceGuideDigest: byteDigest(maintenanceGuide),
  commands: ["pnpm lint", "pnpm test", "pnpm build", "release:check"],
  targets: reports,
  result: "passed",
};
await atomicFile(resolve(evidenceRoot, "release-report.json"), Buffer.from(`${canonicalize(report)}\n`, "utf8"));
const publish = optional("--publish-index");
if (publish) await atomicFile(resolve(publish), indexBytes);

function runPnpm(args) {
  const result = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, { cwd: root, stdio: "inherit", shell: false });
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed`);
}
async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
function required(flag) { const value = optional(flag); if (!value) throw new Error(`${flag} is required`); return value; }
function optional(flag) { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; }
function exact(input, fields) {
  if (!input || typeof input !== "object" || Array.isArray(input) || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([...fields].sort())) throw new Error("release evidence has unknown or missing fields");
  return input;
}
function text(value) { if (typeof value !== "string" || !value) throw new Error("release trust text is invalid"); return value; }
async function atomicFile(path, bytes) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

async function validateAcceptanceLedger(path, releaseVersion) {
  const bytes = await readFile(path);
  const ledger = exact(JSON.parse(bytes), ["releaseVersion", "rows", "v"]);
  if (ledger.v !== 1 || ledger.releaseVersion !== releaseVersion || !Array.isArray(ledger.rows)) {
    throw new Error("final acceptance ledger identity is invalid");
  }
  const ids = new Set();
  for (const row of ledger.rows) {
    const value = exact(row, ["compositionRoot", "consumer", "id", "producer", "source", "terminal", "tests"]);
    if (typeof value.id !== "string" || ids.has(value.id)) throw new Error("final acceptance ledger row id is invalid");
    ids.add(value.id);
    for (const field of ["source", "producer", "consumer", "compositionRoot", "terminal"]) {
      if (typeof value[field] !== "string" || value[field].length === 0) throw new Error(`final acceptance ledger ${value.id} ${field} is empty`);
    }
    if (!Array.isArray(value.tests) || value.tests.length === 0) throw new Error(`final acceptance ledger ${value.id} has no tests`);
    for (const testPath of value.tests) {
      if (typeof testPath !== "string" || testPath.startsWith("/") || testPath.includes("..")) throw new Error(`final acceptance ledger ${value.id} test path is invalid`);
      await access(resolve(root, testPath));
    }
  }
  assertExactStringSet([...ids], RELEASE_ACCEPTANCE_IDS, "final acceptance ledger ids");
  return { ledger, bytes };
}
