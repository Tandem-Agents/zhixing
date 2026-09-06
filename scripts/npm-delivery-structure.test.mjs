import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const canonicalRepositoryUrl = "https://github.com/Tandem-Agents/zhixing.git";
const canonicalHomepage = "https://github.com/Tandem-Agents/zhixing#readme";
const canonicalIssues = "https://github.com/Tandem-Agents/zhixing/issues";
const removed = [
  "packages/cli/src/generated/release-channel.ts",
  "packages/cli/src/runtime/rpc-program-update-facade.ts",
  "packages/cli/src/update",
  "packages/core/src/protocol/release.ts",
  "scripts/build-program-tree.mjs",
  "scripts/build-release-artifact.mjs",
  "scripts/release-channel.mjs",
  "scripts/release-check.mjs",
  "scripts/release-target-evidence.mjs",
  "scripts/release-tooling.mjs",
];

test("production graph has one npm delivery path and no retired update owner", async () => {
  for (const relative of removed) {
    assert.equal(await exists(path.join(root, relative)), false, `${relative} must stay removed`);
  }
  const manifest = await json(path.join(root, "package.json"));
  for (const name of [
    "release:channel:embed", "release:program-tree", "release:artifact",
    "release:target-evidence", "release:tooling:test", "release:check",
  ]) assert.equal(manifest.scripts?.[name], undefined, `${name} must stay removed`);

  const productionFiles = [
    ...await sourceFiles(path.join(root, "packages", "cli", "src")),
    ...await sourceFiles(path.join(root, "packages", "server", "src")),
    ...await sourceFiles(path.join(root, "packages", "core", "src")),
  ].filter((file) => !file.endsWith(".test.ts") && !file.includes(`${path.sep}__tests__${path.sep}`));
  const forbidden = [
    "ProgramStore", "ProgramUpdateReceipt", "EMBEDDED_RELEASE_TRUST",
    "server.update.", "lifecycleUpgrade", "startAutomaticUpdateCheck",
    "program-installer", "program-root-removal", "--restore-previous",
  ];
  for (const file of productionFiles) {
    const text = await readFile(file, "utf8");
    for (const marker of forbidden) {
      assert.equal(text.includes(marker), false, `${path.relative(root, file)} retains ${marker}`);
    }
  }
});

test("public package manifests expose only prebuilt assets and no lifecycle installer", async () => {
  const rootManifest = await json(path.join(root, "package.json"));
  let publicPackageCount = 0;
  for (const packageRoot of await packageDirectories()) {
    const manifest = await json(path.join(packageRoot, "package.json"));
    if (manifest.private === true) continue;
    publicPackageCount += 1;
    assert.equal(manifest.version, rootManifest.version, `${manifest.name} version`);
    assert.equal(manifest.engines?.node, ">=24.0.0", `${manifest.name} Node boundary`);
    assert.equal(manifest.license, "MIT", `${manifest.name} license`);
    assert.equal(manifest.publishConfig?.access, "public", `${manifest.name} publish access`);
    assert.equal(typeof manifest.description, "string", `${manifest.name} description`);
    assert.notEqual(manifest.description.trim(), "", `${manifest.name} description`);
    assert.deepEqual(manifest.repository, {
      type: "git",
      url: canonicalRepositoryUrl,
      directory: path.relative(root, packageRoot).split(path.sep).join("/"),
    }, `${manifest.name} repository`);
    assert.equal(manifest.homepage, canonicalHomepage, `${manifest.name} homepage`);
    assert.deepEqual(manifest.bugs, { url: canonicalIssues }, `${manifest.name} bugs`);
    const readme = await readFile(path.join(packageRoot, "README.md"), "utf8");
    assertPackageReadme(readme, manifest.name);
    for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
      assert.equal(typeof manifest.scripts?.[name], "undefined", `${manifest.name} ${name}`);
    }
    assert.ok(Array.isArray(manifest.files) && manifest.files.includes("dist"), `${manifest.name} files`);
  }
  assert.equal(publicPackageCount, 16, "public package count");
  const expressiveReadme = [
    "# Runtime building blocks",
    "",
    "Install `@zhixing/cli` and follow the project documentation.",
    `[Zhixing](${canonicalHomepage}) also requires [Node.js](https://nodejs.org/).`,
    "Released under MIT.",
  ].join("\n");
  assert.doesNotThrow(() => assertPackageReadme(expressiveReadme, "README example"));
  assert.throws(() => assertPackageReadme(" \n", "empty README"), /README content/u);
});

