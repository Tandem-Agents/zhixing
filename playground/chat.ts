/**
 * 知行 Playground — 快速验证 LLM 连通性
 *
 * 使用方式：
 *   1. 复制 .env.example 为 .env 并填入 API Key
 *   2. pnpm playground
 *
 * 配置来源（无需手动传参）：
 *   - ~/.zhixing/config.json（全局默认，首次自动创建模板）
 *   - ./zhixing.config.json（项目级覆盖，可选）
 *   - 环境变量（API Key 等）
 *
 * 也可通过环境变量覆盖：
 *   ZHIXING_PROVIDER  — provider ID
 *   ZHIXING_MODEL     — 模型名称
 *   ZHIXING_PROMPT    — 用户输入
 */

import { createProviderFromConfig } from "../packages/providers/src/index.js";
import { userMessage, extractText } from "../packages/core/src/index.js";
import { drainAgentLoop } from "../packages/core/src/loop/index.js";

// 从配置文件自动加载 provider，零参数
const { provider, defaultModel, config } = createProviderFromConfig();

// 环境变量可覆盖
const model = process.env["ZHIXING_MODEL"] ?? defaultModel;
const prompt = process.env["ZHIXING_PROMPT"] ?? "你好，请用一句话介绍你自己";

console.log("─".repeat(50));
console.log("  知行 Playground");
console.log(`  Provider: ${provider.id}`);
console.log(`  Model:    ${model}`);
console.log(`  Config:   defaultProvider=${config.defaultProvider ?? "(未设置)"}`);
console.log(`  Prompt:   ${prompt}`);
console.log("─".repeat(50));
console.log();

// ─── 测试 1: 直接调用 Provider（流式输出）───

console.log("[测试 1] Provider 直接流式调用\n");

let fullText = "";
for await (const event of provider.chat({
  model,
  messages: [userMessage(prompt)],
  maxTokens: 200,
})) {
  switch (event.type) {
    case "message_start":
      process.stdout.write("  ▸ ");
      break;
    case "text_delta":
      process.stdout.write(event.text);
      fullText += event.text;
      break;
    case "message_end":
      console.log(`\n\n  ✓ 完成 | 停止原因: ${event.stopReason} | 输入 token: ${event.usage.inputTokens} | 输出 token: ${event.usage.outputTokens}`);
      break;
    case "error":
      console.error(`\n  ✗ 错误: ${event.error.message}`);
      break;
  }
}

// ─── 测试 2: 通过 Agent Loop 调用 ───

console.log("\n" + "─".repeat(50));
console.log("[测试 2] Agent Loop 端到端调用\n");

const { result, yields } = await drainAgentLoop({
  provider,
  model,
  messages: [userMessage("天空是什么颜色？请用一个字回答。")],
  maxTurns: 1,
  systemPrompt: "你是一个极简助手，用最少的字回答问题。",
});

const textDeltas = yields.filter((y) => y.type === "text_delta");
process.stdout.write("  ▸ ");
for (const td of textDeltas) {
  if (td.type === "text_delta") process.stdout.write(td.text);
}
console.log();

if (result.reason === "completed") {
  const answer = extractText(result.message);
  console.log(`\n  ✓ Agent Loop 完成 | 回答: "${answer}" | 输入 token: ${result.usage.inputTokens} | 输出 token: ${result.usage.outputTokens}`);
} else {
  console.log(`\n  ⚠ Agent Loop 结束 | 原因: ${result.reason}`);
}

console.log("\n" + "─".repeat(50));
console.log("  所有测试通过！配置系统 + Provider 层端到端连通。");
console.log("─".repeat(50));
