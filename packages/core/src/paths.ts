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
