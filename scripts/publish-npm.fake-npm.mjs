// publish-npm.test.mjs 使用的 npm 替身：以状态文件模拟官方 registry，并执行真实 registry 的约束
// （同版本不可重复发布、integrity 取上传字节、dist-tag 只能指向已存在版本、只有缺失才返回 E404）。
// 每次调用都必须显式指向官方 registry 与 @zhixing-ai scope，否则直接失败，用来证明发布脚本不受本机 npmrc 影响。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const OFFICIAL = "https://registry.npmjs.org/";
const MIRROR = "https://registry.npmmirror.com/";
const VALUE_FLAGS = new Set(["--tag", "--access", "--pack-destination"]);
const stateFile = process.env.FAKE_NPM_STATE;
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const args = process.argv.slice(2);
const positional = [];
const options = {};
for (let index = 0; index < args.length; index += 1) {
  const item = args[index];
  if (VALUE_FLAGS.has(item)) { options[item] = args[index + 1]; index += 1; continue; }
  if (item.startsWith("--")) { options[item] = true; continue; }
  positional.push(item);
}
state.calls.push(positional);
if (!options[`--registry=${OFFICIAL}`] || !options[`--@zhixing-ai:registry=${OFFICIAL}`]) {
  fail("EREGISTRY", `缺少显式官方 registry：${args.join(" ")}`);
}
const [verb, ...rest] = positional;
const output = handle();
save();
// 与真实 npm 一致：带 --json 时输出 JSON（字符串也带引号），否则输出原文。
if (output !== undefined) process.stdout.write(options["--json"] ? `${JSON.stringify(output)}\n` : `${output}\n`);

function handle() {
  if (verb === "whoami") {
    if (!state.identity) fail("E401", "未登录");
    return state.identity;
  }
  if (verb === "profile") return { tfa: state.tfa === "disabled" ? false : { mode: state.tfa } };
  if (verb === "org") return { [state.identity]: state.orgRole };
  if (verb === "access") {
    requirePackage(rest[2]);
    return { [state.identity]: state.access };
  }
  if (verb === "view") {
    if (state.viewError) fail(state.viewError, "registry 读取失败");
    const { name, version } = parseSpec(rest[0]);
    const pkg = requirePackage(name);
    if (rest[1] === "dist-tags") return pkg.tags;
    if (rest[1] === "name") return name;
    const entry = pkg.versions[version];
    if (!entry) fail("E404", `No match found for version ${version}`);
    return entry.integrity;
  }
  if (verb === "publish") {
    const manifest = JSON.parse(tarExtract(rest[0], "package/package.json"));
    consumeFailure(`publish:${manifest.name}`);
    const pkg = state.registry[manifest.name] ??= { versions: {}, tags: {} };
    if (pkg.versions[manifest.version]) fail("E403", "You cannot publish over the previously published versions");
    const stored = path.join(path.dirname(stateFile), "store", `${flat(manifest.name)}-${manifest.version}.tgz`);
    mkdirSync(path.dirname(stored), { recursive: true });
    copyFileSync(rest[0], stored);
    pkg.versions[manifest.version] = { integrity: integrityOf(readFileSync(stored)), file: stored };
    pkg.tags[options["--tag"] ?? "latest"] = manifest.version;
    if (state.autoLatest && !pkg.tags.latest) pkg.tags.latest = manifest.version;
    return undefined;
  }
  if (verb === "dist-tag") {
    consumeFailure("dist-tag");
    const { name, version } = parseSpec(rest[1]);
    const pkg = requirePackage(name);
    if (!pkg.versions[version]) fail("E404", `No match found for version ${version}`);
    pkg.tags[rest[2]] = version;
    return undefined;
  }
  if (verb === "pack") {
    consumeFailure("pack");
    const { name, version } = parseSpec(rest[0]);
    const entry = requirePackage(name).versions[version];
    if (!entry) fail("E404", `No match found for version ${version}`);
    const filename = `${flat(name)}-${version}.tgz`;
    copyFileSync(entry.file, path.join(options["--pack-destination"], filename));
    return [{ filename }];
  }
  if (verb === "install" && options["--package-lock-only"]) return lockOnly();
  if (verb === "shrinkwrap") {
    renameSync("package-lock.json", "npm-shrinkwrap.json");
    return undefined;
  }
  if (verb === "install") return installConsumer(parseSpec(rest[0]));
  fail("EUNKNOWN", `替身不支持：${positional.join(" ")}`);
}

