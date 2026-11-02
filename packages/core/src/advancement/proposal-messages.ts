/**
 * 推进提议阶段的用户可见文案：由推进领域提供，宿主结果与各接入面原样呈现。
 * 本模块不依赖推进应用，可经窄子路径被接入面的启动路径引用。
 */
import type { ImageSource } from "../types/messages.js";
import type { UserTurnInput } from "../types/user-input.js";

/**
 * 原任务执行运行的上下文：来自提议的会话，执行输入是推进控制消息，原任务与提议阶段的补充经本次运行
 * 上下文原样给出——文字进上下文块，图片按顺序随本次运行附上（与文字里的标注对应），提出推进那一轮
 * 被压出窗口后仍完整可见，历史里不重复用户原文。
 */
export function renderAdvancementOriginalTask(
  task: UserTurnInput,
  supplements: readonly UserTurnInput[] = [],
): { readonly text: string; readonly images: readonly ImageSource[] } {
  const images: ImageSource[] = [];
  const describe = (input: UserTurnInput): string => {
    const text = input.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
    const attached = input.parts.flatMap((part) => (part.type === "image" ? [part.source] : []));
    const first = images.length + 1;
    images.push(...attached);
    const note = attached.length === 0 ? ""
      : attached.length === 1 ? `（附图：随本消息附上的第 ${first} 张）`
      : `（附图：随本消息附上的第 ${first}–${first + attached.length - 1} 张）`;
    return `${text || "（无文字）"}${note}`;
  };
  const lines = ["推进中的原任务（用户提出推进时的原始输入）：", describe(task)];
  supplements.forEach((supplement, index) => lines.push(`提议阶段的补充 ${index + 1}：${describe(supplement)}`));
  return { text: lines.join("\n"), images };
}

/** 提议阶段收到的输入如何处理：目标不变，或记为对原任务的补充。 */
export type AdvancementProposalDisposition = "kept" | "supplemented";

/**
 * 提议阶段输入的回应文案。实时发送与回执核对两条路径同源，回执核对拿不到当时的提议状态，
 * 所以“保持不变”的说明须在起草中、起草失败、结果不明各状态下都成立。
 */
export function advancementProposalDispositionMessage(disposition: AdvancementProposalDisposition): string {
  return disposition === "supplemented"
    ? "已把这条输入作为原任务的补充；验收标准会按补充更新后再请你确认。"
    : "本次输入未接纳，已保留在输入框；原推进目标保持不变，确认验收标准前不执行原任务；可以补充说明，也可以说“直接执行”或“取消”。";
}

/** 提议运行结束时的状态：已提出推进，不是任务完成。 */
export const ADVANCEMENT_PROPOSED_NOTICE = "已提出推进：正在起草验收标准，就绪后会请你确认；确认前不执行原任务。";

/** 草案起草失败或结果不明时的说明与可继续的操作。 */
export function advancementProposalStalledMessage(outcome: "failed" | "uncertain", detail?: string): string {
  const head = outcome === "failed"
    ? `验收标准起草失败${detail ? `：${detail.replace(/[。.\s]+$/u, "")}。` : "。"}`
    : "验收标准起草结果不明（服务曾中断），不会自动重试。";
  return `${head}原任务保留：回复补充说明可重新起草，也可以说“直接执行”或“取消”。`;
}

/** 恢复对话或查看列表时，提议阶段状态的一句话说明。 */
export function describeAdvancementProposalStage(status: "proposed" | "drafting" | "draft-failed" | "draft-uncertain"): string {
  switch (status) {
    case "proposed":
    case "drafting":
      return "已提出推进，正在起草验收标准";
    case "draft-failed":
      return "推进的验收标准起草失败，原任务保留";
    case "draft-uncertain":
      return "推进的验收标准起草结果不明，原任务保留";
  }
}
