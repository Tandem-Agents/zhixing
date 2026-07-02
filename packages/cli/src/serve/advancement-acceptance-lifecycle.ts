import { renderAcceptanceConditions } from "@zhixing/core";
import type { AgentRuntimeLifecycle } from "@zhixing/orchestrator/runtime";
import type { AdvancementController } from "@zhixing/server";

/**
 * 契约验收条件对执行侧可见的注入订阅者。
 *
 * 推进会话 active 期间，把用户确认过的验收条件（通过标准 + 证据要求）经
 * run 瞬态注入通道每 run 贡献进执行侧发送视图——执行侧知道「什么算完成」
 * 才能首轮瞄准真目标，而不是靠失败反馈逐轮逆向拼出标准。注入只活在当前
 * run 的发送视图：落盘 messages[0] 恒为用户原文、窗口不含注入块，由注入
 * 通道结构保证。failureHandling 与裁判过程不在公开面内。
 *
 * 由宿主装配层注册（随 RuntimeHost 的共享订阅者集合下发全部会话实例），
 * 不经 ConversationManager——注入内容按 conversationId 运行期查推进会话
 * 状态动态决定：无 active 会话（含 ephemeral 无会话身份的 run）即不注入，
 * 会话到达终态后自然停注。
 */
export function createAdvancementAcceptanceLifecycle(
  advancement: AdvancementController,
): AgentRuntimeLifecycle {
  return {
    id: "advancement-acceptance-conditions",
    async onBeforeRun(ctx) {
      if (!ctx.conversationId) return;
      const session = await advancement.loadActiveSession(ctx.conversationId);
      if (!session || session.status !== "active") return;
      const rubric = session.confirmedRubric;
      if (!rubric) return;
      ctx.injectUserContext(renderAcceptanceConditions(rubric.content));
    },
  };
}
