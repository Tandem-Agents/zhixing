/**
 * acquireWorksceneConversation —— 进入工作场景时的对话获取策略。
 *
 * 命令触发的 `/enter` 走 auto-resume 语义（与 main 启动 auto-resume 对齐：
 * 用户手动进就是为了回到最近对话继续）；LLM 触发的 `workmode_enter` 工具
 * 始终新建（不走本 helper），避免上次主题完全无关的历史污染 power 上下文。
 *
 * 三条正交路径：
 *   A. latest 不存在 → 直接 create，无 warning（场景首次进入，等同 main
 *      首次启动创建 default 的语义）
 *   B. latest 存在且 load + get 均成功 → recovery，返回非空 loaded、无 warning
 *   C. latest 存在但加载失败（load 抛错 / get 返 null 两子情况合并）→ 降级
 *      create + warning。文案按子情况区分。"latest 存在但加载失败" 语义同款，
 *      避免边界双标。
 *
 * 纯函数（不依赖 cliWriter）—— warning 由 caller 在 applyModeSwitch enter
 * 整体成功之后输出，避免 "helper 内即时输出 + caller 失败回滚" 时序混乱
 * （用户会看到 "已创建新对话" 紧跟 "已回退主对话" 的双消息困惑）。
 */

import type {
  Conversation,
  IConversationRepository,
  ITranscriptStore,
  LoadedTranscript,
} from "@zhixing/core";

export type WorksceneConversation = {
  conversation: Conversation;
  /** null → create 路径(A 或 C)；非 null → recovery 路径(B) */
  loaded: LoadedTranscript | null;
  /** 仅路径 C 携带；caller 在 enter 成功后输出 */
  warning?: string;
};

export async function acquireWorksceneConversation(
  worksceneRepo: IConversationRepository,
  wStore: ITranscriptStore,
): Promise<WorksceneConversation> {
  const latestId = await worksceneRepo.findLatest();

  // 路径 A：latest 不存在 → 直接 create，无 warning
  if (!latestId) {
    const conv = await worksceneRepo.create({});
    return { conversation: conv, loaded: null };
  }

  // 路径 B：latest 存在，尝试恢复
  let loadError: unknown;
  try {
    const loaded = await wStore.load(latestId);
    const conv = await worksceneRepo.get(latestId);
    if (conv) return { conversation: conv, loaded };
    // get 返 null（meta.json 缺失/损坏）落空走降级，与 load 抛错统一处理
  } catch (err) {
    loadError = err;
  }

  // 路径 C：latest 存在但加载失败 → 降级 create + warning
  const conv = await worksceneRepo.create({});
  return {
    conversation: conv,
    loaded: null,
    warning: loadError
      ? `该工作场景历史加载失败（${loadError instanceof Error ? loadError.message : String(loadError)}），已创建新对话`
      : "该工作场景历史元数据缺失，已创建新对话",
  };
}
