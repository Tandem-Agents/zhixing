/**
 * Markdown 行内（inline）token 的 ANSI 渲染——纯函数：marked inline token → ANSI 字符串。
 *
 * 关注点：仅渲染 paragraph 内的 inline 元素（不处理 block 结构）。block 边界与流式
 * 协调由 markdown-stream 负责，本模块只关心"单个 inline token 应该长什么样"。
 *
 * 覆盖类型（视觉细节见下方 STYLE 常量与设计原则）：
 *   text       —— 字面文字（原样输出）
 *   strong     —— `chalk.bold` 加粗
 *   em         —— `chalk.italic` 斜体（终端常退化为 dim/inverse）
 *   codespan   —— 中灰底 (bgAnsi256(238)) + **默认前景**——最大可读性（路径 /
 *                 命令 / 标识符是用户要 *行动* 的事实引用，前景保默认色让所有终端
 *                 配色都高对比；bg 块给"这是引用不是散文"的视觉锚）
 *   link       —— OSC 8 终端超链接（`osc8Hyperlink`）+ cyan 文字 + 虚线下划线
 *                 (`dottedUnderline`，SGR 4:4) 装饰——link 例外保留 brand cyan，
 *                 行业 universal 链接信号 + 虚线下划线作辨识符
 *   del        —— `chalk.strikethrough` 删除线
 *   br         —— 硬换行
 *
 * 嵌套支持：strong / em / del / link 内可含其它 inline tokens（如
 * `**bold _italic_**`），递归调用 renderInline 处理 children。
 *
 * 三档 mode：
 *   render —— 完整 ANSI 渲染（默认 cli REPL TTY）
 *   strip  —— 不染色 / 不 OSC 8（CI / pipe / 日志）；link 输出 `text (url)` plain
 *   raw    —— 直接返回 token.raw（调试用，不解析）
 */

import chalk from "chalk";
import type { Tokens } from "marked";
import { dottedUnderline, osc8Hyperlink } from "../../tui/ansi.js";
import type { MarkdownMode } from "./types.js";

/**
 * inline 元素的视觉契约——集中在此让"未来调样式"只改一处。
 *
 * 设计原则：
 *
 *   - **codespan**：bgAnsi256(238) ≈ #444444 + **默认前景**（不染 fg）。
 *
 *     用户视角：codespan 内容是路径 / 命令 / 文件名 / 标识符这类"事实引用"
 *     ——用户读它们是 *为了行动*（拷贝、执行、查找）。默认前景在所有终端配色
 *     方案下都保证最高对比 → 最大可读性；中深灰 bg 给"this is content not
 *     prose"的视觉锚，但不喧宾夺主。
 *
 *     设计语言：cli-ui-design-language.md P5 锁定 brand cyan 仅用于 *选中 /
 *     品牌 / 主操作*；codespan 是 *信息内容*（非以上三者），按 tone.dim 注释
 *     原则"路径用 dim 系"——具象到 bg 块 + 默认 fg 而非彩色 fg。
 *
 *     与 historyEcho 区分：historyEcho 用 bgAnsi256(236) #303030（行级、用户
 *     消息锚），codespan 用 bgAnsi256(238) #444444（token 级、内容引用）——
 *     同灰族（视觉同源延伸单一来源）+ 差 0x14（人眼可辨，避免混淆）。
 *
 *     行业基准：GitHub web / glow / bat / Claude Code 等成熟工具均采用 "bg
 *     块 + 默认 fg" 模式——用户预期已建立，无需重新学习。
 *
 *   - **link**：cyan + 虚线下划线（dottedUnderline，SGR 4:4）。设计语言 P5
 *     "主操作" 释义包含 *导航主操作*——链接点击=去某处=主操作语义；同时
 *     cyan + underline 是行业 universal 链接信号，破坏惯例代价 > P5 严格性。
 *     虚线下划线作辅助辨识符让 link 在 codespan（bg 块）/ strong（bold）/
 *     em（italic）之间有独立视觉身份。
 *
 *   - **strong / em / del**：保持终端原生（chalk.bold / italic / strikethrough），
 *     不叠颜色避免污染纯文本视觉重量。
 */
