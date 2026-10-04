/** Configuration decisions shared by both terminal surfaces. No renderer or input owner. */
/**
 * L1 主面板：sections 入口 + 操作按钮（完成 / 取消）。
 *
 * 显示用 caller 提供的 sections，每个 section 含若干入口项。最后一组是操作按钮。
 *
 * 导航：
 *   ↑↓     在所有可选项（section entries + 按钮）间移动
 *   Enter  进入该项的目标 panel；按钮触发对应动作
 *   Ctrl+C 退出（cancelled）
 */
import type { ConfigModelContext as ConfigEditorContext, PanelAction, PanelDescriptor, Section, Status, WorkingState } from "../types.js";
import { deriveEntryIssues, deriveEntryStatus } from "../entry.js";
import { getSections } from "../sections/index.js";
import type { KeyEvent } from "../../tui/index.js";

export interface MainPanelCursor {
  index: number;
}

export interface MainPanelItem {
  kind: "section-entry";
  sectionId: string;
  entryIndex: number;
  enterTarget?: PanelDescriptor;
  label: string;
  /** 派生自 entry 的 statusText + issues + disabled——caller 不直接声明 */
  status: Status;
  /** 阻塞 issues——空数组 = 此 entry 完整 */
  issues: readonly string[];
}

export interface MainPanelButton {
  kind: "button";
  label: string;
  action: "complete" | "cancel";
}

export type MainPanelOption = MainPanelItem | MainPanelButton;

export function buildOptions(
  ctx: ConfigEditorContext,
  state: WorkingState,
): { sections: Array<{ section: Section; entries: MainPanelItem[] }>; options: MainPanelOption[] } {
  const sections = getSections(ctx.sections).map((section) => {
    const entries = section.entries(state, ctx.runtime).map<MainPanelItem>((entry, idx) => ({
      kind: "section-entry",
      sectionId: section.id,
      entryIndex: idx,
      enterTarget: entry.enterTarget,
      label: entry.label,
      // Status / issues 由派生 helper 从 EntryState 派生——确保两者从同源出
      status: deriveEntryStatus(entry),
      issues: deriveEntryIssues(entry),
    }));
    return { section, entries };
  });

  const options: MainPanelOption[] = [];
  for (const { entries } of sections) {
    options.push(...entries);
  }
  options.push({ kind: "button", label: "完成（保存并启动）", action: "complete" });
  options.push({ kind: "button", label: "取消并退出", action: "cancel" });

  return { sections, options };
}

export function collectAllIssues(
  sections: Array<{ section: Section; entries: MainPanelItem[] }>,
): string[] {
  return sections.flatMap(({ entries }) => entries.flatMap((e) => e.issues));
}

export interface MainPanelKeyResult {
  action: PanelAction;
  cursor: MainPanelCursor;
  /** 渲染时显示在底部的错误（校验失败） */
  errorMessage?: string;
}

export function handleMainPanelKey(
  ctx: ConfigEditorContext,
  state: WorkingState,
  cursor: MainPanelCursor,
  key: KeyEvent,
): MainPanelKeyResult {
  const { sections, options } = buildOptions(ctx, state);
  const max = options.length - 1;

  switch (key.type) {
    case "arrow-up":
      return {
        action: { type: "stay", state },
        cursor: { index: cursor.index > 0 ? cursor.index - 1 : max },
      };
    case "arrow-down":
      return {
        action: { type: "stay", state },
        cursor: { index: cursor.index < max ? cursor.index + 1 : 0 },
      };
    case "ctrl-c":
    case "escape":
      // 主面板是顶层：Esc 与 Ctrl+C 都退出（cancelled）。
      // 子页面的 Esc=返回上一页由各子面板 handler 自己处理，不到这里。
      return {
        action: { type: "exit", result: { kind: "cancelled" } },
        cursor,
      };
    case "ctrl-s":
      // 全局"完成"快捷键——等同选中并确认完成按钮（含必填校验），无需把光标移到按钮区
      return completeAction(sections, state, cursor);
    case "enter": {
      const selected = options[cursor.index];
      if (!selected) return { action: { type: "stay", state }, cursor };
      if (selected.kind === "button") {
        if (selected.action === "cancel") {
          return { action: { type: "exit", result: { kind: "cancelled" } }, cursor };
        }
        // complete：校验所有 entries 的 issues（与进度计数同源）
        return completeAction(sections, state, cursor);
      }
      // section-entry：跳转
      if (selected.enterTarget) {
        return {
          action: { type: "navigate", state, panel: selected.enterTarget },
          cursor,
        };
      }
      return { action: { type: "stay", state }, cursor };
    }
    default:
      return { action: { type: "stay", state }, cursor };
  }
}

export function completeAction(
  sections: Parameters<typeof collectAllIssues>[0],
  state: WorkingState,
  cursor: MainPanelCursor,
): MainPanelKeyResult {
  const errors = collectAllIssues(sections);
  if (errors.length > 0) {
    return { action: { type: "stay", state }, cursor, errorMessage: errors.join("；") };
  }
  return {
    action: {
      type: "exit",
      result: { kind: "completed", config: state.config, credentials: state.credentials,
        ...(state.channelIntents ? { channelIntents: state.channelIntents } : {}) },
    },
    cursor,
  };
}

export function initialMainCursor(): MainPanelCursor {
  return { index: 0 };
}
