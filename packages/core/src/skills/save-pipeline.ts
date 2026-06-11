/**
 * SkillSavePipeline —— 技能落盘的不变量焊点,**无触发语义**。
 *
 * 谁来的、要不要确认,管线不知道也不该知道:用户路径经 save_skill 工具包装
 * (带明确同意护栏)、技能管家(v2)经 StewardWriter 后台包装(自主落盘 +
 * stewardCreated 来源标记)——同一管线、换包装层。归属语义(stewardCreated
 * 的写与清)同理属包装层,管线不碰。
 *
 * 四类无触发语义的不变量,执行顺序即管线顺序:
 *   1. 凭证脱敏 —— scrubSecrets 过滤全部字段(草稿源自对话、可能粘过 secret;
 *      技能反复进上下文且可分享,绝不固化),命中计数随结果返回(供包装层
 *      向用户做脱敏可见)
 *   2. 来源落位 —— 恒落 own/(本地区,目录即来源);builtin / linked 不可写,
 *      对 builtin id 保存即 fork-to-own(own 同名遮蔽,原件随版本演进)
 *   3. 落盘格式 —— 标准 SKILL.md + frontmatter、mode 写 index、原子写,
 *      全部经 Store 既有写 API(唯一磁盘访问点,不绕过)
 *   4. 索引一致性 —— Store 写 API 落盘后递增结构版本,下一注意力窗口换代
 *      自然重渲染索引(窗口内 systemPrompt byte-equal 不破)
 *
 * upsert:id = skillNameToId(name)。own / linked 目录已有该 id → update
 * (linked-only 沿 Store 的 fork-on-edit 语义);否则 create(全新或 builtin
 * 同名 —— 后者即 fork-to-own)。创建与打磨是同一能力、同一焊接点。
 */

import { scrubSecrets } from "../security/secret-scrubber.js";
import { skillNameToId } from "./id.js";
import type { SkillStore } from "./store.js";
import type { SkillDraft } from "./types.js";

export interface SkillSaveOutcome {
  /** = skillNameToId(脱敏后 name),`/<id>` 唤起用。 */
  id: string;
  /** 原样保留的显示名(脱敏后)。 */
  name: string;
  outcome: "created" | "updated";
  /** 全字段脱敏命中总数;> 0 时包装层须向用户告知(脱敏可见)。 */
  scrubbedCount: number;
}

export async function runSkillSavePipeline(
  store: SkillStore,
  draft: SkillDraft,
): Promise<SkillSaveOutcome> {
  const name = scrubSecrets(draft.name);
  const description = scrubSecrets(draft.description);
  const body = scrubSecrets(draft.body);
  const scrubbedCount =
    name.redactions.length +
    description.redactions.length +
    body.redactions.length;

  const scrubbed: SkillDraft = {
    name: name.scrubbed,
    description: description.scrubbed,
    body: body.scrubbed,
    mode: draft.mode,
  };

  // upsert 路由按目录存在性判(含 disabled —— 禁用的同名技能也是更新对象,
  // 走 create 会撞名);builtin 不算"已有"(注册集非目录),保存即 fork-to-own
  const id = skillNameToId(scrubbed.name);
  if (await store.has(id)) {
    await store.update(id, scrubbed);
    return { id, name: scrubbed.name, outcome: "updated", scrubbedCount };
  }
  const created = await store.create(scrubbed);
  return {
    id: created.id,
    name: scrubbed.name,
    outcome: "created",
    scrubbedCount,
  };
}
