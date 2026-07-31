/**
 * WorksceneDirectory —— 工作场景域抽象:注册表管理 + 场景对话的取 / 建。
 *
 * server 声明接口、装配方注入持久层实现(与 ConversationDirectory 同模式)。
 * 宿主侧没有场景状态机:enter 是原子查询 / 创建(取场景最近对话,无则建),
 * "进入"的全部效果由返回的全域键(`ws:<sceneId>:<convId>`)在后续 send 时
 * 纯函数派生(power 装配 / per-scope 持久化路由)。
 */

import type { WorksceneDto } from "@zhixing/core/contracts";

export class WorksceneInputError extends Error {
  readonly code = "WORKSCENE_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "WorksceneInputError";
  }
}

export interface WorksceneWriteResult {
  scene: WorksceneDto;
  workspaceWarning?: string;
}

export interface WorksceneDirectoryEnterResult {
  conversationId: string;
  scene: WorksceneDto;
}

export interface WorksceneDirectory {
  /** Resume host-owned deletion obligations before serving mutations. */
  recover(): Promise<void>;
  list(): Promise<WorksceneDto[]>;
  get(id: string): Promise<WorksceneDto | null>;
  create(
    opts: {
      name: string;
      workspace?: { deviceId: string; bindingRef: string };
      requestId: string;
    },
  ): Promise<WorksceneWriteResult>;
  /** 改名;场景不存在返回 null */
  rename(
    id: string,
    name: string,
    requestId: string,
  ): Promise<WorksceneDto | null>;
  /** 绑定 / 更换 / 解绑工作目录;场景不存在返回 null */
  setWorkdir(
    id: string,
    workspace: { deviceId: string; bindingRef: string } | null,
    requestId: string,
  ): Promise<WorksceneWriteResult | null>;
  /**
   * 彻底移除场景(登记 + 场景系统目录:meta / 记忆域 / 会话域)。
   * 用户代码工作目录(workdir)不动。不存在返回 false。
   */
  remove(id: string, requestId: string): Promise<boolean>;
  /** 更新会话 owner 的 SessionMeta 活动事实，并刷新可重建读投影。 */
  recordActivity(
    sceneId: string,
    conversationId: string,
    at: string,
    requestId?: string,
  ): Promise<void>;
  /**
   * enter 的完整执行体:取场景最近对话(无则创建)、注册 observer、
   * 按需刷新 lastActiveAt,返回全域键(`ws:<sceneId>:<convId>`)。
   * 场景不存在返回 null。
   */
  enterScene(
    sceneId: string,
    observerId: string,
    opts?: { recordActivity?: boolean; requestId?: string },
  ): Promise<WorksceneDirectoryEnterResult | null>;
  /** 释放接入面 observer，并由同一会话 owner 提交退出活动事实。 */
  exitScene(
    sceneId: string,
    conversationId: string,
    observerId: string,
    requestId: string,
  ): Promise<void>;
  workspaceCatalog?(): Promise<
    readonly {
      deviceId: string;
      deviceName: string;
      bindingRef: string;
      workspaceName: string;
    }[]
  >;
}
