// 发布脚本的实际入口测试：把 publish-npm.mjs 原样复制进临时仓库布局，以 PATH 上的 npm 替身模拟官方 registry，
// 用系统 tar 生成真实 tarball。断言按阶段区分：上传前的拒绝必须零写；部分上传后的失败不得推广、不得覆盖已发布字节。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

const scripts = import.meta.dirname;
const systemTar = process.platform === "win32" ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
const SHRINKWRAP = "package/npm-shrinkwrap.json";
const workspaces = [];

test.after(async () => {
  await Promise.all(workspaces.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("confirmed publishing without a single explicit step writes nothing", async () => {
  const fixture = await createFixture();
  for (const args of [["--confirm-publish"], ["candidate", "promote", "--confirm-publish"]]) {
    const result = await publish(fixture, args);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /candidate 或 promote/u);
    assert.deepEqual((await state(fixture)).calls, []);
  }
});

test("candidate rejects inputs that are not the verified tarball set before any registry call", async () => {
  const cases = [
    ["fingerprint", async () => ({ sha: "0".repeat(64) })],
    ["missing tarball", async (fixture) => { await rm(path.join(fixture.tarballs, fileName("@zhixing-ai/core", fixture.version))); }],
    ["extra tarball", async (fixture) => { await writeFile(path.join(fixture.tarballs, "zhixing-extra-1.0.0.tgz"), "x"); }],
    ["mirror publish address", async (fixture) => {
      await writePackageTarball(fixture, "@zhixing-ai/core", { publishConfig: { registry: "https://registry.npmmirror.com/" } });
      return { sha: fingerprint(fixture) };
    }],
  ];
  for (const [label, mutate] of cases) {
    const fixture = await createFixture();
    const override = await mutate(fixture);
    const result = await publish(fixture, candidateArgs(fixture, override?.sha ?? fingerprint(fixture)));
    assert.notEqual(result.code, 0, label);
    assert.deepEqual((await state(fixture)).calls, [], `${label} must not touch the registry`);
  }
});

test("candidate stops on identity and permission gaps before uploading", async () => {
  const cases = [
    ["no identity", { identity: "" }],
    ["two-factor disabled", { tfa: "disabled" }],
    ["no org role", { orgRole: "none" }],
    ["no package write", { access: "read", seed: true }],
  ];
  for (const [label, patch] of cases) {
    const fixture = await createFixture();
    if (patch.seed) await seedRegistry(fixture, "@zhixing-ai/core", Buffer.from("older"), "0.9.0");
    await patchState(fixture, patch);
    const result = await publish(fixture, candidateArgs(fixture));
    assert.notEqual(result.code, 0, label);
    assert.deepEqual(writes(await state(fixture)), [], `${label} must not write`);
  }
});

test("registry read failures other than 404 are never treated as a first publish", async () => {
  const fixture = await createFixture();
  await patchState(fixture, { viewError: "ETIMEDOUT" });
  const result = await publish(fixture, candidateArgs(fixture));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /ETIMEDOUT/u);
  assert.deepEqual(writes(await state(fixture)), []);
});

test("candidate uploads the verified bytes, appends only the CLI lock and leaves latest untouched", async () => {
  const fixture = await createFixture();
  const result = await publish(fixture, candidateArgs(fixture));
  assert.equal(result.code, 0, result.stderr);
  const registry = (await state(fixture)).registry;
  for (const name of ["@zhixing-ai/core", "@zhixing-ai/tools", "@zhixing-ai/channel-feishu"]) {
    assert.equal(registry[name].versions[fixture.version].integrity, integrityOf(fixture.frozen.get(name)), name);
    assert.deepEqual(registry[name].tags, { "zhixing-candidate": fixture.version }, name);
  }
  const cli = registry["zhixing"];
  assert.deepEqual(cli.tags, { "zhixing-candidate": fixture.version });
  await assertAppendedOnly(fixture.frozen.get("zhixing"), await readFile(cli.versions[fixture.version].file));
  const lock = JSON.parse(execFileSync(systemTar, ["-xOzf", cli.versions[fixture.version].file, SHRINKWRAP], { encoding: "utf8" }));
  assert.equal(lock.packages["node_modules/@zhixing-ai/core"].integrity, integrityOf(fixture.frozen.get("@zhixing-ai/core")));
  assert.match(result.stdout, new RegExp(escape(cli.versions[fixture.version].integrity), "u"));
  assert.equal(latestMoves(await state(fixture)).length, 0);
  assert.equal((await state(fixture)).calls.filter(([verb]) => verb === "dist-tag").length, 0);
});

test("an interrupted dependency upload resumes without republishing what already landed", async () => {
  const fixture = await createFixture();
  await patchState(fixture, { failOnce: { "publish:@zhixing-ai/tools": true } });
  const first = await publish(fixture, candidateArgs(fixture));
  assert.notEqual(first.code, 0);
  const afterFirst = await state(fixture);
  assert.ok(afterFirst.registry["@zhixing-ai/core"]?.versions[fixture.version], "core landed before the failure");
  assert.equal(afterFirst.registry["zhixing"], undefined);
  assert.equal(latestMoves(afterFirst).length, 0);
  const callsBefore = afterFirst.calls.length;
  const second = await publish(fixture, candidateArgs(fixture));
  assert.equal(second.code, 0, second.stderr);
  const resumed = (await state(fixture)).calls.slice(callsBefore).filter(([verb]) => verb === "publish");
  assert.equal(resumed.some(([, file]) => file.includes("zhixing-ai-core-")), false, "core must not be uploaded again");
});

test("a CLI already on the registry resumes from its bytes instead of regenerating a drifted lock", async () => {
  const fixture = await createFixture();
  await patchState(fixture, { failOnce: { pack: true } });
  const first = await publish(fixture, candidateArgs(fixture));
  assert.notEqual(first.code, 0);
  const uploaded = (await state(fixture)).registry["zhixing"].versions[fixture.version].integrity;
  await patchState(fixture, { lockDrift: "drifted" });
  const callsBefore = (await state(fixture)).calls.length;
  const second = await publish(fixture, candidateArgs(fixture));
  assert.equal(second.code, 0, second.stderr);
  const after = await state(fixture);
  const resumed = after.calls.slice(callsBefore);
  assert.equal(resumed.some(([verb]) => verb === "publish" || verb === "shrinkwrap"), false);
  assert.equal(after.registry["zhixing"].versions[fixture.version].integrity, uploaded);
  assert.equal(latestMoves(after).length, 0);
});

test("conflicting bytes already on the registry are never overwritten", async () => {
  const dependency = await createFixture();
  await seedRegistry(dependency, "@zhixing-ai/core", Buffer.from("different"), dependency.version);
  const first = await publish(dependency, candidateArgs(dependency));
  assert.notEqual(first.code, 0);
  assert.match(first.stderr, /integrity 冲突/u);
  assert.deepEqual(writes(await state(dependency)), []);

  const cli = await createFixture();
  const extra = await appendEntries(cli.frozen.get("zhixing"), { [SHRINKWRAP]: "{}", "package/extra.js": "x" });
  await seedRegistry(cli, "zhixing", extra, cli.version);
  const second = await publish(cli, candidateArgs(cli));
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /恰好是已验证条目/u);
  const after = await state(cli);
  assert.equal(after.calls.some(([verb, file]) => verb === "publish" && /(?:^|[\\/])zhixing-\d/u.test(file)), false);
  assert.equal(latestMoves(after).length, 0);
});

