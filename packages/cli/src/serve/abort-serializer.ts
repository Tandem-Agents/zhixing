/**
 * AbortReason → RPC client / scheduled task 的 JSON-friendly 序列化。
 *
 * 对应渲染层职责切分(详见 server/channels/abort-formatter-zh.ts):
 *   - `message` 字段:unwrap 根因后的英文文案,给最终用户/调用方看
 *   - `detail` 字段:**完整原始结构**保留所有 fork wrap 层,client 想自行解析嵌套
 *     fork 链路 / 做诊断审计可直接 recurse parentReason
 *
 * 两个字段职责分离:message 给人看,detail 给程序看。
 */

import type { AbortReason } from "@zhixing/core";

function unwrapParentAbort(reason: AbortReason): AbortReason {
  let r: AbortReason = reason;
  while (r.kind === "parent-abort" && r.parentReason) r = r.parentReason;
  return r;
}

export interface SerializedAbort {
  readonly status: "aborted";
  readonly message: string;
  /** 完整原始结构(含全部 fork wrap 层),null 表示无 typed reason */
  readonly detail: AbortReason | null;
}

export function serializeAbortReason(reason: AbortReason | null | undefined): SerializedAbort {
  return {
    status: "aborted",
    message: formatAbortReasonEn(reason),
    detail: reason ?? null,
  };
}

export function formatAbortReasonEn(reason: AbortReason | null | undefined): string {
  if (!reason) return "Aborted.";
  const root = unwrapParentAbort(reason);
  switch (root.kind) {
    case "user-cancel": {
      const label = root.source === "ctrl-c" ? "ctrl+c" : root.source;
      return `Aborted by user (${label}).`;
    }
    case "idle-timeout":
      return `Aborted: stream idle for ${Math.round(root.timeoutMs / 1000)}s.`;
    case "parent-abort":
      return "Aborted by parent.";
    case "external":
      return root.origin
        ? `Aborted: ${root.origin}.`
        : "Aborted by external signal.";
  }
}
