/**
 * Profile Loader — 身份画像加载
 *
 * Phase M1 核心模块：加载 ~/.zhixing/me/profile.md，
 * 解析 YAML frontmatter，注入到上下文中。
 *
 * 文件格式：
 * ```markdown
 * ---
 * name: 张三
 * language: zh-CN
 * timezone: Asia/Shanghai
 * ---
 *
 * ## 技术栈
 * TypeScript, React, Node.js
 *
 * ## 偏好
 * 喜欢简洁的代码风格
 * ```
 *
 * 加载行为：
 * - 文件不存在 → 返回 null（正常，不报错）
 * - 文件存在但为空 → 返回 null
 * - frontmatter 缺少 name → 仍然加载（name 取 "User"）
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import type { ProfileData, ProfileMeta } from "./types.js";
import { getMemoryDir } from "./types.js";

/**
 * 加载用户身份画像。
 * @returns ProfileData 或 null（文件不存在/为空时）
 */
export async function loadProfile(): Promise<ProfileData | null> {
  const profilePath = path.join(getMemoryDir(), "profile.md");

  let raw: string;
  try {
    raw = await fs.readFile(profilePath, "utf-8");
  } catch {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const parsed = parseFrontmatter<Partial<ProfileMeta>>(raw);

  const meta: ProfileMeta = {
    name: parsed.data.name ?? "User",
    language: parsed.data.language,
    timezone: parsed.data.timezone,
  };

  return {
    meta,
    content: parsed.content,
    raw: trimmed,
  };
}

/**
 * 将 Profile 格式化为上下文注入段落。
 *
 * 输出格式：
 * ```
 * # User Profile
 * Name: 张三
 * Language: zh-CN
 *
 * ## 技术栈
 * TypeScript, React, Node.js
 * ```
 *
 * 设计要点：
 * - 结构化的 meta 字段放在顶部（便于 LLM 快速定位身份信息）
 * - Markdown 正文原样追加（用户自由组织的详细信息）
 * - 控制在 ~500 tokens 内（profile.md 本身应保持简洁）
 */
export function formatProfileForContext(profile: ProfileData): string {
  const lines: string[] = ["# User Profile"];

  lines.push(`Name: ${profile.meta.name}`);
  if (profile.meta.language) {
    lines.push(`Language: ${profile.meta.language}`);
  }
  if (profile.meta.timezone) {
    lines.push(`Timezone: ${profile.meta.timezone}`);
  }

  if (profile.content) {
    lines.push("", profile.content);
  }

  return lines.join("\n");
}
