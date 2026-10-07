import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { CHECKPOINT_BRIDGE_TARGETS, checkpointBridgeTarget, assertCheckpointBridgeHost, currentGlibcVersion, verifyCheckpointBridgeArtifact } from "../packages/mesh/src/checkpoint-bridge-artifact.ts";

const root = path.resolve(import.meta.dirname, "..");
const canonicalRepositoryUrl = "https://github.com/Tandem-Agents/zhixing.git";
const canonicalHomepage = "https://github.com/Tandem-Agents/zhixing#readme";
const canonicalIssues = "https://github.com/Tandem-Agents/zhixing/issues";
const skipBuild = process.argv.includes("--skip-build");
const allTargets = process.argv.includes("--all-targets");
// A single POSIX pack preserves executable modes for every target. Other
// hosts install those exact npm tarballs instead of repacking them on NTFS.
const inputTarballs = directoryOption("--tarballs");
const outputTarballs = directoryOption("--pack-only");
assert(!(inputTarballs && outputTarballs), "--tarballs 与 --pack-only 不可同时使用");
assert(!(allTargets && process.platform === "win32" && !inputTarballs), "五目标 npm tarball 必须在 POSIX 打包以保留可执行位；Windows 使用 --tarballs <目录> 验证同一组包");
const terminalInputBytes = await readFile(path.join(root, "packages/terminal-ui/native/build-inputs.json"));
const terminalInputs = JSON.parse(terminalInputBytes);
// Canonical JSON avoids checkout CRLF/LF differences between the five hosts.
const terminalInputHash = createHash("sha256").update(JSON.stringify(terminalInputs)).digest("hex");
const hostTarget = checkpointBridgeTarget();
const command = process.platform === "win32" ? (name) => `${name}.cmd` : (name) => name;
const temporary = await mkdtemp(path.join(root, ".zhixing-package-check-"));
const npmEnv = { ...process.env };
for (const key of Object.keys(npmEnv)) {
  if (["npm_config_cache", "npm_config_userconfig", "npm_config_verify_deps_before_run"].includes(key.toLowerCase())) {
    delete npmEnv[key];
  }
}
npmEnv.npm_config_cache = path.join(temporary, "npm-cache");
npmEnv.npm_config_userconfig = path.join(temporary, "empty-npmrc");

