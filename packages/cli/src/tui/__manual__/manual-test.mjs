// 手动 TTY 验收脚本 — 在真实 Windows Terminal 里跑这个确认组件体验
//
// 用法:
//   pnpm --filter @zhixing/cli build
//   node packages/cli/dist/tui/__manual__/manual-test.mjs
//
// 或直接用 tsx:
//   pnpm tsx packages/cli/src/tui/__manual__/manual-test.mjs
//
// 预期:
//   - 面板只出现一次（无堆叠）
//   - ↑↓ 箭头在选项间移动
//   - Enter 选中 simple 选项时返回 { kind: "selected", value }
//   - Enter 在 input 选项上进入输入模式，再次 Enter 提交带 note
//   - 中文输入正常
//   - Ctrl+C 返回 { kind: "cancelled", cause: "ctrl-c" }
//   - resize 终端不破坏面板

import { getAgentIdentity } from "@zhixing/core";
import { selectWithInput } from "../select-with-input.js";

// 取应用身份（默认 "知行"；被 zhixing.config.json 的 agent.displayName 覆盖时
// 走 setAgentIdentity 写进单例）。手动测试里没跑 createAgentRuntime 所以用默认值。
const { displayName } = getAgentIdentity();

console.log(`=== SelectWithInput 手动验收 (${displayName}) ===`);
console.log("Platform:", process.platform, "Node:", process.version);
console.log("stdout.isTTY:", process.stdout.isTTY);
console.log("stdout.columns:", process.stdout.columns);
console.log();

const result = await selectWithInput({
  title: `安全确认 (手动测试)`,
  body: "$ rm -rf node_modules",
  options: [
    { type: "simple", value: "allow-once", label: "允许这一次", hotkey: "y" },
    {
      type: "input",
      value: "allow-with-note",
      label: "允许并补充...",
      placeholder: `告诉${displayName}接下来该做什么`,
      allowEmptySubmit: true,
    },
    {
      type: "simple",
      value: "allow-session",
      label: '会话内允许 "rm *"',
      hotkey: "s",
    },
    {
      type: "input",
      value: "deny",
      label: "拒绝...",
      placeholder: `告诉${displayName}哪里错了`,
      allowEmptySubmit: true,
      hotkey: "n",
    },
  ],
});

console.log("\n最终决定:", JSON.stringify(result, null, 2));
