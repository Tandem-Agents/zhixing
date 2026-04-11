/**
 * Memory Retriever — 记忆检索引擎
 *
 * 从用户消息中匹配相关记忆，返回需要注入到上下文中的内容。
 * 同时检索技能（Trigger 匹配）和人物（人名/关系词匹配）。
 *
 * 设计要点：
 * - 被动精准：只在匹配时注入，不浪费 token
 * - 使用追踪：每次注入时记录技能使用情况
 * - 统一接口：技能和人物通过同一方法检索
 */

import { SkillsStore, type SkillMatch } from "./skills-store.js";
import { PeopleStore, type PersonMatch } from "./people-store.js";

// ─── 类型 ───

export interface RetrievalResult {
  /** 匹配到的技能列表 */
  skills: SkillMatch[];
  /** 匹配到的人物列表 */
  people: PersonMatch[];
  /** 格式化后的注入文本，为空表示无匹配 */
  contextText: string | null;
}

// ─── Memory Retriever ───

export class MemoryRetriever {
  private readonly skillsStore: SkillsStore;
  private readonly peopleStore: PeopleStore;

  constructor(skillsStore?: SkillsStore, peopleStore?: PeopleStore) {
    this.skillsStore = skillsStore ?? new SkillsStore();
    this.peopleStore = peopleStore ?? new PeopleStore();
  }

  /**
   * 根据用户消息检索相关记忆（技能 + 人物）。
   */
  async retrieve(userMessage: string): Promise<RetrievalResult> {
    const [skills, people] = await Promise.all([
      this.skillsStore.matchByMessage(userMessage),
      this.peopleStore.matchByMessage(userMessage),
    ]);

    if (skills.length === 0 && people.length === 0) {
      return { skills: [], people: [], contextText: null };
    }

    // 记录技能使用
    for (const match of skills) {
      await this.skillsStore.recordUsage(match.skill.id);
    }

    // 组装上下文
    const parts: string[] = [];
    if (skills.length > 0) {
      parts.push(SkillsStore.formatForContext(skills));
    }
    if (people.length > 0) {
      parts.push(PeopleStore.formatForContext(people));
    }

    return {
      skills,
      people,
      contextText: parts.join("\n\n"),
    };
  }
}