try {
  assertCheckpointBridgeHost(hostTarget, currentGlibcVersion());
  await writeFile(npmEnv.npm_config_userconfig, "", "utf8");
  await run(process.execPath, ["--test", "scripts/npm-delivery-structure.test.mjs"], root);
  if (!skipBuild) await run(command("pnpm"), ["build"], root);
  const rootManifest = await json(path.join(root, "package.json"));
  const packages = await publicPackages(rootManifest.version);
  const tarballDir = inputTarballs ?? outputTarballs ?? path.join(temporary, "tarballs");
  if (!inputTarballs) await mkdir(tarballDir);
  if (inputTarballs) {
    const expected = packages.map(item => `${item.name.replace(/^@/u, "").replaceAll("/", "-")}-${rootManifest.version}.tgz`).sort();
    assert(JSON.stringify((await readdir(tarballDir)).sort()) === JSON.stringify(expected), "预打包目录并非当前版本的完整公开包集合");
  }
  const tarballs = [];
  for (const item of packages) {
    let tarball;
    if (inputTarballs) tarball = path.join(tarballDir, `${item.name.replace(/^@/u, "").replaceAll("/", "-")}-${rootManifest.version}.tgz`);
    else {
      const before = new Set(await readdir(tarballDir));
      await run(command("pnpm"), ["pack", "--pack-destination", tarballDir], item.directory);
      const added = (await readdir(tarballDir)).filter((name) => !before.has(name));
      assert(added.length === 1 && added[0].endsWith(".tgz"), `${item.name} 未生成唯一 tarball`);
      tarball = path.join(tarballDir, added[0]);
    }
    await inspectTarball(item, tarball, rootManifest.version);
    tarballs.push({ ...item, tarball });
  }
  const tarballFingerprint = await fingerprintTarballs(tarballs);

  if (outputTarballs) {
    console.log(`package:check pack-only：${packages.length} 个包已检查并保存至 ${outputTarballs}；tarball sha256 ${tarballFingerprint}；尚未执行安装或运行验证`);
  } else {
    const installRoot = path.join(temporary, "consumer");
    const home = path.join(temporary, "user-home");
    await mkdir(installRoot);
    await mkdir(home);
    await writeFile(path.join(home, "sentinel.txt"), "keep", "utf8");
    await writeFile(path.join(installRoot, "package.json"), `${JSON.stringify({
      name: "zhixing-package-consumer",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: Object.fromEntries(tarballs.map(({ name, tarball }) => [name, `file:${tarball}`])),
    }, null, 2)}\n`, "utf8");
    await run(command("npm"), ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], installRoot, npmEnv);
    await verifyInstalledClosure(installRoot, packages, rootManifest.version);
    await verifyPublicEntrypoints(installRoot, packages);
    await verifyInstalledBraceExpansionBoundary(installRoot);
    await verifyCli(installRoot, home, rootManifest.version);
    await verifyTerminalClosure(path.join(installRoot, "node_modules/@zhixing/cli"), rootManifest.version);
    await verifyInstalledTerminalNative(installRoot, home);
    await verifyPlatformHelper(installRoot, home);
    await run(command("npm"), ["uninstall", "--ignore-scripts", "--no-audit", "--no-fund", "@zhixing/cli"], installRoot, npmEnv);
    assert(await exists(path.join(home, "sentinel.txt")), "npm 卸载影响了 ZHIXING_HOME");
    console.log(
      `package:check 通过：${packages.length} 个公开包，${hostTarget.id} 本地安装闭包可消费；tarball sha256 ${tarballFingerprint}`,
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function publicPackages(version) {
  const directories = [];
  for (const parent of [path.join(root, "packages"), path.join(root, "packages", "channels")]) {
    for (const name of await readdir(parent)) {
      const directory = path.join(parent, name);
      if (!(await stat(directory)).isDirectory() || !await exists(path.join(directory, "package.json"))) continue;
      const manifest = await json(path.join(directory, "package.json"));
      if (manifest.private === true) continue;
      assert(manifest.version === version, `${manifest.name} 版本未与发布版本全等`);
      assert(manifest.engines?.node === ">=24.0.0", `${manifest.name} Node 下界不一致`);
      assert(manifest.license === "MIT" && manifest.repository && manifest.publishConfig?.access === "public", `${manifest.name} 发布元数据不完整`);
      assertPublicPackageMetadata(manifest, path.relative(root, directory).split(path.sep).join("/"));
      assertPackageReadme(await readFile(path.join(directory, "README.md"), "utf8"), manifest.name);
      assertNoLifecycleScripts(manifest, manifest.name);
      directories.push({ name: manifest.name, directory, manifest });
    }
  }
  return directories.sort((a, b) => a.name.localeCompare(b.name, "en-US"));
}

async function inspectTarball(item, tarball, version) {
  const extractRoot = path.join(temporary, "inspect", item.name.replaceAll("/", "_").replaceAll("@", ""));
  await mkdir(extractRoot, { recursive: true });
  await run("tar", ["-xzf", tarball, "-C", extractRoot], root);
  const packageRoot = path.join(extractRoot, "package");
  const manifest = await json(path.join(packageRoot, "package.json"));
  assert(manifest.version === version, `${item.name} packed version 漂移`);
  assertPublicPackageMetadata(manifest, path.relative(root, item.directory).split(path.sep).join("/"));
  assertNoLifecycleScripts(manifest, item.name);
  for (const [name, value] of Object.entries(manifest.dependencies ?? {})) {
    assert(typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value), `${item.name} 依赖 ${name} 不是 exact registry version`);
    assert(!value.includes("workspace:") && !value.startsWith("file:") && !value.startsWith("link:"), `${item.name} tarball 泄漏本地依赖`);
  }
  const files = await relativeFiles(packageRoot);
  for (const file of files) {
    const allowed = file === "package.json" || /^(?:README|LICENSE)(?:\.|$)/iu.test(file) || file.startsWith("dist/") ||
      (item.name === "@zhixing/mesh" && CHECKPOINT_BRIDGE_TARGETS.some((target) =>
        file === `build/prebuilt/${target.id}/${target.file}` || file === `build/prebuilt/${target.id}/descriptor.json`));
    assert(allowed, `${item.name} tarball 含未声明资产：${file}`);
  }
  assert(files.includes("README.md"), `${item.name} tarball 缺少 README.md`);
  assert(files.includes("LICENSE"), `${item.name} tarball 缺少 LICENSE`);
  const [readme, packedLicense, rootLicense] = await Promise.all([
    readFile(path.join(packageRoot, "README.md"), "utf8"),
    readFile(path.join(packageRoot, "LICENSE"), "utf8"),
    readFile(path.join(root, "LICENSE"), "utf8"),
  ]);
  assertPackageReadme(readme, item.name);
  assert(packedLicense === rootLicense, `${item.name} tarball LICENSE 与仓库根许可不一致`);
  if (item.name === "@zhixing/mesh") {
    for (const target of CHECKPOINT_BRIDGE_TARGETS) {
      const included = files.some((file) => file.startsWith(`build/prebuilt/${target.id}/`));
      if (allTargets || included || target.id === hostTarget.id) verifyCheckpointBridgeArtifact(packageRoot, target);
    }
  }
  if (item.name === "@zhixing/cli") await verifyTerminalClosure(packageRoot, version);
}

function directoryOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  assert(typeof value === "string" && value.length > 0 && !value.startsWith("--"), `${name} 需要目录参数`);
  return path.resolve(value);
}

