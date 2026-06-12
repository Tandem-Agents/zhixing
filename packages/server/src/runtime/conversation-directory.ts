/**
 * ConversationDirectory —— 对话目录抽象:落盘对话的清单 / 改名 / 删除 / 倒读。
 *
 * server 声明接口、装配方注入持久层实现(与 RuntimeFactory / loadHistory 同模式):
 * 目录在哪个 scope、用什么 store 是装配决策,server 不直接触持久层。
 *
 * 与 ConversationManager 的分界:manager 管"活跃会话"(内存窗口 / 串行点 /
 * observer),directory 管"盘上事实"(meta 清单 / 落盘 run 序列)。session.list
 * 以盘上全量为底、叠加活跃态;session.history 倒读落盘事实流,不要求会话活跃。
 */

import type { Conversation, RunRecordWithRef } from "@zhixing/core";

/** 倒读分页游标——指向上一页最后一条 run 的位置,续读其前的内容 */
export interface RunsPageCursor {
  shardId: string;
  runIndex: number;
}

export interface RunsPage {
  /** 倒序(新→旧)的 run 记录 */
  runs: RunRecordWithRef[];
  /** 更早的内容是否还有(续读游标 = 本页末条的 {shardId, runIndex}) */
  hasMore: boolean;
}

export interface ConversationDirectory {
  /** 盘上全量对话清单(未归档),新→旧排序 */
  list(): Promise<Conversation[]>;
  /** 改名;对话不存在返回 null */
  rename(id: string, name: string): Promise<Conversation | null>;
  /** 删除落盘数据(meta + transcript + 派生);不存在返回 false */
  remove(id: string): Promise<boolean>;
  /** 倒读落盘 run 序列(读容错:索引事故自愈,对话不存在产出空页) */
  readRunsReverse(
    id: string,
    opts: { limit: number; before?: RunsPageCursor },
  ): Promise<RunsPage>;
}
