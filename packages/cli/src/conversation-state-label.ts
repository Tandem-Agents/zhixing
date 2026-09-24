/** Shared projection of authoritative run state; input consumption is separate. */
export function conversationStateLabel(state: unknown): string | undefined {
  switch (state) {
    case "queued": return "待运行";
    case "dispatched": return "已派发";
    case "running": return "运行中";
    case "cancel-requested": return "正在停止";
    case "committed": return "运行已提交";
    case "cancelled": return "运行已停止";
    case "failed": return "运行失败";
    case "expired": return "运行已过期";
    case "uncertain": return "运行结果待确认";
    default: return undefined;
  }
}
