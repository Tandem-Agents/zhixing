import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";

const root = path.resolve(import.meta.dirname, "..");
// 所有读写固定指向官方仓库；scope 配置优先于 registry，两者都要显式覆盖本机 npmrc。
const REGISTRY = "https://registry.npmjs.org/";
const SCOPE = "zhixing-ai";
// 用户安装入口不带 scope，其余组件位于 @zhixing-ai。
const CLI = "zhixing";
const CANDIDATE_TAG = "zhixing-candidate";
const SHRINKWRAP_ENTRY = "package/npm-shrinkwrap.json";
// npm 打包使用的固定时间戳，追加的锁文件与其保持一致。
const PACK_MTIME = new Date("1985-10-26T08:15:00Z");
const argv = process.argv.slice(2);
const confirm = argv.includes("--confirm-publish");
const command = process.platform === "win32" ? (name) => `${name}.cmd` : (name) => name;

if (!confirm) {
  console.log("未写入 npm。发布分两步：candidate 上传五目标已验证的候选且不改 latest；promote 在真实验收通过后单独推广 latest。写入时显式追加 --confirm-publish，用法见 release-and-maintenance-guide.md 的发布者合同。");
  process.exit(0);
}
if (process.env.ZHIXING_ALLOW_NPM_PUBLISH !== "1") {
  throw new Error("发布写入未获本次环境授权；请显式设置 ZHIXING_ALLOW_NPM_PUBLISH=1");
}
const modes = argv.filter((item) => item === "candidate" || item === "promote");
if (modes.length !== 1) throw new Error("必须且只能指定一个发布步骤：candidate 或 promote");
const mode = modes[0];

const temporary = await mkdtemp(path.join(tmpdir(), "zhixing-npm-publish-"));
try {
  const rootManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const version = rootManifest.version;
  const packages = await loadPackages(version);
  if (!packages.some(({ name }) => name === CLI)) throw new Error(`缺少 ${CLI}`);
  if (mode === "candidate") await publishCandidate(packages, version);
  else await promoteAccepted(packages, version);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function publishCandidate(packages, version) {
  // 写入前先固定输入：只接受五目标已验证的同一组 tarball，不在本机重新打包。
  const tar = await systemTar();
  const frozen = await loadFrozenTarballs(requiredOption("--tarballs"), packages, version, tar);
  const expected = requiredOption("--tarball-sha256");
  if (!/^[0-9a-f]{64}$/u.test(expected)) throw new Error("--tarball-sha256 需要 64 位小写十六进制指纹");
  if (fingerprint(frozen) !== expected) throw new Error("候选 tarball 指纹与五目标验证记录不一致");

  const identity = await assertRegistryAuthority(packages);
  const latestBefore = await readLatestTags(packages);
  const ordered = topological(packages);
  for (const item of ordered.filter(({ name }) => name !== CLI)) {
    await publishExact(item.name, version, frozen.get(item.name));
  }
  const cliIntegrity = await publishCliCandidate(packages, version, frozen, tar);
  await verifyRegistryCandidate(packages, version);
  await assertLatestUntouched(packages, version, latestBefore);
  console.log(`npm 候选上传完成（${identity}）：${CLI}@${version} 位于 ${CANDIDATE_TAG}，latest 未变更。`);
  console.log(`候选身份：${JSON.stringify({ version, tag: CANDIDATE_TAG, tarballSha256: expected, cliIntegrity })}`);
  console.log(`验收安装：npm install -g ${CLI}@${version} --registry=${REGISTRY}`);
  console.log(`验收通过后推广：pnpm package:publish -- promote --accepted-integrity ${cliIntegrity} --confirm-publish`);
}

async function promoteAccepted(packages, version) {
  const accepted = requiredOption("--accepted-integrity");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(accepted)) throw new Error("--accepted-integrity 需要验收记录中的 sha512 integrity");
  if (version.split("+")[0].includes("-")) throw new Error(`${version} 是预发布版本，只作为候选，不推广为 latest`);
  const identity = await assertRegistryAuthority(packages);
  const remote = await viewOptional([`${CLI}@${version}`, "dist.integrity"]);
  if (remote === null) throw new Error(`${CLI}@${version} 尚未上传到官方 registry`);
  if (remote !== accepted) throw new Error(`${CLI}@${version} 的 registry integrity 与验收记录不一致`);
  // 推广前按官方 registry 现状重新核验整个安装闭包。
  await verifyRegistryCandidate(packages, version);
  const before = await viewOptional([CLI, "dist-tags"]);
  if (before?.latest !== version) {
    await run(command("npm"), npmArgs(["dist-tag", "add", `${CLI}@${version}`, "latest"]), root);
  }
  const after = await viewOptional([CLI, "dist-tags"]);
  if (after?.latest !== version) throw new Error(`latest 回读为 ${after?.latest ?? "（无）"}，推广未生效`);
  console.log(`npm 推广完成（${identity}）：${CLI}@${version} 已成为 latest`);
}

