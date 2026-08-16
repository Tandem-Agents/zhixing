import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const confirm = process.argv.includes("--confirm-publish");
const command = process.platform === "win32" ? (name) => `${name}.cmd` : (name) => name;

if (!confirm) {
  console.log("未写入 npm。确认发布前先运行 pnpm package:check；发布时显式追加 --confirm-publish。");
  process.exit(0);
}
if (process.env.ZHIXING_ALLOW_NPM_PUBLISH !== "1") {
  throw new Error("发布写入未获本次环境授权；请显式设置 ZHIXING_ALLOW_NPM_PUBLISH=1");
}

const temporary = await mkdtemp(path.join(tmpdir(), "zhixing-npm-publish-"));
try {
  await run(command("pnpm"), ["package:check", "--", "--skip-build"], root);
  const identity = (await capture(command("npm"), ["whoami"], root)).trim();
  if (!identity) throw new Error("npm 身份不可用");
  const profile = JSON.parse(await capture(command("npm"), ["profile", "get", "--json"], root));
  if (!profile.tfa || profile.tfa.mode === "disabled") throw new Error("npm 账号必须启用二次验证");

  const rootManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const packages = await loadPackages(rootManifest.version);
  await assertRegistryAuthority(identity, packages);

  const tarballDir = path.join(temporary, "tarballs");
  await mkdir(tarballDir);
  const cli = packages.find(({ name }) => name === "@zhixing/cli");
  if (!cli) throw new Error("缺少 @zhixing/cli");
  const ordered = topological(packages);
  const frozenTarballs = new Map();
  for (const item of ordered) {
    frozenTarballs.set(item.name, await pack(item.directory, tarballDir));
  }
  for (const item of ordered.filter(({ name }) => name !== cli.name)) {
    await publishExact(item.name, rootManifest.version, frozenTarballs.get(item.name));
  }

  const cliRoot = path.join(temporary, "cli-candidate");
  await mkdir(cliRoot);
  await run("tar", ["-xzf", frozenTarballs.get(cli.name), "-C", cliRoot], root);
  const extracted = path.join(cliRoot, "package");
  await run(command("npm"), ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], extracted);
  await run(command("npm"), ["shrinkwrap"], extracted);
  await verifyShrinkwrap(extracted, packages, rootManifest.version);
  const cliTarball = await npmPack(extracted, tarballDir);
  await publishExact(cli.name, rootManifest.version, cliTarball);

  await verifyRegistryCandidate(packages, rootManifest.version);
  await run(command("npm"), ["dist-tag", "add", `${cli.name}@${rootManifest.version}`, "latest"], root);
  console.log(`npm 发布完成：${cli.name}@${rootManifest.version} 已成为 latest`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function assertRegistryAuthority(identity, packages) {
  const scope = "zhixing";
  const membership = JSON.parse(await capture(command("npm"), ["org", "ls", scope, "--json"], root));
  const role = membership?.[identity];
  if (!new Set(["developer", "admin", "owner"]).has(role)) {
    throw new Error(`当前 npm 身份 ${identity} 没有 @${scope} 发布权限`);
  }
  for (const item of packages) {
    if (!item.name.startsWith(`@${scope}/`)) throw new Error(`发布包不属于 @${scope}：${item.name}`);
    const exists = await captureOptional(command("npm"), ["view", item.name, "name", "--json"], root);
    if (!exists) continue;
    const collaborators = JSON.parse(await capture(
      command("npm"), ["access", "list", "collaborators", item.name, "--json"], root,
    ));
    if (!new Set(["read-write", "write"]).has(collaborators?.[identity])) {
      throw new Error(`当前 npm 身份 ${identity} 无法确认 ${item.name} 的写权限`);
    }
  }
}

async function verifyShrinkwrap(directory, packages, version) {
  const shrinkwrap = JSON.parse(await readFile(path.join(directory, "npm-shrinkwrap.json"), "utf8"));
  if (shrinkwrap.packages?.[""]?.version !== version) {
    throw new Error(`CLI shrinkwrap 根版本不是 ${version}`);
  }
  for (const item of packages.filter(({ name }) => name !== "@zhixing/cli")) {
    const key = `node_modules/${item.name}`;
    const locked = shrinkwrap.packages?.[key];
    if (!locked || locked.version !== version || typeof locked.integrity !== "string") {
      throw new Error(`CLI shrinkwrap 未锁定 ${item.name}@${version} 的 registry integrity`);
    }
  }
}

async function verifyRegistryCandidate(packages, version) {
  const consumer = path.join(temporary, "registry-consumer");
  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true }), "utf8");
  await run(command("npm"), [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", `@zhixing/cli@${version}`,
  ], consumer);
  const lock = JSON.parse(await readFile(path.join(consumer, "package-lock.json"), "utf8"));
  for (const item of packages) {
    const packageRoot = path.join(consumer, "node_modules", ...item.name.split("/"));
    const installed = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (installed.version !== version) throw new Error(`${item.name} registry 安装版本不一致`);
    const locked = lock.packages?.[`node_modules/${item.name}`];
    const remote = JSON.parse(await capture(
      command("npm"), ["view", `${item.name}@${version}`, "dist.integrity", "--json"], root,
    ));
    if (!locked || locked.version !== version || locked.integrity !== remote) {
      throw new Error(`${item.name} registry 安装 integrity 不一致`);
    }
  }
  const entry = path.join(consumer, "node_modules", "@zhixing", "cli", "dist", "index.js");
  await run(process.execPath, [entry, "--version"], consumer);
  await run(process.execPath, [entry, "--help"], consumer);
}

