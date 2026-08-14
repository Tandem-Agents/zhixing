import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RELEASE_ACCEPTANCE_IDS,
  RELEASE_SMOKE_SCENARIO_CONTRACTS,
  RELEASE_SMOKE_SCENARIOS,
  assertCanonicalTargetSmokeReport,
  assertExactStringSet,
  assertProgramTreeContract,
  assertReleaseNodeVersion,
  canonicalize,
  collectProgramFiles,
  digest,
  programTreeDigest,
  stableProgramLoaderSource,
} from "./release-tooling.mjs";

test("release program inventory is deterministic and rejects development assets", async () => {
  const root = join(tmpdir(), `zhixing-release-tooling-${process.pid}-${Date.now()}`);
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin", "zz"), "launcher");
  const first = await collectProgramFiles(root);
  const second = await collectProgramFiles(root);
  assert.equal(programTreeDigest(first), programTreeDigest(second));
  await writeFile(join(root, "bin", "zz.js.map"), "{}");
  await assert.rejects(() => collectProgramFiles(root), /development asset/);
});

test("release program inventory rejects symlink escapes where the host supports symlinks", async (t) => {
  const root = join(tmpdir(), `zhixing-release-symlink-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "target"), "payload");
  try { await symlink(join(root, "target"), join(root, "link")); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) return t.skip("host cannot create symlinks");
    throw error;
  }
  await assert.rejects(() => collectProgramFiles(root), /symlinks/);
});

test("release evidence requires producer-bound target terminals and an exact Node 22 runtime", () => {
  assert.deepEqual(RELEASE_SMOKE_SCENARIOS, RELEASE_SMOKE_SCENARIO_CONTRACTS.map(({ id }) => id));
  const sha = `sha256:${"a".repeat(64)}`;
  const expected = {
    target: "linux-x64",
    platform: "linux",
    arch: "x64",
    manifestDigest: sha,
    artifactDigest: sha,
    baselineManifestDigest: sha,
    baselineArtifactDigest: sha,
    sourceTreeDigest: sha,
    packageGraphDigest: sha,
  };
  const report = {
    v: 3,
    producerVersion: 2,
    ...expected,
    candidateExecutionDigest: sha,
    scenarios: RELEASE_SMOKE_SCENARIO_CONTRACTS.map((contract) => smokeRow(contract, sha)),
  };
  assert.equal(assertCanonicalTargetSmokeReport(report, expected), report);
  assert.throws(() => assertCanonicalTargetSmokeReport({
    ...report,
    scenarios: report.scenarios.map((row, index) => index === 0 ? { ...row, entryDigest: `sha256:${"b".repeat(64)}` } : row),
  }, expected), /row clean-install/);
  assert.throws(() => assertCanonicalTargetSmokeReport({
    ...report,
    scenarios: report.scenarios.slice(1),
  }, expected), /scenario set/);
  assert.equal(assertReleaseNodeVersion("22.18.0"), "22.18.0");
  assert.throws(() => assertReleaseNodeVersion("24.0.0"), /Node 22/);
});

test("release smoke contracts are strict candidate-entry descriptors with a fixed producer", async () => {
  for (const contract of RELEASE_SMOKE_SCENARIO_CONTRACTS) {
    assert.deepEqual(
      Object.keys(contract).sort(),
      ["argvTemplate", "entryKind", "id", "terminalKind"],
      `${contract.id} contract shape drifted`,
    );
    assert.ok(["candidate-cli", "candidate-installer", "candidate-rpc", "stable-installer", "stable-launcher"].includes(contract.entryKind));
    assert.ok(Array.isArray(contract.argvTemplate));
    assert.equal(typeof contract.terminalKind, "string");
  }
  const producer = await readFile(join(import.meta.dirname, "release-target-evidence.mjs"), "utf8");
  assert.match(producer, /switch \(contract\.id\)/u);
  assert.doesNotMatch(producer, /vitest|\.test\.[cm]?[jt]s/u);
  assert.match(producer, /candidate offline doctor changed the isolated home/u);
  for (const { id } of RELEASE_SMOKE_SCENARIO_CONTRACTS) assert.match(producer, new RegExp(`case "${id}"`, "u"));
});

test("release acceptance ledger requires the fixed fifty identifiers", () => {
  assert.equal(RELEASE_ACCEPTANCE_IDS.length, 50);
  assert.deepEqual(
    assertExactStringSet([...RELEASE_ACCEPTANCE_IDS], RELEASE_ACCEPTANCE_IDS, "ledger"),
    RELEASE_ACCEPTANCE_IDS,
  );
  assert.throws(
    () => assertExactStringSet(RELEASE_ACCEPTANCE_IDS.slice(1), RELEASE_ACCEPTANCE_IDS, "ledger"),
    /canonical exact-set/,
  );
  assert.throws(
    () => assertExactStringSet([...RELEASE_ACCEPTANCE_IDS, RELEASE_ACCEPTANCE_IDS[0]], RELEASE_ACCEPTANCE_IDS, "ledger"),
    /canonical exact-set/,
  );
});

test("all five release program trees require their exact runtime and launcher surface", () => {
  for (const target of ["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]) {
    const windows = target === "win32-x64";
    const files = [
      windows ? "runtime/node.exe" : "runtime/node",
      windows ? "bin/zz.cmd" : "bin/zz",
      windows ? "bin/zhixing.cmd" : "bin/zhixing",
      "installer/launch.js",
      "installer/program-installer.js",
      "app/package.json",
      "app/dist/index.js",
      "app/dist/program-installer.js",
      "program-tree-receipt.json",
    ].map((path) => ({ path }));
    assert.equal(assertProgramTreeContract(files, target), files);
    assert.throws(
      () => assertProgramTreeContract([...files, { path: "home/credentials.json" }], target),
      /unmanaged root/,
    );
    for (const entry of ["app/dist/index.js", "app/dist/program-installer.js"]) {
      const loader = stableProgramLoaderSource(target, entry);
      assert.match(loader, /current\.json/u);
      assert.match(loader, /versions/u);
      assert.match(loader, windows ? /node\.exe/u : /"node"/u);
      assert.match(loader, new RegExp(entry.split("/").map(escapeRegExp).join('\",\"'), "u"));
      assert.match(loader, /spawn\(/u);
    }
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function smokeRow(contract, value) {
  const commandDigest = digest(Buffer.from(canonicalize({
    contract,
    entryDigest: value,
    argvDigest: value,
  }), "utf8"));
  return {
    id: contract.id,
    entryDigest: value,
    argvDigest: value,
    commandDigest,
    resultDigest: value,
    terminalDigest: value,
    executionDigest: digest(Buffer.from(canonicalize({
      commandDigest,
      resultDigest: value,
      terminalDigest: value,
    }), "utf8")),
  };
}
