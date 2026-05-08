/**
 * 闭合 block 的 ANSI 渲染——纯函数：单 block token → ANSI 字符串。
 *
 * 完备覆盖：heading / paragraph / code / list / blockquote / hr / space。renderBlock
 * 接受任意 marked block token + 嵌套层级 indentLevel，递归处理子 block（list_item
 * 嵌套 list / blockquote.tokens 子段落 list 等）让任意嵌套结构正确渲染。
 *
 * 视觉契约：
 *   - 列起 = 列 2 (PREFIX) + indentLevel * 2（嵌套每层多 2 列）
 *   - heading：粗体 + 起首空行；一级标题 brand cyan，二级及以下默认色
 *   - code block：fenced 带受支持 lang 走 cli-highlight 语法高亮；无 lang / 不支持
 *     lang / strip 模式走 dim 退化——起首空行 + 列对齐 + 无装饰字符（便于复制）。
 *     跨行 SGR token（如 Python `"""docstring"""` 多行字符串）经 splitAnsiLines
 *     处理让每行 SGR 自平衡，避免续行被染色或 SGR 泄露后续段
 *   - paragraph：起首空行 + 列对齐 + inline ANSI（**bold** / `code` / [link] 等）
 *   - list：无序用 `·` 中点（CJK 友好，比 `•` 克制）；有序保留数字。list_item
 *     首行 `{indent}{dim marker} {inline ANSI}`；嵌套 list / 续段缩进 +2 列
 *   - blockquote：递归渲染子 block 后整段 dim
 *   - hr：dim 横线 `─` + 起首空行
 *
 * 输出契约：
 *   返回字符串以 `\n` 起首 + `\n` 结尾（独立段语义）。caller 经 cliWriter.line
 *   写入时与 ScreenController 的 inMidLine 协同形成视觉空行。空字符串表示该
 *   block 不渲染（如 mode 降级 / 内容为空）。
 *
 *   嵌套调用时（list_item / blockquote 内部递归 renderBlock）caller 通过
 *   stripBlockBoundaryNewlines 剥两端 \n 后 join，避免重复空行。
 */

import chalk from "chalk";
import { highlight, supportsLanguage, type Theme } from "cli-highlight";
import type { Tokens } from "marked";
import { splitAnsiLines } from "../../tui/ansi.js";
import { layout, tone } from "../../tui/style.js";
import { renderInlines } from "./inline-renderer.js";
import type { MarkdownMode } from "./types.js";

const PREFIX = layout.contentPrefix;
const INDENT_UNIT = "  ";

/**
 * 代码块语法高亮 theme——把 cli-highlight 的 token 映射到本项目 chalk 5 实例的
 * 染色函数。不复用 cli-highlight 的 DEFAULT_THEME 因为它用的是内嵌 chalk 4
 * 实例，在 non-TTY 环境（vitest / pipe）默认 level=0 不染色，而本项目 chalk 5
 * 实例由全局 chalk.level 统一控制（cli REPL 启动时按 supports-color 设置）。
 *
 * 色彩取向：cyan（brand 色）覆盖类型 / 类 / 函数 / 内建，magenta keyword 突出
 * 控制流，yellow number / literal 跳出常量，green string，red regexp，dim 注
 * 释 / meta（让代码"形状"主导，文字色少而克制）。与 inline `codespan`（bg
 * cyan 文字）/ link（cyan + 虚线）形成层次区分而非冲突。
 */
const CODE_THEME: Theme = {
  keyword: chalk.magenta,
  built_in: chalk.cyan,
  type: chalk.cyan,
  literal: chalk.yellow,
  number: chalk.yellow,
  regexp: chalk.red,
  string: chalk.green,
  symbol: chalk.cyan,
  class: chalk.cyan,
  function: chalk.cyan,
  title: chalk.cyan,
  comment: chalk.dim,
  doctag: chalk.dim,
  meta: chalk.dim,
  tag: chalk.dim,
  attr: chalk.cyan,
  variable: chalk.cyan,
  emphasis: chalk.italic,
  strong: chalk.bold,
  link: chalk.underline,
  addition: chalk.green,
  deletion: chalk.red,
};

/**
 * 渲染单个闭合 block → 多行 ANSI 字符串（含起首 / 末尾 \n 让段独立落地）。
 *
 * indentLevel：嵌套层级（默认 0 = 顶层）。每层多 2 列起首缩进 (INDENT_UNIT)，
 * 复合 PREFIX 让嵌套 list / blockquote 等子结构视觉对齐。
 *
 * 返回空字符串表示该 block 不渲染（space token / 内容为空）。
 */
