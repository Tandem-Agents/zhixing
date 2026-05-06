/**
 * 共享路径基础设施
 *
 * 全 monorepo 路径解析的公共原语：
 *   - `getZhixingHome()`  ~/.zhixing 数据根（domain 子路径都从这里派生）
 *   - `expandUserHome()`  ~ 路径展开
 *   - `getProjectId()`    项目路径 → 12 位 hex id
 *   - `toSafePathSegment()` 跨平台目录名安全化
 *
 * 各 domain 自己的子路径 getter 在各 domain 模块内（如 server/paths.ts、
 * providers/paths.ts），都基于 getZhixingHome 派生 —— 同一物理路径在系统里只
 * 在一处拼接。本文件是直接调用 node:os homedir / node:fs mkdtemp 等"路径原始
 * API"的唯一豁免点（防回归靠 ESLint no-restricted-imports）。
 */

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

/** 知行数据根目录：~/.zhixing 或 ZHIXING_HOME 环境变量 */
export function getZhixingHome(): string {
  return (
    process.env.ZHIXING_HOME ??
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".zhixing")
  );
}

/**
 * 把以 `~` 开头的路径展开为绝对路径——`~` 自身、`~/...`、`~\...`（Windows）。
 * 不以 `~` 开头的输入（绝对路径、相对路径、空字符串等）原样返回。
 *
 * 严格只匹配 `~`、`~/`、`~\` 三种前缀；像 `~user/foo` 这种 Unix
 * "另一用户家目录" 形式不展开（Node 无原生 API、跨平台不支持），原样透传。
 */
export function expandUserHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
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
