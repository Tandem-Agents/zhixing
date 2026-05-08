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
 *   - code block：fenced 带受支持 lang 走 cli-highlight 语法高亮；无 lang / 不支持
 *     lang / strip 模式走 dim 退化——起首空行 + 列 2 缩进 + 无装饰字符（便于复制）。
 *     跨行 SGR token（如 Python `"""docstring"""` 多行字符串）经 splitAnsiLines
 *     处理让每行 SGR 自平衡，避免续行 PREFIX 被染色或 SGR 泄露后续段
 *   - list：无序用 `·` 中点（CJK 友好，比 `•` 克制）；有序保留数字
 *   - blockquote：dim 文字
 *   - hr：dim 横线 `─` + 起首空行
 *
 * 输出契约：
 *   返回字符串末尾保证以 \n 结尾（独立段语义）。"前后空行"中的"前空行"由起首
 *   的 `\n` 提供——caller 经 cliWriter.line 写入时与 ScreenController 的 inMidLine
 *   补 \n 协同形成视觉空行；"后空行"由下一段的起首 `\n` 提供。不重复加末尾 \n\n——
 *   ScreenController 的 tailBuffer 模型对每个 \n 会增加一行。
 */

import chalk from "chalk";
import { highlight, supportsLanguage, type Theme } from "cli-highlight";
import type { Tokens } from "marked";
import { splitAnsiLines } from "../../tui/ansi.js";
import { layout, tone } from "../../tui/style.js";
import type { MarkdownMode } from "./types.js";

const PREFIX = layout.contentPrefix;

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

/**
 * 流式期 code block 的 dim 格式化——双态渲染流式期占位用：整段 dim + 列 2
 * PREFIX + 起首 \n + 末尾 \n（与 renderCode 闭合 highlight 输出格式对齐，commit
 * 切换时行数 / 列对齐稳定）。
 *
 * 仅 render 模式调用——strip / raw 模式走 hold 路径不进入双态。
 */
export function formatStreamingCode(codeText: string): string {
  if (codeText === "") return "";
  const styled = tone.dim(codeText);
  const lines = splitAnsiLines(styled);
  return `\n${lines.map((l) => `${PREFIX}${l}`).join("\n")}\n`;
}

function renderHeading(t: Tokens.Heading, mode: MarkdownMode): string {
  const text = t.text;
  if (mode === "strip") return `\n${PREFIX}${text}\n`;
  const styled = t.depth === 1 ? tone.brand.bold(text) : chalk.bold(text);
  return `\n${PREFIX}${styled}\n`;
}

function renderCode(t: Tokens.Code, mode: MarkdownMode): string {
  if (mode === "strip") {
    const lines = t.text.split("\n");
    return `\n${lines.map((l) => `${PREFIX}${l}`).join("\n")}\n`;
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
  // 否则续行 PREFIX 会继承上行未关闭 SGR + 下一段被染色泄露
  const lines = splitAnsiLines(styled);
  return `\n${lines.map((l) => `${PREFIX}${l}`).join("\n")}\n`;
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
