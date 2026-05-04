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
  KeyEvent,
  PanelAction,
  PanelDescriptor,
  Section,
  Status,
  WorkingState,
} from "../types.js";
import { deriveEntryIssues, deriveEntryStatus } from "../entry.js";
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
  enterTarget?: PanelDescriptor;
  label: string;
  /** 派生自 entry 的 statusText + issues + disabled——caller 不直接声明 */
  status: Status;
  /** 阻塞 issues——空数组 = 此 entry 完整 */
  issues: readonly string[];
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

/**
 * 收集所有 entries 的 issues——progress 计数 + 完成校验的**单一数据源**。
 * 保证"待补充 N 项"与点击完成后的错误数永远一致。
 */
function collectAllIssues(
  sections: Array<{ section: Section; entries: MainPanelItem[] }>,
): string[] {
  return sections.flatMap(({ entries }) => entries.flatMap((e) => e.issues));
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

  if (ctx.welcomeText) {
    renderer.writeLine(`  ${ctx.welcomeText}`);
    renderer.writeLine("");
  }

  if (ctx.header) {
    if (ctx.header.workspaceRoot) {
      renderer.writeLine(`  工作目录：${ctx.header.workspaceRoot}`);
    }
    renderer.writeLine(
      renderer.dim(
        `  配置：${ctx.header.configPath} · 凭证：${ctx.header.credentialsPath}`,
      ),
    );
    renderer.writeLine("");
  }

  const { sections, options } = buildOptions(ctx, state);
  const pending = collectAllIssues(sections).length;

  let runningIndex = 0;
  for (const { section, entries } of sections) {
    renderer.writeLine(`  ${renderer.bold(section.title)}`);
    if (section.description) {
      renderer.writeLine(`  ${renderer.dim(section.description)}`);
    }
    renderer.writeLine("");
    for (const entry of entries) {
      const selected = runningIndex === cursor.index;
      renderer.writeLine(renderer.entryRow(selected, entry.label, entry.status));
      runningIndex++;
    }
    renderer.writeLine("");
  }

  const progressLabel =
    pending === 0
      ? renderer.green("全部就绪")
      : renderer.yellow(`待补充 ${pending} 项`);
  renderer.writeLine(`  ${renderer.bold("操作")}    ${progressLabel}`);
  renderer.writeLine("");
  for (const option of options) {
    if (option.kind !== "button") continue;
    const selected = runningIndex === cursor.index;
    const label =
      option.action === "complete" && pending > 0
        ? "完成（请先补全必填项）"
        : option.label;
    // 全部就绪时完成按钮 primary（绿），与上方"全部就绪"形成视觉路径
    const primary = option.action === "complete" && pending === 0;
    renderer.writeLine(renderer.actionButton(selected, label, { primary }));
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
        // complete：校验所有 entries 的 issues（与进度计数同源）
        const errors = collectAllIssues(sections);
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

/**
 * 计算初始光标位置——目前固定指向第一项。
 *
 * 未来可基于 ctx + state 计算"第一个未配置的 entry"以引导用户，但当前没有
 * 强需求；保持简单，不引入未用参数。
 */
export function initialMainCursor(): MainPanelCursor {
  return { index: 0 };
}
