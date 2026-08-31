/**
 * WorksceneDirectory —— enter/exit 尚未迁移的最窄场景会话桥。
 *
 * server 声明接口、装配方注入持久层实现。
 * 宿主侧没有场景状态机:enter 是原子查询 / 创建(取场景最近对话,无则建),
 * "进入"的全部效果由返回的全域键(`ws:<sceneId>:<convId>`)在后续 send 时
 * 纯函数派生(power 装配 / per-scope 持久化路由)。
 */

import type { WorksceneDto } from "@zhixing/core/contracts";

export interface WorksceneDirectoryEnterResult {
  conversationId: string;
  scene: WorksceneDto;
}

export interface WorksceneDirectory {
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
      workspaceBindingRevision: number;
      workspaceName: string;
    }[]
  >;
}