async function verifyTerminalClosure(packageRoot, version) {
  const directory = path.join(packageRoot, "dist/terminal");
  const entries = await readdir(directory, { withFileTypes: true });
  const targets = Object.keys(terminalInputs.targets);
  assert(JSON.stringify([...targets].sort()) === JSON.stringify(CHECKPOINT_BRIDGE_TARGETS.map(target => target.id).sort()), "terminal 与平台五目标集合不一致");
  for (const entry of entries) assert(entry.isDirectory() && (entry.name === "shared" || targets.includes(entry.name)), `未知 terminal 资产：${entry.name}`);
  for (const name of ["protocol", "channel", "parent-transport", "body-model", "skills-model"]) {
    for (const extension of ["js", "d.ts"]) assert((await stat(path.join(directory, `shared/${name}.${extension}`))).size > 0, `缺少 terminal shared/${name}.${extension}`);
  }
  for (const id of targets) {
    if (!allTargets && id !== hostTarget.id && !entries.some(entry => entry.name === id)) continue;
    const target = terminalInputs.targets[id], targetRoot = path.join(directory, id);
    const manifest = await json(path.join(targetRoot, "manifest.json"));
    assert(manifest.protocol === "zhixing-terminal/1" && manifest.packageVersion === version && `${manifest.platform}-${manifest.arch}` === id, `${id} terminal 版本/目标不匹配`);
    for (const name of ["bun", "opentui", "solid"]) assert(manifest[name] === terminalInputs.versions[name], `${id} ${name} 版本不匹配`);
    assert(manifest.nativeCommit === terminalInputs.opentui.commit && manifest.buildInputs?.definitionSha256 === terminalInputHash, `${id} terminal 固定输入身份不匹配`);
    assert(manifest.buildInputs.zig === terminalInputs.versions.zig && typeof manifest.buildInputs.nativeCompilerVersion === "string" && manifest.buildInputs.nativeCompilerVersion.length > 0, `${id} 原生编译器记录缺失`);
    assert(id.startsWith("darwin-") ? manifest.buildInputs.recoveryZig === null : ["0.14.1", "0.16.0"].includes(manifest.buildInputs.recoveryZig), `${id} 恢复编译器记录不正确`);
    if (allTargets) {
      assert(manifest.buildInputs.verifiedArchives === true && manifest.buildInputs.node === terminalInputs.versions.node &&
        manifest.buildInputs.recoveryZig === (id.startsWith("darwin-") ? null : terminalInputs.versions.recoveryZig), `${id} 不是经固定 archive 校验的发布制品`);
    }
    const nodeFiles = manifest.buildInputs.nodeFiles;
    const expectedNodeFiles = [...terminalInputs.node.headerFiles, ...(id === "win32-x64" ? ["node.lib"] : [])].sort();
    assert(Array.isArray(nodeFiles) && JSON.stringify(nodeFiles.map(item => item.name).sort()) === JSON.stringify(expectedNodeFiles) &&
      nodeFiles.every(item => /^[0-9a-f]{64}$/u.test(item.sha256)), `${id} Node 开发输入记录不完整`);
    if (manifest.buildInputs.verifiedArchives && id === "win32-x64") assert(nodeFiles.find(item => item.name === "node.lib").sha256 === terminalInputs.node.windowsLibrary.sha256, "Windows node.lib 不属于固定 Node 24.0.0");
    const binaries = [`ui${target.suffix}`, `recovery${target.suffix}`, target.library, "foreground.node", ...(id.startsWith("win32-") ? [] : ["exec-gate"])];
    const expectedFiles = [...binaries, ...terminalInputs.requiredAssets].sort();
    const actualFiles = (await relativeFiles(targetRoot)).filter(name => name !== "manifest.json").sort();
    assert(JSON.stringify(actualFiles) === JSON.stringify(expectedFiles), `${id} terminal worker/grammar/assets/notices 或二进制闭包不完整`);
    assert(Array.isArray(manifest.artifacts) && JSON.stringify(manifest.artifacts.map(item => item.name).sort()) === JSON.stringify(expectedFiles), `${id} terminal manifest 未完整覆盖制品`);
    for (const artifact of manifest.artifacts) {
      const file = path.join(targetRoot, artifact.name), content = await readFile(file), metadata = await stat(file);
      assert(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0 && artifact.bytes === content.length && /^[0-9a-f]{64}$/u.test(artifact.sha256) &&
        createHash("sha256").update(content).digest("hex") === artifact.sha256, `${id}/${artifact.name} 大小/哈希不符`);
      if (binaries.includes(artifact.name)) assertTerminalBinary(content, id, artifact.name);
      if (process.platform !== "win32" && !id.startsWith("win32-") && ["ui", "recovery", "exec-gate"].includes(artifact.name)) {
        assert((metadata.mode & 0o111) !== 0, `${id}/${artifact.name} 丢失可执行权限`);
      }
    }
  }
}

