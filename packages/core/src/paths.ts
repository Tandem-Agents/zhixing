/**
 * 共享路径基础设施
 *
 * ConversationRepository 和 TranscriptStore 都依赖这些工具函数，
 * 提取到独立模块避免重复定义和隐性耦合。
 */

import { createHash } from "node:crypto";
import path from "node:path";

/** 知行数据根目录：~/.zhixing 或 ZHIXING_HOME 环境变量 */
export function getZhixingHome(): string {
  return (
    process.env.ZHIXING_HOME ??
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".zhixing")
  );
}

/** 计算项目 ID：SHA-256(路径归一化) 前 12 位 hex */
export function getProjectId(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, "/").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

/**
 * 将逻辑标识符转为跨平台安全的目录名。
 *
 * 对话 ID 等逻辑标识符可能包含 `:` 等在 Windows 上非法的路径字符。
 * 所有从逻辑 ID 到文件系统路径的映射都必须经过此函数。
 */
export function toSafePathSegment(id: string): string {
  return id.replace(/:/g, "--");
}
