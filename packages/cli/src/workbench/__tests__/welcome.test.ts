/**
 * 工作台 welcome 渲染快照——守护"启动后用户看到什么"。
 *
 * 视觉变更（如调整品牌锚 / body 信息条目 / 颜色 token / 锚 row 角色重排）
 * 会让快照失败，强制 reviewer 明确改动意图，避免无声漂移。
 *
 * 锚 body 三行角色（与 welcome.ts JSDoc 同源）：
 *   row1 = 锚天线（仅 glyph） / row2 = 产品身份（知行）/ row3 = 会话状态
 */

import { describe, expect, it } from "vitest";
import chalk from "chalk";
import { renderHomeWelcome } from "../welcome.js";
import { stripAnsi } from "../../tui/index.js";

// vitest stdout 非 TTY，chalk 默认不染色——强开以让 dim 等 token 出现在结果里
chalk.level = 3;

const FIXED_COLUMNS = 80;
const originalColumns = process.stdout.columns;

function withFixedWidth<T>(fn: () => T): T {
  Object.defineProperty(process.stdout, "columns", {
    value: FIXED_COLUMNS,
    configurable: true,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(process.stdout, "columns", {
      value: originalColumns,
      configurable: true,
    });
  }
}

describe("renderHomeWelcome", () => {
  it("workspace + model + 已恢复对话完整渲染", () => {
    const lines = withFixedWidth(() =>
      renderHomeWelcome({
        providerId: "siliconflow",
        model: "DeepSeek-V3",
        workspaceRoot: "/Users/me/project",
        resumedConversationName: "chat-20260504-41b4",
      }),
    );
    expect(lines.map(stripAnsi).join("\n")).toMatchInlineSnapshot(`
      "╭──── ╲ ───────────────────────────────────────────────────────────────────────╮
      │    ▄▄▄                                                                       │
      │   ▌●●▐    知行                                                               │
      │    ▀▀     已恢复对话 chat-20260504-41b4                                      │
      │                                                                              │
      │   工作目录    /Users/me/project                                              │
      │   模型        siliconflow · DeepSeek-V3                                      │
      │                                                                              │
      ╰──────────────────────────────────────────────────────────────────────────────╯"
    `);
  });

  it("无 workspaceRoot 时该行不渲染（不强行 fallback）", () => {
    const lines = withFixedWidth(() =>
      renderHomeWelcome({
        providerId: "siliconflow",
        model: "DeepSeek-V3",
      }),
    );
    const visible = lines.map(stripAnsi).join("\n");
    expect(visible).not.toContain("工作目录");
    expect(visible).toContain("siliconflow · DeepSeek-V3");
  });

  it("锚 row 角色：row1 仅天线 / row2 inline 知行 / row3 仅 glyph（新会话）", () => {
    const lines = withFixedWidth(() =>
      renderHomeWelcome({
        providerId: "x",
        model: "y",
      }),
    );
    const stripped = lines.map(stripAnsi);
    // lines[0] 顶边；lines[1..3] 锚 body 三行
    expect(stripped[1]!).toContain("▄▄▄");
    expect(stripped[1]!).not.toContain("知行"); // row1 留给天线，文字不放此行
    expect(stripped[2]!).toContain("●●");
    expect(stripped[2]!).toContain("知行"); // 产品身份在心脏 ●● 位置
    expect(stripped[3]!).toContain("▀▀");
    expect(stripped[3]!).not.toContain("已恢复对话"); // 新会话 row3 仅 glyph
  });

  it("有 resumedConversationName 时 row3 inline '已恢复对话 X'", () => {
    const lines = withFixedWidth(() =>
      renderHomeWelcome({
        providerId: "x",
        model: "y",
        resumedConversationName: "chat-XXXX",
      }),
    );
    const stripped = lines.map(stripAnsi);
    expect(stripped[1]!).not.toContain("知行"); // row1 不变（仅天线）
    expect(stripped[2]!).toContain("知行"); // row2 不变（产品身份）
    expect(stripped[3]!).toContain("▀▀");
    expect(stripped[3]!).toContain("已恢复对话 chat-XXXX"); // row3 inline 状态
  });

  it("已恢复对话用 dim——次要状态告知不抢戏", () => {
    const lines = withFixedWidth(() =>
      renderHomeWelcome({
        providerId: "x",
        model: "y",
        resumedConversationName: "chat-XXXX",
      }),
    );
    // row3 包含 dim ANSI 序列（chalk.dim = ESC[2m）
    const row3 = lines[3]!;
    expect(row3).toContain("\x1b[2m");
    expect(row3).toContain("已恢复对话 chat-XXXX");
  });

  it("model 行用 dim——保持终端清爽感", () => {
    const lines = withFixedWidth(() =>
      renderHomeWelcome({ providerId: "siliconflow", model: "DeepSeek-V3" }),
    );
    const modelLine = lines.find((l) => l.includes("siliconflow · DeepSeek-V3"))!;
    expect(modelLine).toContain("\x1b[2m");
  });

  it("不再渲染 /help 提示——已迁移到 prompt placeholder", () => {
    const lines = withFixedWidth(() =>
      renderHomeWelcome({
        providerId: "siliconflow",
        model: "DeepSeek-V3",
        workspaceRoot: "/Users/me/project",
      }),
    );
    const visible = lines.map(stripAnsi).join("\n");
    expect(visible).not.toContain("/help");
    expect(visible).not.toContain("查看可用命令");
  });
});