function assertTerminalBinary(bytes, id, name) {
  const [platform, arch] = id.split("-");
  let valid = false;
  if (bytes.length >= 64 && platform === "win32" && bytes.toString("ascii", 0, 2) === "MZ") {
    const pe = bytes.readUInt32LE(0x3c);
    valid = pe <= bytes.length - 6 && bytes.toString("binary", pe, pe + 4) === "PE\0\0" && bytes.readUInt16LE(pe + 4) === 0x8664;
  } else if (bytes.length >= 64 && platform === "linux") {
    valid = bytes.toString("binary", 0, 4) === "\x7fELF" && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === (arch === "x64" ? 62 : 183);
  } else if (bytes.length >= 32 && platform === "darwin") {
    valid = bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === (arch === "x64" ? 0x01000007 : 0x0100000c);
  }
  assert(valid, `${id}/${name} 不是匹配目标的 64 位原生制品`);
}

async function verifyInstalledTerminalNative(installRoot, home) {
  const target = terminalInputs.targets[hostTarget.id];
  const directory = path.join(installRoot, "node_modules/@zhixing/cli/dist/terminal", hostTarget.id);
  const smoke = [
    'const native = require(process.argv[1]);',
    'for (const name of [process.platform === "win32" ? "create" : "createPosix", "observe", "seal", "executionState", "terminateExecution"]) if (typeof native[name] !== "function") throw Error(`Missing native operation: ${name}`);',
    'const state = native.executionState(); if (state.active !== 0 || state.creating !== 0) throw Error("Unexpected native execution state");',
    'native.seal(); native.terminateExecution();',
  ].join("\n");
  const env = { ...process.env, ZHIXING_HOME: home };
  for (const key of Object.keys(env)) if (key.startsWith("ZHIXING_TERMINAL_")) delete env[key];
  const native = await runOutcomeWithDeadline(process.execPath, ["--eval", smoke, "--", path.join(directory, "foreground.node")], installRoot, env, 15_000);
  assert(native.code === 0 && native.signal === null && !native.timedOut, `安装后的 terminal Node-API 调用失败：${native.stderr}`);
  const ui = await runOutcomeWithDeadline(path.join(directory, `ui${target.suffix}`), [], installRoot, env, 15_000);
  assert(!ui.timedOut && ui.code !== 0 && ui.signal === null && ui.stderr.includes("The terminal UI requires its foreground supervisor."), `安装后的自足 UI 未到达监督者准入边界：${ui.stderr}`);
  console.log(`terminal ${hostTarget.id}: installed Node-API executed; self-contained UI reached admission guard. Interactive S/N/U/R and host input remain separate journey evidence.`);
}

