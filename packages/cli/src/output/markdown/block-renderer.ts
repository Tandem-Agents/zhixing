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
import { clampLine, stringWidth, wrapAnsiLine } from "../../tui/line-width.js";
import { layout, tone } from "../../tui/style.js";
import { renderInlines } from "./inline-renderer.js";
import type { MarkdownMode } from "./types.js";

const PREFIX = layout.contentPrefix;
const INDENT_UNIT = "  ";

/**
 * block 渲染上下文——所有 renderXxx 函数共享的环境参数。
 *
 * - `mode`：MarkdownMode（render / strip / raw）
 * - `indentLevel`：嵌套层级（0 = 顶层；list_item / blockquote 子块 +1）
 * - `columns`：终端列宽——区域写入合约要求每段 \n 切分后 ≤ columns - 1，
 *   每个 renderer 据此 wrap 长行
 */
export interface RenderContext {
  readonly mode: MarkdownMode;
  readonly indentLevel: number;
  readonly columns: number;
}

/** 嵌套递归的 ctx 派生——indentLevel +1，其余继承 */
function withDeeperIndent(ctx: RenderContext): RenderContext {
  return { ...ctx, indentLevel: ctx.indentLevel + 1 };
}

/**
 * 给单行 ANSI 染色内容加 indent 前缀 + 软折行到 columns - 1，续行用同 indent 对齐。
 *
 * 适用 indent === continuationIndent 的渲染场景（heading / code / paragraph /
 * formatStreamingCode / 默认 block fallback）。list_item 的 marker 偏移走另一条
 * stateful API 路径，不用此 helper。
 *
 * 行宽合约：返回字符串按 `\n` 切分后每段 ≤ columns - 1。预留 1 列防御边界 case。
 */
function indentAndWrapLine(
  line: string,
  indent: string,
  columns: number,
): string {
  const indentWidth = stringWidth(indent);
  const budget = Math.max(1, columns - 1 - indentWidth);
  const { output } = wrapAnsiLine(line, budget, {
    continuationPrefix: indent,
  });
  return `${indent}${output}`;
}

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
 * 通过 RenderContext 注入 mode / indentLevel / columns。每层嵌套多 2 列起首
 * 缩进 (INDENT_UNIT)，复合 PREFIX 让嵌套 list / blockquote 等子结构视觉对齐。
 *
 * 返回空字符串表示该 block 不渲染（space token / 内容为空）。
 */
