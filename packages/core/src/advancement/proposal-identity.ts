import { protocolDigest } from "../protocol/canonical.js";
import type { UserTurnInput } from "../types/user-input.js";
import type { AdvancementSession } from "./types.js";

/** 推进提议工具名，与提议意图的 kind 相同；产品经 TurnOrigin.enabledControls 为新任务运行启用它。 */
export const ADVANCEMENT_PROPOSAL_TOOL = "propose_advancement";

/** 提议身份由会话与提议运行确定性派生：同一运行重复接受得到同一提议与同一会话。 */
export function advancementProposalId(conversationId: string, runId: string): string {
  return protocolDigest("AdvancementProposal", 1, { conversationId, runId });
}

export function advancementProposalSessionId(proposalId: string): string {
  return `advancement-proposal-${proposalId.replace("sha256:", "")}`;
}

export type AdvancementProposalExecutionMode = "advancement" | "direct";

/**
 * 确认或降级后执行原任务的运行输入：一条推进控制消息，不是原文拷贝。原任务已随提议运行进入历史，
 * 执行运行的上下文另由 turnContext 注入。输入只取决于模式，恢复重放时可直接派生。
 */
export function advancementProposalExecutionInput(mode: AdvancementProposalExecutionMode): UserTurnInput {
  const text = mode === "advancement"
    ? "用户已确认 Rubric，开始执行上面提出的原任务。"
    : "用户选择不启用推进，直接执行上面提出的原任务。";
  return { parts: [{ type: "text", text }] };
}

/** 原任务执行运行的输入：来自提议的会话是推进控制消息，其余会话是原始输入。首次接纳与恢复重放共用。 */
export function advancementOriginalTaskInput(
  session: Pick<AdvancementSession, "proposal" | "originalUserTask" | "originalTaskAdmission">,
): UserTurnInput {
  return session.proposal
    ? advancementProposalExecutionInput(session.originalTaskAdmission?.mode ?? "advancement")
    : session.originalUserTask;
}

/**
 * 原任务执行的 turn 身份：由原始输入身份派生，接入面与宿主同算，不另传。确认执行绑定被确认的草案，
 * 降级执行每个原始输入只有一次；与原始输入身份不同，所以提议运行的 ingress 不被复用。
 */
export function advancementExecutionTurnId(
  originalTurnId: string,
  mode: AdvancementProposalExecutionMode,
  draftId?: string,
): string {
  if (mode === "advancement" && !draftId) throw new TypeError("Advancement execution requires its confirmed draft");
  return mode === "advancement" ? `${originalTurnId}:advancement:${draftId}` : `${originalTurnId}:direct`;
}

/** 来自提议的会话：执行身份与推进控制消息输入。 */
export function advancementProposalExecution(input: Readonly<{
  originalTurnId: string;
  mode: AdvancementProposalExecutionMode;
  draftId?: string;
}>): { readonly turnId: string; readonly input: UserTurnInput } {
  return {
    turnId: advancementExecutionTurnId(input.originalTurnId, input.mode, input.draftId),
    input: advancementProposalExecutionInput(input.mode),
  };
}