const STYLE = {
  strong: chalk.bold,
  em: chalk.italic,
  codespan: chalk.bgAnsi256(238),
  link: (text: string) => chalk.cyan(dottedUnderline(text)),
  del: chalk.strikethrough,
} as const;

/** marked inline token 联合类型——本模块按 type 字段分发渲染。 */
type InlineToken =
  | Tokens.Text
  | Tokens.Strong
  | Tokens.Em
  | Tokens.Codespan
  | Tokens.Link
  | Tokens.Del
  | Tokens.Br
  | Tokens.Generic;

/**
 * 渲染单个 inline token → ANSI 字符串。
 *
 * 未识别类型 fallback 到 `token.raw`（保留原 markdown 标记字符不丢失内容），
 * 避免 marked 未来引入新 inline 类型时静默丢内容。
 */
export function renderInline(token: InlineToken, mode: MarkdownMode): string {
  if (mode === "raw") return token.raw ?? "";

  switch (token.type) {
    case "text": {
      // text token 是字面文字（GFM 扩展的 autolink 走 link token 而非 text）。
      // 但 marked 在 list_item.tokens 等位置会把 inline 标记嵌在 text.tokens 子
      // 属性里（如 list 内 `**bold**` → text(tokens=[strong, text])）——存在
      // tokens 子属性时递归渲染解锁内层 inline ANSI；否则用 .text 字面字符。
      const textToken = token as Tokens.Text;
      if (textToken.tokens && textToken.tokens.length > 0) {
        return renderInlines(textToken.tokens, mode);
      }
      return textToken.text;
    }

    case "strong": {
      const inner = renderInlines(
        (token as Tokens.Strong).tokens ?? [],
        mode,
      );
      return mode === "strip" ? inner : STYLE.strong(inner);
    }

    case "em": {
      const inner = renderInlines((token as Tokens.Em).tokens ?? [], mode);
      return mode === "strip" ? inner : STYLE.em(inner);
    }

    case "codespan": {
      const text = (token as Tokens.Codespan).text;
      // codespan 内部不递归 inline——按 markdown 语义 backticks 内是字面字符
      return mode === "strip" ? text : STYLE.codespan(text);
    }

    case "link": {
      const link = token as Tokens.Link;
      const inner = renderInlines(link.tokens ?? [], mode);
      if (mode === "strip") {
        // 不支持 OSC 8 时的降级形式：`<text> (<url>)` plain
        return inner === link.href ? link.href : `${inner} (${link.href})`;
      }
      // OSC 8 包 SGR 染色后的 visible text——终端先解析 SGR 给链接文字 cyan +
      // underline 视觉，再 OSC 8 把整段标记为可点击 url（hyper-aware 终端）。
      // 不支持 OSC 8 的终端降级仅显示 inner 染色文本，url 不可点（仍可读）
      return osc8Hyperlink(link.href, STYLE.link(inner));
    }

    case "del": {
      const inner = renderInlines((token as Tokens.Del).tokens ?? [], mode);
      return mode === "strip" ? inner : STYLE.del(inner);
    }

    case "br":
      return "\n";

    default:
      // 未识别类型（image / html / 未来扩展）—— fallback 字面 raw 不丢内容
      return token.raw ?? "";
  }
}

/**
 * 渲染 inline token 数组 → 拼接的 ANSI 字符串——递归入口。
 *
 * 调用方传入 `paragraph.tokens`（marked 解析后的 inline tokens 数组）即可获得
 * 整段 inline ANSI 字符串。strong / em / del / link 内部嵌套时本函数递归处理
 * children。
 */
export function renderInlines(
  tokens: readonly InlineToken[],
  mode: MarkdownMode,
): string {
  let out = "";
  for (const token of tokens) {
    out += renderInline(token, mode);
  }
  return out;
}
