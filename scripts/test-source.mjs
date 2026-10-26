#!/usr/bin/env node
// 源码级测试入口：跨包导入直接解析到各包 src（不依赖 dist 是否最新），按快慢车道运行。
//
//   node scripts/test-source.mjs [--lane fast|slow|all] [--workers N] [--profile] [vitest 过滤参数...]
//
// - fast（默认）：排除慢车道清单里的文件，用于迭代与修正验证。
// - slow：只跑慢车道清单（规模、耐久与重集成用例），三级任务收尾时运行。
// - all：两条车道一起跑。
// - --profile：额外输出逐文件耗时，并按阈值重写慢车道清单（scripts/test-lanes.json）。
// - 运行期间受测源码（各包 src、scripts/*.mjs）被改动时，结尾列出改动的文件；用例全过也以 3 退出。
//
// 运行器固定为仓库锁定的 vitest（取自 packages/core/node_modules），不经 npx：
// 仓库根目录没有 vitest，npx 会落到全局缓存的其他大版本。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lanesFile = path.join(root, "scripts", "test-lanes.json");
const cacheDir = path.join(root, "node_modules", ".cache", "zhixing-test-source");
const vitest = path.join(root, "packages", "core", "node_modules", "vitest", "vitest.mjs");

const args = process.argv.slice(2);
const take = (name) => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const [, value] = args.splice(index, 2);
  return value;
};
const lane = take("--lane") ?? "fast";
// 默认线程池、逻辑核数的 2/3：core 快车道实测 forks×6 88 秒、threads×6 75 秒、threads×8 65 秒。
const workers = Number(take("--workers") ?? Math.max(2, Math.round(os.cpus().length * 2 / 3)));
const pool = take("--pool") ?? "threads";
if (!["forks", "threads"].includes(pool)) throw new Error(`Unknown pool: ${pool}`);
const profile = args.includes("--profile") ? (args.splice(args.indexOf("--profile"), 1), true) : false;
// 默认共享模块：同一 worker 依次执行多个文件时复用已加载的源码模块图（每个文件重新导入约占
// 快车道八成墙钟）。需要全新模块状态的文件单独隔离运行：用 vi.mock/vi.doMock 的文件，以及
// 文件内显式标注 `test-source: isolate` 的文件。--isolate-all 退回逐文件隔离，用于对照排查。
const isolateAll = args.includes("--isolate-all") ? (args.splice(args.indexOf("--isolate-all"), 1), true) : false;
const physicalSync = args.includes("--physical-sync") ? (args.splice(args.indexOf("--physical-sync"), 1), true) : false;
// --cpu-prof：worker 进程写 V8 CPU 剖析到缓存目录，用于定位测试耗时去向。
const cpuProf = args.includes("--cpu-prof") ? (args.splice(args.indexOf("--cpu-prof"), 1), true) : false;
// --count-fs：统计每个测试文件的文件系统调用次数（按方法与调用方），定位细碎 I/O 的来源。
const countFs = args.includes("--count-fs") ? (args.splice(args.indexOf("--count-fs"), 1), true) : false;
if (!["fast", "slow", "all"].includes(lane)) throw new Error(`Unknown lane: ${lane}`);
if (!Number.isSafeInteger(workers) || workers < 1) throw new Error("--workers must be a positive integer");
if (!existsSync(vitest)) throw new Error(`Pinned vitest is missing: ${vitest}`);

/** 工作区包目录：packages/* 与 packages/channels/*。 */
function packageDirs() {
  const dirs = [];
  for (const base of [path.join(root, "packages"), path.join(root, "packages", "channels")]) {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const dir = path.join(base, entry.name);
      if (entry.isDirectory() && existsSync(path.join(dir, "package.json"))) dirs.push(dir);
    }
  }
  return dirs;
}

/** 由 exports 推出“包导出名→源码文件”：./dist/x/y.js 对应 src/x/y.ts。找不到源码的导出跳过。 */
function sourceAliases() {
  const aliases = [];
  for (const dir of packageDirs()) {
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    if (!manifest.name?.startsWith("@zhixing/") || !manifest.exports) continue;
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const file = typeof target === "string" ? target : target?.import ?? target?.default;
      if (typeof file !== "string" || !file.startsWith("./dist/") || !file.endsWith(".js")) continue;
      const source = path.join(dir, "src", file.slice("./dist/".length, -".js".length) + ".ts");
      if (!existsSync(source)) continue;
      const specifier = subpath === "." ? manifest.name : manifest.name + subpath.slice(1);
      aliases.push({ specifier, source: source.split(path.sep).join("/") });
    }
  }
  return aliases;
}

