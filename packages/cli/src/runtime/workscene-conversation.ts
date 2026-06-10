/**
 * acquireWorksceneConversation —— 进入工作场景时的对话获取策略。
 *
 * 命令触发的 `/work` 走 auto-resume 语义（与 main 启动 auto-resume 对齐：
 * 用户手动进就是为了回到最近对话继续）；LLM 触发的 `workmode_enter` 工具
 * 始终新建（不走本 helper），避免上次主题完全无关的历史污染 power 上下文。
 *
 * 本 helper 只裁决"复用哪个对话还是新建"——窗口装填（启动装填器）由
 * caller 在 enter 流程中按 power 模型执行，装填 IO 失败走 enter 的 undo
 * 回退，不在此处预读 transcript。
 *
 * 三条正交路径：
 *   A. latest 不存在 → create，无 warning（场景首次进入，等同 main
 *      首次启动创建 default 的语义）
 *   B. latest 存在且 get 成功 → recovery（recovered=true）、无 warning
 *   C. latest 存在但 get 返 null（meta.json 缺失/损坏）→ 降级 create + warning
 *
 * 纯函数（不依赖 cliWriter）—— warning 由 caller 在 applyModeSwitch enter
 * 整体成功之后输出，避免 "helper 内即时输出 + caller 失败回滚" 时序混乱
 * （用户会看到 "已创建新对话" 紧跟 "已回退主对话" 的双消息困惑）。
 */

import type { Conversation, IConversationRepository } from "@zhixing/core";

export type WorksceneConversation = {
  conversation: Conversation;
  /** true → 复用既有对话（路径 B）；false → 新建（路径 A 或 C） */
  recovered: boolean;
  /** 仅路径 C 携带；caller 在 enter 成功后输出 */
  warning?: string;
};

export async function acquireWorksceneConversation(
  worksceneRepo: IConversationRepository,
): Promise<WorksceneConversation> {
  const latestId = await worksceneRepo.findLatest();

  // 路径 A：latest 不存在 → 直接 create，无 warning
  if (!latestId) {
    const conv = await worksceneRepo.create({});
    return { conversation: conv, recovered: false };
  }

  // 路径 B：latest 存在，按 meta 复用
  const existing = await worksceneRepo.get(latestId);
  if (existing) return { conversation: existing, recovered: true };

  // 路径 C：meta 缺失 / 损坏 → 降级 create + warning
  const conv = await worksceneRepo.create({});
  return {
    conversation: conv,
    recovered: false,
    warning: "该工作场景历史元数据缺失，已创建新对话",
  };
}
