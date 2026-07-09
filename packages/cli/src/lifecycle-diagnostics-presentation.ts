import chalk from "chalk";
import type { AgentEventMap } from "@zhixing/core";
import { layout } from "./tui/style.js";

const MAX_LIFECYCLE_WARNING_DEDUPE_KEYS = 1_000;

export interface LifecycleWarningDeduper {
  shouldShow(info: AgentEventMap["lifecycle:warning"]): boolean;
}

export function createLifecycleWarningDeduper(): LifecycleWarningDeduper {
  const shown = new Set<string>();
  return {
    shouldShow(info) {
      const key = `${info.runtimeId}\u0000${info.hookId}\u0000${info.message.trim()}`;
      if (shown.has(key)) return false;
      shown.add(key);
      if (shown.size > MAX_LIFECYCLE_WARNING_DEDUPE_KEYS) {
        const oldest = shown.values().next().value;
        if (oldest !== undefined) shown.delete(oldest);
      }
      return true;
    },
  };
}

export function renderLifecycleWarningLine(
  info: AgentEventMap["lifecycle:warning"],
): string {
  const message = info.message.trim() || "未知降级";
  const text =
    info.hookId === "zhixing-guidance"
      ? `约定未完全生效：${message}`
      : `运行组件提示：${message}`;
  return `${layout.contentPrefix}${chalk.yellow("⚠")} ${chalk.dim(text)}`;
}
