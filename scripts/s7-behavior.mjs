#!/usr/bin/env node
// 从源码运行 S7 行为承接登记里的用例，供 `pnpm s7:lint` 与 CI 使用。
// 只把登记的文件与实际标题交给运行器，结果写到本次唯一的 JSON 文件，再逐条核对每个登记用例恰好收集到一个且通过；
// 运行器退出码为 0 但登记用例缺失、被跳过、是 todo 或重名，同样失败。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S7_BEHAVIOR_EVIDENCE, behaviorEvidenceCases, behaviorEvidenceFailures } from "./s7-behavior-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = behaviorEvidenceCases(S7_BEHAVIOR_EVIDENCE);
if (cases.length === 0) {
  console.error("S7 behavior evidence registry is empty");
  process.exit(1);
}
const files = [...new Set(cases.map((entry) => entry.file))];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
const pattern = [...new Set(cases.map((entry) => escape(entry.title)))].join("|");
// 结果文件按本次运行独占，不与其他并发运行或运行器自己的缓存共用
const outputDirectory = mkdtempSync(path.join(os.tmpdir(), "zhixing-s7-behavior-"));
const outputFile = path.join(outputDirectory, "report.json");
// 失败只记退出码，不在 try 里直接 process.exit：那样会跳过 finally，留下本次的结果目录
let failed = false;
try {
  // 登记用例都是单例，2 个 worker 足够，避免和其他重作业争用
  const result = spawnSync(process.execPath, [
    path.join(root, "scripts", "test-source.mjs"), "--lane", "all", "--workers", "2",
    "--reporter=default", "--reporter=json", `--outputFile.json=${outputFile}`,
    ...files, "-t", pattern,
  ], { cwd: root, stdio: "inherit" });
  let report;
  try {
    report = JSON.parse(readFileSync(outputFile, "utf8"));
  } catch {
    report = undefined;
  }
  const failures = report ? behaviorEvidenceFailures(report, root) : ["S7 behavior evidence produced no runner result"];
  if (result.status !== 0) failures.push(`S7 behavior evidence runner exited ${result.status}`);
  if (failures.length > 0) {
    failed = true;
    console.error(`S7 behavior evidence failed:\n- ${failures.join("\n- ")}`);
  } else {
    console.log(`S7 behavior evidence passed: ${cases.length} registered cases collected once and passed.`);
  }
} finally {
  rmSync(outputDirectory, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
