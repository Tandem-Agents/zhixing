/**
 * 工作台启动告警 —— 进入 REPL 时一次性输出的"异常状态需要你注意"信号。
 *
 * 与 welcome.ts 关系（workbench 子系统两个并列组件）：
 *   welcome.ts    = 稳态快照（chrome 内的运行环境信息）
 *   advisories.ts = 异常告知（chrome 之前的、需要立即看到的警告）
 *
 * 输出顺序：advisories（异常）→ chrome（稳态）→ prompt
 * 为什么 advisories 在 chrome 之前：
 *   - 异常状态（如 workspace 创建失败）若用户启动后立刻输入命令会被错过
 *   - chrome 之前最醒目；chrome 之后的位置 user 视线已下移到 prompt 区
 *   - chrome 是稳态门面，不应被异常告警污染
 *
 * 设计原则：
 *   - 行式输出：纯函数返回 string[]，caller 顺序写出，与 chrome 同契约
 *   - 极简告警：只输出该轮启动需要用户注意的异常；正常状态返回空数组
 *   - stateless：每次启动重新评估，不做"已经看过就不再显示"逻辑
 *
 * 扩展指南：未来加凭证过期 / 新版本可用 / scheduler missed-task 等告警时，
 *   在 StartupAdvisoryInfo 里加字段 + 在 renderStartupAdvisories 加 if 分支。
 *   每个告警自洽（输入条件 → 1-2 行输出），不互相依赖。
 */

import chalk from "chalk";
import type { WorkspaceDirStatus, WorkspaceSource } from "@zhixing/providers";

export interface StartupAdvisoryInfo {
  /** workspace 目录就绪状态 */
  workspaceDirStatus: WorkspaceDirStatus;
  /** workspace 解析后的绝对路径，null = 无 workspace 上下文 */
  workspacePath: string | null;
  /** workspace 来源——用于区分 "skipped" 的两种语义（fallback vs 创建失败） */
  workspaceSource: WorkspaceSource;
}

/**
 * 渲染启动告警的所有行——chrome 之前打印。
 * 无告警时返回空数组——caller 可据此决定是否在 advisories 与 chrome 之间加空行分隔。
 */
export function renderStartupAdvisories(
  info: StartupAdvisoryInfo,
): string[] {
  const lines: string[] = [];

  // workspace 创建失败警告：用户配置了 workspace 路径但 mkdir 失败。
  //
  // "skipped" 在 ensureWorkspaceDir 里同时表达两种语义：
  //   1) 无需创建（cwd-fallback / none）—— 健康状态，不告警
  //   2) 配置了路径但创建失败（catch 分支）—— 异常状态，必须告警
  // 排除前两种来源 + 路径非空，剩下的就是真正的"用户配置了路径但失败"。
  if (
    info.workspaceDirStatus === "skipped" &&
    info.workspacePath &&
    info.workspaceSource !== "cwd-fallback" &&
    info.workspaceSource !== "none"
  ) {
    lines.push(chalk.yellow(`  ⚠ workspace: ${info.workspacePath}`));
    lines.push(
      chalk.yellow("  工作区目录不存在且无法创建，请检查路径或权限。"),
    );
  }

  return lines;
}
