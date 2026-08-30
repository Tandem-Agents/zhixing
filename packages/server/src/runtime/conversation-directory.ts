/**
 * ConversationDirectory —— 尚未迁移的对话生命周期持久端口。
 *
 * server 声明接口、装配方注入持久层实现(与 RuntimeFactory / loadHistory 同模式):
 * 目录在哪个 scope、用什么 store 是装配决策,server 不直接触持久层。
 *
 * 与 ConversationManager 的分界:manager 管"活跃会话"(内存窗口 / 串行点 /
 * observer),directory 管"盘上事实"(meta 清单 / 落盘 run 序列)。session.list
 * 以盘上全量为底、叠加活跃态;session.history 倒读落盘事实流,不要求会话活跃。
 */

import type { Conversation } from "@zhixing/core";

export interface ConversationDirectory {
  /** 对话身份是否存在(meta 层存在即为真,不激活运行体、不写最近活跃时刻) */
  exists(id: string): Promise<boolean>;
  /** 确保指定 conversationId 已有 meta + transcript 壳,已存在则幂等返回 meta */
  ensure(id: string): Promise<Conversation>;
  /**
   * 只初始化 transcript 壳。场景会话的身份与活动归会话 owner，
   * 不得为兼容目录另写一份可变 meta 事实。
   */
  ensureTranscript(id: string): Promise<void>;
  /** 更新最近活跃时刻(切换到该对话即"使用"),返回更新后 meta;不存在 null */
  touch(id: string, at?: string): Promise<Conversation | null>;
  /** 删除落盘数据(meta + transcript + 派生);不存在返回 false */
  remove(id: string): Promise<boolean>;
}
