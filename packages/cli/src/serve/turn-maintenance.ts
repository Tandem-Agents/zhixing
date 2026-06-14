/**
 * 宿主侧 turn 后维护 —— ConversationManager.onTurnCommitted 的装配实现。
 *
 * 所有入口(RPC / 渠道)的 turn 持久化成功后经唯一汇聚点触发:
 * - 自动命名:首轮(turnCount === 1)后用轻量 LLM 给 name 仍为 id 的对话起名,
 *   改名成功经 onRenamed 通知接入面(session.changed renamed 组播挂点);
 * - journal 生命周期:宿主级全局 single-flight——过期凝练清理 + 温日志凝练
 *   (LLM 经运行体 callText 的 light 档)。
 *
 * 单向阀:个人记忆维护只在 user 域(main)对话触发——场景对话(ws: 前缀)
 * 的记忆域是 workscene,绝不跑个人 journal,也不参与 main 列表命名。
 * 全部 fire-and-forget 且静默兜错:维护是辅助能力,绝不影响用户主路径。
 */

import {
  buildConversationNamerPrompt,
  extractText,
  parseConversationId,
  sanitizeConversationName,
  userMessageOf,
  type Conversation,
  type JournalStore,
} from "@zhixing/core";
import type { TurnCommittedInfo } from "@zhixing/server";

/** 自动命名所需的 meta 仓窄面 */
export interface NamerConversationRepo {
  get(id: string): Promise<Conversation | null>;
  rename(id: string, name: string): Promise<Conversation>;
}

export interface TurnMaintenanceDeps {
  convRepo: NamerConversationRepo;
  journal: Pick<JournalStore, "expireOld" | "scan" | "condense">;
  /** 自动命名成功后的通知挂点(组播 session.changed renamed) */
  onRenamed?: (conversationId: string, name: string) => void;
}

export function createTurnMaintenance(
  deps: TurnMaintenanceDeps,
): (info: TurnCommittedInfo) => void {
  // journal 是用户全局资源,不是 conversation 资源。宿主进程生命周期内:
  // 成功跑完一次即完成;运行中触发直接合并;失败后回到 idle,让后续 turn 重试。
  let journalState: "idle" | "running" | "done" = "idle";

  return (info) => {
    if (info.ephemeral) return;
    if (parseConversationId(info.conversationId).scope.kind !== "user") return;
    const runtime = info.runtime;
    if (!runtime.callText) return;
    const callText = runtime.callText.bind(runtime);

    if (info.turnCount === 1) {
      void autoNameFirstTurn(deps, info, callText).catch(() => {});
    }

    if (journalState === "idle") {
      journalState = "running";
      void runJournalLifecycle(deps.journal, callText).then(
        () => {
          journalState = "done";
        },
        () => {
          journalState = "idle";
        },
      );
    }
  };
}

/**
 * 首轮自动命名——双查守卫(infer 前后 name 仍为 id 才改)防与用户手动改名竞争;
 * 渠道对话在持久会话建立时已有 meta,因此与 CLI 对话共用同一命名路径。
 */
async function autoNameFirstTurn(
  deps: TurnMaintenanceDeps,
  info: TurnCommittedInfo,
  callText: (prompt: string, role?: "main" | "light") => Promise<string>,
): Promise<void> {
  const userMsg = userMessageOf(info.runMessages);
  if (!userMsg) return;
  const text = extractText(userMsg).trim();
  if (!text) return;

  const conv = await deps.convRepo.get(info.conversationId);
  if (!conv || conv.name !== conv.id) return;

  const raw = await callText(buildConversationNamerPrompt(text));
  const name = sanitizeConversationName(raw);
  if (!name) return;

  const latest = await deps.convRepo.get(info.conversationId);
  if (!latest || latest.name !== latest.id) return;

  await deps.convRepo.rename(info.conversationId, name);
  deps.onRenamed?.(info.conversationId, name);
}

/** journal 生命周期:删过期凝练文件 + 凝练温日志(LLM light 档)。 */
async function runJournalLifecycle(
  journal: Pick<JournalStore, "expireOld" | "scan" | "condense">,
  callText: (prompt: string, role?: "main" | "light") => Promise<string>,
): Promise<void> {
  await journal.expireOld();
  const plan = await journal.scan();
  if (!plan.condensePlan) return;
  await journal.condense(plan.condensePlan, {
    async condense(dailyContents: string): Promise<string> {
      return callText(
        `请将以下日志内容凝练为简洁的月度摘要，保留关键事实和决策，去掉冗余细节。\n\n${dailyContents}`,
      );
    },
  });
}
