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
  /** 对话身份是否存在(meta 层存在即为真,不激活运行体、不写最近活跃时刻) */
  exists(id: string): Promise<boolean>;
  /** 建一个 user 域新对话(meta + transcript 壳),返回完整 meta */
  create(): Promise<Conversation>;
  /** 改名;对话不存在返回 null */
  rename(id: string, name: string): Promise<Conversation | null>;
  /** 更新最近活跃时刻(切换到该对话即"使用"),返回更新后 meta;不存在 null */
  touch(id: string): Promise<Conversation | null>;
  /**
   * 清空对话的盘上事实——transcript 追加 clear 事件(倒读遇之即止,旧原文
   * 物理仍在、由时间窗清理收走)+ meta 视图层状态清理(task_list / 段切换
   * 历史;身份字段保留)。不存在返回 false。
   */
  clear(id: string): Promise<boolean>;
  /** 删除落盘数据(meta + transcript + 派生);不存在返回 false */
  remove(id: string): Promise<boolean>;
  /** 倒读落盘 run 序列(读容错:索引事故自愈,对话不存在产出空页) */
  readRunsReverse(
    id: string,
    opts: { limit: number; before?: RunsPageCursor },
  ): Promise<RunsPage>;
}