async function publishExact(name, version, tarball) {
  const integrity = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`;
  const existing = await captureOptional(command("npm"), ["view", `${name}@${version}`, "dist.integrity", "--json"], root);
  if (existing) {
    if (JSON.parse(existing) !== integrity) throw new Error(`${name}@${version} 已存在但 integrity 冲突`);
    return;
  }
  await run(command("npm"), ["publish", tarball, "--tag", "zhixing-candidate", "--access", "public"], root);
  const remote = JSON.parse(await capture(command("npm"), ["view", `${name}@${version}`, "dist.integrity", "--json"], root));
  if (remote !== integrity) throw new Error(`${name}@${version} registry integrity 不一致`);
}

async function loadPackages(version) {
  const result = [];
  for (const parent of [path.join(root, "packages"), path.join(root, "packages", "channels")]) {
    for (const name of await readdir(parent)) {
      const directory = path.join(parent, name);
      let manifest;
      try { manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")); } catch { continue; }
      if (manifest.private === true) continue;
      if (manifest.version !== version) throw new Error(`${manifest.name} 版本不一致`);
      result.push({ name: manifest.name, directory, dependencies: Object.keys(manifest.dependencies ?? {}).filter((item) => item.startsWith("@zhixing/")) });
    }
  }
  return result;
}

function topological(packages) {
  const byName = new Map(packages.map((item) => [item.name, item]));
  const ordered = [];
  const active = new Set();
  const done = new Set();
  const visit = (item) => {
    if (done.has(item.name)) return;
    if (active.has(item.name)) throw new Error(`包依赖存在循环：${item.name}`);
    active.add(item.name);
    for (const dependency of item.dependencies) if (byName.has(dependency)) visit(byName.get(dependency));
    active.delete(item.name);
    done.add(item.name);
    ordered.push(item);
  };
  for (const item of packages) visit(item);
  return ordered;
}

async function pack(directory, destination) {
  const before = new Set(await readdir(destination));
  await run(command("pnpm"), ["pack", "--pack-destination", destination], directory);
  const added = (await readdir(destination)).filter((name) => !before.has(name));
  if (added.length !== 1) throw new Error("pnpm pack 未生成唯一候选");
  return path.join(destination, added[0]);
}

async function npmPack(directory, destination) {
  const output = JSON.parse(await capture(command("npm"), ["pack", "--json", "--pack-destination", destination], directory));
  if (!Array.isArray(output) || output.length !== 1) throw new Error("npm pack 未生成唯一 CLI 候选");
  return path.join(destination, output[0].filename);
}

function run(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(executable, args, {
      cwd,
      windowsHide: true,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 && signal === null ? resolve() : reject(new Error(`${executable} ${args.join(" ")} 失败（${signal ?? code}）`)));
  });
}

function capture(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(executable, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 && signal === null ? resolve(stdout) : reject(new Error(`${executable} ${args.join(" ")} 失败：${stderr.trim()}`)));
  });
}

async function captureOptional(executable, args, cwd) {
  try { return (await capture(executable, args, cwd)).trim(); } catch { return ""; }
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
