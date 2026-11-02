import type { BeginReferencedUserTurnResult } from "./conversation-controller.js";

/**
 * 旧输入框的提交结清；只消费应用事实，不推断保存或重新发送。
 * 结清时带上本次输入发生了什么的说明（已保存待确认、准则生成失败、旧任务仍待确认等），由输入框所在页面直接显示。
 */
export function createUserSubmission(draft: { commit(message?: string): void; reject(message?: string): void } | null) {
  let settled = false;
  const accept = (message?: string) => {
    if (settled) return;
    settled = true;
    draft?.commit(message);
  };
  const reject = (message?: string) => {
    if (settled) return;
    settled = true;
    draft?.reject(message);
  };
  return {
    accept,
    reject,
    settle(result: BeginReferencedUserTurnResult<unknown>): string | undefined {
      if (result.kind === "accepted" || result.kind === "cancelled") {
        accept();
      } else if (result.kind === "contract-failed") {
        const message = `推进准则生成失败：${result.error.message}；输入已保留，可修改后重试。`;
        reject(message);
        return message;
      } else {
        if (result.kind === "submission-settled") {
          if (result.submission.disposition === "original-saved" || result.submission.disposition === "revision-saved") accept(result.message); else reject(result.message);
          return result.message;
        }
        switch (result.submission?.disposition) {
          case "original-saved": {
            const message = "原任务已保存，等待确认。";
            accept(message);
            return message;
          }
          case "revision-saved": {
            const message = "准则修订已保存，等待确认。";
            accept(message);
            return message;
          }
          case "not-saved": {
            const message = "旧任务仍待确认，本次新输入未保存。";
            reject(message);
            return message;
          }
          default: {
            const message = "无法确认本次输入是否已保存，已保留输入草稿；请先查看待确认任务。";
            reject(message);
            return message;
          }
        }
      }
    },
  };
}
