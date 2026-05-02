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

import type {
  ConfigEditorContext,
  ConfigEditorResult,
  KeyEvent,
  PanelAction,
  Section,
  WorkingState,
} from "../types.js";
import { Renderer } from "../ui/render.js";
import { getSections } from "../sections/index.js";

/** UI 主面板的当前光标位置——平铺所有可选项（sections + 按钮） */
export interface MainPanelCursor {
  index: number;
}

interface MainPanelItem {
  kind: "section-entry";
  sectionId: string;
  entryIndex: number;
  enterTarget?: import("../types.js").PanelDescriptor;
  label: string;
  status: string;
}
interface MainPanelButton {
  kind: "button";
  label: string;
  action: "complete" | "cancel";
}

type MainPanelOption = MainPanelItem | MainPanelButton;

/** 平铺面板所有可选项——sections 中的 entries 加上底部 [完成]/[取消]。 */
function buildOptions(
  ctx: ConfigEditorContext,
  state: WorkingState,
): { sections: Array<{ section: Section; entries: MainPanelItem[] }>; options: MainPanelOption[] } {
  const sections = getSections(ctx.sections).map((section) => {
    const entries = section.entries(state).map<MainPanelItem>((entry, idx) => ({
      kind: "section-entry",
      sectionId: section.id,
      entryIndex: idx,
      enterTarget: entry.enterTarget,
      label: entry.label,
      status: entry.status,
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

export function renderMainPanel(
  ctx: ConfigEditorContext,
  state: WorkingState,
  cursor: MainPanelCursor,
  renderer: Renderer,
  errorMessage?: string,
): void {
  renderer.clear();
  renderer.hideCursor();

  renderer.separator();
  renderer.writeLine(`  ${renderer.bold("知行 · " + ctx.title)}`);
  renderer.separator();
  renderer.writeLine("");

  if (ctx.header) {
    if (ctx.header.workspaceRoot) {
      renderer.writeLine(`  工作目录：${ctx.header.workspaceRoot}（已创建）`);
    }
    renderer.writeLine(renderer.dim(`  配置文件：${ctx.header.configPath}`));
    renderer.writeLine(renderer.dim(`  凭证文件：${ctx.header.credentialsPath}`));
    renderer.writeLine("");
  }

  const { sections, options } = buildOptions(ctx, state);

  let runningIndex = 0;
  for (const { section, entries } of sections) {
    renderer.writeLine(`  ${renderer.bold(section.title)}`);
    renderer.writeLine("");
    for (const entry of entries) {
      const selected = runningIndex === cursor.index;
      renderer.writeLine(renderer.listItem(selected, entry.label, entry.status));
      runningIndex++;
    }
    renderer.writeLine("");
  }

  renderer.writeLine(`  ${renderer.bold("操作")}`);
  renderer.writeLine("");
  for (const option of options) {
    if (option.kind !== "button") continue;
    const selected = runningIndex === cursor.index;
    renderer.writeLine(renderer.listItem(selected, `[ ${option.label} ]`));
    runningIndex++;
  }

  renderer.writeLine("");
  if (errorMessage) {
    renderer.writeLine(renderer.red("  " + errorMessage));
    renderer.writeLine("");
  }
  renderer.writeLine(renderer.dim("  ↑↓ 选择    Enter 进入/确认    Ctrl+C 退出"));
}

/**
 * 处理按键，返回下一步动作。
 *
 * 返回 errorMessage 时由 caller 重渲染——校验失败回 main 面板时用。
 */
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
  const { options } = buildOptions(ctx, state);
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
      return {
        action: { type: "exit", result: { kind: "cancelled" } },
        cursor,
      };
    case "enter": {
      const selected = options[cursor.index];
      if (!selected) return { action: { type: "stay", state }, cursor };
      if (selected.kind === "button") {
        if (selected.action === "cancel") {
          return { action: { type: "exit", result: { kind: "cancelled" } }, cursor };
        }
        // complete：校验所有 sections
        const errors = collectValidationErrors(ctx, state);
        if (errors.length > 0) {
          return {
            action: { type: "stay", state },
            cursor,
            errorMessage: errors.join("；"),
          };
        }
        return {
          action: {
            type: "exit",
            result: { kind: "completed", config: state.config, credentials: state.credentials },
          },
          cursor,
        };
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

function collectValidationErrors(
  ctx: ConfigEditorContext,
  state: WorkingState,
): string[] {
  const errors: string[] = [];
  for (const section of getSections(ctx.sections)) {
    errors.push(...section.validate(state));
  }
  return errors;
}

/**
 * 计算初始光标位置——指向第一个未配置的 entry，没有则指向第一项。
 *
 * 用户首次进入面板时，光标自然落在最需要操作的字段上。
 */
export function initialMainCursor(
  ctx: ConfigEditorContext,
  state: WorkingState,
): MainPanelCursor {
  return { index: 0 };
}
