/**
 * 启动告警渲染测试 —— 守护"什么状态触发哪个告警"。
 *
 * 这些断言保证：
 *   - 真正的异常（workspace 创建失败）不会被静默
 *   - 正常状态（exists / created / cwd-fallback / 无路径）不打扰用户
 *
 * 未来增加新告警类型时，在此追加 describe 块即可——每个告警独立测试。
 */

import { describe, expect, it } from "vitest";
import chalk from "chalk";
import { renderStartupAdvisories } from "../advisories.js";
import { stripAnsi } from "../../tui/index.js";

chalk.level = 3;

describe("renderStartupAdvisories — workspace 创建失败警告", () => {
  it("skipped + cli source + 路径非空 → 黄色 ⚠ + 提示", () => {
    const lines = renderStartupAdvisories({
      workspaceDirStatus: "skipped",
      workspacePath: "/some/blocked/path",
      workspaceSource: "cli",
    });
    const visible = lines.map(stripAnsi).join("\n");
    expect(lines).toHaveLength(2);
    expect(visible).toContain("⚠ workspace: /some/blocked/path");
    expect(visible).toContain("无法创建");
    // 黄色 ANSI（chalk.yellow = ESC[33m）
    expect(lines[0]!).toContain("\x1b[33m");
    expect(lines[1]!).toContain("\x1b[33m");
  });

  it("skipped + global-config / directory-config 也触发警告", () => {
    for (const source of ["global-config", "directory-config"] as const) {
      const lines = renderStartupAdvisories({
        workspaceDirStatus: "skipped",
        workspacePath: "/blocked",
        workspaceSource: source,
      });
      expect(lines.length).toBeGreaterThan(0);
    }
  });

  it("skipped + cwd-fallback → 不警告（健康的'无需创建'语义）", () => {
    const lines = renderStartupAdvisories({
      workspaceDirStatus: "skipped",
      workspacePath: process.cwd(),
      workspaceSource: "cwd-fallback",
    });
    expect(lines).toEqual([]);
  });

  it("skipped + none → 不警告（非交互模式无 workspace）", () => {
    const lines = renderStartupAdvisories({
      workspaceDirStatus: "skipped",
      workspacePath: null,
      workspaceSource: "none",
    });
    expect(lines).toEqual([]);
  });

  it("skipped + 路径为 null → 不警告（无路径意味着没有'配置失败'概念）", () => {
    const lines = renderStartupAdvisories({
      workspaceDirStatus: "skipped",
      workspacePath: null,
      workspaceSource: "cli",
    });
    expect(lines).toEqual([]);
  });
});

describe("renderStartupAdvisories — 健康状态不打扰用户", () => {
  it("exists → 空数组", () => {
    const lines = renderStartupAdvisories({
      workspaceDirStatus: "exists",
      workspacePath: "/healthy",
      workspaceSource: "global-config",
    });
    expect(lines).toEqual([]);
  });

  it("created（首次创建）→ 空数组", () => {
    const lines = renderStartupAdvisories({
      workspaceDirStatus: "created",
      workspacePath: "/new",
      workspaceSource: "cli",
    });
    expect(lines).toEqual([]);
  });

  it("recreated（重建）→ 空数组", () => {
    const lines = renderStartupAdvisories({
      workspaceDirStatus: "recreated",
      workspacePath: "/restored",
      workspaceSource: "global-config",
    });
    expect(lines).toEqual([]);
  });
});
