import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { validateExtensionCandidate } from "@zhixing/core/extensions/candidate";
import { channelDeclaration } from "@zhixing/core/channels/extension";

try {
  if (!process.argv[2]) throw new Error("用法：node validate.mjs <candidate.json>");
  const candidate = validateExtensionCandidate(JSON.parse(await readFile(process.argv[2], "utf8")));
  channelDeclaration(candidate.manifest);
  const check = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: candidate.code, encoding: "utf8", timeout: 10000, windowsHide: true });
  if (check.status !== 0) throw new Error("入口 JavaScript 语法检查未通过");
  process.stdout.write(JSON.stringify({ valid: true, id: candidate.manifest.id, digest: candidate.manifest.digest,
    protocol: candidate.manifest.protocol, contract: candidate.manifest.contract, executed: false }) + "\n");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : "候选校验失败") + "\n");
  process.exitCode = 1;
}