/**
 * 测试文件按运行要求分组（相对仓库根），其余文件进入共享模块组：
 * - process：依赖进程隔离的文件，走 forks 子进程并逐文件隔离——调用线程 worker 不支持的 API
 *   （process.chdir），或读取进程级资源读数（rss、resourceUsage、cpuUsage：线程池下是全部 worker 之和）；
 * - isolated：需要全新模块状态（vi.mock/vi.doMock，或文件内显式标注 `test-source: isolate`）；
 * - exclusive：断言墙钟资源边界的文件（文件内显式标注 `test-source: exclusive`）。其他组全部结束后
 *   才执行，走 forks 并逐文件隔离：墙钟边界只在没有并发测试负载时才测得到被测代码本身。
 */
function fileGroups() {
  const groups = { exclusive: [], process: [], isolated: [] };
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".test.ts")) {
        const text = readFileSync(full, "utf8");
        const file = path.relative(root, full).split(path.sep).join("/");
        if (/test-source: exclusive/.test(text)) groups.exclusive.push(file);
        else if (/\bprocess\.chdir\(|memoryUsage\(\)\.rss|memoryUsage\.rss\(|\bresourceUsage\(|\bprocess\.cpuUsage\(/.test(text)) groups.process.push(file);
        else if (/\bvi\.(mock|doMock)\(|test-source: isolate/.test(text)) groups.isolated.push(file);
      }
    }
  };
  walk(path.join(root, "packages"));
  return { exclusive: groups.exclusive.sort(), process: groups.process.sort(), isolated: groups.isolated.sort() };
}

const lanes = existsSync(lanesFile) ? JSON.parse(readFileSync(lanesFile, "utf8")) : { thresholdMs: 20_000, slow: [] };
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const aliases = sourceAliases();
const slow = lanes.slow ?? [];
const include = lane === "slow" ? slow : ["packages/**/*.test.ts"];
const exclude = ["**/node_modules/**", "**/dist/**", ...(lane === "fast" ? slow : [])];
const reportFile = path.join(cacheDir, `last-${lane}.json`);
const groups = fileGroups();
// 慢车道只取清单内的文件；快车道与全量由 exclude 排除不属于本车道的文件。
const laneFiles = (files) => (lane === "slow" ? include.filter((file) => files.includes(file)) : files);
// include/exclude 只写在各组里：extends 会把根配置的 include 合并进每组，导致重复执行。
// 空组不生成。--isolate-all 时共享组也逐文件隔离，隔离组并入共享组。独占组排在最后一组（groupOrder 1）。
const projects = `projects: ${JSON.stringify([
  { name: "shared", isolate: isolateAll, include, exclude: [...exclude, ...groups.exclusive, ...groups.process, ...(isolateAll ? [] : groups.isolated)] },
  { name: "isolated", isolate: true, include: isolateAll ? [] : laneFiles(groups.isolated), exclude },
  { name: "process", isolate: true, pool: "forks", include: laneFiles(groups.process), exclude },
  { name: "exclusive", isolate: true, pool: "forks", include: laneFiles(groups.exclusive), exclude, sequence: { groupOrder: 1 } },
].filter((test) => test.include.length > 0).map((test) => ({ extends: true, test })))},`;

mkdirSync(cacheDir, { recursive: true });
// 测试进程内把 fsync 系列换成空操作：它只防断电与系统崩溃，测试不模拟这两者；进程崩溃、
// 强杀子进程时数据仍在操作系统缓存里。被测的写入顺序、原子改名与故障注入语义不受影响。
// 子进程不受影响。这是逻辑回归模式；改动涉及存储、耐久或刷盘路径时，收尾须对受影响用例加
// --physical-sync 跑真实刷盘（保留刷盘错误、等待与真实交错），结果写明模式（见执行计划第五节第 3 条）。
const setupFile = path.join(cacheDir, "relaxed-durability.mjs");
writeFileSync(setupFile, `// 由 scripts/test-source.mjs 生成，勿手改。
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const handle = await fs.promises.open(${JSON.stringify(path.join(cacheDir, "relaxed-durability.mjs").split(path.sep).join("/"))}, "r");
const prototype = Object.getPrototypeOf(handle);
await handle.close();
prototype.sync = async function () {};
prototype.datasync = async function () {};
fs.fsyncSync = () => {};
fs.fdatasyncSync = () => {};
fs.fsync = (_fd, callback) => queueMicrotask(() => callback(null));
fs.fdatasync = (_fd, callback) => queueMicrotask(() => callback(null));
fs.promises.fsync = undefined;
syncBuiltinESMExports();
`);
// 每个测试文件在自己的 worker 里采样，文件结束时写出（worker 不走正常退出，--cpu-prof 不可用）。
const profileDir = path.join(cacheDir, "cpu-prof");
const profileSetupFile = path.join(cacheDir, "cpu-profile.mjs");
if (cpuProf) {
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(profileSetupFile, `// 由 scripts/test-source.mjs 生成，勿手改。
import { Session } from "node:inspector/promises";
import { writeFileSync } from "node:fs";
import { afterAll } from "vitest";
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.setSamplingInterval", { interval: 1000 });
await session.post("Profiler.start");
afterAll(async () => {
  const { profile } = await session.post("Profiler.stop");
  writeFileSync(${JSON.stringify(profileDir.split(path.sep).join("/"))} + "/" + process.pid + "-" + Date.now() + ".cpuprofile", JSON.stringify(profile));
});
`);
}
const countSetupFile = path.join(cacheDir, "count-fs.mjs");
if (countFs) {
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(countSetupFile, `// 由 scripts/test-source.mjs 生成，勿手改。
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterAll, expect } from "vitest";
const counts = new Map();
const callers = new Map();
const note = (name) => {
  counts.set(name, (counts.get(name) ?? 0) + 1);
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 25;
  const stack = String(new Error().stack).replace(/\\\\/g, "/");
  Error.stackTraceLimit = limit;
  const frame = stack.split("\\n").slice(3).find((l) => l.includes("/packages/") && !l.includes("__tests__") && !l.includes("/test-utils/"));
  const site = frame ? frame.replace(/^.*\\/packages\\//, "").replace(/\\)?$/, "").replace(/:\\d+$/, "") : "(test or node)";
  const key = name + " @ " + site;
  callers.set(key, (callers.get(key) ?? 0) + 1);
};
// 等待记账：事件循环利用率（活跃/空闲）+ 异步文件调用的完成延迟（按方法累计，并发调用会重叠）。
const elu = performance.eventLoopUtilization();
const latency = new Map();
const wrap = (target, names, prefix) => {
  for (const name of names) {
    const original = target[name];
    if (typeof original !== "function") continue;
    target[name] = function (...args) {
      note(prefix + name);
      const started = performance.now();
      const result = original.apply(this, args);
      if (result && typeof result.finally === "function") {
        result.finally(() => {
          const entry = latency.get(prefix + name) ?? { count: 0, ms: 0 };
          entry.count++; entry.ms += performance.now() - started;
          latency.set(prefix + name, entry);
        }).catch(() => {});
      }
      return result;
    };
  }
};
// 计时器：按调用方累计请求次数与延迟，以及实际触发（未被清除）的次数与延迟（毫秒），
// 用来区分“等文件操作”与“等计时器”。
const timerDelay = new Map();
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function (callback, delay, ...rest) {
  const ms = Number(delay) || 0;
  if (ms >= 1 && typeof callback === "function") {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 25;
    const stack = String(new Error().stack).replace(/\\\\/g, "/");
    Error.stackTraceLimit = limit;
    const frame = stack.split("\\n").slice(2).find((l) => l.includes("/packages/") && !l.includes("/test-utils/"));
    const site = frame ? frame.replace(/^.*\\/packages\\//, "").replace(/\\)?$/, "").replace(/:\\d+$/, "") : "(node)";
    const entry = timerDelay.get(site) ?? { count: 0, ms: 0, fired: 0, firedMs: 0 };
    entry.count++; entry.ms += ms;
    timerDelay.set(site, entry);
    const original = callback;
    callback = function (...args) { entry.fired++; entry.firedMs += ms; return original.apply(this, args); };
  }
  return originalSetTimeout.call(this, callback, delay, ...rest);
};
wrap(fs.promises, ["open", "stat", "lstat", "mkdir", "rm", "rmdir", "rename", "unlink", "readFile", "writeFile", "readdir", "copyFile", "access", "realpath"], "p.");
wrap(fs, ["openSync", "statSync", "lstatSync", "mkdirSync", "rmSync", "renameSync", "unlinkSync", "readFileSync", "writeFileSync", "readdirSync", "existsSync", "fsyncSync"], "s.");
syncBuiltinESMExports();
afterAll(() => {
  const top = [...callers].sort((a, b) => b[1] - a[1]).slice(0, 40);
  const total = [...counts.values()].reduce((s, v) => s + v, 0);
  fs.writeFileSync(${JSON.stringify(profileDir.split(path.sep).join("/"))} + "/fs-" + process.pid + "-" + Date.now() + ".json",
    JSON.stringify({ file: expect.getState().testPath ?? null, total, counts: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])), top,
      eventLoop: performance.eventLoopUtilization(elu),
      latency: [...latency].sort((a, b) => b[1].ms - a[1].ms).map(([name, v]) => [name, { count: v.count, ms: Math.round(v.ms), avgMs: +(v.ms / v.count).toFixed(2) }]),
      timers: [...timerDelay].sort((a, b) => b[1].firedMs - a[1].firedMs).slice(0, 25) }, null, 1));
});
`);
}
const configFile = path.join(cacheDir, `vitest.${lane}.config.mjs`);
writeFileSync(configFile, `// 由 scripts/test-source.mjs 生成，勿手改。
export default {
  root: ${JSON.stringify(root.split(path.sep).join("/"))},
  resolve: { alias: [
${aliases.map(({ specifier, source }) => `    { find: /^${escape(specifier)}$/, replacement: ${JSON.stringify(source)} },`).join("\n")}
  ] },
  test: {
    pool: ${JSON.stringify(pool)},
    maxWorkers: ${workers},
    setupFiles: ${JSON.stringify([...(physicalSync ? [] : [setupFile]), ...(cpuProf ? [profileSetupFile] : []), ...(countFs ? [countSetupFile] : [])].map((file) => file.split(path.sep).join("/")))},
    ${projects}
    server: { deps: { inline: [/^@zhixing\\//] } },
    // 超时沿用 vitest 默认值（与各包自身配置一致），不为并发负载放宽。
  },
};
`);

// profile 时另记每个文件的收集、准备与执行耗时（vitest 的 testModule.diagnostic），定位导入开销。
const phaseFile = path.join(cacheDir, `phases-${lane}.json`);
const phaseReporter = path.join(cacheDir, "phase-reporter.mjs");
if (profile) {
  writeFileSync(phaseReporter, `// 由 scripts/test-source.mjs 生成，勿手改。
import { writeFileSync } from "node:fs";
export default class PhaseReporter {
  rows = [];
  onTestModuleEnd(module) {
    const d = module.diagnostic();
    this.rows.push({ file: module.moduleId, project: module.project.name, collect: d.collectDuration, prepare: d.prepareDuration, setup: d.setupDuration, run: d.duration });
  }
  onTestRunEnd() { writeFileSync(${JSON.stringify(phaseFile.split(path.sep).join("/"))}, JSON.stringify(this.rows)); }
}
`);
}
const reporters = profile ? ["--reporter=default", "--reporter=json", `--outputFile.json=${reportFile}`, `--reporter=${phaseReporter.split(path.sep).join("/")}`] : [];
console.log(`[test-source] lane=${lane} workers=${workers} sync=${physicalSync ? "physical" : "relaxed(fsync no-op)"} isolated-files=${isolateAll ? "all" : groups.isolated.length} process-files=${groups.process.length} exclusive-files=${groups.exclusive.length} aliases=${aliases.length} slow-files=${slow.length}`);
// 先清掉上一次的报告，避免本次未生成时把旧文件归档成本次证据。
if (profile) for (const file of [reportFile, phaseFile]) rmSync(file, { force: true });
const startedAt = new Date();
const started = performance.now();
const result = spawnSync(process.execPath, [vitest, "run", "--config", configFile, ...reporters, ...args], { cwd: root, stdio: "inherit" });
const wallSeconds = Math.round((performance.now() - started) / 1000);
console.log(`[test-source] lane=${lane} wall=${wallSeconds}s exit=${result.status}`);

// 测试从源码按需加载：运行期间改过受测源码，结果就混合了两个候选，不能作证据。
// 范围是各包 src（含用例）与 scripts 下的脚本；--profile 自动改写的 test-lanes.json 不算。
const changedDuringRun = [];
const walkChanged = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkChanged(full);
    else if (statSync(full).mtimeMs > startedAt.getTime()) changedDuringRun.push(path.relative(root, full).split(path.sep).join("/"));
  }
};
for (const base of [path.join(root, "packages"), path.join(root, "packages", "channels")]) {
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const src = path.join(base, entry.name, "src");
    if (entry.isDirectory() && existsSync(src)) walkChanged(src);
  }
}
for (const entry of readdirSync(path.join(root, "scripts"), { withFileTypes: true })) {
  const full = path.join(root, "scripts", entry.name);
  if (entry.isFile() && entry.name.endsWith(".mjs") && statSync(full).mtimeMs > startedAt.getTime()) changedDuringRun.push(`scripts/${entry.name}`);
}
if (changedDuringRun.length > 0) {
  console.log(`[test-source] 运行期间受测源码被改动（${changedDuringRun.length} 个），本次结果混合了两个候选，不作证据：`);
  for (const file of changedDuringRun.slice(0, 10)) console.log(`  ${file}`);
}

