import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  RELEASE_TARGETS,
  canonicalize,
  collectProgramFiles,
  digest,
  fingerprintPackageGraph,
  fingerprintSourceTree,
  programTreeDigest,
  assertProgramTreeContract,
  assertReleaseNodeVersion,
} from "./release-tooling.mjs";
import {
  DURABLE_SCHEMA_INVENTORY,
  assertProgramArtifactArchiveBytes,
} from "../packages/core/dist/protocol/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const rootPackage = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
const target = arg("--target");
if (!RELEASE_TARGETS.includes(target)) throw new Error("release target is outside the stable exact-set");
const programRoot = resolve(arg("--program-root"));
const outputRoot = resolve(arg("--output"));
const evidence = exact(JSON.parse(await readFile(resolve(arg("--platform-evidence")), "utf8")), ["passed", "target", "treeDigest", "v"]);
if (evidence.v !== 1 || evidence.passed !== true || evidence.target !== target) throw new Error("platform signing evidence does not match target");

const files = await collectProgramFiles(programRoot);
assertProgramTreeContract(files, target);
if (evidence.treeDigest !== programTreeDigest(files)) throw new Error("platform signing evidence does not bind the final program tree");
const treeReceipt = exact(
  JSON.parse(await readFile(resolve(programRoot, "program-tree-receipt.json"), "utf8")),
  ["appTreeDigest", "indexUrl", "keyId", "nodeVersion", "runtimeDigest", "target", "v"],
);
if (
  treeReceipt.v !== 1 || treeReceipt.target !== target ||
  treeReceipt.nodeVersion !== assertReleaseNodeVersion(arg("--node-version")) ||
  treeReceipt.keyId !== arg("--key-id") ||
  treeReceipt.appTreeDigest !== programTreeDigest(await collectProgramFiles(resolve(programRoot, "app")))
) throw new Error("program tree receipt does not bind the release build inputs");
const artifact = { v: 1, target, releaseVersion: rootPackage.version, files };
const artifactBytes = Buffer.from(canonicalize(artifact), "utf8");
assertProgramArtifactArchiveBytes(artifactBytes.byteLength);
const sourceTreeDigest = await fingerprintSourceTree(repositoryRoot);
const packageGraphDigest = await fingerprintPackageGraph(repositoryRoot);
const manifestPayload = {
  v: 1,
  releaseVersion: rootPackage.version,
  releaseSequence: uint64(arg("--release-sequence")),
  channel: "stable",
  target,
  nodeVersion: treeReceipt.nodeVersion,
  sourceTreeDigest,
  packageGraphDigest,
  artifact: { digest: digest(artifactBytes), bytes: artifactBytes.byteLength },
  protocolRange: { readMin: "1", readMax: "1", writeVersion: "1" },
  durableSchemas: DURABLE_SCHEMA_INVENTORY,
  minimumRollbackVersion: arg("--minimum-rollback-version"),
  keyId: arg("--key-id"),
};
await atomicDirectory(outputRoot, async (temporary) => {
  await writeFile(resolve(temporary, "program-artifact.json"), artifactBytes);
  await writeFile(resolve(temporary, "release-manifest-payload.json"), canonicalize(manifestPayload));
  await writeFile(resolve(temporary, "build-inputs.json"), canonicalize({ v: 1, sourceTreeDigest, packageGraphDigest }));
});

function arg(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${flag} is required`);
  return process.argv[index + 1];
}
function uint64(value) {
  if (!/^(0|[1-9][0-9]*)$/u.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) throw new Error("release sequence is invalid");
  return value;
}
function exact(input, fields) {
  if (!input || typeof input !== "object" || Array.isArray(input) || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([...fields].sort())) throw new Error("platform evidence is not exact");
  return input;
}
async function atomicDirectory(final, write) {
  const temporary = `${final}.${process.pid}.tmp`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try { await write(temporary); await rm(final, { recursive: true, force: true }); await rename(temporary, final); }
  catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}