async function verifyInstalledClosure(installRoot, packages, version) {
  for (const item of packages) {
    const manifest = await json(path.join(installRoot, "node_modules", ...item.name.split("/"), "package.json"));
    assert(manifest.version === version, `${item.name} 安装版本不一致`);
  }
  const expectedAudit = await json(path.join(root, "scripts", "npm-production-install-script-audit.json"));
  const actual = [];
  const productionNames = await productionDependencyNames(installRoot, packages.map(({ name }) => name));
  for (const name of productionNames) {
    if (name.startsWith("@zhixing/")) continue;
    const manifest = await json(path.join(installRoot, "node_modules", ...name.split("/"), "package.json"));
    const scripts = ["preinstall", "install", "postinstall"].filter((key) => typeof manifest.scripts?.[key] === "string");
    if (await exists(path.join(installRoot, "node_modules", ...name.split("/"), "binding.gyp")) &&
      !scripts.includes("preinstall") && !scripts.includes("install")) {
      scripts.push("install:node-gyp-rebuild");
    }
    if (scripts.length > 0) actual.push({ name, version: manifest.version, scripts });
  }
  actual.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en-US"));
  const audited = expectedAudit.packages.map(({ name, version: packageVersion, scripts }) => ({
    name,
    version: packageVersion,
    scripts,
  }));
  assert(expectedAudit.packages.every(({ review }) => typeof review === "string" && review.length > 0), "第三方生产安装脚本审计缺少副作用结论");
  assert(
    JSON.stringify(actual) === JSON.stringify(audited),
    `第三方生产安装脚本与审计清单不一致：expected=${JSON.stringify(audited)} actual=${JSON.stringify(actual)}`,
  );
}

async function fingerprintTarballs(tarballs) {
  const hash = createHash("sha256");
  for (const { name, tarball } of [...tarballs].sort((a, b) => a.name.localeCompare(b.name, "en-US"))) {
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(tarball));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function productionDependencyNames(installRoot, roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const manifest = await json(path.join(installRoot, "node_modules", ...name.split("/"), "package.json"));
    queue.push(...Object.keys(manifest.dependencies ?? {}));
  }
  return [...seen];
}

async function verifyPublicEntrypoints(installRoot, packages) {
  for (const { name, manifest } of packages) {
    if (!manifest.exports) continue;
    for (const value of Object.values(manifest.exports)) {
      const target = typeof value === "string" ? value : value.import;
      if (!target) continue;
      await import(pathToFileURL(path.join(installRoot, "node_modules", ...name.split("/"), target)).href);
    }
  }
}