// profile 运行归档到带时间戳的独立目录，last-*.json 只是“最近一次”的入口，不作证据锚点。
if (profile) {
  const runDir = path.join(cacheDir, "runs", `${startedAt.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")}-${lane}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "meta.json"), JSON.stringify({
    lane, workers, pool, uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? null, isolateAll, physicalSync, filters: args, startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(), wallSeconds, exit: result.status, slowFiles: slow.length, isolatedFiles: groups.isolated.length, processFiles: groups.process.length, exclusiveFiles: groups.exclusive.length,
    cpus: os.cpus().length, platform: process.platform,
  }, null, 2) + "\n");
  for (const file of [reportFile, phaseFile]) if (existsSync(file)) writeFileSync(path.join(runDir, path.basename(file)), readFileSync(file));
  console.log(`[test-source] archived ${path.relative(root, runDir)}`);
}

if (profile && existsSync(reportFile)) {
  // 归类按每文件总成本：收集（模块导入）+ 准备 + 执行。导入重、执行快的文件同样拖慢快车道；
  // 没有阶段数据时退回执行时间。
  const relative = (file) => path.relative(root, file).split(path.sep).join("/");
  const timed = existsSync(phaseFile)
    ? JSON.parse(readFileSync(phaseFile, "utf8")).map((row) => ({ file: relative(row.file), ms: (row.collect || 0) + (row.prepare || 0) + (row.run || 0) }))
    : JSON.parse(readFileSync(reportFile, "utf8")).testResults.map((file) => ({ file: relative(file.name), ms: file.endTime - file.startTime }));
  // 只按本次实际跑到的文件更新：未跑到的保留原归类。迟滞：快车道文件达到阈值才转慢，慢车道
  // 文件降到阈值一半以下才转回快，避免负载抖动让阈值附近的文件在两条车道间来回切换。
  const cost = new Map(timed.map((entry) => [entry.file, entry.ms]));
  const inSlow = new Set(slow);
  const staysSlow = (file) => cost.has(file)
    ? cost.get(file) >= (inSlow.has(file) ? lanes.thresholdMs / 2 : lanes.thresholdMs)
    : existsSync(path.join(root, file));
  const next = [...new Set([...slow, ...cost.keys()])].filter(staysSlow).sort();
  writeFileSync(lanesFile, JSON.stringify({
    thresholdMs: lanes.thresholdMs,
    note: "慢车道清单：按 --profile 实测的每文件总成本（收集+准备+执行，达到阈值）自动维护，勿手改；归类不改变覆盖，只改变运行时机。",
    measuredWith: { workers, pool, cpus: os.cpus().length, platform: process.platform },
    slow: next,
  }, null, 2) + "\n");
  const top = [...timed].sort((a, b) => b.ms - a.ms).slice(0, 10);
  console.log(`[test-source] slow lane now ${next.length} files; slowest this run:`);
  for (const entry of top) console.log(`  ${(entry.ms / 1000).toFixed(1)}s  ${entry.file}`);
}
// 用例全过但源码中途变了，以 3 退出，避免验证链把它当成通过
process.exit(result.status === 0 && changedDuringRun.length > 0 ? 3 : result.status ?? 1);
