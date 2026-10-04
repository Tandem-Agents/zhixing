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
import type { ConfigEditorContext, WorkingState } from "../types.js";
import { tone, renderChrome, type BrandAnchor, renderSectionHead, renderEntryRow, renderButtonRow, renderFooter, Renderer } from "../../tui/index.js";
import { type MainPanelCursor, type MainPanelOption, buildOptions, collectAllIssues } from '../model/main.js';
export { type MainPanelCursor, type MainPanelKeyResult, handleMainPanelKey, initialMainCursor } from '../model/main.js';



const FOOTER_HINTS = [
  "↑↓ 选择",
  "Enter 进入/确认",
  "Ctrl+S 完成",
  "Esc / Ctrl+C 退出",
] as const;


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

const ANCHOR_GLYPH_ROW3 = " ▀▀ ";
 // 末尾补 1 空格使三行视宽一致（4 col），便于 inline 文字对齐
const ANCHOR_INLINE_GAP = "    ";


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
    rows.push(tone.dim(`秘密存储    ${ctx.header.secretStoreLabel}`));
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
        // 全局快捷键提示（接在括号说明后）：完成 Ctrl+S、取消 Esc（Ctrl+C 亦可，见 footer）
        shortcut: option.action === "complete" ? "Ctrl+S" : "Esc",
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
