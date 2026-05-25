/**
 * 基础配置编辑器主入口。
 *
 * 与初始配置 / 服务模式启动 / REPL `/config` 命令解耦——caller 按需求传 sections + title。
 *
 * 完成时执行事务性写盘（writeConfig + writeCredentials），保证两文件不会半致状态。
 * 取消 / Ctrl+C 时不写盘，所有改动丢弃。
 */

import type {
  ConfigEditorContext,
  ConfigEditorResult,
} from "./types.js";
import { runEventLoop } from "./runner.js";

export async function runConfigEditor(
  ctx: ConfigEditorContext,
): Promise<ConfigEditorResult> {
  const result = await runEventLoop(ctx);

  if (result.kind === "completed") {
    await ctx.writers.writeConfig(result.config);
    await ctx.writers.writeCredentials(result.credentials);
  }

  return result;
}

// ─── 类型再导出 ───
export type {
  ConfigEditorContext,
  ConfigEditorResult,
  ConfigEditorRuntime,
  ConfigEditorWriters,
  EntryState,
  KeyEvent,
  ModelRole,
  PanelDescriptor,
  Section,
  SectionEntry,
  SectionId,
  Status,
  StatusLevel,
  WorkingState,
} from "./types.js";

// ─── 派生器再导出（外部如需复用派生逻辑） ───
export { deriveEntryIssues, deriveEntryStatus } from "./entry.js";

// ─── 检测函数再导出——单一规则源，sections + startup 共用 ───
export { checkModel, type ModelIssue } from "./checks/model.js";
export { checkMessaging, type MessagingIssue } from "./checks/messaging.js";

// ─── Section 注册再导出（caller 用来"打开全部 sections"等场景） ───
export { ALL_SECTION_IDS, BASE_CONFIG_SECTION_IDS } from "./sections/index.js";

// ─── MCP 接入引导再导出——caller（/mcp 命令）据此把查源 + LLM 绑成 mcpResolve 注入 ───
export {
  resolveMcpSetup,
  extractMcpCandidate,
  type McpSetupLlm,
  type McpSourceFetcher,
  type McpResolveDeps,
  type McpResolveResult,
} from "./mcp-setup.js";