async function verifyCli(installRoot, home, version) {
  const entry = path.join(installRoot, "node_modules", "@zhixing", "cli", "dist", "index.js");
  const env = { ...process.env, ZHIXING_HOME: home, NO_COLOR: "1" };
  // First-run checks may create configuration. Each independent scenario must
  // own its initial state; shared installation does not mean shared user state.
  const scenarioEnv = (scenario) => ({ ...env, ZHIXING_HOME: path.join(home, "cli-scenarios", scenario) });
  const metadata = await import(pathToFileURL(path.join(path.dirname(entry), "metadata.js")).href);
  const versionResult = await run(process.execPath, [entry, "--version"], installRoot, env, true);
  assert(versionResult.stdout.includes(version), "CLI --version 输出不正确");
  const cliManifest = await json(path.join(installRoot, "node_modules/@zhixing/cli/package.json"));
  const binDirectory = path.join(installRoot, "node_modules/.bin");
  for (const name of ["zz", "zhixing"]) {
    assert(["dist/index.js", "./dist/index.js"].includes(cliManifest.bin?.[name]), `${name} 未指向正式 CLI 入口`);
    const executable = process.platform === "win32" ? command(name) : path.join(binDirectory, name);
    const output = await run(executable, ["--version"], binDirectory, env, true);
    assert(output.stdout.includes(version), `npm 安装的 ${name} bin 不可执行`);
    const noTty = await runOutcome(executable, [], binDirectory, scenarioEnv(`non-tty-${name}`), true);
    assert(noTty.code === 2 && noTty.signal === null && `${noTty.stdout}\n${noTty.stderr}`.includes("请在 TTY 终端中运行 `zhixing` 完成配置"), `${name} 非 TTY 入口不正确`);
  }
  const help = await run(process.execPath, [entry, "--help"], installRoot, env, true);
  const helpCommand = await run(process.execPath, [entry, "help"], installRoot, env, true);
  const canonicalHelp = metadata.program.helpInformation().trim();
  assert(help.stdout.trim() === canonicalHelp, "tarball CLI --help 与真实 Commander registry 不一致");
  assert(helpCommand.stdout.trim() === canonicalHelp, "tarball CLI help 与真实 Commander registry 不一致");
  const hiddenTopLevel = metadata.captureCliCommandDescriptor()
    .filter(({ path: commandPath, hidden }) => hidden && /^zhixing [^ ]+$/u.test(commandPath))
    .map(({ path: commandPath }) => commandPath.slice("zhixing ".length));
  for (const command of hiddenTopLevel) {
    assert(!new RegExp(`^  ${command}(?: |$)`, "mu").test(canonicalHelp), `隐藏命令 ${command} 泄漏到 tarball 默认帮助`);
  }
  const doctor = await run(process.execPath, [entry, "doctor"], installRoot, scenarioEnv("doctor-empty"), true);
  assert(doctor.stdout.includes("知行尚未完成首次设置") && doctor.stdout.includes("运行 zz 完成设置"), "空 home 的 doctor 未给出唯一设置行动");
  const maintenance = await run(process.execPath, [entry, "stop", "--maintenance"], installRoot, scenarioEnv("maintenance-empty"), true);
  assert(maintenance.stdout.includes("npm install -g @zhixing/cli@latest"), "maintenance stop 未给出显式 npm 行动");
  const removal = await run(process.execPath, [entry, "app", "remove"], installRoot, scenarioEnv("remove-empty"), true);
  assert(removal.stdout.includes("程序尚未卸载") && removal.stdout.includes("npm uninstall -g @zhixing/cli"), "应用停用未交接给 npm 卸载");
  const firstRun = await runOutcome(process.execPath, [entry], installRoot, scenarioEnv("first-run-empty"), true);
  assert(firstRun.code === 2 && firstRun.signal === null, "非交互首次运行未安全进入配置边界");
  assert(`${firstRun.stdout}\n${firstRun.stderr}`.includes("请在 TTY 终端中运行 `zhixing` 完成配置"), "首次运行未给出唯一交互配置行动");
}

async function verifyPlatformHelper(installRoot, home) {
  const packageRoot = path.join(installRoot, "node_modules", "@zhixing", "mesh");
  verifyCheckpointBridgeArtifact(packageRoot, hostTarget);
  const modulePath = path.join(packageRoot, "dist", "checkpoint-target.js");
  const targetRoot = path.join(home, "helper-smoke");
  const helperSmoke = [
    'const { pathToFileURL } = await import("node:url");',
    "const checkpoint = await import(pathToFileURL(process.argv[1]).href);",
    "const directory = await checkpoint.freezeCheckpointDirectory(process.argv[2], true);",
    "try {",
    "await directory.handle.writeFile('probe.bin', Buffer.from('checkpoint'));",
    "if ((await directory.handle.readFile('probe.bin', -1, 0, 64)).toString() !== 'checkpoint') throw Error('helper read failed');",
    "for (let i = 0; i < 2; i++) if (!(await directory.handle.listEntries(10)).includes('probe.bin')) throw Error('helper repeated inventory failed');",
    "await directory.handle.renameTo('probe.bin', directory.handle, 'renamed.bin');",
    "await directory.handle.unlink('renamed.bin', false);",
    "await directory.handle.sync();",
    "} finally { await directory.handle.close(); }",
    "const target = await checkpoint.FileRecoveryCheckpointTarget.openPaired({ targetRoot: process.argv[2], targetDeviceId: \"package-check-device\" });",
    "await target.close();",
    "process.exit(0);",
  ].join("\n");
  await run(process.execPath, ["--input-type=module", "--eval", helperSmoke, "--", modulePath, targetRoot], installRoot, process.env, true);
  // The helper owns no state after its parent closes the pipe; allow Windows to release the executable before npm removes the package.
  if (process.platform === "win32") await delay(250);
}

