/**
 * 记忆系统类型定义
 *
 * 记忆支柱 + 暂存层架构：
 * - Profile（身份画像）— 始终注入
 * - People（关系网络）— 按需检索注入
 * - Journal（对话日志）— 暂存层，有生命周期
 *
 * 所有记忆以 Markdown + YAML frontmatter 存储在 ~/.zhixing/me/ 下。
 */

import path from "node:path";
import { getZhixingHome } from "../paths.js";

// ─── Profile ───

export interface ProfileMeta {
  name: string;
  language?: string;
  timezone?: string;
}

export interface ProfileData {
  meta: ProfileMeta;
  /** frontmatter 之后的 Markdown 正文 */
  content: string;
  /** 文件完整内容（含 frontmatter），用于 /me 展示 */
  raw: string;
}

// ─── 记忆目录 ───

/**
 * 个人记忆域根目录：`<zhixingHome>/me`。
 *
 * 经 getZhixingHome() 派生 —— 尊重 ZHIXING_HOME；未设时落 ~/.zhixing/me，
 * 与历史默认逐字节一致。这是所有 me/ 域访问者（4 store class 的 baseDir
 * fallback、profile-loader、cli 各 store）未显式注入 root 时的默认路径源；
 * 工作场景的 scope 隔离另由装配期 root 注入覆盖（两层分工：本函数负责
 * 默认路径正确，root 注入负责物理隔离）。
 */
export function getMemoryDir(): string {
  return path.join(getZhixingHome(), "me");
}