async function loadFrozenTarballs(directory, packages, version, tar) {
  const fileName = (name) => `${name.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
  const expected = packages.map(({ name }) => fileName(name)).sort();
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expected)) {
    throw new Error("候选目录并非当前版本的完整公开包集合");
  }
  const frozen = new Map();
  for (const item of packages) {
    const file = path.join(directory, fileName(item.name));
    const bytes = await readFile(file);
    const manifest = JSON.parse(await tarExtract(tar, file, "package/package.json"));
    if (manifest.name !== item.name || manifest.version !== version) {
      throw new Error(`${path.basename(file)} 的清单不是 ${item.name}@${version}`);
    }
    const declared = manifest.publishConfig?.registry;
    if (declared !== undefined && declared.replace(/\/?$/u, "/") !== REGISTRY) {
      throw new Error(`${item.name} 声明了非官方发布地址：${declared}`);
    }
    frozen.set(item.name, { name: item.name, file, bytes, integrity: integrityOf(bytes) });
  }
  if ((await tarList(tar, frozen.get(CLI).file)).includes(SHRINKWRAP_ENTRY)) {
    throw new Error("已验证的 CLI 包不应自带 npm-shrinkwrap.json");
  }
  return frozen;
}

async function publishCliCandidate(packages, version, frozen, tar) {
  const verified = frozen.get(CLI);
  if (await viewOptional([`${CLI}@${version}`, "dist.integrity"]) === null) {
    const shrinkwrap = await generateShrinkwrap(tar, verified.file);
    verifyShrinkwrap(JSON.parse(shrinkwrap), packages, version, frozen);
    const assembled = await appendShrinkwrap(tar, verified.file, shrinkwrap);
    await verifyAppended(tar, verified.file, assembled.file);
    await publishExact(CLI, version, assembled);
  }
  // 新上传与中断后接续都以 registry 实际字节为准：已验证原件加一个锁文件，不重新生成。
  const downloaded = await downloadRegistryTarball(CLI, version);
  const shrinkwrap = await verifyAppended(tar, verified.file, downloaded.file);
  verifyShrinkwrap(JSON.parse(shrinkwrap), packages, version, frozen);
  return downloaded.integrity;
}

async function generateShrinkwrap(tar, cliTarball) {
  const directory = path.join(temporary, "cli-lock");
  await mkdir(directory);
  // 锁文件只描述用户安装时的生产闭包。npm 生成锁时会解析开发依赖（--omit=dev 也一样），
  // 而开发依赖里有不发布的 private 包，因此临时清单去掉 devDependencies。
  const manifest = JSON.parse(await tarExtract(tar, cliTarball, "package/package.json"));
  delete manifest.devDependencies;
  await writeFile(path.join(directory, "package.json"), JSON.stringify(manifest, null, 2), "utf8");
  await run(command("npm"), npmArgs(["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]), directory);
  await run(command("npm"), npmArgs(["shrinkwrap"]), directory);
  return readFile(path.join(directory, "npm-shrinkwrap.json"), "utf8");
}

async function appendShrinkwrap(tar, cliTarball, shrinkwrap) {
  const directory = path.join(temporary, "cli-append");
  const lockFile = path.join(directory, "staging", ...SHRINKWRAP_ENTRY.split("/"));
  await mkdir(path.dirname(lockFile), { recursive: true });
  await writeFile(lockFile, shrinkwrap, "utf8");
  await chmod(lockFile, 0o644);
  await utimes(lockFile, PACK_MTIME, PACK_MTIME);
  // 系统 tar 只在末尾追加一个条目；原条目的头与内容（含可执行位）逐字节保留。
  const tarFile = path.join(directory, "cli.tar");
  await writeFile(tarFile, gunzipSync(await readFile(cliTarball)));
  await run(tar.executable, ["-rf", tarFile, ...tar.ownerArgs, "-C", path.join(directory, "staging"), SHRINKWRAP_ENTRY], directory);
  const file = path.join(directory, path.basename(cliTarball));
  const bytes = gzipSync(await readFile(tarFile));
  await writeFile(file, bytes);
  return { name: CLI, file, bytes, integrity: integrityOf(bytes) };
}

async function verifyAppended(tar, verifiedTarball, finalTarball) {
  const original = gunzipSync(await readFile(verifiedTarball));
  const final = gunzipSync(await readFile(finalTarball));
  let end = original.length;
  while (end > 0 && original[end - 1] === 0) end -= 1;
  if (end === 0 || !final.subarray(0, end).equals(original.subarray(0, end))) {
    throw new Error("CLI 包没有逐字节保留已验证条目");
  }
  const before = await tarList(tar, verifiedTarball);
  const after = await tarList(tar, finalTarball);
  if (JSON.stringify(after) !== JSON.stringify([...before, SHRINKWRAP_ENTRY])) {
    throw new Error("CLI 包条目必须恰好是已验证条目加 npm-shrinkwrap.json");
  }
  // 字节前缀不覆盖最后一个条目末尾的合法 NUL 内容，按字节单独核对这一条。
  const last = before.at(-1);
  if (last !== undefined) {
    const [expected, actual] = await Promise.all([
      tarExtractBytes(tar, verifiedTarball, last),
      tarExtractBytes(tar, finalTarball, last),
    ]);
    if (!expected.equals(actual)) throw new Error(`CLI 包最后一个已验证条目 ${last} 的内容被改变`);
  }
  return tarExtract(tar, finalTarball, SHRINKWRAP_ENTRY);
}

function verifyShrinkwrap(shrinkwrap, packages, version, frozen) {
  if (shrinkwrap.packages?.[""]?.version !== version) {
    throw new Error(`CLI shrinkwrap 根版本不是 ${version}`);
  }
  for (const name of productionClosure(packages)) {
    const key = `node_modules/${name}`;
    const locked = shrinkwrap.packages?.[key];
    if (!locked || locked.version !== version || typeof locked.integrity !== "string") {
      throw new Error(`CLI shrinkwrap 未锁定 ${name}@${version} 的 registry integrity`);
    }
    if (locked.integrity !== frozen.get(name).integrity) {
      throw new Error(`CLI shrinkwrap 锁定的 ${name} 不是本次上传的已验证包`);
    }
  }
  const devEntry = Object.entries(shrinkwrap.packages ?? {}).find(([key, entry]) => key !== "" && entry?.dev === true);
  if (devEntry) throw new Error(`CLI shrinkwrap 不应包含开发依赖：${devEntry[0]}`);
  const braceEntries = Object.entries(shrinkwrap.packages ?? {})
    .filter(([key]) => /(?:^|\/)node_modules\/brace-expansion$/u.test(key));
  if (braceEntries.length === 0) throw new Error("CLI shrinkwrap 缺少 brace-expansion");
  for (const [key, locked] of braceEntries) {
    if (locked?.version !== "5.0.9" || typeof locked.integrity !== "string") {
      throw new Error(`CLI shrinkwrap 未锁定修复后的 brace-expansion：${key}`);
    }
  }
  assertOfficialResolved(shrinkwrap, "CLI shrinkwrap");
}

function assertOfficialResolved(lock, label) {
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (typeof entry?.resolved === "string" && !entry.resolved.startsWith(REGISTRY)) {
      throw new Error(`${label} 的 ${key} 指向非官方 registry：${entry.resolved}`);
    }
  }
}

async function verifyRegistryCandidate(packages, version) {
  const consumer = await mkdtemp(path.join(temporary, "registry-consumer-"));
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true }), "utf8");
  await run(command("npm"), npmArgs([
    "install", "--ignore-scripts", "--no-audit", "--no-fund", `${CLI}@${version}`,
  ]), consumer);
  const lock = JSON.parse(await readFile(path.join(consumer, "package-lock.json"), "utf8"));
  assertOfficialResolved(lock, "registry 安装闭包");
  // 用户安装只得到 CLI 及其生产依赖闭包；只作为开发依赖的包（如 channel-feishu）不在其中。
  for (const name of [CLI, ...productionClosure(packages)]) {
    const packageRoot = path.join(consumer, "node_modules", ...name.split("/"));
    const installed = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (installed.version !== version) throw new Error(`${name} registry 安装版本不一致`);
    const locked = lock.packages?.[`node_modules/${name}`];
    const remote = await viewOptional([`${name}@${version}`, "dist.integrity"]);
    if (!locked || locked.version !== version || remote === null || locked.integrity !== remote) {
      throw new Error(`${name} registry 安装 integrity 不一致`);
    }
  }
  const entry = path.join(consumer, "node_modules", CLI, "dist", "index.js");
  await run(process.execPath, [entry, "--version"], consumer);
  await run(process.execPath, [entry, "--help"], consumer);
}

async function assertRegistryAuthority(packages) {
  const identity = (await capture(command("npm"), npmArgs(["whoami"]), root)).trim();
  if (!identity) throw new Error("npm 身份不可用");
  const profile = JSON.parse(await capture(command("npm"), npmArgs(["profile", "get", "--json"]), root));
  if (!profile.tfa || profile.tfa.mode === "disabled") throw new Error("npm 账号必须启用二次验证");
  const membership = JSON.parse(await capture(command("npm"), npmArgs(["org", "ls", SCOPE, "--json"]), root));
  const role = membership?.[identity];
  if (!new Set(["developer", "admin", "owner"]).has(role)) {
    throw new Error(`当前 npm 身份 ${identity} 没有 @${SCOPE} 发布权限`);
  }
  for (const item of packages) {
    if (item.name !== CLI && !item.name.startsWith(`@${SCOPE}/`)) throw new Error(`发布包不属于 ${CLI} 或 @${SCOPE}：${item.name}`);
    if (await viewOptional([item.name, "name"]) === null) continue;
    const collaborators = JSON.parse(await capture(
      command("npm"), npmArgs(["access", "list", "collaborators", item.name, "--json"]), root,
    ));
    if (!new Set(["read-write", "write"]).has(collaborators?.[identity])) {
      throw new Error(`当前 npm 身份 ${identity} 无法确认 ${item.name} 的写权限`);
    }
  }
  return identity;
}

async function readLatestTags(packages) {
  const result = new Map();
  for (const item of packages) result.set(item.name, (await viewOptional([item.name, "dist-tags"]))?.latest ?? null);
  return result;
}

async function assertLatestUntouched(packages, version, before) {
  const after = await readLatestTags(packages);
  const problems = packages
    .filter(({ name }) => after.get(name) !== before.get(name) || after.get(name) === version)
    .map(({ name }) => `${name}：${before.get(name) ?? "（无）"} → ${after.get(name) ?? "（无）"}`);
  if (problems.length > 0) {
    throw new Error(`候选上传后 latest 被变更或指向候选版本，未经验收不得成为默认安装，需人工处置后再继续：${problems.join("；")}`);
  }
}

async function publishExact(name, version, tarball) {
  const existing = await viewOptional([`${name}@${version}`, "dist.integrity"]);
  if (existing !== null) {
    if (existing !== tarball.integrity) throw new Error(`${name}@${version} 已存在但 integrity 冲突`);
    return;
  }
  await run(command("npm"), npmArgs(["publish", tarball.file, "--tag", CANDIDATE_TAG, "--access", "public"]), root);
  const remote = await viewOptional([`${name}@${version}`, "dist.integrity"]);
  if (remote !== tarball.integrity) throw new Error(`${name}@${version} registry integrity 不一致`);
}

async function downloadRegistryTarball(name, version) {
  const directory = await mkdtemp(path.join(temporary, "registry-tarball-"));
  const output = JSON.parse(await capture(
    command("npm"), npmArgs(["pack", `${name}@${version}`, "--json", "--pack-destination", directory]), root,
  ));
  if (!Array.isArray(output) || output.length !== 1) throw new Error(`未能从 registry 取回唯一的 ${name}@${version}`);
  const file = path.join(directory, output[0].filename);
  const bytes = await readFile(file);
  const remote = await viewOptional([`${name}@${version}`, "dist.integrity"]);
  if (remote !== integrityOf(bytes)) throw new Error(`${name}@${version} 下载内容与 registry integrity 不一致`);
  return { name, file, bytes, integrity: remote };
}

async function viewOptional(args) {
  try {
    const output = (await capture(command("npm"), npmArgs(["view", ...args, "--json"]), root)).trim();
    return output ? JSON.parse(output) : null;
  } catch (error) {
    // 只有明确的 404 才表示不存在；鉴权、网络等其他失败一律中止。
    if (/\bE404\b/u.test(`${error.stdout ?? ""}\n${error.stderr ?? ""}`)) return null;
    throw error;
  }
}

function npmArgs(args) {
  return [...args, `--registry=${REGISTRY}`, `--@${SCOPE}:registry=${REGISTRY}`];
}

async function systemTar() {
  // Windows 固定使用系统自带 bsdtar；Git Bash 的 GNU tar 会把盘符当作远程主机。
  const executable = process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
  const version = await capture(executable, ["--version"], root);
  if (/bsdtar/u.test(version)) return { executable, ownerArgs: ["--uid", "0", "--gid", "0", "--uname", "", "--gname", ""] };
  if (/GNU tar/u.test(version)) return { executable, ownerArgs: ["--owner=0", "--group=0", "--numeric-owner"] };
  throw new Error(`无法识别系统 tar：${version.split(/\r?\n/u)[0]}`);
}

async function tarList(tar, file) {
  return (await capture(tar.executable, ["-tzf", file], root)).split(/\r?\n/u).filter(Boolean);
}

function tarExtract(tar, file, entry) {
  return capture(tar.executable, ["-xOzf", file, entry], root);
}

async function tarExtractBytes(tar, file, entry) {
  return capture(tar.executable, ["-xOzf", file, entry], root, { binary: true });
}

function fingerprint(frozen) {
  // 与 package-check 的 tarball 指纹算法一致。
  const hash = createHash("sha256");
  for (const { name, bytes } of [...frozen.values()].sort((a, b) => a.name.localeCompare(b.name, "en-US"))) {
    hash.update(name);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function integrityOf(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function requiredOption(name) {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) throw new Error(`缺少 ${name} 参数`);
  return value;
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
      result.push({ name: manifest.name, directory, dependencies: Object.keys(manifest.dependencies ?? {}).filter((item) => item === CLI || item.startsWith(`@${SCOPE}/`)) });
    }
  }
  return result;
}

/** CLI 生产依赖（只来自 dependencies）的传递闭包，不含 CLI 自身。 */
function productionClosure(packages) {
  const byName = new Map(packages.map((item) => [item.name, item]));
  const closure = new Set();
  const queue = [...byName.get(CLI).dependencies];
  while (queue.length > 0) {
    const name = queue.shift();
    if (closure.has(name) || !byName.has(name)) continue;
    closure.add(name);
    queue.push(...byName.get(name).dependencies);
  }
  return closure;
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

function capture(executable, args, cwd, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(executable, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { chunks.push(chunk); }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    // 用 close 而非 exit：等 stdout 全部读完，二进制内容不能截断。
    child.once("close", (code, signal) => {
      const bytes = Buffer.concat(chunks);
      if (code === 0 && signal === null) resolve(binary ? bytes : bytes.toString("utf8"));
      else reject(Object.assign(new Error(`${executable} ${args.join(" ")} 失败：${stderr.trim()}`), { stdout: bytes.toString("utf8"), stderr }));
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
