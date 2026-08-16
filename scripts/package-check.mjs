import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const skipBuild = process.argv.includes("--skip-build");
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
  assert(process.platform === "win32" && process.arch === "x64", "package:check 仅验证当前正式目标 Windows x64");
  await writeFile(npmEnv.npm_config_userconfig, "", "utf8");
  await run(process.execPath, ["--test", "scripts/npm-delivery-structure.test.mjs"], root);
  if (!skipBuild) await run(command("pnpm"), ["build"], root);
  const rootManifest = await json(path.join(root, "package.json"));
  const packages = await publicPackages(rootManifest.version);
  const tarballDir = path.join(temporary, "tarballs");
  await mkdir(tarballDir);
  const tarballs = [];
  for (const item of packages) {
    const before = new Set(await readdir(tarballDir));
    await run(command("pnpm"), ["pack", "--pack-destination", tarballDir], item.directory);
    const added = (await readdir(tarballDir)).filter((name) => !before.has(name));
    assert(added.length === 1 && added[0].endsWith(".tgz"), `${item.name} 未生成唯一 tarball`);
    const tarball = path.join(tarballDir, added[0]);
    await inspectTarball(item, tarball, rootManifest.version);
    tarballs.push({ ...item, tarball });
  }
  const tarballFingerprint = await fingerprintTarballs(tarballs);

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
  await verifyCli(installRoot, home, rootManifest.version);
  await verifyWindowsHelper(installRoot, home);
  await run(command("npm"), ["uninstall", "--ignore-scripts", "--no-audit", "--no-fund", "@zhixing/cli"], installRoot, npmEnv);
  assert(await exists(path.join(home, "sentinel.txt")), "npm 卸载影响了 ZHIXING_HOME");
  console.log(
    `package:check 通过：${packages.length} 个公开包，Windows x64 本地安装闭包可消费；tarball sha256 ${tarballFingerprint}`,
  );
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
  assertNoLifecycleScripts(manifest, item.name);
  for (const [name, value] of Object.entries(manifest.dependencies ?? {})) {
    assert(typeof value === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value), `${item.name} 依赖 ${name} 不是 exact registry version`);
    assert(!value.includes("workspace:") && !value.startsWith("file:") && !value.startsWith("link:"), `${item.name} tarball 泄漏本地依赖`);
  }
  const files = await relativeFiles(packageRoot);
  for (const file of files) {
    const allowed = file === "package.json" || /^(?:README|LICENSE)(?:\.|$)/iu.test(file) || file.startsWith("dist/") ||
      (item.name === "@zhixing/mesh" && /^build\/Release\/checkpoint_child_bridge\.(?:exe|descriptor\.json)$/u.test(file));
    assert(allowed, `${item.name} tarball 含未声明资产：${file}`);
  }
  if (item.name === "@zhixing/mesh") await verifyHelperDescriptor(packageRoot, version);
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
  for (const args of [["--version"], ["--help"], ["help"]]) {
    const result = await run(process.execPath, [entry, ...args], installRoot, env, true);
    assert(result.stdout.includes(args[0] === "--version" ? version : "用法："), `CLI ${args.join(" ")} 输出不正确`);
  }
  const doctor = await run(process.execPath, [entry, "doctor"], installRoot, env, true);
  assert(doctor.stdout.includes("知行尚未完成首次设置") && doctor.stdout.includes("运行 zz 完成设置"), "空 home 的 doctor 未给出唯一设置行动");
  const maintenance = await run(process.execPath, [entry, "stop", "--maintenance"], installRoot, env, true);
  assert(maintenance.stdout.includes("npm install -g @zhixing/cli@latest"), "maintenance stop 未给出显式 npm 行动");
  const removal = await run(process.execPath, [entry, "app", "remove"], installRoot, env, true);
  assert(removal.stdout.includes("程序尚未卸载") && removal.stdout.includes("npm uninstall -g @zhixing/cli"), "应用停用未交接给 npm 卸载");
  const firstRun = await runOutcome(process.execPath, [entry], installRoot, env, true);
  assert(firstRun.code === 2 && firstRun.signal === null, "非交互首次运行未安全进入配置边界");
  assert(`${firstRun.stdout}\n${firstRun.stderr}`.includes("请在 TTY 终端中运行 `zhixing` 完成配置"), "首次运行未给出唯一交互配置行动");
}

async function verifyWindowsHelper(installRoot, home) {
  const packageRoot = path.join(installRoot, "node_modules", "@zhixing", "mesh");
  await verifyHelperDescriptor(packageRoot, (await json(path.join(packageRoot, "package.json"))).version);
  const modulePath = path.join(packageRoot, "dist", "checkpoint-target.js");
  const targetRoot = path.join(home, "helper-smoke");
  const helperSmoke = [
    'const { pathToFileURL } = await import("node:url");',
    "const checkpoint = await import(pathToFileURL(process.argv[1]).href);",
    "const target = await checkpoint.FileRecoveryCheckpointTarget.openPaired({ targetRoot: process.argv[2], targetDeviceId: \"package-check-device\" });",
    "await target.close();",
    "process.exit(0);",
  ].join("\n");
  await run(process.execPath, ["--input-type=module", "--eval", helperSmoke, "--", modulePath, targetRoot], installRoot, process.env, true);
  // The helper owns no state after its parent closes the pipe; allow Windows to release the executable before npm removes the package.
  await delay(250);
}

async function verifyHelperDescriptor(packageRoot, version) {
  const binary = await readFile(path.join(packageRoot, "build", "Release", "checkpoint_child_bridge.exe"));
  const descriptor = await json(path.join(packageRoot, "build", "Release", "checkpoint_child_bridge.descriptor.json"));
  assert(Object.keys(descriptor).sort().join("\0") === [
    "arch", "bytes", "file", "os", "packageVersion", "schemaVersion", "sha256",
  ].sort().join("\0"), "Windows helper descriptor 字段不规范");
  assert(descriptor.schemaVersion === 1 && descriptor.os === "win32" && descriptor.arch === "x64" && descriptor.packageVersion === version, "Windows helper descriptor identity 不匹配");
  assert(descriptor.bytes === binary.byteLength && descriptor.sha256 === createHash("sha256").update(binary).digest("hex"), "Windows helper descriptor 摘要不匹配");
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
