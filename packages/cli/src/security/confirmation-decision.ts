import type { ConfirmationDecision, ConfirmationOption } from "@zhixing/core/confirmation";
import type { SelectResult } from "../tui/select-types.js";

export function translate(
  result: SelectResult,
  optionById: Map<string, ConfirmationOption>,
): ConfirmationDecision {
  if (result.kind === "cancelled") {
    switch (result.cause) {
      case "ctrl-c":
        return { kind: "cancelled", cause: "user-ctrl-c" };
      case "ctrl-d":
        return { kind: "cancelled", cause: "user-ctrl-d" };
      case "aborted":
        return { kind: "cancelled", cause: "aborted" };
      case "escape":
        // Esc 语义上等价于"拒绝"——用户明确不想做。
        // 与 Ctrl+C 区分：Ctrl+C 是"中止这次对话"，Esc 是"对这个决策说 no"。
        return { kind: "deny" };
    }
  }

  // selected
  const opt = optionById.get(result.value);
  if (!opt) {
    // 理论上不会发生——我们控制 optionById 和 value 的映射
    return {
      kind: "deny",
      reason: `未知选项 value：${result.value}`,
    };
  }

  switch (opt.kind) {
    case "allow-once":
      return { kind: "allow-once" };
    case "allow-with-note":
      return { kind: "allow-once", note: result.note };
    case "allow-session":
      return {
        kind: "allow-session",
        pattern: opt.pattern,
        note: result.note,
      };
    case "allow-context":
      return {
        kind: "allow-context",
        pattern: opt.pattern,
        note: result.note,
      };
    case "allow-global":
      return {
        kind: "allow-global",
        pattern: opt.pattern,
        note: result.note,
      };
    case "deny":
      return { kind: "deny" };
    case "deny-with-reason":
      return { kind: "deny", reason: result.note };
    case "edit-then-allow":
      // Step 8 feature——Step 3 还未支持
      return {
        kind: "deny",
        reason: "edit-then-allow 尚未实现",
      };
    case "show-full":
      // show-full 是 UI 内部动作，不会产生决定——按 deny 兜底
      return { kind: "deny" };
  }
}