test("a registry CLI that differs only inside the trailing NUL bytes of its last entry is rejected", async () => {
  const fixture = await createFixture();
  const verified = await writeCliWithTail(fixture, Buffer.from("tail\0\0\0\0"));
  const tampered = gunzipSync(verified);
  tampered[tampered.lastIndexOf(Buffer.from("tail")) + 6] = 0x58;
  const lock = {
    name: "zhixing", version: fixture.version, lockfileVersion: 3, requires: true,
    packages: {
      "": { name: "zhixing", version: fixture.version },
      ...Object.fromEntries(["@zhixing-ai/core", "@zhixing-ai/tools", "@zhixing-ai/channel-feishu"].map((name) => [`node_modules/${name}`, {
        version: fixture.version,
        resolved: `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${fixture.version}.tgz`,
        integrity: integrityOf(fixture.frozen.get(name)),
      }])),
      "node_modules/brace-expansion": { version: "5.0.9", resolved: "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz", integrity: "sha512-brace" },
    },
  };
  const registryCopy = await appendEntries(gzipSync(tampered), { [SHRINKWRAP]: JSON.stringify(lock) });
  await seedRegistry(fixture, "zhixing", registryCopy, fixture.version, { "zhixing-candidate": fixture.version });
  const result = await publish(fixture, candidateArgs(fixture));
  assert.notEqual(result.code, 0, "tampered trailing content must not pass as the verified CLI");
  assert.match(result.stderr, /最后一个已验证条目/u);
  assert.equal(latestMoves(await state(fixture)).length, 0);
});

