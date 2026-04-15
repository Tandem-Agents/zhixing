// Typeahead 面板手动验收脚本 — 真 TTY 下跑这个，确认光标不变量 + 键盘交互
//
// 用法:
//   pnpm --filter @zhixing/cli build
//   node packages/cli/dist/tui/__manual__/typeahead-manual.mjs
//
// 或直接用 tsx:
//   pnpm tsx packages/cli/src/tui/__manual__/typeahead-manual.mjs
//
// 预期体验（spec §9.2 Step 4 手动验收）:
//   1. 打开脚本 → 屏幕显示 "输入 '/' 开始补全" 的提示
//   2. 打 '/' → 面板立刻出现，显示全部内建命令（按 category 排序）
//   3. 打 '/e' → 面板 resort 到以 e 开头的命令（/elevated 排首位，已选中）
//   4. ↑↓ 在候选项间移动（选中项 ❯）
//   5. Enter / Tab → 接受首项，面板消失，上方 "接受" 行打印 displayText
//   6. Esc → 清空 trigger，面板消失，draft 恢复到 '/' 前
//   7. 退出 active 态时面板**完全消失**（无残留行、无 stack）
//   8. 终端 resize（拖窗口）时自动 rerender（下次按键触发）
//   9. Ctrl+C 退出脚本

import {
  CommandProvider,
  DefaultCommandRegistry,
  DefaultTypeaheadBroker,
  registerBuiltinCommands,
  UsageTracker,
  getAgentIdentity,
} from "@zhixing/core";
import * as readline from "node:readline";
import { createTerminalTypeaheadRenderer } from "../typeahead-renderer.js";

const { displayName } = getAgentIdentity();

console.log(`=== TypeaheadPanel 手动验收 (${displayName}) ===`);
console.log("Platform:", process.platform, "Node:", process.version);
console.log("stdout.isTTY:", process.stdout.isTTY);
console.log("stdout.columns:", process.stdout.columns);
console.log();
console.log("打 '/' 开始补全；↑↓ 导航；Enter 接受；Esc 清空；Ctrl+C 退出");
console.log();

// ── Broker + provider 接线 ──
const registry = new DefaultCommandRegistry();
registerBuiltinCommands(registry);

const usageTracker = new UsageTracker({
  // 不持久化：手动验收里不要在用户目录留文件
  rootDir: null,
  now: () => Date.now(),
});

const broker = new DefaultTypeaheadBroker({
  eventSink: (event) => {
    // 诊断：把关键事件打到上方区域（不影响面板）
    if (
      event.type === "typeahead:query-completed" ||
      event.type === "typeahead:suggestion-accepted"
    ) {
      // 不 log —— 避免和面板冲突。如需调试取消下一行注释
      // process.stderr.write(`[event] ${event.type}\n`);
    }
  },
});

broker.register(
  new CommandProvider({ registry, usageTracker }),
);

// ── InputBuffer：最小化本地实现 ──
// 真实 Step 5 的 InputBuffer 在 @zhixing/cli/input-buffer.ts —— 本 playground
// 只演示 panel 的接线，所以直接 inline 一个玩具实现。
const buffer = { draft: "", cursor: 0 };
const makeCtx = () => ({
  draft: buffer.draft,
  cursor: buffer.cursor,
  mode: "prompt",
  runtime: {
    sessionBusy: false,
    workspaceId: null,
    cwd: process.cwd(),
    target: "cli",
    features: {},
    now: Date.now(),
  },
});

const session = broker.beginSession(makeCtx());

// ── Renderer ──
const renderer = createTerminalTypeaheadRenderer({
  broker,
  onAccept: (sessionId, item) => {
    const result = broker.accept(sessionId, item);
    if (!result) return;
    buffer.draft = result.newDraft;
    buffer.cursor = result.newCursor;
    // 手动验收里用 stderr 打印结果（避免污染 panel 区域）
    process.stderr.write(
      `\n[accepted] ${item.displayText} → draft="${buffer.draft}" execute=${result.execute}\n`,
    );
  },
  onCancel: () => {
    // Esc：清掉 trigger token（最简单：清整个 draft）
    buffer.draft = "";
    buffer.cursor = 0;
    broker.updateInput(session.id, makeCtx());
  },
});
renderer.attach(session.id);

// ── 我们自己的按键处理：把字符写入 buffer 并 updateInput ──
//
// 注意：renderer 已经独占了 stdin，它在 attach 时 snapshot 了 saved listeners
// 并摘除，所以我们要在 renderer.attach **之前**挂好 keypress —— 但这会被
// snapshot 摘掉。正确做法：让 renderer attach 完毕后我们再添加（renderer 不
// 会再 snapshot），但我们的 listener 必须处理"panel 没吞的按键"。
//
// 更简单的做法：手动 polling stdin.read() 拿原始字节。不过这里演示用
// 的是同步 keypress 事件。
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

process.stdin.on("keypress", (str, key) => {
  if (!key) return;

  // 让 renderer 先吞：导航键和 Enter/Esc 已经由 panel 处理，我们这里只处理
  // 可打印字符和 backspace。Renderer 不消费这些 —— 它们都进 buffer。
  if (key.ctrl && key.name === "c") {
    renderer.detach();
    broker.cancelSession(session.id);
    process.stderr.write("\n[exit]\n");
    process.exit(0);
  }

  if (key.name === "return" || key.name === "tab" ||
      key.name === "up" || key.name === "down" ||
      key.name === "escape") {
    // Panel 已处理；但 panel 不知道 buffer 的存在，我们在 onAccept 里
    // 已经更新 buffer，updateInput 的触发改到 onAccept 回调里：
    if (key.name === "escape") {
      // onCancel 已经清了 buffer 并 updateInput
    }
    return;
  }

  if (key.name === "backspace") {
    if (buffer.draft.length > 0) {
      buffer.draft = buffer.draft.slice(0, -1);
      buffer.cursor = buffer.draft.length;
      broker.updateInput(session.id, makeCtx());
    }
    return;
  }

  // 可打印字符
  if (str && !key.ctrl && !key.meta && !str.startsWith("\x1b")) {
    buffer.draft += str;
    buffer.cursor = buffer.draft.length;
    broker.updateInput(session.id, makeCtx());
  }
});

// 保持 process 活着
process.stdin.resume();