test("npm publish command defaults to a zero-write instruction", async () => {
  const result = await run(process.execPath, [path.join(root, "scripts", "publish-npm.mjs")]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /未写入 npm/u);
});

test("Glob and Grep use the patched external brace expansion chain", async () => {
  const [globSource, grepCandidates, rootManifest, cliManifest, lockfile, publishSource] = await Promise.all([
    readFile(path.join(root, "packages", "tools-builtin", "src", "glob.ts"), "utf8"),
    readFile(path.join(root, "packages", "tools-builtin", "src", "grep", "candidate-files.ts"), "utf8"),
    json(path.join(root, "package.json")),
    json(path.join(root, "packages", "cli", "package.json")),
    readFile(path.join(root, "pnpm-lock.yaml"), "utf8"),
    readFile(path.join(root, "scripts", "publish-npm.mjs"), "utf8"),
  ]);
  for (const [label, source] of [["Glob", globSource], ["Grep", grepCandidates]]) {
    assert.match(source, /from\s+["']glob\/raw["']/u, `${label} must use glob/raw`);
    assert.doesNotMatch(source, /from\s+["']glob["']/u, `${label} must not use bundled glob`);
  }
  const selector = "brace-expansion@>=5.0.0 <5.0.9";
  assert.equal(rootManifest.pnpm?.overrides?.[selector], "5.0.9", "workspace patched brace override");
  assert.equal(cliManifest.overrides?.[selector], "5.0.9", "CLI shrinkwrap patched brace override");
  assert.match(lockfile, /^  brace-expansion@5\.0\.9:$/mu, "workspace lock must contain patched brace");
  assert.doesNotMatch(lockfile, /^  brace-expansion@5\.0\.[0-8]:$/mu, "workspace lock retains vulnerable brace");
  assert.match(publishSource, /locked\?\.version !== "5\.0\.9"/u, "publish candidate must pin patched brace");
  assert.match(publishSource, /typeof locked\.integrity !== "string"/u, "publish candidate must require brace integrity");
});

async function packageDirectories() {
  const result = [];
  for (const parent of [path.join(root, "packages"), path.join(root, "packages", "channels")]) {
    for (const name of await readdir(parent)) {
      const directory = path.join(parent, name);
      if ((await stat(directory)).isDirectory() && await exists(path.join(directory, "package.json"))) {
        result.push(directory);
      }
    }
  }
  return result;
}

async function sourceFiles(directory) {
  const result = [];
  for (const name of await readdir(directory)) {
    const full = path.join(directory, name);
    const entry = await stat(full);
    if (entry.isDirectory()) result.push(...await sourceFiles(full));
    else if (name.endsWith(".ts")) result.push(full);
  }
  return result;
}

async function exists(file) {
  try { await stat(file); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: { ...process.env, ZHIXING_ALLOW_NPM_PUBLISH: "" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function assertPackageReadme(readme, packageName) {
  assert.notEqual(readme.trim(), "", `${packageName} README content`);
  assert.match(readme, /@zhixing\/cli/u, `${packageName} README user installation entry`);
  assert.ok(readme.includes(canonicalHomepage), `${packageName} README canonical documentation`);
  assert.match(readme, /MIT/u, `${packageName} README license`);
}