export function renderBlock(
  token: Tokens.Generic,
  mode: MarkdownMode,
  indentLevel = 0,
): string {
  if (mode === "raw") return token.raw ?? "";

  switch (token.type) {
    case "heading":
      return renderHeading(token as Tokens.Heading, mode, indentLevel);
    case "code":
      return renderCode(token as Tokens.Code, mode, indentLevel);
    case "list":
      return renderList(token as Tokens.List, mode, indentLevel);
    case "blockquote":
      return renderBlockquote(token as Tokens.Blockquote, mode, indentLevel);
    case "hr":
      return renderHr(mode, indentLevel);
    case "paragraph":
      return renderParagraph(token as Tokens.Paragraph, mode, indentLevel);
    case "space":
      // 段落分隔由 caller 控制，此处不重复 emit
      return "";
    default:
      // 未知 block 类型 fallback 到 raw 文本（含末尾换行让段独立）
      return ensureTrailingNewline(
        `${lineIndent(indentLevel)}${token.raw ?? ""}`,
      );
  }
}

/**
 * 流式期 code block 的 dim 格式化——双态渲染流式期占位用：整段 dim + 列 2
 * PREFIX + 起首 \n + 末尾 \n（与 renderCode 闭合 highlight 输出格式对齐，commit
 * 切换时行数 / 列对齐稳定）。
 *
 * 仅 render 模式调用——strip / raw 模式走 hold 路径不进入双态。仅顶层 code 流式
 * 调用（嵌套 code 在 list/blockquote 内由 renderBlock 闭合渲染）。
 */
export function formatStreamingCode(codeText: string): string {
  if (codeText === "") return "";
  const styled = tone.dim(codeText);
  const lines = splitAnsiLines(styled);
  return `\n${lines.map((l) => `${PREFIX}${l}`).join("\n")}\n`;
}

/** 行起首 indent: PREFIX (列 2) + 嵌套层数 * INDENT_UNIT */
function lineIndent(indentLevel: number): string {
  return PREFIX + INDENT_UNIT.repeat(indentLevel);
}

/** 剥嵌套 renderBlock 输出两端 \n——caller 用于 join 控制 \n 不重复 */
function stripBlockBoundaryNewlines(s: string): string {
  return s.replace(/^\n+/, "").replace(/\n+$/, "");
}

function renderHeading(
  t: Tokens.Heading,
  mode: MarkdownMode,
  indentLevel: number,
): string {
  const indent = lineIndent(indentLevel);
  const text = t.text;
  if (mode === "strip") return `\n${indent}${text}\n`;
  const styled = t.depth === 1 ? tone.brand.bold(text) : chalk.bold(text);
  return `\n${indent}${styled}\n`;
}

function renderCode(
  t: Tokens.Code,
  mode: MarkdownMode,
  indentLevel: number,
): string {
  const indent = lineIndent(indentLevel);
  if (mode === "strip") {
    const lines = t.text.split("\n");
    return `\n${lines.map((l) => `${indent}${l}`).join("\n")}\n`;
  }

  // 已知且受支持的 lang 走 cli-highlight；否则退化 dim（无 lang / 未识别 lang
  // / 流式期 lang 还未到——markdown-stream 双态模式自己 dim 占位流式期）
  const lang = t.lang?.trim() ?? "";
  const styled =
    lang && supportsLanguage(lang)
      ? // ignoreIllegals: 容忍代码不完整或非法语法（流式期可能不完整、用户片段
        // 可能含语法错误）—— hl.js 抛错会破坏整段渲染，此选项让 highlight 尽
        // 力着色已识别部分。theme: 强制走本项目 chalk 5 实例避免 cli-highlight
        // 内嵌 chalk 4 在 non-TTY 不染色
        highlight(t.text, {
          language: lang,
          ignoreIllegals: true,
          theme: CODE_THEME,
        })
      : tone.dim(t.text);

  // 跨行 SGR（多行字符串 / 块注释等）需 splitAnsiLines 让每行 SGR 自平衡——
  // 否则续行 indent 会继承上行未关闭 SGR + 下一段被染色泄露
  const lines = splitAnsiLines(styled);
  return `\n${lines.map((l) => `${indent}${l}`).join("\n")}\n`;
}

function renderParagraph(
  t: Tokens.Paragraph,
  mode: MarkdownMode,
  indentLevel: number,
): string {
  const indent = lineIndent(indentLevel);
  const inline = renderInlines(t.tokens ?? [], mode);
  if (inline === "") return "";
  // inline 可能含 softbreak \n —— splitAnsiLines 让每行 SGR 自平衡 + 给每行加 indent
  const lines = splitAnsiLines(inline);
  return `\n${lines.map((l) => `${indent}${l}`).join("\n")}\n`;
}

function renderList(
  t: Tokens.List,
  mode: MarkdownMode,
  indentLevel: number,
): string {
  const items = t.items ?? [];
  if (items.length === 0) return "";
  const lines: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const marker = t.ordered ? `${(t.start || 1) + i}.` : "·";
    lines.push(renderListItem(items[i]!, marker, mode, indentLevel));
  }
  return `\n${lines.join("\n")}\n`;
}

