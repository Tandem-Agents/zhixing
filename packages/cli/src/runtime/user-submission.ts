import type { BeginReferencedUserTurnResult } from "./conversation-controller.js";

/** 旧输入框的提交结清；只消费应用事实，不推断保存或重新发送。 */
export function createUserSubmission(draft: { commit(): void; reject(): void } | null) {
  let settled = false;
  const accept = () => {
    if (settled) return;
    settled = true;
    draft?.commit();
  };
  const reject = () => {
    if (settled) return;
    settled = true;
    draft?.reject();
  };
  return {
    accept,
    reject,
    settle(result: BeginReferencedUserTurnResult<unknown>): string | undefined {
      if (result.kind === "accepted" || result.kind === "cancelled") {
        accept();
      } else if (result.kind === "contract-failed") {
        reject();
      } else {
        switch (result.submission?.disposition) {
          case "original-saved":
            accept();
            return "原任务已保存，等待确认。";
          case "revision-saved":
            accept();
            return "准则修订已保存，等待确认。";
          case "not-saved":
            reject();
            return "旧任务仍待确认，本次新输入未保存。";
          default:
            reject();
            return "无法确认本次输入是否已保存，已保留输入草稿；请先查看待确认任务。";
        }
      }
    },
  };
}
