/**
 * AbortReason → 中文 channel 文案。
 *
 * 服务飞书等中文 channel 用户的渲染层。每个 channel formatter 各自归属对应包
 * (cli/server/cli-serve),不抽公共——渲染上下文不同(终端 chalk vs 飞书 markdown
 * vs RPC JSON),抽到 core 会成为 swiss-army-knife;协议层只负责 reason 的结构稳定
 * 与语义定义,格式化是 channel 层的事。
 *
 * 同一 reason kind 的语义跨 channel 必须一致——本文件文案选择以执行规格 §2.5
 * "用户视角语义表"为单一参考源。
 */

import type { AbortReason } from "@zhixing/core";

/**
 * server 路径任意 abort 触发后,经 SessionAdapter outer controller + agent-loop
 * inner controller(以及 RPC 路径多一层 connection close abortController)的 fork
 * 链路,`AgentResult.aborted.abortReason` 必然是若干层 `parent-abort` 嵌套的根因。
 *
 * switch 前必须先 unwrap 到非 parent-abort 的根因,否则 server 99% abort 路径会全部
 * 退化到 parent-abort 兜底分支,差异化文案能力实质失效。
 *
 * 不抽到 core/interrupt(协议层 0 修改)、不跨 channel 共享(渲染层非协议化);
 * 4 行的 helper 各 channel 各自维护一份,通过文档约定保证一致性。
 */
function unwrapParentAbort(reason: AbortReason): AbortReason {
  let r: AbortReason = reason;
  while (r.kind === "parent-abort" && r.parentReason) r = r.parentReason;
  return r;
}

/**
 * 把 `AgentResult.aborted.abortReason` 渲染成飞书可读的中文文案。
 *
 * `null` / `undefined` 入参对应"reason 字段缺失"或"裸 abort 无 typed reason"的兜底。
 *
 * 未知 kind / 未知 origin 必须落到默认兜底文案,不允许抛异常——这是 INV-R3 的渲染层落地。
 */
export function formatAbortReasonZh(reason: AbortReason | null | undefined): string {
  if (!reason) return "已停止处理。";
  const root = unwrapParentAbort(reason);
  switch (root.kind) {
    case "user-cancel":
      return "已停止处理。";
    case "idle-timeout":
      return `已停止处理。(等待响应超过 ${Math.round(root.timeoutMs / 1000)} 秒)`;
    case "parent-abort":
      // unwrap 后仍是 parent-abort → parentReason === null,父是裸 AbortController.abort()
      return "已停止处理。";
    case "external":
      switch (root.origin) {
        case "scheduler-shutdown":
          return "已停止处理。(服务正在重启,请稍后重试)";
        case "cron-timeout":
          return "已停止处理。(任务超出时长上限)";
        case "rpc-connection-close":
          return "已停止处理。(连接已断开)";
        case "session-runtime-abort":
          return "已停止处理。";
        default:
          return "已停止处理。";
      }
  }
}
