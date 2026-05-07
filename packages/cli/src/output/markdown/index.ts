/**
 * Markdown 渲染层——LLM 流式 chunk → ANSI 输出协调。
 *
 * 仅导出主入口 MarkdownStream + 模式枚举，内部 block-renderer / inline-renderer
 * 不对外暴露（封装实现细节，未来重构 token diff 算法 / 渲染策略不破坏调用方）。
 */

export { MarkdownStream, type MarkdownStreamOptions } from "./markdown-stream.js";
export type { MarkdownMode } from "./types.js";
