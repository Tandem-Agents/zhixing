/**
 * 闭合 block 的 ANSI 渲染——纯函数：单 block token → ANSI 字符串。
 *
 * **当前实际启用范围（重要）**：
 *   markdown-stream 当前只在 code block 闭合时调用 `renderBlock` 走 ANSI emit；
 *   heading / list / blockquote / hr 走"字面字符 forward"路径（避免末尾 hold 卡住
 *   stream），不调用本模块的 ANSI 渲染。这意味着 `renderHeading` / `renderList` /
 *   `renderBlockquote` / `renderHr` **目前是预留接口**——保留它们是为后续接入"行级
 *   流式"策略时可直接复用单 item 渲染（届时 markdown-stream 改为单 item 闭合即
 *   emit ANSI，避免整 block hold；renderer 函数无需重写）。
 *
 *   `markdown-stream.ts` 顶部注释有完整 trade-off 说明。
 *
 * 视觉契约（仅 code block 当前生效；其他渲染函数为预留契约）：
 *   - 列 2 起（layout.contentPrefix），与 AI 文字 `◆ <text>` 同基线
 *   - heading：粗体 + 起首空行；一级标题 brand cyan，二级及以下默认色
 *   - code block：dim 灰文字 + 起首空行 + 无装饰字符（便于复制）
 *   - list：无序用 `·` 中点（CJK 友好，比 `•` 克制）；有序保留数字
 *   - blockquote：dim 文字
 *   - hr：dim 横线 `─` + 起首空行
 *
 * 输出契约：
 *   返回字符串末尾保证以 \n 结尾（独立段语义）。"前后空行"中的"前空行"由起首
 *   的 `\n` 提供——caller 经 cliWriter.line 写入时与 ScreenController 的 inMidLine
 *   补 \n 协同形成视觉空行；"后空行"由下一段的起首 `\n` 提供。不重复加末尾 \n\n——
 *   ScreenController 的 tailBuffer 模型对每个 \n 会增加一行。
 *
 * inline 元素（粗体/斜体/链接/inline code）当前在 paragraph 流内为字面字符；后续
 * inline-renderer 接入时再把 paragraph 内的 strong / em / codespan / link 转 ANSI。
 */

import chalk from "chalk";
import type { Tokens } from "marked";
import { layout, tone } from "../../tui/style.js";
import type { MarkdownMode } from "./types.js";

const PREFIX = layout.contentPrefix;

/**
 * 渲染单个闭合 block → 多行 ANSI 字符串（含末尾 \n 让段独立落地）。
 *
 * 返回空字符串表示该 block 不渲染（如 strip 模式下的某些元素降级）。
 */
export function renderBlock(token: Tokens.Generic, mode: MarkdownMode): string {
  if (mode === "raw") return token.raw ?? "";

  switch (token.type) {
    case "heading":
      return renderHeading(token as Tokens.Heading, mode);
    case "code":
      return renderCode(token as Tokens.Code, mode);
    case "list":
      return renderList(token as Tokens.List, mode);
    case "blockquote":
      return renderBlockquote(token as Tokens.Blockquote, mode);
    case "hr":
      return renderHr(mode);
    case "space":
      // 段落分隔由 caller 控制，此处不重复 emit
      return "";
    default:
      // 未知 block 类型 fallback 到 raw 文本（含末尾换行让段独立）
      return ensureTrailingNewline(`${PREFIX}${token.raw ?? ""}`);
  }
}

function renderHeading(t: Tokens.Heading, mode: MarkdownMode): string {
  const text = t.text;
  if (mode === "strip") return `\n${PREFIX}${text}\n`;
  const styled = t.depth === 1 ? tone.brand.bold(text) : chalk.bold(text);
  return `\n${PREFIX}${styled}\n`;
}

function renderCode(t: Tokens.Code, mode: MarkdownMode): string {
  const lines = t.text.split("\n");
  const styledLines = lines.map((line) => {
    const indented = `${PREFIX}${line}`;
    return mode === "strip" ? indented : tone.dim(indented);
  });
  return `\n${styledLines.join("\n")}\n`;
}

function renderList(t: Tokens.List, mode: MarkdownMode): string {
  const out: string[] = [];
  for (let i = 0; i < t.items.length; i++) {
    const item = t.items[i]!;
    const marker = t.ordered ? `${(t.start || 1) + i}.` : "·";
    const styledMarker = mode === "strip" ? marker : tone.dim(marker);
    // list_item.text 已是去掉 marker 的纯文本
    out.push(`${PREFIX}${styledMarker} ${item.text}`);
  }
  return ensureTrailingNewline(out.join("\n"));
}

function renderBlockquote(t: Tokens.Blockquote, mode: MarkdownMode): string {
  // blockquote.text 是去掉 `> ` 前缀的内容；多行用 dim 文字呈现
  const lines = t.text.split("\n");
  const styledLines = lines.map((line) => {
    const indented = `${PREFIX}${line}`;
    return mode === "strip" ? indented : tone.dim(indented);
  });
  return ensureTrailingNewline(styledLines.join("\n"));
}

function renderHr(mode: MarkdownMode): string {
  const rule = "─".repeat(40);
  const styled = mode === "strip" ? rule : tone.dim(rule);
  return `\n${PREFIX}${styled}\n`;
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
