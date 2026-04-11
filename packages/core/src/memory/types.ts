/**
 * 记忆系统类型定义
 *
 * 三支柱 + 暂存层架构：
 * - Profile（身份画像）— 始终注入
 * - People（关系网络）— 按需检索注入
 * - Skills（技能沉淀）— Trigger 匹配注入
 * - Journal（对话日志）— 暂存层，有生命周期
 *
 * 所有记忆以 Markdown + YAML frontmatter 存储在 ~/.zhixing/me/ 下。
 */

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
 * 获取记忆根目录路径：~/.zhixing/me/
 * 所有记忆文件都在此目录下。
 */
export function getMemoryDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return `${home}/.zhixing/me`;
}