async function verifyInstalledBraceExpansionBoundary(installRoot) {
  const toolsEntry = path.join(
    installRoot,
    "node_modules",
    "@zhixing",
    "tools-builtin",
    "dist",
    "index.js",
  );
  const toolsSource = await readFile(toolsEntry, "utf8");
  assert(/from\s+["']glob\/raw["']/u.test(toolsSource), "安装后的 tools-builtin 未使用 glob/raw");
  assert(!/from\s+["']glob["']/u.test(toolsSource), "安装后的 tools-builtin 仍使用内嵌旧 brace 的 glob 默认入口");

  const smoke = [
    'const { createGlobTool, createGrepTool } = await import("@zhixing/tools-builtin");',
    "const part = \"{\" + \"0\".repeat(50) + \"1..100000}\";",
    "const bracePattern = \"{\" + Array(400).fill(part).join(\",\") + \"}\";",
    "const context = { workingDirectory: process.cwd() };",
    "const mode = process.argv[1];",
    "const result = mode === \"glob\"",
    "  ? await createGlobTool().call({ pattern: bracePattern }, context)",
    "  : await createGrepTool().call({ pattern: \"release-p07-no-match\", glob: bracePattern }, context);",
    "if (result.isError) throw new Error(result.content);",
  ].join("\n");
  for (const mode of ["glob", "grep"]) {
    const result = await runOutcomeWithDeadline(
      process.execPath,
      ["--max-old-space-size=64", "--input-type=module", "--eval", smoke, "--", mode],
      installRoot,
      npmEnv,
      15_000,
    );
    assert(
      result.code === 0 && result.signal === null && !result.timedOut,
      `安装后的 ${mode} brace 安全反例失败（${result.timedOut ? "timeout" : result.signal ?? result.code}）${result.stderr ? `：${result.stderr.trim()}` : ""}`,
    );
  }
}

function assertPublicPackageMetadata(manifest, directory) {
  assert(typeof manifest.description === "string" && manifest.description.trim().length > 0, `${manifest.name} 缺少用途说明`);
  assert(manifest.repository?.type === "git", `${manifest.name} repository type 不正确`);
  assert(manifest.repository?.url === canonicalRepositoryUrl, `${manifest.name} repository url 不正确`);
  assert(manifest.repository?.directory === directory, `${manifest.name} repository directory 不正确`);
  assert(manifest.homepage === canonicalHomepage, `${manifest.name} homepage 不正确`);
  assert(manifest.bugs?.url === canonicalIssues, `${manifest.name} bugs url 不正确`);
}

function assertPackageReadme(readme, packageName) {
  assert(readme.trim().length > 0, `${packageName} README 内容为空`);
  assert(readme.includes("@zhixing/cli"), `${packageName} README 缺少用户安装入口`);
  assert(readme.includes(canonicalHomepage), `${packageName} README 缺少规范文档入口`);
  assert(readme.includes("MIT"), `${packageName} README 缺少许可说明`);
}

function assertNoLifecycleScripts(manifest, label) {
  for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
    assert(typeof manifest.scripts?.[name] !== "string", `${label} 禁止发布 ${name} 脚本`);
  }
}

async function relativeFiles(directory, base = directory) {
  const result = [];
  for (const name of await readdir(directory)) {
    const full = path.join(directory, name);
    const entry = await stat(full);
    if (entry.isDirectory()) result.push(...await relativeFiles(full, base));
    else result.push(path.relative(base, full).replaceAll("\\", "/"));
  }
  return result;
}

async function json(file) { return JSON.parse(await readFile(file, "utf8")); }
async function exists(file) { try { await stat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
function assert(value, message) { if (!value) throw new Error(message); }

async function run(executable, args, cwd, env = process.env, capture = false) {
  const result = await runOutcome(executable, args, cwd, env, capture);
  if (result.code === 0 && result.signal === null) return result;
  throw new Error(`${executable} ${args.join(" ")} 失败（${result.signal ?? result.code}）${result.stderr ? `：${result.stderr.trim()}` : ""}`);
}

function runOutcome(executable, args, cwd, env = process.env, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(executable, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ stdout, stderr, code, signal }));
  });
}

function runOutcomeWithDeadline(executable, args, cwd, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(executable, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code, signal, timedOut });
    });
  });
}

function spawnCommand(executable, args, options) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(executable)) {
    return spawn(executable, args, options);
  }
  if (!/^[0-9A-Za-z_.-]+\.(?:cmd|bat)$/u.test(executable)) {
    throw new Error(`不安全的 Windows 命令入口：${executable}`);
  }
  const line = [executable, ...args.map(quoteWindowsCommandArgument)].join(" ");
  return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", line], options);
}

function quoteWindowsCommandArgument(value) {
  if (/\r|\n/u.test(value)) throw new Error("Windows 命令参数不得包含换行");
  if (!/[\s&|<>^()%!]/u.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
