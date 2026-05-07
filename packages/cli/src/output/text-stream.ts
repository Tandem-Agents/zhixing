/**
 * AI 文字流式输出——列 2 缩进 + 起首 ◆ 锚 + wrap hanging 4。
 *
 * 视觉契约：
 *   起首：`  ◆ <text>`（缩进 2 + 锚 + 1 空格 + 文字）
 *   续行：`    <text>`（hanging 4 = 缩进 2 + 锚 1 + 空格 1）
 *   wrap：撞 maxLineWidth 时插 \n + hanging
 *   单 \n：硬换行 + hanging（同段续行）
 *   连续 \n（双换行 = 段落分隔）：真空行（无 hanging），下段重新起首 hanging
 *
 * 解耦设计：write 函数 + columns 由 caller 注入，TextStream 不直接耦合 stdout。
 *   - cli REPL 模式下 caller 注入 cliWriter.appendInline，多次 write 调用拼接到
 *     ScreenController 的 tailBuffer 末尾行（chunk 接续语义）
 *   - runOnce / 测试模式下 write 可直接为 stdout.write
 */

import { aiTextAnchor } from "./speaker-state.js";
import { charWidth } from "../tui/line-width.js";
import { layout } from "../tui/style.js";

/** 锚字符 1 列 + 空格 1 列 = 续行缩进比 contentIndent 多 2 列 */
const HANGING_INDENT = layout.contentIndent + 2;
/** 极窄终端的下界——避免 maxLineWidth 跌至 0 导致 wrap 死循环 */
const MIN_USABLE_WIDTH = 20;

const FIRST_LINE_PREFIX = layout.contentPrefix;
const HANGING_PREFIX = " ".repeat(HANGING_INDENT);

/**
 * 起首视觉规范化——第一次 feed 时跳过 chunk 前导的三类字符：
 *   - `\s` 空白字符（空格 / \n / \r / \t / 全角空格 U+3000 等）：起首空格让
 *     `◆ ` 后出现多余 padding 破坏锚紧凑感；起首 \n 让 ◆ 行视觉空
 *   - `\p{Cc}` C0/C1 控制字符（含 DEL U+007F）：不可见但占字符位
 *   - `\p{Cf}` Unicode 格式控制字符（BOM / 零宽 / ZWJ / LRM / RLM / word
 *     joiner / soft hyphen 等）：不可见但占字符位
 *
 * 三类语义不同（空白可视；Cc/Cf 不可视），起首处理一致——都该跳过让 ◆ 锚
 * 紧跟第一个"实质字符"。覆盖范围与 `charWidth = 0`（不可见字符）+ 空白对齐：
 * 任何不会让 ◆ 后出现可见字符的字符都被 trim。这是**视觉规范化契约**，
 * 独立于 charWidth 显示宽度判断（charWidth(空格) = 1，空格算可视；但起首
 * 仍应 trim 防 padding）。
 *
 * Unicode 通用类别 `\p{Cc}` 与 `\p{Cf}` 一次覆盖所有控制字符与格式字符
 * （包括未来 Unicode 标准新增的此两类字符），无须维护字符黑名单。实证：LLM
 * 模型偶尔输出 DEL 起首 chunk（如 MiniMax 把 `:` token 错误编码为 DEL），
 * 不 trim 会让 ◆ 行视觉空。
 */
const LEADING_INVISIBLE = /^[\s\p{Cc}\p{Cf}]+/u;

export interface TextStreamOptions {
  readonly write: (chunk: string) => void;
  readonly columns: number;
}

export class TextStream {
  private hasStarted = false;
  private currentColWidth = 0;
  /**
   * 上次 feed 末尾在新行起首（\n 后）——下次 feed 起首前需补 hanging 续行 prefix。
   *
   * 用途：跨 feed 边界处理 hanging。chunk = "abc\n" 末尾 \n 后，下次 feed("def")
   * 来时 def 应该在 hanging 续行；needsHangingPrefix=true 让下次 feed 起首先补 hanging。
   */
  private needsHangingPrefix = false;
  private readonly maxLineWidth: number;
  private readonly write: (chunk: string) => void;

  constructor(options: TextStreamOptions) {
    this.write = options.write;
    this.maxLineWidth = Math.max(options.columns - HANGING_INDENT, MIN_USABLE_WIDTH);
  }

  /**
   * 喂入 LLM 流式 chunk——内部按字符级 wrap 累积成字符串后**一次** write 调用。
   *
   * 段落分隔语义（`\n\n`）：双换行视为段落分隔，中间产生**真空行**（无 hanging
   * 4 空格），下一段重新起首 hanging。这样 markdown 段落感与 4 空格 hanging 视觉
   * 噪声分离——段间空行干净，段内 wrap 续行有 hanging。
   */
  feed(chunk: string): void {
    if (!chunk) return;

    // 起首时按 LEADING_INVISIBLE 视觉规范化跳过 chunk 前导的空白与 Cf 类不可见
    // 字符，让 ◆ 锚紧跟第一个实质字符；规范化后全空时本次 feed 不输出，等下次
    // 有实质字符再起首。规范化范围与设计原因见 LEADING_INVISIBLE 注释。
    const activeChunk = this.hasStarted
      ? chunk
      : chunk.replace(LEADING_INVISIBLE, "");
    if (activeChunk.length === 0) return;

    const segments = activeChunk.split("\n");
    let out = "";
    if (!this.hasStarted) {
      out += `${FIRST_LINE_PREFIX}${aiTextAnchor()} `;
      this.hasStarted = true;
      this.currentColWidth = 0;
      this.needsHangingPrefix = false;
    } else if (this.needsHangingPrefix && segments[0]!.length > 0) {
      // 上次 feed 末尾停在新行起首，且本次第一段非空——续行内容需要补 hanging。
      // 第一段为空（chunk 起首是 \n）说明这是段落分隔的延续，不补 hanging
      // 让真空行出现。
      out += HANGING_PREFIX;
    }
    this.needsHangingPrefix = false;
    for (let i = 0; i < segments.length; i++) {
      out += this.buildSegment(segments[i]!);
      if (i < segments.length - 1) {
        out += "\n";
        this.currentColWidth = 0;
        // 下一段非空才补 hanging——空段（连续 \n 段落分隔）让真空行出现
        const nextSeg = segments[i + 1]!;
        if (nextSeg.length > 0) {
          out += HANGING_PREFIX;
        }
      }
    }

    // 末尾如果在新行起首（最后 segment 为空 = chunk 末尾 \n，或多段都是空），
    // 下次 feed 起首前需要补 hanging（除非下次又是段落分隔）
    if (
      segments.length > 1 &&
      segments[segments.length - 1]!.length === 0
    ) {
      this.needsHangingPrefix = true;
    }

    if (out.length > 0) this.write(out);
  }

  /** turn 末——若已起首，写末尾换行让下一轮回到列 0 起手。 */
  end(): void {
    if (this.hasStarted) {
      this.write("\n");
      this.hasStarted = false;
      this.currentColWidth = 0;
      this.needsHangingPrefix = false;
    }
  }

  /** 按字符级 wrap 把单段（不含 \n）累积成字符串——超 maxLineWidth 处插 hanging 续行。 */
  private buildSegment(seg: string): string {
    let out = "";
    for (const ch of seg) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      const w = charWidth(cp);
      if (this.currentColWidth + w > this.maxLineWidth && this.currentColWidth > 0) {
        out += `\n${HANGING_PREFIX}`;
        this.currentColWidth = 0;
      }
      out += ch;
      this.currentColWidth += w;
    }
    return out;
  }
}

