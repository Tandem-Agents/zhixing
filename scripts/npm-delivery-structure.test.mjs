import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
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
  for (const packageRoot of await packageDirectories()) {
    const manifest = await json(path.join(packageRoot, "package.json"));
    if (manifest.private === true) continue;
    assert.equal(manifest.version, rootManifest.version, `${manifest.name} version`);
    assert.equal(manifest.engines?.node, ">=24.0.0", `${manifest.name} Node boundary`);
    assert.equal(manifest.license, "MIT", `${manifest.name} license`);
    assert.equal(manifest.publishConfig?.access, "public", `${manifest.name} publish access`);
    for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
      assert.equal(typeof manifest.scripts?.[name], "undefined", `${manifest.name} ${name}`);
    }
    assert.ok(Array.isArray(manifest.files) && manifest.files.includes("dist"), `${manifest.name} files`);
  }
});

test("npm publish command defaults to a zero-write instruction", async () => {
  const result = await run(process.execPath, [path.join(root, "scripts", "publish-npm.mjs")]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /未写入 npm/u);
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
