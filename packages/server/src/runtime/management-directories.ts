/**
 * 管理面目录抽象 —— trust / skill / memory 三个管理域的窄接口。
 *
 * server 声明接口、装配方注入持久层实现(与 ConversationDirectory /
 * WorksceneDirectory 同模式)。三域共性:全局数据(非会话域)、单写者在宿主、
 * 接入面经 RPC 读写(/trust /skills /journal /people 的执行体)。
 */

import type {
  JournalStats,
  ManagedSkillRecord,
  PermissionRule,
  PersonEntry,
  SkillMode,
} from "@zhixing/core";

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

/** 技能库管理 —— /skills 管理器与 slash 补全候选源的执行体 */
export interface SkillDirectory {
  /** 管理视图(含 disabled 全集;builtin 零暴露) */
  list(): Promise<ManagedSkillRecord[]>;
  /** 改技能状态;技能不存在返回 false */
  setState(
    id: string,
    patch: { mode?: SkillMode; pinned?: boolean; disabled?: boolean },
  ): Promise<boolean>;
  /** 归档(可逆删除:目录移至 archived/);不存在返回 false */
  archive(id: string): Promise<boolean>;
  /** 结构版本——变更通知携带,接入面据此刷新补全候选 */
  structuralVersion(): number;
}

/** /journal 展示的扫描投影——统计 + 待办摘要(凝练计划 / 过期数) */
export interface JournalScanView {
  stats: JournalStats;
  /** 待凝练摘要;无计划为 null */
  condense: { months: number; files: number } | null;
  expiredCount: number;
}

/** 记忆域查看 —— /journal 统计与 /people 关系列表的只读执行体 */
export interface MemoryDirectory {
  journalStats(): Promise<JournalScanView>;
  peopleList(): Promise<PersonEntry[]>;
}
