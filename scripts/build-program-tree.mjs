import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  RELEASE_TARGETS,
  assertReleaseNodeVersion,
  assertProgramTreeContract,
  canonicalize,
  collectProgramFiles,
  digest,
  programTreeDigest,
  stableProgramLoaderSource,
} from "./release-tooling.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const target = required("--target");
if (!RELEASE_TARGETS.includes(target)) throw new Error("release target is outside the stable exact-set");
const runtimePath = resolve(required("--node-runtime"));
const runtimeEvidence = exact(
  JSON.parse(await readFile(resolve(required("--node-evidence")), "utf8")),
  ["digest", "nodeVersion", "passed", "target", "v"],
  "Node runtime evidence",
);
if (
  runtimeEvidence.v !== 1 || runtimeEvidence.passed !== true || runtimeEvidence.target !== target ||
  runtimeEvidence.digest !== digest(await readFile(runtimePath))
) throw new Error("Node runtime evidence does not bind the selected target runtime");
const nodeVersion = assertReleaseNodeVersion(runtimeEvidence.nodeVersion);
const outputRoot = resolve(required("--output"));
const channelSource = await readFile(
  resolve(repositoryRoot, "packages/cli/src/generated/release-channel.ts"),
  "utf8",
);
const channel = parseEmbeddedChannel(channelSource);

await atomicDirectory(outputRoot, async (temporary) => {
  const deployed = `${temporary}.deploy`;
  await rm(deployed, { recursive: true, force: true });
  runPnpm(["--filter", "@zhixing/cli", "deploy", "--prod", deployed]);
  await cp(deployed, resolve(temporary, "app"), { recursive: true, dereference: true });
  await rm(deployed, { recursive: true, force: true });
  await pruneDeployment(resolve(temporary, "app"));

  const runtimeName = target === "win32-x64" ? "node.exe" : "node";
  if (basename(runtimePath).toLowerCase() !== runtimeName) {
    throw new Error(`target runtime must be named ${runtimeName}`);
  }
  await mkdir(resolve(temporary, "runtime"), { recursive: true });
  await cp(runtimePath, resolve(temporary, "runtime", runtimeName));

  await mkdir(resolve(temporary, "installer"), { recursive: true });
  await writeFile(
    resolve(temporary, "installer", "launch.js"),
    stableProgramLoaderSource(target, "app/dist/index.js"),
    "utf8",
  );
  await writeFile(
    resolve(temporary, "installer", "program-installer.js"),
    stableProgramLoaderSource(target, "app/dist/program-installer.js"),
    "utf8",
  );
  await mkdir(resolve(temporary, "bin"), { recursive: true });
  if (target === "win32-x64") {
    await writeFile(resolve(temporary, "bin", "zz.cmd"), windowsLauncher(), "utf8");
    await writeFile(resolve(temporary, "bin", "zhixing.cmd"), windowsLauncher(), "utf8");
  } else {
    await writeFile(resolve(temporary, "bin", "zz"), unixLauncher(), { encoding: "utf8", mode: 0o755 });
    await writeFile(resolve(temporary, "bin", "zhixing"), unixLauncher(), { encoding: "utf8", mode: 0o755 });
  }

  const appFiles = await collectProgramFiles(resolve(temporary, "app"));
  const receipt = {
    v: 1,
    target,
    nodeVersion,
    runtimeDigest: runtimeEvidence.digest,
    appTreeDigest: programTreeDigest(appFiles),
    indexUrl: channel.indexUrl,
    keyId: channel.keyId,
  };
  await writeFile(resolve(temporary, "program-tree-receipt.json"), canonicalize(receipt), "utf8");
  assertProgramTreeContract(await collectProgramFiles(temporary), target);
});

function runPnpm(args) {
  const result = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed`);
}

async function pruneDeployment(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filePath = join(root, entry.name);
    if (
      entry.name === ".bin" || entry.name.endsWith(".map") ||
      /^(?:__tests__|test|tests)$/u.test(entry.name) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name)
    ) {
      await rm(filePath, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) {
      await pruneDeployment(filePath);
      continue;
    }
    if (entry.isFile() && entry.name === "package.json") {
      const value = JSON.parse(await readFile(filePath, "utf8"));
      delete value.devDependencies;
      delete value.scripts;
      delete value.pnpm;
      await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    }
  }
}

function windowsLauncher() {
  return "@echo off\r\n\"%~dp0..\\runtime\\node.exe\" \"%~dp0..\\installer\\launch.js\" %*\r\n";
}

function unixLauncher() {
  return "#!/bin/sh\nexec \"$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd)/runtime/node\" \"$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd)/installer/launch.js\" \"$@\"\n";
}

function parseEmbeddedChannel(source) {
  if (/STABLE_RELEASE_INDEX_URL[^=]*=\s*undefined/u.test(source) || /EMBEDDED_RELEASE_TRUST[^=]*=\s*undefined/u.test(source)) {
    throw new Error("stable release channel and trust must be embedded before building program trees");
  }
  const indexUrl = source.match(/STABLE_RELEASE_INDEX_URL[^=]*=\s*"([^"]+)"/u)?.[1];
  const keyId = source.match(/"keyId":"([A-Za-z0-9._-]+)"/u)?.[1];
  if (!indexUrl || !keyId || new URL(indexUrl).protocol !== "https:") {
    throw new Error("embedded stable release channel is invalid");
  }
  return { indexUrl, keyId };
}

function required(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${flag} is required`);
  return process.argv[index + 1];
}

function exact(input, fields, label) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([...fields].sort())) {
    throw new Error(`${label} is not exact`);
  }
  return input;
}

async function atomicDirectory(final, write) {
  const temporary = `${final}.${process.pid}.tmp`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    await write(temporary);
    await rm(final, { recursive: true, force: true });
    await rename(temporary, final);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    await rm(`${temporary}.deploy`, { recursive: true, force: true });
    throw error;
  }
}
