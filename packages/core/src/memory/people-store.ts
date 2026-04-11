/**
 * PeopleStore — 关系网络存储与检索
 *
 * Phase M3 核心模块：管理 ~/.zhixing/me/people/ 下的人物档案。
 * 支持通过人名精确匹配和关系词映射匹配。
 *
 * 文件结构：
 *   ~/.zhixing/me/people/<slug>.md
 *
 * 关系词映射：内置中文关系词到标准 relation 的映射，
 * 用户消息中出现"我老婆"→ 匹配 relation: "妻子" 的人物档案。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.js";
import { getMemoryDir } from "./types.js";

// ─── 类型 ───

export interface PersonMeta {
  name: string;
  relation: string;
  birthday?: string;
  tags?: string[];
}

export interface PersonEntry {
  id: string;
  meta: PersonMeta;
  content: string;
  filePath: string;
}

export interface PersonMatch {
  person: PersonEntry;
  /** 命中的关键词（人名或关系词） */
  matchedKeyword: string;
  /** 匹配类型 */
  matchType: "name" | "relation";
}

// ─── 关系词映射 ───

/**
 * 中文关系词 → 标准 relation 映射。
 * 支持同一 relation 的多种口语表达。
 */
const RELATION_ALIASES: ReadonlyMap<string, string> = new Map([
  // 配偶
  ["老婆", "妻子"], ["媳妇", "妻子"], ["太太", "妻子"], ["夫人", "妻子"],
  ["老公", "丈夫"], ["先生", "丈夫"],
  // 父母
  ["妈妈", "母亲"], ["我妈", "母亲"], ["老妈", "母亲"], ["娘", "母亲"],
  ["爸爸", "父亲"], ["我爸", "父亲"], ["老爸", "父亲"],
  // 子女
  ["儿子", "儿子"], ["女儿", "女儿"], ["孩子", "子女"], ["小孩", "子女"],
  // 兄弟姐妹
  ["哥哥", "兄长"], ["弟弟", "弟弟"], ["姐姐", "姐姐"], ["妹妹", "妹妹"],
  // 恋人
  ["女朋友", "女友"], ["女友", "女友"], ["男朋友", "男友"], ["男友", "男友"],
  ["对象", "伴侣"],
  // 朋友/同事
  ["朋友", "朋友"], ["同事", "同事"], ["同学", "同学"],
  ["老板", "上司"], ["领导", "上司"], ["上司", "上司"],
]);

// ─── PeopleStore ───

export class PeopleStore {
  private readonly peopleDir: string;

  constructor(baseDir?: string) {
    const memDir = baseDir ?? getMemoryDir();
    this.peopleDir = path.join(memDir, "people");
  }

  /**
   * 保存人物档案。
   */
  async save(id: string, meta: PersonMeta, content: string): Promise<string> {
    await fs.mkdir(this.peopleDir, { recursive: true });

    const filePath = this.resolvePath(id);
    const raw: Record<string, unknown> = {
      name: meta.name,
      relation: meta.relation,
    };
    if (meta.birthday) raw.birthday = meta.birthday;
    if (meta.tags && meta.tags.length > 0) raw.tags = meta.tags;

    const fileContent = stringifyFrontmatter(raw, content);
    await fs.writeFile(filePath, fileContent, "utf-8");

    return filePath;
  }

  /**
   * 加载人物档案。
   */
  async load(id: string): Promise<PersonEntry | null> {
    const filePath = this.resolvePath(id);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }

    return this.parsePersonFile(id, filePath, raw);
  }

  /**
   * 删除人物档案。
   */
  async delete(id: string): Promise<boolean> {
    try {
      await fs.unlink(this.resolvePath(id));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 列出所有人物。
   */
  async listAll(): Promise<PersonEntry[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.peopleDir);
    } catch {
      return [];
    }

    const entries: PersonEntry[] = [];
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const id = file.slice(0, -3);
      const entry = await this.load(id);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /**
   * 根据用户消息匹配人物。
   *
   * 匹配策略（按优先级）：
   * 1. 人名精确匹配：消息中包含 person.meta.name
   * 2. 关系词匹配：消息中的关系词映射到 relation，匹配 person.meta.relation
   */
  async matchByMessage(userMessage: string): Promise<PersonMatch[]> {
    const people = await this.listAll();
    if (people.length === 0) return [];

    const msg = userMessage.toLowerCase();
    const matches: PersonMatch[] = [];
    const matchedIds = new Set<string>();

    // 1. 人名匹配
    for (const person of people) {
      if (msg.includes(person.meta.name.toLowerCase())) {
        matches.push({ person, matchedKeyword: person.meta.name, matchType: "name" });
        matchedIds.add(person.id);
      }
    }

    // 2. 关系词匹配
    for (const [alias, normalizedRelation] of RELATION_ALIASES) {
      if (!msg.includes(alias)) continue;

      for (const person of people) {
        if (matchedIds.has(person.id)) continue;
        if (person.meta.relation === normalizedRelation) {
          matches.push({ person, matchedKeyword: alias, matchType: "relation" });
          matchedIds.add(person.id);
        }
      }
    }

    return matches;
  }

  /**
   * 将匹配的人物格式化为上下文注入段落。
   */
  static formatForContext(matches: PersonMatch[]): string {
    if (matches.length === 0) return "";

    const sections = matches.map((m) => {
      const lines: string[] = [];
      lines.push(`### ${m.person.meta.name}（${m.person.meta.relation}）`);
      if (m.person.meta.birthday) {
        lines.push(`Birthday: ${m.person.meta.birthday}`);
      }
      if (m.person.meta.tags && m.person.meta.tags.length > 0) {
        lines.push(`Tags: ${m.person.meta.tags.join(", ")}`);
      }
      if (m.person.content) {
        lines.push("");
        lines.push(m.person.content);
      }
      return lines.join("\n");
    });

    return `# Relevant People\n\n${sections.join("\n\n---\n\n")}`;
  }

  // ─── 内部 ───

  private resolvePath(id: string): string {
    return path.join(this.peopleDir, `${id}.md`);
  }

  private parsePersonFile(
    id: string,
    filePath: string,
    raw: string,
  ): PersonEntry | null {
    const parsed = parseFrontmatter<Partial<PersonMeta>>(raw);
    const data = parsed.data;

    const meta: PersonMeta = {
      name: String(data.name ?? id),
      relation: String(data.relation ?? ""),
      birthday: data.birthday ? String(data.birthday) : undefined,
      tags: Array.isArray(data.tags) ? data.tags.map(String) : undefined,
    };

    return { id, meta, content: parsed.content, filePath };
  }
}

/**
 * 获取标准关系词列表（供外部使用，如 memory 工具的 description）。
 */
export function getRelationAliases(): ReadonlyMap<string, string> {
  return RELATION_ALIASES;
}
