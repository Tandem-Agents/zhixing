/**
 * 基础配置编辑器主入口。
 *
 * 与首次配置 / 服务模式启动 / 未来 REPL slash 命令解耦——caller 按需求传 sections + title。
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
  ConfigEditorWriters,
  KeyEvent,
  PanelDescriptor,
  Section,
  SectionEntry,
  SectionId,
  WorkingState,
} from "./types.js";

// ─── 检测函数再导出（caller 用来决定 sections） ───
export { checkBootModel, type BootModelMissing } from "./checks/model.js";
export { checkBootMessaging, type BootMessagingMissing } from "./checks/messaging.js";
