/**
 * ReplLocalView —— cli 接入面的本地派生视图。
 *
 * 核心宿主是会话与 workspace 解析权威;REPL 仍需要少量本地派生状态:
 * 配置显示、网络代理诊断、@file 补全/解析 root。它们随 /config 宿主换代
 * 刷新,集中在这里避免命令层各自捕获旧快照。
 */

import type { SessionModelSelection } from "@zhixing-ai/core";
import type { ServerDescriptionResult } from "./rpc-management-facade.js";
import {
  type EffectiveModelSurfaceProjectionOptions,
  type ReplRuntimeConfigurationProjection,
  type RuntimeConfigurationProvider,
  type RuntimeNetworkProxyDisplayProjection,
  type RuntimePrimaryModelDisplayProjection,
} from "./runtime-configuration-provider.js";

export interface ReplLocalViewManagement {
  serverDescription(): Promise<ServerDescriptionResult>;
}

export interface ReplLocalViewOptions {
  readonly management: ReplLocalViewManagement;
  readonly configuration: Pick<
    RuntimeConfigurationProvider,
    "readReplSurface" | "projectEffectiveModel"
  >;
  readonly currentSceneId?: () => string | undefined;
  readonly currentConversationId?: () => string | undefined;
  readonly currentSessionMode?: () => "normal" | "workscene";
  readonly resolveSessionModelSelection?: (
    conversationId: string,
  ) => Promise<SessionModelSelection | undefined>;
  readonly readModelCredentials?: () => Promise<
    EffectiveModelSurfaceProjectionOptions["credentials"] | undefined
  >;
  readonly modelCatalog?: () => EffectiveModelSurfaceProjectionOptions["catalog"] | undefined;
  readonly resolveModelCatalog?: () => Promise<
    EffectiveModelSurfaceProjectionOptions["catalog"] | undefined
  >;
  readonly resolveSceneWorkspace?: (sceneId: string) => Promise<{ root: string | null; label: string }>;
}

export interface ReplLocalViewSnapshot {
  readonly primaryModel: RuntimePrimaryModelDisplayProjection;
  readonly hostInfo: ServerDescriptionResult | null;
  readonly workspaceRoot: string | null;
  readonly workspaceLabel?: string;
  readonly networkProxy: RuntimeNetworkProxyDisplayProjection;
}

export class ReplLocalView {
  private readonly configuration: Pick<
    RuntimeConfigurationProvider,
    "readReplSurface" | "projectEffectiveModel"
  >;
  private snapshot: ReplLocalViewSnapshot;
  private sceneId: string | undefined;
  private generation = 0;

  constructor(private readonly opts: ReplLocalViewOptions) {
    this.configuration = opts.configuration;
    this.snapshot = this.buildSnapshot(
      this.configuration.readReplSurface(),
      null,
      this.projectModelSync(),
    );
  }

  get primaryModel(): RuntimePrimaryModelDisplayProjection {
    return this.snapshot.primaryModel;
  }

  get hostInfo(): ServerDescriptionResult | null {
    return this.snapshot.hostInfo;
  }

  get workspaceRoot(): string | null {
    if (this.opts.currentSceneId?.() !== this.sceneId) return null;
    return this.snapshot.workspaceRoot;
  }
  get workspaceLabel(): string | undefined {
    if (this.opts.currentSceneId?.() !== this.sceneId) return '正在读取工作目录…';
    return this.snapshot.workspaceLabel;
  }

  get networkProxy(): RuntimeNetworkProxyDisplayProjection {
    return this.snapshot.networkProxy;
  }

  async refresh(): Promise<ReplLocalViewSnapshot> {
    const generation = ++this.generation;
    const sceneId = this.opts.currentSceneId?.();
    const conversationId = this.opts.currentConversationId?.();
    const sessionMode = this.opts.currentSessionMode?.() ?? (sceneId ? "workscene" : "normal");
    const configuration = this.configuration.readReplSurface();
    const [hostInfo, workspace, sessionSelection, credentials, resolvedCatalog] = await Promise.all([
      this.opts.management.serverDescription().catch(() => null),
      sceneId ? this.opts.resolveSceneWorkspace?.(sceneId).catch(() => ({ root: null, label: '工作目录暂不可用' })) : undefined,
      conversationId && this.opts.resolveSessionModelSelection
        ? this.opts.resolveSessionModelSelection(conversationId).catch(() => undefined)
        : undefined,
      this.opts.readModelCredentials
        ? this.opts.readModelCredentials().catch(() => undefined)
        : undefined,
      this.opts.resolveModelCatalog
        ? this.opts.resolveModelCatalog().catch(() => undefined)
        : undefined,
    ]);
    if (
      generation !== this.generation ||
      sceneId !== this.opts.currentSceneId?.() ||
      conversationId !== this.opts.currentConversationId?.()
    ) {
      return this.snapshot;
    }
    this.sceneId = sceneId;
    const projectedModel = this.configuration.projectEffectiveModel?.({
      credentials,
      sessionMode,
      sessionSelection,
      catalog: resolvedCatalog ?? this.opts.modelCatalog?.(),
    });
    this.snapshot = Object.freeze({
      ...this.buildSnapshot(configuration, hostInfo, projectedModel),
      ...(sceneId ? { workspaceRoot: workspace?.root ?? null, workspaceLabel: workspace?.label ?? '未设置工作目录' } : {}),
    });
    return this.snapshot;
  }

  private projectModelSync(): RuntimePrimaryModelDisplayProjection | undefined {
    if (!this.configuration.projectEffectiveModel) return undefined;
    const sceneId = this.opts.currentSceneId?.();
    const sessionMode = this.opts.currentSessionMode?.() ?? (sceneId ? "workscene" : "normal");
    return this.configuration.projectEffectiveModel({
      sessionMode,
      catalog: this.opts.modelCatalog?.(),
    });
  }

  private buildSnapshot(
    configuration: ReplRuntimeConfigurationProjection,
    hostInfo: ServerDescriptionResult | null,
    projectedModel?: RuntimePrimaryModelDisplayProjection,
  ): ReplLocalViewSnapshot {
    return Object.freeze({
      primaryModel: projectedModel ?? configuration.primaryModel,
      hostInfo,
      workspaceRoot: hostInfo?.workspace ?? null,
      networkProxy: configuration.networkProxy,
    });
  }
}
