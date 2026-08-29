/**
 * 管理面目录抽象 —— Server 仍需适配的 trust 管理窄接口。
 *
 * 装配方注入持久层实现(与 ConversationDirectory / WorksceneDirectory 同模式)。
 * Skill Catalog 的 Query/Command/Fact 合同由 Skill 领域拥有，不再由 Server
 * 声明平行目录接口。
 */

import type { PermissionRule } from "@zhixing/core";

/**
 * 信任规则管理 —— 按对话语境列 / 撤用户可管规则(/trust 的上下文相关视角:
 * 场景对话见该场景上下文规则,main 对话见 workspace / main 上下文规则,
 * global 规则两者都见;builtin 系统规则不在列)。
 *
 * 语境由 conversationId 派生(全域键编码归属),缺省为 main 对话语境。
 *
 * 边界(结构性):session 作用域授权活在各 per-conversation 实例内存、不落盘,
 * 管理面不可见——其生命周期即会话,随实例释放消逝。持久规则的变更对已载入
 * 副本的活跃实例最终一致(随实例换代刷新)。
 */
export interface TrustDirectory {
  list(conversationId?: string): Promise<PermissionRule[]>;
  /** 撤销语境内可见的一条规则;不存在返回 false */
  revoke(ruleId: string, conversationId?: string): Promise<boolean>;
}
