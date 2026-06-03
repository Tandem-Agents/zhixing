/**
 * /trust 命令的 target 无关核心查询 —— "用户可管的信任规则"的单一定义。
 *
 * builtin 系统防护规则不归用户管（归 /security 查看），此处过滤。各 target 的 /trust
 * 前端（cli 命令行文本 / cli typeahead 面板 / 未来渠道卡片）都从这里取数据，避免"什么算
 * 用户规则"的判定散落多处而漂移。撤销直接走 `IPermissionStore.revoke`，本就是 core 能力。
 */

import type { SecurityPipeline } from "./security-pipeline.js";
import type { PermissionRule } from "./types.js";

/**
 * 列出当前上下文里用户可管的信任规则（排除 builtin 系统规则），保持 store 顺序。
 */
export function listUserTrustRules(pipeline: SecurityPipeline): PermissionRule[] {
  const store = pipeline.getPermissionStore();
  const contextId = pipeline.getContextId();
  return store.list(contextId).filter((rule) => rule.scope !== "builtin");
}
