import { readFile } from "node:fs/promises";
import { validateCandidatePayload } from "./validate-candidate.js";

try {
  if (!process.argv[2]) throw new Error("用法：node validate.mjs <candidate.json>");
  const { summary } = await validateCandidatePayload(JSON.parse(await readFile(process.argv[2], "utf8")));
  process.stdout.write(JSON.stringify(summary) + "\n");
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : "候选校验失败") + "\n");
  process.exitCode = 1;
}
