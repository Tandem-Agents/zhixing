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
    sourceTreeDigest: sha,
    packageGraphDigest: sha,
  };
  const report = {
    v: 2,
    producerVersion: 1,
    ...expected,
    candidateExecutionDigest: sha,
    scenarios: RELEASE_SMOKE_SCENARIO_CONTRACTS.map((contract) => ({
      id: contract.id,
      commandDigest: digest(Buffer.from(canonicalize(contract), "utf8")),
      resultDigest: sha,
      tests: 1,
      candidateExecutionDigest: sha,
    })),
  };
  assert.equal(assertCanonicalTargetSmokeReport(report, expected), report);
  assert.throws(() => assertCanonicalTargetSmokeReport({
    ...report,
    scenarios: report.scenarios.map((row, index) => index === 0 ? { ...row, tests: 0 } : row),
  }, expected), /row clean-install/);
  assert.throws(() => assertCanonicalTargetSmokeReport({
    ...report,
    candidateExecutionDigest: `sha256:${"b".repeat(64)}`,
  }, expected), /row clean-install/);
  assert.equal(assertReleaseNodeVersion("22.18.0"), "22.18.0");
  assert.throws(() => assertReleaseNodeVersion("24.0.0"), /Node 22/);
});

test("release smoke contracts name existing direct production tests", async () => {
  for (const contract of RELEASE_SMOKE_SCENARIO_CONTRACTS) {
    const source = await readFile(join(import.meta.dirname, "..", "packages", "cli", contract.testFile), "utf8");
    assert.ok(source.includes(contract.testName), `${contract.id} test contract drifted`);
  }
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
