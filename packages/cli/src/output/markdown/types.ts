/**
 * Markdown 渲染层共享类型。
 *
 * 三档模式（render / strip / raw）由 caller 在创建 MarkdownStream 时决定，
 * 让同一渲染层既能服务 cli REPL（render），也能服务 CI / pipe（strip 不染色）和
 * 调试场景（raw 输出原始 markdown 标记）。
 */

export type MarkdownMode = "render" | "strip" | "raw";
