/**
 * 知行 Playground — 快速验证 LLM + 工具端到端连通性
 *
 * 使用方式：
 *   1. 首次：在交互终端跑 `pnpm cli` 让向导写入 ~/.zhixing/credentials.json
 *   2. pnpm playground
 *
 * 配置来源（与 CLI 一致，零参数）：
 *   - ~/.zhixing/config.json（公开元数据；首次自动创建模板）
 *   - ~/.zhixing/credentials.json（apiKey；向导写入或用户编辑）
 *   - ./zhixing.config.json（项目级覆盖，可选）
 *
 * 也可通过环境变量覆盖（运行时 toggle，与凭证无关）：
 *   ZHIXING_MODEL     — 模型名称
 *   ZHIXING_PROMPT    — 用户输入
 */

import { createProviderFromConfig } from "../packages/providers/src/index.js";
import { userMessage, extractText } from "../packages/core/src/index.js";
import { drainAgentLoop } from "../packages/core/src/loop/index.js";
import { createReadTool, createWriteTool, createBashTool } from "../packages/tools-builtin/src/index.js";

// 从配置文件自动加载 provider，零参数
const { provider, defaultModel } = createProviderFromConfig();

// 环境变量可覆盖
const model = process.env["ZHIXING_MODEL"] ?? defaultModel;
const prompt = process.env["ZHIXING_PROMPT"] ?? "你好，请用一句话介绍你自己";

console.log("─".repeat(50));
console.log("  知行 Playground");
console.log(`  Provider: ${provider.id}`);
console.log(`  Model:    ${model}`);
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

// ─── 测试 2: 通过 Agent Loop 调用（无工具）───

console.log("\n" + "─".repeat(50));
console.log("[测试 2] Agent Loop 端到端调用（无工具）\n");

{
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
}

// ─── 测试 3: Agent Loop + 工具调用 ───

console.log("\n" + "─".repeat(50));
console.log("[测试 3] Agent Loop + 内置工具\n");

{
  const tools = [createReadTool(), createWriteTool(), createBashTool()];
  console.log(`  已注册工具: ${tools.map(t => t.name).join(", ")}\n`);

  const { result, yields } = await drainAgentLoop({
    provider,
    model,
    messages: [userMessage("请读取当前目录下的 package.json 文件，告诉我项目名称和版本号。")],
    tools,
    maxTurns: 3,
    workingDirectory: process.cwd(),
    systemPrompt: "你是一个编程助手。使用提供的工具来完成任务。",
  });

  // 输出事件流摘要
  for (const y of yields) {
    switch (y.type) {
      case "text_delta":
        process.stdout.write(y.text);
        break;
      case "tool_start":
        console.log(`\n  🔧 [tool:${y.name}] 开始执行...`);
        break;
      case "tool_end":
        console.log(`  🔧 [tool:${y.name}] 完成 (${y.duration}ms) | 结果前100字: ${y.result.content.slice(0, 100).replace(/\n/g, "\\n")}...`);
        break;
      case "turn_complete":
        console.log(`\n  ↻ 第 ${y.turnCount} 轮完成`);
        break;
    }
  }

  console.log();
  if (result.reason === "completed") {
    const answer = extractText(result.message);
    console.log(`\n  ✓ Agent + Tools 完成 | 输入 token: ${result.usage.inputTokens} | 输出 token: ${result.usage.outputTokens}`);
  } else {
    console.log(`\n  ⚠ Agent + Tools 结束 | 原因: ${result.reason}`);
  }
}

console.log("\n" + "─".repeat(50));
console.log("  所有测试通过！Provider + Agent Loop + Tools 端到端连通。");
console.log("─".repeat(50));