/**
 * 单个 list_item → ANSI 多行字符串（不含两端 \n，由 caller join）。
 *
 * 结构：
 *   - 首行：`{indent}{dim marker} {inline ANSI}` —— marker 与 inline 同一行
 *   - inline 跨行（含 softbreak）→ 续行 indent + 2 列（与 marker 后字符对齐）
 *   - 嵌套子 block（list / blockquote / paragraph 等）：递归 renderBlock + 1 层
 *     indentLevel；递归输出两端 \n 由 stripBlockBoundaryNewlines 剥除
 */
function renderListItem(
  item: Tokens.ListItem,
  marker: string,
  mode: MarkdownMode,
  indentLevel: number,
): string {
  const indent = lineIndent(indentLevel);
  // marker 后单空格 + 续行对齐：marker 占 1+ 字符 + 1 空格——简化为 INDENT_UNIT (2 列)
  const continuationIndent = indent + INDENT_UNIT;
  const styledMarker = mode === "strip" ? marker : tone.dim(marker);
  const { inlineTokens, blockTokens } = splitListItemTokens(item);

  const out: string[] = [];

  if (inlineTokens.length > 0) {
    const inlineAnsi = renderInlines(inlineTokens, mode);
    const inlineLines = splitAnsiLines(inlineAnsi);
    if (inlineLines.length > 0) {
      out.push(`${indent}${styledMarker} ${inlineLines[0]!}`);
      for (let i = 1; i < inlineLines.length; i++) {
        out.push(`${continuationIndent}${inlineLines[i]!}`);
      }
    } else {
      out.push(`${indent}${styledMarker}`);
    }
  } else {
    out.push(`${indent}${styledMarker}`);
  }

  for (const block of blockTokens) {
    const sub = renderBlock(block, mode, indentLevel + 1);
    const trimmed = stripBlockBoundaryNewlines(sub);
    if (trimmed.length > 0) out.push(trimmed);
  }

  return out.join("\n");
}

interface SplitListItemTokens {
  inlineTokens: Tokens.Generic[];
  blockTokens: Tokens.Generic[];
}

const BLOCK_TOKEN_TYPES = new Set<string>([
  "heading",
  "code",
  "list",
  "blockquote",
  "hr",
  "paragraph",
  "space",
]);

/**
 * list_item.tokens 切成 inline 起首部分 + 嵌套子 block 部分。
 *
 * marked 给 list_item.tokens 因 tight/loose + 内容而异：
 *   - tight + 单行：[text, strong, ...]（直接是 inline）
 *   - loose 或多段：[paragraph(.tokens=[inline...]), ...]
 *   - 含嵌套：[paragraph 或 inline 起首, list/blockquote/...]
 *
 * 统一为 { inlineTokens, blockTokens }——首段 inline（text 或 paragraph 内 inline）
 * 视为 inlineTokens；其后所有 token 视为 blockTokens（递归 renderBlock 处理）。
 */
function splitListItemTokens(item: Tokens.ListItem): SplitListItemTokens {
  const tokens = item.tokens ?? [];
  if (tokens.length === 0) return { inlineTokens: [], blockTokens: [] };

  const first = tokens[0]!;
  if (first.type === "paragraph") {
    const inlineTokens = (first as Tokens.Paragraph).tokens ?? [];
    const blockTokens = tokens.slice(1);
    return { inlineTokens: [...inlineTokens], blockTokens };
  }

  const blockStart = tokens.findIndex((t) => BLOCK_TOKEN_TYPES.has(t.type));
  if (blockStart === -1) {
    return { inlineTokens: [...tokens], blockTokens: [] };
  }
  return {
    inlineTokens: tokens.slice(0, blockStart),
    blockTokens: tokens.slice(blockStart),
  };
}

function renderBlockquote(
  t: Tokens.Blockquote,
  mode: MarkdownMode,
  indentLevel: number,
): string {
  const subTokens = t.tokens ?? [];
  if (subTokens.length === 0) return "";

  const subBlocks: string[] = [];
  for (const sub of subTokens) {
    const rendered = renderBlock(sub, mode, indentLevel);
    const trimmed = stripBlockBoundaryNewlines(rendered);
    if (trimmed.length > 0) subBlocks.push(trimmed);
  }
  if (subBlocks.length === 0) return "";

  const fullText = subBlocks.join("\n");
  if (mode === "strip") return `\n${fullText}\n`;

  // 整段 dim：每行加 dim 包裹，splitAnsiLines 让 SGR 自平衡（不破坏内部 inline ANSI）
  const lines = splitAnsiLines(fullText);
  const styled = lines.map((l) => (l === "" ? l : tone.dim(l))).join("\n");
  return `\n${styled}\n`;
}

function renderHr(mode: MarkdownMode, indentLevel: number): string {
  const indent = lineIndent(indentLevel);
  const rule = "─".repeat(40);
  const styled = mode === "strip" ? rule : tone.dim(rule);
  return `\n${indent}${styled}\n`;
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
