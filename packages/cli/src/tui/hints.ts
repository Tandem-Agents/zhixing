/**
 * Key hint 行 —— 「操作说明（亮） + 按键标识（暗）」的单一样式来源。
 *
 *   导航 ↑↓  退出 Esc            置顶 p  禁用 d  改 mode m  归档 a
 *   └说明┘└键┘                   说明在前、亮（终端默认前景）；按键在后、dim。
 *
 * 为什么独立成原语：footer（带分隔线的页脚）与 inputBox（框下提示行）此前各自把
 * hint 拼成字符串、各自染色——重复即债务。提成 `renderHintBar` 后两个 caller 共享
 * 同一样式与布局，改观感只改这一处。
 *
 * **alt-screen 行宽不变量**：输出恒 ≤ `width`（clampLine 兜底）。Renderer 不截断写入行
 * （render.ts），超 columns 会触发终端折行、打乱清行光标数学（line-width.ts docstring）。
 * 故双区放不下时优雅降级回单区平铺并截断，与 footer / renderListRow 同守此不变量。
 */

import { tone, layout } from "./style.js";
import { clampLine, stringWidth } from "./line-width.js";

export interface KeyHint {
  /** 操作说明 —— 亮色在前（如「置顶」「提交」「导航」）。 */
  label: string;
  /** 按键标识 —— 暗色在后（如「p」「Ctrl+S」「↑↓」）。 */
  key: string;
}

/** hint 间分隔：双空格（hint 内「说明 键」已用单空格，靠颜色分组 + 双空格分隔 hint）。 */
const HINT_GAP = "  ";

/** 单个 hint：说明亮（裸前景）在前 + 按键暗（dim）在后。 */
function renderOne(h: KeyHint): string {
  return `${h.label} ${tone.dim(h.key)}`;
}

export interface HintBarOptions {
  width: number;
  /** 左区 —— 基础 / 导航操作（贴左、缩进对齐）。 */
  hints: readonly KeyHint[];
  /** 右区 —— 功能 / 变更操作（贴右、两端对齐到 width）。省略 = 仅左区。 */
  rightHints?: readonly KeyHint[];
  /** 左缩进，缺省 `layout.contentPrefix`（2 列）；inputBox 框下提示传 1 列对齐框。 */
  indent?: string;
}

/**
 * 一组 key hint → 单行文本（不含分隔线，caller 自配上下文）。
 *
 * 左区贴左、右区贴右两端对齐；放不下时优雅降级回单区平铺并 clamp。恒 ≤ width。
 */
export function renderHintBar(opts: HintBarOptions): string {
  const indent = opts.indent ?? layout.contentPrefix;
  const left = indent + opts.hints.map(renderOne).join(HINT_GAP);

  if (!opts.rightHints || opts.rightHints.length === 0) {
    return clampLine(left, opts.width);
  }

  const right = opts.rightHints.map(renderOne).join(HINT_GAP);
  const leftW = stringWidth(left);
  const rightW = stringWidth(right);
  // 放得下（左 + 至少 1 列间隔 + 右 ≤ width）：单行两端对齐。
  if (leftW + 1 + rightW <= opts.width) {
    return left + " ".repeat(opts.width - leftW - rightW) + right;
  }
  // 放不下：优雅降级回单区平铺，clamp 守行宽不变量。
  const merged =
    indent + [...opts.hints, ...opts.rightHints].map(renderOne).join(HINT_GAP);
  return clampLine(merged, opts.width);
}