test("a CLI lock resolving through a mirror is rejected before the CLI is uploaded", async () => {
  const fixture = await createFixture();
  await patchState(fixture, { mirror: true });
  const result = await publish(fixture, candidateArgs(fixture));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /非官方 registry/u);
  const after = await state(fixture);
  assert.equal(after.registry["zhixing"], undefined);
  assert.equal(latestMoves(after).length, 0);
});

test("a registry that changes latest during the candidate upload fails the candidate", async () => {
  const fixture = await createFixture();
  await patchState(fixture, { autoLatest: true });
  const result = await publish(fixture, candidateArgs(fixture));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /latest 被变更或指向候选版本/u);
  assert.equal((await state(fixture)).calls.filter(([verb]) => verb === "dist-tag").length, 0);
});

test("promote moves latest only for the accepted bytes after re-verifying the registry closure", async () => {
  const fixture = await createFixture();
  assert.equal((await publish(fixture, candidateArgs(fixture))).code, 0);
  const accepted = (await state(fixture)).registry["zhixing"].versions[fixture.version].integrity;
  const rejected = [
    ["wrong integrity", {}, `sha512-${Buffer.alloc(64, 1).toString("base64")}`],
    ["corrupted closure", { corruptInstall: "@zhixing-ai/core" }, accepted],
    ["broken entry", { brokenCli: true }, accepted],
    ["no org role", { orgRole: "none" }, accepted],
  ];
  for (const [label, patch, integrity] of rejected) {
    const saved = await state(fixture);
    await patchState(fixture, patch);
    const result = await publish(fixture, ["promote", "--accepted-integrity", integrity, "--confirm-publish"]);
    assert.notEqual(result.code, 0, label);
    assert.equal(latestMoves(await state(fixture)).length, 0, `${label} must not move latest`);
    await writeFile(fixture.stateFile, JSON.stringify({ ...saved, calls: (await state(fixture)).calls }));
  }
  const promoted = await publish(fixture, ["promote", "--accepted-integrity", accepted, "--confirm-publish"]);
  assert.equal(promoted.code, 0, promoted.stderr);
  const after = await state(fixture);
  assert.equal(after.registry["zhixing"].tags.latest, fixture.version);
  assert.equal(latestMoves(after).length, 1);
  const again = await publish(fixture, ["promote", "--accepted-integrity", accepted, "--confirm-publish"]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(latestMoves(await state(fixture)).length, 1, "a repeated promote must not re-tag");
});

test("promote refuses prerelease and unpublished versions without moving latest", async () => {
  const prerelease = await createFixture("1.0.0-rc.1");
  assert.equal((await publish(prerelease, candidateArgs(prerelease))).code, 0);
  const accepted = (await state(prerelease)).registry["zhixing"].versions[prerelease.version].integrity;
  const callsBefore = (await state(prerelease)).calls.length;
  const result = await publish(prerelease, ["promote", "--accepted-integrity", accepted, "--confirm-publish"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /预发布版本/u);
  assert.equal((await state(prerelease)).calls.length, callsBefore, "prerelease refusal happens before any registry call");

  const missing = await createFixture();
  const unpublished = await publish(missing, ["promote", "--accepted-integrity", accepted, "--confirm-publish"]);
  assert.notEqual(unpublished.code, 0);
  assert.equal(latestMoves(await state(missing)).length, 0);
});

async function createFixture(version = "1.0.0") {
  const directory = await mkdtemp(path.join(tmpdir(), "zhixing-publish-test-"));
  workspaces.push(directory);
  const repository = path.join(directory, "repo");
  const manifests = {
    "packages/core": { name: "@zhixing-ai/core", version },
    "packages/tools": { name: "@zhixing-ai/tools", version, dependencies: { "@zhixing-ai/core": version } },
    "packages/cli": {
      name: "zhixing", version, dependencies: { "@zhixing-ai/tools": version, "@zhixing-ai/core": version },
      devDependencies: { "@zhixing-ai/internal": version, "@zhixing-ai/channel-feishu": version, typescript: "^5.8.3" },
    },
    "packages/channels/feishu": { name: "@zhixing-ai/channel-feishu", version, dependencies: { "@zhixing-ai/core": version } },
    "packages/internal": { name: "@zhixing-ai/internal", version, private: true },
  };
  await mkdir(path.join(repository, "scripts"), { recursive: true });
  await copyFile(path.join(scripts, "publish-npm.mjs"), path.join(repository, "scripts", "publish-npm.mjs"));
  await writeFile(path.join(repository, "package.json"), JSON.stringify({ name: "fixture", version, private: true }));
  for (const [relative, manifest] of Object.entries(manifests)) {
    await mkdir(path.join(repository, relative), { recursive: true });
    await writeFile(path.join(repository, relative, "package.json"), JSON.stringify(manifest));
  }
  const fixture = {
    directory, repository, version, manifests,
    tarballs: path.join(directory, "npm-candidate"),
    stateFile: path.join(directory, "registry", "state.json"),
    bin: path.join(directory, "bin"),
    frozen: new Map(),
  };
  await mkdir(fixture.tarballs);
  for (const manifest of Object.values(manifests)) {
    if (!manifest.private) await writePackageTarball(fixture, manifest.name);
  }
  await mkdir(path.dirname(fixture.stateFile));
  await writeFile(fixture.stateFile, JSON.stringify({
    identity: "maintainer", tfa: "auth-and-writes", orgRole: "owner", access: "read-write",
    lockDrift: "stable", registry: {}, calls: [],
  }));
  await mkdir(fixture.bin);
  const fake = path.join(scripts, "publish-npm.fake-npm.mjs");
  if (process.platform === "win32") {
    await writeFile(path.join(fixture.bin, "npm.cmd"), `@"${process.execPath}" "${fake}" %*\r\n`);
  } else {
    await writeFile(path.join(fixture.bin, "npm"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    await chmod(path.join(fixture.bin, "npm"), 0o755);
  }
  return fixture;
}

async function writePackageTarball(fixture, name, extra = {}) {
  const manifest = Object.values(fixture.manifests).find((item) => item.name === name);
  const staging = await mkdtemp(path.join(fixture.directory, "staging-"));
  await mkdir(path.join(staging, "package", "dist"), { recursive: true });
  await writeFile(path.join(staging, "package", "package.json"), JSON.stringify({ ...manifest, ...extra }));
  const entry = name === "zhixing"
    ? `const arg = process.argv[2];\nif (arg === "--version") console.log(${JSON.stringify(fixture.version)});\nelse if (arg === "--help") console.log("help");\nelse process.exit(2);\n`
    : "export {};\n";
  await writeFile(path.join(staging, "package", "dist", "index.js"), entry);
  const file = path.join(fixture.tarballs, fileName(name, fixture.version));
  execFileSync(systemTar, ["-czf", file, "-C", staging, "package"]);
  fixture.frozen.set(name, await readFile(file));
}

async function writeCliWithTail(fixture, tail) {
  const manifest = fixture.manifests["packages/cli"];
  const staging = await mkdtemp(path.join(fixture.directory, "staging-cli-"));
  await mkdir(path.join(staging, "package", "dist"), { recursive: true });
  await writeFile(path.join(staging, "package", "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(staging, "package", "dist", "index.js"), `console.log(${JSON.stringify(fixture.version)});\n`);
  await writeFile(path.join(staging, "package", "tail.bin"), tail);
  const file = path.join(fixture.tarballs, fileName(manifest.name, fixture.version));
  // 显式列出条目，保证 tail.bin 是最后一个条目。
  execFileSync(systemTar, ["-czf", file, "-C", staging, "package/package.json", "package/dist/index.js", "package/tail.bin"]);
  const bytes = await readFile(file);
  fixture.frozen.set(manifest.name, bytes);
  return bytes;
}

async function seedRegistry(fixture, name, bytes, version, tags = { latest: version }) {
  const stored = path.join(path.dirname(fixture.stateFile), "seed", `${fileName(name, version)}`);
  await mkdir(path.dirname(stored), { recursive: true });
  await writeFile(stored, bytes);
  const current = await state(fixture);
  current.registry[name] = {
    versions: { [version]: { integrity: integrityOf(bytes), file: stored } },
    tags,
  };
  await writeFile(fixture.stateFile, JSON.stringify(current));
}

async function appendEntries(tarball, entries) {
  const staging = await mkdtemp(path.join(tmpdir(), "zhixing-publish-append-"));
  workspaces.push(staging);
  const tarFile = path.join(staging, "candidate.tar");
  await writeFile(tarFile, gunzipSync(tarball));
  for (const [entry, content] of Object.entries(entries)) {
    await mkdir(path.join(staging, path.dirname(entry)), { recursive: true });
    await writeFile(path.join(staging, entry), content);
    execFileSync(systemTar, ["-rf", tarFile, "-C", staging, entry]);
  }
  return gzipSync(await readFile(tarFile));
}

async function assertAppendedOnly(verified, final) {
  const original = gunzipSync(verified);
  const appended = gunzipSync(final);
  let end = original.length;
  while (end > 0 && original[end - 1] === 0) end -= 1;
  assert.ok(appended.subarray(0, end).equals(original.subarray(0, end)), "verified entries must stay byte-identical");
  const staging = await mkdtemp(path.join(tmpdir(), "zhixing-publish-list-"));
  workspaces.push(staging);
  const list = async (bytes, name) => {
    const file = path.join(staging, name);
    await writeFile(file, bytes);
    return execFileSync(systemTar, ["-tzf", file], { encoding: "utf8" }).split(/\r?\n/u).filter(Boolean);
  };
  assert.deepEqual(await list(final, "final.tgz"), [...await list(verified, "verified.tgz"), SHRINKWRAP]);
}

async function publish(fixture, args) {
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const env = { ...process.env, [pathKey]: `${fixture.bin}${path.delimiter}${process.env[pathKey]}`, FAKE_NPM_STATE: fixture.stateFile, ZHIXING_ALLOW_NPM_PUBLISH: "1" };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(fixture.repository, "scripts", "publish-npm.mjs"), ...args], {
      cwd: fixture.repository, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function candidateArgs(fixture, sha = fingerprint(fixture)) {
  return ["candidate", "--tarballs", fixture.tarballs, "--tarball-sha256", sha, "--confirm-publish"];
}

function fingerprint(fixture) {
  const hash = createHash("sha256");
  for (const [name, bytes] of [...fixture.frozen.entries()].sort(([a], [b]) => a.localeCompare(b, "en-US"))) {
    hash.update(name);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function state(fixture) {
  return JSON.parse(await readFile(fixture.stateFile, "utf8"));
}

async function patchState(fixture, patch) {
  const { seed: _seed, ...rest } = patch;
  await writeFile(fixture.stateFile, JSON.stringify({ ...await state(fixture), ...rest }));
}

function writes(current) {
  return current.calls.filter(([verb]) => verb === "publish" || verb === "dist-tag");
}

function latestMoves(current) {
  return current.calls.filter(([verb, action, , tag]) => verb === "dist-tag" && action === "add" && tag === "latest");
}

function fileName(name, version) {
  return `${name.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
}

function integrityOf(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