export function renderBlock(
  token: Tokens.Generic,
  ctx: RenderContext,
): string {
  if (ctx.mode === "raw") return token.raw ?? "";

  switch (token.type) {
    case "heading":
      return renderHeading(token as Tokens.Heading, ctx);
    case "code":
      return renderCode(token as Tokens.Code, ctx);
    case "list":
      return renderList(token as Tokens.List, ctx);
    case "blockquote":
      return renderBlockquote(token as Tokens.Blockquote, ctx);
    case "hr":
      return renderHr(ctx);
    case "paragraph":
      return renderParagraph(token as Tokens.Paragraph, ctx);
    case "table":
      return renderTable(token as Tokens.Table, ctx);
    case "space":
      // 段落分隔由 caller 控制，此处不重复 emit
      return "";
    default:
      // 未知 block 类型 fallback 到 raw 文本（含末尾换行让段独立）
      return ensureTrailingNewline(
        indentAndWrapLine(
          token.raw ?? "",
          lineIndent(ctx.indentLevel),
          ctx.columns,
        ),
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
 *
 * columns：终端列宽，用于把超宽行软折到 columns - 1（与 renderCode 闭合渲染同
 * 合约）。否则流式期 dim 占位的物理行数与闭合 highlight 后行数会不一致，segment
 * commit 切换时屏幕跳动。
 */
export function formatStreamingCode(codeText: string, columns: number): string {
  if (codeText === "") return "";
  const styled = tone.dim(codeText);
  const lines = splitAnsiLines(styled);
  return `\n${lines.map((l) => indentAndWrapLine(l, PREFIX, columns)).join("\n")}\n`;
}

/** 行起首 indent: PREFIX (列 2) + 嵌套层数 * INDENT_UNIT */
function lineIndent(indentLevel: number): string {
  return PREFIX + INDENT_UNIT.repeat(indentLevel);
}

/** 剥嵌套 renderBlock 输出两端 \n——caller 用于 join 控制 \n 不重复 */
function stripBlockBoundaryNewlines(s: string): string {
  return s.replace(/^\n+/, "").replace(/\n+$/, "");
}

function renderHeading(t: Tokens.Heading, ctx: RenderContext): string {
  const indent = lineIndent(ctx.indentLevel);
  const text = t.text;
  // hash 前缀(行业事实标准,参考 marked-terminal showSectionPrefix 默认行为):
  //   - 保留 markdown 原生 `#` / `##` / `###` 等层级标记,零学习成本
  //   - dim 着色弱化前缀让标题文本主体突出(与 list marker dim 同原则)
  //   - depth ∈ [1,6],生成 "# " ~ "###### "
  //   - strip 模式按字面 hash 输出(供 CI / pipe 场景)
  const rawHash = "#".repeat(t.depth) + " ";
  const hashPrefix = ctx.mode === "strip" ? rawHash : tone.dim(rawHash);
  const styledText =
    ctx.mode === "strip"
      ? text
      : t.depth === 1
      ? tone.brand.bold(text)
      : chalk.bold(text);
  return `\n${indentAndWrapLine(hashPrefix + styledText, indent, ctx.columns)}\n`;
}

function renderCode(t: Tokens.Code, ctx: RenderContext): string {
  const indent = lineIndent(ctx.indentLevel);
  if (ctx.mode === "strip") {
    const lines = t.text.split("\n");
    return `\n${lines.map((l) => indentAndWrapLine(l, indent, ctx.columns)).join("\n")}\n`;
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
  return `\n${lines.map((l) => indentAndWrapLine(l, indent, ctx.columns)).join("\n")}\n`;
}

/**
 * Paragraph 续行 prefix 与首行 prefix 控制。caller 不传时退化为 `lineIndent(ctx.indentLevel)`
 * 单 prefix 模式（list_item 嵌套 paragraph 等场景）；显式传入时 caller 控制首行（含 ◆
 * 锚或 hanging 4 空格）+ 续行（hanging 4 空格与首行同宽对齐），承接 markdown 流式
 * 渲染主路径的视觉契约。
 */
export interface ParagraphPrefix {
  readonly firstLinePrefix: string;
  readonly continuationPrefix: string;
}

/**
 * Paragraph → 多行 ANSI（含起首 / 末尾 \n）。
 *
 * `paragraphPrefix` 缺省 → 走 `lineIndent(ctx.indentLevel)` 单 prefix 路径（用于
 * list_item 内嵌 paragraph 等结构化嵌套场景）；显式传入 → 首行 / 续行分离。
 *
 * `isOpen=true` 表示 paragraph 仍为流式末位 token —— 跳过末位 inline 不渲染，
 * 保留 hold 契约（如 `**bo` 期间末位未闭合 strong inline 不输出字面 `**bo`，
 * 闭合后整段切到 ANSI bold）。inline-renderer 不感知 hold，逻辑内嵌于本函数循环层。
 */
export function renderParagraph(
  t: Tokens.Paragraph,
  ctx: RenderContext,
  paragraphPrefix?: ParagraphPrefix,
  isOpen: boolean = false,
): string {
  const inlineTokens = t.tokens ?? [];
  const renderedTokens = isOpen ? inlineTokens.slice(0, -1) : inlineTokens;
  if (renderedTokens.length === 0) return "";

  const inline = renderInlines(renderedTokens, ctx.mode);
  if (inline === "") return "";

  // inline 可能含 softbreak \n —— splitAnsiLines 让每行 SGR 自平衡，逐行 wrap
  const lines = splitAnsiLines(inline);

  if (paragraphPrefix === undefined) {
    const indent = lineIndent(ctx.indentLevel);
    return `\n${lines.map((l) => indentAndWrapLine(l, indent, ctx.columns)).join("\n")}\n`;
  }

  const continuationWidth = stringWidth(paragraphPrefix.continuationPrefix);
  const budget = Math.max(1, ctx.columns - 1 - continuationWidth);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const prefix =
      i === 0
        ? paragraphPrefix.firstLinePrefix
        : paragraphPrefix.continuationPrefix;
    const { output } = wrapAnsiLine(lines[i]!, budget, {
      continuationPrefix: paragraphPrefix.continuationPrefix,
    });
    out.push(prefix + output);
  }
  return `\n${out.join("\n")}\n`;
}

function renderList(t: Tokens.List, ctx: RenderContext): string {
  const items = t.items ?? [];
  if (items.length === 0) return "";
  const lines: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const marker = t.ordered ? `${(t.start || 1) + i}.` : "·";
    lines.push(renderListItem(items[i]!, marker, ctx));
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
  ctx: RenderContext,
): string {
  const indent = lineIndent(ctx.indentLevel);
  // marker 后单空格 + 续行对齐：marker 占 1+ 字符 + 1 空格——简化为 INDENT_UNIT (2 列)
  const continuationIndent = indent + INDENT_UNIT;
  const styledMarker = ctx.mode === "strip" ? marker : tone.dim(marker);
  const { inlineTokens, blockTokens } = splitListItemTokens(item);

  const out: string[] = [];

  // 首行起手 cursor 在 indent + marker + 空格之后；续行起手在 continuationIndent。
  // wrap budget 按续行基准（最严格）；首行的额外起手偏移用 startColumnWidth 表达
  // —— marker 较短（"·"）时偏移为 0，长 marker（"10."）时偏移为正让首行更早 wrap。
  const continuationWidth = stringWidth(continuationIndent);
  const wrapBudget = Math.max(1, ctx.columns - 1 - continuationWidth);
  const firstLineCursorOffset = Math.max(
    0,
    stringWidth(indent) + stringWidth(marker) + 1 - continuationWidth,
  );

  if (inlineTokens.length > 0) {
    const inlineAnsi = renderInlines(inlineTokens, ctx.mode);
    const inlineLines = splitAnsiLines(inlineAnsi);
    if (inlineLines.length > 0) {
      const first = wrapAnsiLine(inlineLines[0]!, wrapBudget, {
        startColumnWidth: firstLineCursorOffset,
        continuationPrefix: continuationIndent,
      });
      out.push(`${indent}${styledMarker} ${first.output}`);
      for (let i = 1; i < inlineLines.length; i++) {
        const cont = wrapAnsiLine(inlineLines[i]!, wrapBudget, {
          continuationPrefix: continuationIndent,
        });
        out.push(`${continuationIndent}${cont.output}`);
      }
    } else {
      out.push(`${indent}${styledMarker}`);
    }
  } else {
    out.push(`${indent}${styledMarker}`);
  }

  const childCtx = withDeeperIndent(ctx);
  for (const block of blockTokens) {
    const sub = renderBlock(block, childCtx);
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

function renderBlockquote(t: Tokens.Blockquote, ctx: RenderContext): string {
  const subTokens = t.tokens ?? [];
  if (subTokens.length === 0) return "";

  const subBlocks: string[] = [];
  for (const sub of subTokens) {
    const rendered = renderBlock(sub, ctx);
    const trimmed = stripBlockBoundaryNewlines(rendered);
    if (trimmed.length > 0) subBlocks.push(trimmed);
  }
  if (subBlocks.length === 0) return "";

  const fullText = subBlocks.join("\n");
  if (ctx.mode === "strip") return `\n${fullText}\n`;

  // 整段 dim：每行加 dim 包裹，splitAnsiLines 让 SGR 自平衡（不破坏内部 inline ANSI）
  const lines = splitAnsiLines(fullText);
  const styled = lines.map((l) => (l === "" ? l : tone.dim(l))).join("\n");
  return `\n${styled}\n`;
}

// ─── 表格渲染（GFM table，minimal markdown 风格无框线） ───

/** 表格列分隔符——双空格（与 INDENT_UNIT 同），与 list/blockquote 视觉系一致 */
const TABLE_COL_SEPARATOR = "  ";
/**
 * 列压缩下限——极窄终端的兜底硬合约：单列至少 1 字符。
 *
 * 为什么是 1 而不是 3 / 4：行宽合约（每段 ≤ columns - 1）必须严格保住，否则
 * ScrollRegion 滚动数失算。极窄场景（columns=30 + 长列）下若 MIN=3 会让总宽
 * 撑超 budget——选 MIN=1 接受极端 case 下单列截断到 `…`（可读性下降），换取
 * 合约绝对不破。常规终端（80+ 列）+ 典型表格（2-3 列）从不触发下限。
 */
const TABLE_MIN_COL_WIDTH = 1;

type TableAlign = "left" | "right" | "center" | null | undefined;

/**
 * 渲染 GFM table —— minimal markdown 风格（无框线、头部下方 `─` 分隔行、双空格
 * 列分隔），与 list / blockquote 同 indent 系统，不抢 ◆ AI 决策行的主轴。
 *
 * 视觉契约：
 *   ┌ header 行：粗体 cell，按列宽 padding 对齐
 *   ├ 分隔行：每列 `─` × 列宽，整体 dim
 *   └ rows：每行按列宽 + 对齐 padding，cell inline 元素经 renderInlines ANSI 化
 *
 * 列宽算法（保 ScrollRegion 行宽硬合约——每段 \n 切分 ≤ columns - 1）：
 *   1. computeColWidths：每列 max(stringWidth(cell)) 全表
 *   2. compressColWidths：总宽 > budget 时按比例缩放，保 TABLE_MIN_COL_WIDTH 下限
 *   3. padOrTruncateCell：超宽走 clampLine（ANSI-aware truncate + `…`），不足按 align
 *      padding（left/right/center）
 *
 * 流式策略：
 *   表格 hold 等闭合（marked 在 ``\n`` 闭合 + 列宽统一计算后才能正确渲染）。与
 *   heading / blockquote / hr 同模式——markdown-stream emitClosedBlock 的 default
 *   分支天然 cover，不改 stream 流程。
 *
 * 边界：
 *   - 完全空表（无 header 无 rows）→ 返回 ""（renderBlock 输出契约：空字符串不渲染）
 *   - 空 header（header 长度 0 或全空字符串）→ 跳过 header + 分隔行，直接 emit rows
 *   - raw mode：renderBlock 顶部已处理（返 token.raw），不进本函数
 *   - strip mode：保留 layout（列宽 + padding + 分隔行）但 chalk.bold / tone.dim 跳过
 */
function renderTable(t: Tokens.Table, ctx: RenderContext): string {
  const header = t.header ?? [];
  const rows = t.rows ?? [];
  const align = (t.align ?? []) as TableAlign[];

  if (header.length === 0 && rows.length === 0) return "";

  const numCols = Math.max(
    header.length,
    ...rows.map((r) => r.length),
    0,
  );
  if (numCols === 0) return "";

  // 渲染每 cell 为 ANSI 字符串（cell.tokens 含 inline 元素：codespan / strong /
  // em / link 等，经 renderInlines 统一 ANSI 化）
  const headerAnsi = header.map((cell) =>
    renderInlines(cell.tokens ?? [], ctx.mode),
  );
  // header 加粗——与 heading 视觉系一致让"列名 vs 值"语义可视化；strip 模式跳过
  const headerStyled =
    ctx.mode === "render"
      ? headerAnsi.map((cell) => (cell.length > 0 ? chalk.bold(cell) : cell))
      : headerAnsi;

  const rowsAnsi = rows.map((row) =>
    row.map((cell) => renderInlines(cell.tokens ?? [], ctx.mode)),
  );

  // 列宽算法：先取每列 max，再按 budget 压缩
  const allCellsByRow: string[][] = [headerStyled, ...rowsAnsi];
  const rawWidths = computeColWidths(allCellsByRow, numCols);

  const indent = lineIndent(ctx.indentLevel);
  const indentWidth = stringWidth(indent);
  const separatorTotal = TABLE_COL_SEPARATOR.length * Math.max(0, numCols - 1);
  // budget = 终端可用宽度 - indent - 列分隔符总宽（剩下分给 cell 内容）
  const availableCell = ctx.columns - 1 - indentWidth - separatorTotal;
  // 极窄终端容纳不下表格（譬如 columns=15 + 5 列）—— 退化到 default block 同
  // fallback 路径（raw 字面 + wrapAnsiLine），保 ScrollRegion 行宽硬合约严格不破。
  // 现代终端 80+ 列 + 典型 LLM 表格 2-4 列从不触发此分支
  if (availableCell < numCols * TABLE_MIN_COL_WIDTH) {
    return ensureTrailingNewline(
      indentAndWrapLine(t.raw ?? "", indent, ctx.columns),
    );
  }
  const adjustedWidths = compressColWidths(rawWidths, availableCell);

  // 渲染一行：每个 cell 按调整后列宽 padding/truncate + 列分隔符拼接
  const renderRow = (cells: string[]): string => {
    const parts: string[] = [];
    for (let c = 0; c < numCols; c++) {
      const cellText = cells[c] ?? "";
      parts.push(
        padOrTruncateCell(cellText, adjustedWidths[c]!, align[c] ?? null),
      );
    }
    return indent + parts.join(TABLE_COL_SEPARATOR);
  };

  const lines: string[] = [];

  // header 行 + 分隔行（仅当 header 非全空）
  const headerHasContent = headerStyled.some((c) => c.length > 0);
  if (headerHasContent) {
    lines.push(renderRow(headerStyled));
    const sepParts = adjustedWidths.map((w) => "─".repeat(w));
    const sepLine = sepParts.join(TABLE_COL_SEPARATOR);
    const sepStyled = ctx.mode === "render" ? tone.dim(sepLine) : sepLine;
    lines.push(indent + sepStyled);
  }

  // 数据行
  for (const row of rowsAnsi) {
    lines.push(renderRow(row));
  }

  if (lines.length === 0) return "";
  return `\n${lines.join("\n")}\n`;
}

/**
 * 每列宽度 = 该列所有 cell 的 max(stringWidth)。空表 cell 视为 0 宽，但最终
 * 列宽至少 1（避免空列触发 `─`.repeat(0) 渲染异常）。
 */
function computeColWidths(rows: string[][], numCols: number): number[] {
  const widths: number[] = new Array(numCols).fill(0);
  for (const row of rows) {
    for (let c = 0; c < numCols; c++) {
      const cell = row[c] ?? "";
      const w = stringWidth(cell);
      if (w > widths[c]!) widths[c] = w;
    }
  }
  return widths.map((w) => Math.max(1, w));
}

/**
 * 列宽压缩——总宽超 maxTotal 时按各列原宽度比例缩放，下限 TABLE_MIN_COL_WIDTH。
 *
 * 算法：
 *   1. 总宽 ≤ maxTotal：原样返回
 *   2. 否则按 `ratio = maxTotal / total` 比例缩放，每列至少 TABLE_MIN_COL_WIDTH
 *   3. Math.floor 余数累加分配给最长列，让总宽精确 ≤ maxTotal
 */
function compressColWidths(widths: number[], maxTotal: number): number[] {
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= maxTotal) return widths;

  const ratio = maxTotal / total;
  const adjusted = widths.map((w) =>
    Math.max(TABLE_MIN_COL_WIDTH, Math.floor(w * ratio)),
  );

  // 修正 floor 累积误差：剩余 budget 分配给最长列（理论 diff < numCols）。
  // 极窄场景下 MIN=1 + ratio 压缩后 sum ≤ maxTotal 自然成立，无需 diff<0 兜底
  let diff = maxTotal - adjusted.reduce((a, b) => a + b, 0);
  if (diff <= 0) return adjusted;

  // 多次循环分配（每轮把 1 字符给当前最长列），稳定且终止
  let guard = diff + widths.length; // 防御无限循环
  while (diff > 0 && guard-- > 0) {
    let maxIdx = 0;
    for (let i = 1; i < adjusted.length; i++) {
      if (adjusted[i]! > adjusted[maxIdx]!) maxIdx = i;
    }
    adjusted[maxIdx]!++;
    diff--;
  }
  return adjusted;
}

/**
 * 按列宽 padding 或 truncate 一个 cell——保证返回的可见宽度恰好 = width。
 *
 *   - 宽 < width：按 align padding 空格（left/null → 右补 / right → 左补 /
 *     center → 左右平均，左侧少一格让奇数余宽偏右）
 *   - 宽 = width：原样
 *   - 宽 > width：clampLine 复用 ANSI-aware truncate（添 `…` + reset），然后补
 *     空格让总宽 == width（clampLine 可能因末 reset 字符串实际可见宽 < width-1，
 *     此处补齐保 align 合约）
 */
function padOrTruncateCell(
  text: string,
  width: number,
  align: TableAlign,
): string {
  const cellWidth = stringWidth(text);

  if (cellWidth > width) {
    // clampLine 添加 `…` + `\x1b[0m`，但返回视觉宽度可能略小于 width（因末字符
    // 边界）—— 用 stringWidth 重新算并补尾空格让宽度精确
    const truncated = clampLine(text, width);
    const truncatedWidth = stringWidth(truncated);
    const fillPad = Math.max(0, width - truncatedWidth);
    // truncate 默认 left 对齐（保首字符可读）；align 右/居中时尾空格放右侧 OK
    return truncated + " ".repeat(fillPad);
  }

  if (cellWidth === width) return text;

  // cellWidth < width
  const pad = width - cellWidth;
  if (align === "right") return " ".repeat(pad) + text;
  if (align === "center") {
    const leftPad = Math.floor(pad / 2);
    const rightPad = pad - leftPad;
    return " ".repeat(leftPad) + text + " ".repeat(rightPad);
  }
  // left / null （默认）
  return text + " ".repeat(pad);
}

function renderHr(ctx: RenderContext): string {
  const indent = lineIndent(ctx.indentLevel);
  // 长度: 填满 columns - 1 - indent (避免触发隐式 wrap), 不再限 40 字符 ——
  // hr 是内容间的视觉边界, 应占满可用宽度
  const indentWidth = stringWidth(indent);
  const ruleLength = Math.max(1, ctx.columns - 1 - indentWidth);
  // 字符: ╌ (U+254C LIGHT DOUBLE DASH HORIZONTAL) 虚线横线 —— 内容间用虚线
  // 而非实线 ─, 视觉是"分隔但不强分割";与 thinking 段 ┊ (LIGHT QUADRUPLE
  // DASH VERTICAL) 同 box drawing dash family。
  const rule = "╌".repeat(ruleLength);
  const styled = ctx.mode === "strip" ? rule : tone.dim(rule);
  return `\n${indent}${styled}\n`;
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