function lockOnly() {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const packages = { "": { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies } };
  // 真实 npm 生成锁时也会解析开发依赖（--omit=dev 不改变这一点），未发布的包直接失败。
  for (const dependency of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]) {
    if (dependency.startsWith("@zhixing-ai/") && !state.registry[dependency]?.versions[manifest.version]) {
      fail("E404", `'${dependency}@${manifest.version}' is not in this registry`);
    }
  }
  for (const name of closure(manifest.dependencies, manifest.version)) {
    packages[`node_modules/${name}`] = { version: manifest.version, resolved: tarballUrl(OFFICIAL, name, manifest.version), integrity: state.registry[name].versions[manifest.version].integrity };
  }
  for (const name of Object.keys(manifest.devDependencies ?? {}).filter((item) => item.startsWith("@zhixing-ai/"))) {
    packages[`node_modules/${name}`] ??= { version: manifest.version, resolved: tarballUrl(OFFICIAL, name, manifest.version), integrity: state.registry[name].versions[manifest.version].integrity, dev: true };
  }
  packages["node_modules/brace-expansion"] = {
    version: "5.0.9",
    resolved: tarballUrl(state.mirror ? MIRROR : OFFICIAL, "brace-expansion", "5.0.9"),
    integrity: integrityOf(Buffer.from(`brace-expansion ${state.lockDrift}`)),
  };
  writeFileSync("package-lock.json", JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages }, null, 2));
  return undefined;
}

function installConsumer({ name, version }) {
  const cli = requirePackage(name).versions[version];
  if (!cli) fail("E404", `No match found for version ${version}`);
  const packages = { "": { dependencies: { [name]: version } } };
  // 消费方安装只得到入口包及其生产依赖闭包，开发依赖不会安装。
  for (const packageName of [name, ...closure(JSON.parse(tarExtract(cli.file, "package/package.json")).dependencies, version)]) {
    const entry = state.registry[packageName].versions[version];
    const directory = path.join("node_modules", ...packageName.split("/"));
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: packageName, version }));
    if (packageName === name) {
      mkdirSync(path.join(directory, "dist"), { recursive: true });
      const entryScript = state.brokenCli ? "process.exit(3);\n" : tarExtract(entry.file, "package/dist/index.js");
      writeFileSync(path.join(directory, "dist", "index.js"), entryScript);
    }
    packages[`node_modules/${packageName}`] = {
      version,
      resolved: tarballUrl(OFFICIAL, packageName, version),
      integrity: state.corruptInstall === packageName ? "sha512-corrupt" : entry.integrity,
    };
  }
  writeFileSync("package-lock.json", JSON.stringify({ lockfileVersion: 3, requires: true, packages }, null, 2));
  return undefined;
}

function closure(dependencies, version) {
  const result = new Set();
  const queue = Object.keys(dependencies ?? {}).filter((item) => item.startsWith("@zhixing-ai/"));
  while (queue.length > 0) {
    const name = queue.shift();
    if (result.has(name)) continue;
    const entry = state.registry[name]?.versions[version];
    if (!entry) fail("E404", `'${name}@${version}' is not in this registry`);
    result.add(name);
    queue.push(...Object.keys(JSON.parse(tarExtract(entry.file, "package/package.json")).dependencies ?? {}).filter((item) => item.startsWith("@zhixing-ai/")));
  }
  return result;
}

function requirePackage(name) {
  const pkg = state.registry[name];
  if (!pkg) fail("E404", `'${name}' is not in this registry`);
  return pkg;
}

function consumeFailure(key) {
  if (!state.failOnce?.[key]) return;
  delete state.failOnce[key];
  fail("ECONNRESET", `注入的一次性失败：${key}`);
}

function parseSpec(spec) {
  const at = spec.lastIndexOf("@");
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec, version: undefined };
}

function tarExtract(file, entry) {
  const executable = process.platform === "win32" ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
  return execFileSync(executable, ["-xOzf", file, entry], { encoding: "utf8" });
}

function tarballUrl(registry, name, version) {
  return `${registry}${name}/-/${name.split("/").at(-1)}-${version}.tgz`;
}

function flat(name) {
  return name.replace(/^@/u, "").replaceAll("/", "-");
}

function integrityOf(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function save() {
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function fail(code, message) {
  save();
  process.stderr.write(`npm error code ${code}\nnpm error ${message}\n`);
  process.exit(1);
}
