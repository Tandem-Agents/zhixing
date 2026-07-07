/**
 * WorksceneDirectory —— 工作场景域抽象:注册表管理 + 场景对话的取 / 建。
 *
 * server 声明接口、装配方注入持久层实现(与 ConversationDirectory 同模式)。
 * 宿主侧没有场景状态机:enter 是原子查询 / 创建(取场景最近对话,无则建),
 * "进入"的全部效果由返回的全域键(`ws:<sceneId>:<convId>`)在后续 send 时
 * 纯函数派生(power 装配 / per-scope 持久化路由)。
 */

import type { WorkScene } from "@zhixing/core";

export class WorksceneInputError extends Error {
  readonly code = "WORKSCENE_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "WorksceneInputError";
  }
}

export interface WorksceneWriteResult {
  scene: WorkScene;
  workdirWarning?: string;
}

export interface WorksceneDirectoryEnterResult {
  conversationId: string;
  scene: WorkScene;
}

export interface WorksceneDirectory {
  list(): Promise<WorkScene[]>;
  get(id: string): Promise<WorkScene | null>;
  create(opts: { name: string; workdir?: string }): Promise<WorksceneWriteResult>;
  /** 改名;场景不存在返回 null */
  rename(id: string, name: string): Promise<WorkScene | null>;
  /** 绑定 / 更换 / 解绑工作目录;场景不存在返回 null */
  setWorkdir(
    id: string,
    workdir: string | null,
  ): Promise<WorksceneWriteResult | null>;
  /**
   * 彻底移除场景(登记 + 场景系统目录:meta / 记忆域 / 会话域)。
   * 用户代码工作目录(workdir)不动。不存在返回 false。
   */
  remove(id: string): Promise<boolean>;
  /** 刷新场景 lastActiveAt(enter / exit 时调) */
  touch(id: string): Promise<void>;
  /**
   * enter 的完整执行体:取场景最近对话(无则创建)、注册 observer、
   * 按需刷新 lastActiveAt,返回全域键(`ws:<sceneId>:<convId>`)。
   * 场景不存在返回 null。
   */
  enterScene(
    sceneId: string,
    observerId: string,
    opts?: { touch?: boolean },
  ): Promise<WorksceneDirectoryEnterResult | null>;
}
