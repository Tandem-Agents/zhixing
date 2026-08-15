import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  RELEASE_ACCEPTANCE_IDS,
  RELEASE_PRODUCER_PATHS,
  RELEASE_SMOKE_SCENARIO_CONTRACTS,
  RELEASE_SMOKE_SCENARIOS,
  assertCanonicalTargetSmokeReport,
  assertExactStringSet,
  assertProgramTreeContract,
  assertReleaseNodeVersion,
  canonicalize,
  collectProgramFiles,
  collectSourceTreeRows,
  compareProgramArtifactPaths,
  digest,
  fingerprintPackageGraph,
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

test("release program inventory sorts paths by the shared canonical comparator, not locale collation", async () => {
  const root = join(tmpdir(), `zhixing-release-canonical-order-${process.pid}-${Date.now()}`);
  await mkdir(join(root, "app", ".hidden"), { recursive: true });
  for (const name of ["a.txt", "B.txt", "_hidden.md", "é.txt", "中.txt"]) {
    await writeFile(join(root, "app", name), `payload:${name}`);
  }
  await writeFile(join(root, "app", ".hidden", "value.txt"), "hidden");
  const files = await collectProgramFiles(root);
  assert.deepEqual(files.map(({ path }) => path), [
    "app/.hidden/value.txt",
    "app/B.txt",
    "app/_hidden.md",
    "app/a.txt",
    "app/é.txt",
    "app/中.txt",
  ]);
  assert.deepEqual(
    [...files].sort((left, right) => compareProgramArtifactPaths(left.path, right.path)).map(({ path }) => path),
    files.map(({ path }) => path),
  );
  assert.equal(compareProgramArtifactPaths("app/B.txt", "app/a.txt"), -1);
  assert.equal(compareProgramArtifactPaths("app/a.txt", "app/B.txt"), 1);
  assert.equal(compareProgramArtifactPaths("app/a.txt", "app/a.txt"), 0);
});

test("the release producer exact-set is complete and binds the source fingerprint", async () => {
  assert.deepEqual(
    assertExactStringSet([...RELEASE_PRODUCER_PATHS], RELEASE_PRODUCER_PATHS, "release producers"),
    RELEASE_PRODUCER_PATHS,
  );
  for (const path of RELEASE_PRODUCER_PATHS) {
    assert.ok((await readFile(resolve(import.meta.dirname, "..", path))).byteLength > 0, `${path} must exist`);
  }
  const rootPackage = JSON.parse(await readFile(resolve(import.meta.dirname, "..", "package.json"), "utf8"));
  const declaredReleaseProducers = [...new Set(Object.entries(rootPackage.scripts)
    .filter(([name, command]) => name.startsWith("release:") && !name.endsWith(":test") && command.startsWith("node scripts/"))
    .map(([, command]) => command.match(/scripts\/[A-Za-z0-9._-]+\.mjs/u)?.[0])
    .filter(Boolean))];
  assert.deepEqual(
    declaredReleaseProducers.sort(compareProgramArtifactPaths),
    RELEASE_PRODUCER_PATHS.filter((path) => path !== "scripts/release-tooling.mjs").sort(compareProgramArtifactPaths),
  );
  const rows = await collectSourceTreeRows(resolve(import.meta.dirname, ".."));
  const producerRows = rows.filter(({ path }) => RELEASE_PRODUCER_PATHS.includes(path));
  assert.deepEqual(
    producerRows.map(({ path }) => path),
    [...RELEASE_PRODUCER_PATHS].sort((left, right) => compareProgramArtifactPaths(left, right)),
  );
  for (let index = 1; index < rows.length; index += 1) {
    assert.ok(
      compareProgramArtifactPaths(rows[index - 1].path, rows[index].path) < 0,
      `${rows[index].path} is not canonically ordered`,
    );
  }
  const artifactBuilder = await readFile(resolve(import.meta.dirname, "build-release-artifact.mjs"), "utf8");
  assert.match(artifactBuilder, /validateProgramArtifact\(artifact\)/u);
  const treeBuilder = await readFile(resolve(import.meta.dirname, "build-program-tree.mjs"), "utf8");
  assert.match(treeBuilder, /sourceTreeDigest: frozenSourceTreeDigest/u);
  assert.match(treeBuilder, /packageGraphDigest: frozenPackageGraphDigest/u);
  assert.match(treeBuilder, /release inputs drifted while the program tree was being built/u);
  const evidenceProducer = await readFile(resolve(import.meta.dirname, "release-target-evidence.mjs"), "utf8");
  assert.match(evidenceProducer, /candidate manifest does not bind the current build input closure/u);
});

test("package graph fingerprint ignores installed dependency and build directories", async () => {
  const root = join(tmpdir(), `zhixing-release-package-graph-${process.pid}-${Date.now()}`);
  const packageRoot = join(root, "packages", "demo");
  const externalModules = join(root, "external-node-modules");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(externalModules, { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"workspace"}\n');
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(join(packageRoot, "package.json"), '{"name":"demo"}\n');
  await writeFile(join(externalModules, "package.json"), '{"name":"dependency","version":"1.0.0"}\n');
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "dist", "package.json"), '{"name":"stale-build"}\n');
  try {
    await symlink(
      externalModules,
      join(packageRoot, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "EPERM" || error.code === "EACCES")
    ) return;
    throw error;
  }

  const before = await fingerprintPackageGraph(root);
  await writeFile(join(externalModules, "package.json"), '{"name":"dependency","version":"2.0.0"}\n');
  await writeFile(join(packageRoot, "dist", "package.json"), '{"name":"different-stale-build"}\n');
  assert.equal(await fingerprintPackageGraph(root), before);

  await symlink(
    externalModules,
    join(packageRoot, "vendor-link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(() => fingerprintPackageGraph(root), /symlinks/u);
});

test("release evidence requires producer-bound target terminals and an exact Node 24 runtime", () => {
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
  assert.equal(assertReleaseNodeVersion("24.19.0"), "24.19.0");
  assert.throws(() => assertReleaseNodeVersion("22.19.0"), /Node 24/);
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
