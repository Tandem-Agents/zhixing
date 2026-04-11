/**
 * Memory Retriever — 记忆检索引擎
 *
 * 从用户消息中匹配相关记忆，返回需要注入到上下文中的内容。
 *
 * Phase M4a 重点：Trigger 匹配注入技能。
 * 后续 Phase M3 扩展：关系词匹配注入人物档案。
 *
 * 设计要点：
 * - 被动精准：只在匹配时注入，不浪费 token
 * - 使用追踪：每次注入时记录使用情况
 * - 统一接口：后续扩展人物/journal 检索时不改调用方
 */

import { SkillsStore, type SkillMatch } from "./skills-store.js";

// ─── 类型 ───

export interface RetrievalResult {
  /** 匹配到的技能列表 */
  skills: SkillMatch[];
  /** 格式化后的注入文本，为空表示无匹配 */
  contextText: string | null;
}

// ─── Memory Retriever ───

export class MemoryRetriever {
  private readonly skillsStore: SkillsStore;

  constructor(skillsStore?: SkillsStore) {
    this.skillsStore = skillsStore ?? new SkillsStore();
  }

  /**
   * 根据用户消息检索相关记忆。
   *
   * 当前实现：Trigger 匹配技能。
   * 后续扩展：关系词匹配人物、Journal 检索等。
   */
  async retrieve(userMessage: string): Promise<RetrievalResult> {
    const skills = await this.skillsStore.matchByMessage(userMessage);

    if (skills.length === 0) {
      return { skills: [], contextText: null };
    }

    // 记录使用
    for (const match of skills) {
      await this.skillsStore.recordUsage(match.skill.id);
    }

    const contextText = SkillsStore.formatForContext(skills);

    return { skills, contextText };
  }
}
