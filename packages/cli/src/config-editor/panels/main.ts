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
import { tone, getTerminalWidth, layout, icon } from "../../tui/style.js";
import { renderChrome } from "../../tui/chrome.js";
import { renderSectionHead, renderEntryRow } from "../../tui/section.js";
import { renderButton } from "../../tui/button.js";
import { renderFooter } from "../../tui/footer.js";

const CONTENT_INDENT = " ".repeat(layout.contentIndent);
const FOOTER_HINTS = ["↑↓ 选择", "Enter 进入/确认", "Ctrl+C 退出"] as const;
const BUTTON_HINT_GAP = "   "; // 按钮与右侧 hint 之间的间隔

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

/**
 * 按钮右侧的 hint 文本——纯描述，不影响按下逻辑。
 *   完成 + 缺字段 → 提示"先补全"
 *   完成 + 就绪    → 提示"保存并启动"
 *   取消           → 提示"退出"
 */
function pickButtonHint(action: "complete" | "cancel", pending: number): string {
  if (action === "cancel") return "退出";
  return pending > 0 ? "请先补全必填项" : "保存并启动";
}

/**
 * 拼装 Welcome chrome 的 body：名字 + 上下文 + 可选 welcomeText + 工作目录 + 路径。
 *
 * 品牌锚（✦）由 chrome 顶边居中承载——此函数只构造 body 内容。
 * 名字与 subtitle 在最顶部紧贴（同一品牌块），随后用空行与正文分隔。
 *
 * 路径用 dim 弱化——它们是技术细节；工作目录保留正常色（用户日常会关心
 * "agent 在哪儿读写文件"）。
 */
function buildHeaderBody(ctx: ConfigEditorContext): string[] {
  const rows: string[] = [];

  rows.push(tone.brand.bold("知行"));
  rows.push(tone.dim(ctx.title));

  if (ctx.welcomeText) {
    rows.push("");
    rows.push(ctx.welcomeText);
  }
  if (ctx.header) {
    rows.push("");
    if (ctx.header.workspaceRoot) {
      rows.push(`工作目录    ${ctx.header.workspaceRoot}`);
    }
    rows.push(tone.dim(`配置        ${ctx.header.configPath}`));
    rows.push(tone.dim(`凭证        ${ctx.header.credentialsPath}`));
  }
  return rows;
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

  const width = getTerminalWidth(ctx.stdout);

  // Welcome chrome：顶边嵌入品牌锚（占位 ✦——将来由独立设计的图腾替换），
  // body 内承载名字 + 上下文 + welcome 内容
  renderer.writeLines(
    renderChrome({
      brandAnchor: icon.brand,
      body: buildHeaderBody(ctx),
      width,
    }),
  );
  renderer.writeLine("");

  const { sections, options } = buildOptions(ctx, state);
  const pending = collectAllIssues(sections).length;

  let runningIndex = 0;
  for (const { section, entries } of sections) {
    renderer.writeLines(
      renderSectionHead({
        title: section.title,
        description: section.description,
      }),
    );
    renderer.writeLine("");
    // 列表项紧贴——entry 自身已是双区布局有视觉重量，不再加 inter-entry 空行
    for (const entry of entries) {
      const selected = runningIndex === cursor.index;
      renderer.writeLines(
        renderEntryRow({
          label: entry.label,
          status: { kind: entry.status.level, text: entry.status.text },
          selected,
          width,
        }),
      );
      runningIndex++;
    }
    renderer.writeLine("");
  }

  // "操作"是 section 形态——头部带进度 pill，紧挨标题（非右对齐）
  const opStatus =
    pending === 0
      ? ({ kind: "ready", text: "全部就绪" } as const)
      : ({ kind: "pending", text: `待补充 ${pending} 项` } as const);
  renderer.writeLines(
    renderSectionHead({
      title: "操作",
      status: opStatus,
    }),
  );
  renderer.writeLine("");

  // 按钮：label 只放短动作名（完成 / 取消），说明性 hint 拼到按钮右侧 dim
  // 选中态用外置 cursor `▸` 在按钮左侧——避免 bg 染色在跨终端的不稳定渲染
  const buttonOptions = options.filter(
    (o): o is Extract<MainPanelOption, { kind: "button" }> => o.kind === "button",
  );
  for (const option of buttonOptions) {
    const selected = runningIndex === cursor.index;
    const label = option.action === "complete" ? "完成" : "取消";
    const hint = pickButtonHint(option.action, pending);
    const primary = option.action === "complete" && pending === 0;
    const lines = renderButton({ label, selected, primary });
    if (hint) {
      lines[1] = lines[1] + BUTTON_HINT_GAP + tone.dim(`(${hint})`);
    }
    // 三行布局：top / middle / bottom——cursor 仅放 middle 行外左侧，其他两行
    // 用空格补齐对齐位（cursor 占 1 列 + space 1 列 = 与 CONTENT_INDENT 同宽）
    // 按钮间无 inter-button 空行——按钮自身 3 行已自带视觉重量
    const cursorMark = selected ? tone.brand(icon.cursor) : " ";
    renderer.writeLine(CONTENT_INDENT + lines[0]!);
    renderer.writeLine(cursorMark + " " + lines[1]!);
    renderer.writeLine(CONTENT_INDENT + lines[2]!);
    runningIndex++;
  }

  renderer.writeLine("");

  if (errorMessage) {
    renderer.writeLine(tone.error("  " + errorMessage));
    renderer.writeLine("");
  }

  renderer.writeLines(renderFooter({ width, hints: FOOTER_HINTS }));
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
