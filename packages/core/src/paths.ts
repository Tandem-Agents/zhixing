/**
 * 共享路径基础设施
 *
 * 全 monorepo 路径解析的公共原语：
 *   - `getZhixingHome()`  ~/.zhixing 数据根（domain 子路径都从这里派生）
 *   - `expandUserHome()`  ~ 路径展开
 *   - `toSafePathSegment()` 跨平台目录名安全化
 *
 * 各 domain 自己的子路径 getter 在各 domain 模块内（如 server/paths.ts、
 * providers/paths.ts），都基于 getZhixingHome 派生 —— 同一物理路径在系统里只
 * 在一处拼接。本文件是直接调用 node:os homedir / node:fs mkdtemp 等"路径原始
 * API"的唯一豁免点（防回归靠 ESLint no-restricted-imports）。
 */

import { Buffer } from "node:buffer";
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

/**
 * 将逻辑标识符转为跨平台安全、无碰撞的单个目录段。
 *
 * 普通 slug 保持可读；包含路径分隔符、Windows 非法/保留字符、编码前缀等
 * 风险形态时转为带前缀的 base64url。所有从逻辑 ID 到文件系统路径的映射
 * 都必须经过此函数，调用方不得自行替换字符。
 */
export function toSafePathSegment(id: string): string {
  if (isPlainSafePathSegment(id)) return id;
  return `${ENCODED_PATH_SEGMENT_PREFIX}${Buffer.from(id, "utf8").toString(
    "base64url",
  )}`;
}

const ENCODED_PATH_SEGMENT_PREFIX = "zid-";
const PLAIN_SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isPlainSafePathSegment(id: string): boolean {
  if (!PLAIN_SAFE_PATH_SEGMENT.test(id)) return false;
  if (id.startsWith(ENCODED_PATH_SEGMENT_PREFIX)) return false;
  if (id === "." || id === "..") return false;
  if (id.endsWith(".") || id.endsWith(" ")) return false;
  return !isWindowsReservedSegment(id);
}

function isWindowsReservedSegment(id: string): boolean {
  const base = id.split(".")[0]!.toUpperCase();
  return (
    base === "CON" ||
    base === "PRN" ||
    base === "AUX" ||
    base === "NUL" ||
    /^COM[1-9]$/.test(base) ||
    /^LPT[1-9]$/.test(base)
  );
}
