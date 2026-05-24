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
import {
  tone,
  renderChrome,
  type BrandAnchor,
  renderSectionHead,
  renderEntryRow,
  renderButtonRow,
  renderFooter,
} from "../../tui/index.js";

const FOOTER_HINTS = ["↑↓ 选择", "Enter 进入/确认", "Ctrl+C 退出"] as const;

/**
 * 品牌锚"浮灵 / Drift"的固定形态：
 *   - 顶边：倾斜符 ╲（生灵从顶边斜倾下落的天线）
 *   - 锚 body 三行：` ▄▄▄` / `▌●●▐` / ` ▀▀`（身体）
 *
 * Body 文本（知行 / 副标题 / 欢迎语）拼到锚 body 右侧 inline——节省 3 行高度，
 * 同时为 welcome 内"右半"动态内容（版本变更等）预留视觉位置。完整 anchor 在
 * `buildBrandAnchor` 中按 ctx 拼装。
 */
const ANCHOR_GLYPH_ROW1 = " ▄▄▄";
const ANCHOR_GLYPH_ROW2 = "▌●●▐";
const ANCHOR_GLYPH_ROW3 = " ▀▀ "; // 末尾补 1 空格使三行视宽一致（4 col），便于 inline 文字对齐
const ANCHOR_INLINE_GAP = "    "; // 锚右侧到 inline 文字之间的 4 空格留白

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
 * 拼装 BrandAnchor：锚 body 三行各自携带 inline 文字（知行 / 副标题 / 欢迎语）。
 *
 * 列形：
 *   ╲                                        （顶边）
 *    ▄▄▄    知行
 *   ▌●●▐    初始配置
 *    ▀▀     欢迎语…
 *
 * 把品牌信息嵌入锚 body 是为了：
 *   - 节省 3 行高度（不再让"知行"/"副标题"各占独立 body 行）
 *   - 锚右侧形成自然的"左半屏文字区"，与 welcome 右半的预留区分层
 */
function buildBrandAnchor(ctx: ConfigEditorContext): BrandAnchor {
  const row1 = `${tone.brand.bold(ANCHOR_GLYPH_ROW1)}${ANCHOR_INLINE_GAP}${tone.brand.bold("知行")}`;
  const row2 = `${tone.brand.bold(ANCHOR_GLYPH_ROW2)}${ANCHOR_INLINE_GAP}${tone.dim(ctx.title)}`;
  const row3 = ctx.welcomeText
    ? `${tone.brand.bold(ANCHOR_GLYPH_ROW3)}${ANCHOR_INLINE_GAP}${ctx.welcomeText}`
    : tone.brand.bold(ANCHOR_GLYPH_ROW3);
  return {
    topEdge: "╲",
    bodyLines: [row1, row2, row3],
  };
}

/**
 * 拼装 Welcome chrome 的 body：仅 3 个路径行（工作目录 / 配置 / 凭证）。
 *
 * 品牌名 / 副标题 / 欢迎语已 inline 进 brandAnchor body——此函数只剩"读出来的
 * 技术信息"层，三行统一 dim 弱化（读得到、不抢戏）。
 */
function buildHeaderBody(ctx: ConfigEditorContext): string[] {
  const rows: string[] = [];
  if (ctx.header?.workspaceRoot) {
    rows.push(tone.dim(`工作目录    ${ctx.header.workspaceRoot}`));
  }
  if (ctx.header) {
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

  const width = renderer.terminalWidth();

  // Welcome chrome：品牌锚"浮灵"——倾斜符 ╲ 嵌顶边，身体三行落 body 顶部并 inline
  // 携带"知行 / 副标题 / 欢迎语"。锚右侧的剩余空间是 welcome 内"右半区"，
  // 留给未来动态内容（版本变更、近期更新等）
  renderer.writeLines(
    renderChrome({
      brandAnchor: buildBrandAnchor(ctx),
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

  // "操作"区头部进度 pill 仅在"有意义"时显示：存在完成门槛（含必填项的 section），
  // 或当前确有待补充项。全可选编辑器（如 /mcp）且无待补充 → pill 恒真、无信息且误导，
  // 省略。`|| pending > 0` 让显示与 optional 标志的准确性解耦：万一某 optional section
  // 仍产出 issues，pill 仍以"待补充 N 项"解释为何"完成"被挡，不会出现"无 pill 却被挡"的矛盾。
  const hasCompletionGate = sections.some(({ section }) => !section.optional);
  const opStatus =
    !hasCompletionGate && pending === 0
      ? undefined
      : pending === 0
        ? ({ kind: "ready", text: "全部就绪" } as const)
        : ({ kind: "pending", text: `待补充 ${pending} 项` } as const);
  renderer.writeLines(
    renderSectionHead({
      title: "操作",
      ...(opStatus ? { status: opStatus } : {}),
    }),
  );
  renderer.writeLine("");

  // 按钮：label 只放短动作名（完成 / 取消），说明性 hint 拼到按钮右侧 dim。
  // renderButtonRow 内部统一处理外置 cursor + indent + hint 拼接，按钮间不留
  // inter-button 空行——按钮自身 3 行已自带视觉重量。
  const buttonOptions = options.filter(
    (o): o is Extract<MainPanelOption, { kind: "button" }> => o.kind === "button",
  );
  for (const option of buttonOptions) {
    const selected = runningIndex === cursor.index;
    renderer.writeLines(
      renderButtonRow({
        label: option.action === "complete" ? "完成" : "取消",
        hint: pickButtonHint(option.action, pending),
        primary: option.action === "complete" && pending === 0,
        selected,
      }),
    );
    runningIndex++;
  }

  renderer.writeLine("");

  if (errorMessage) {
    renderer.writeLine(tone.error("  " + errorMessage));
    renderer.writeLine("");
  }

  renderer.writeLines(
    renderFooter({ width, hints: FOOTER_HINTS }),
  );
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
