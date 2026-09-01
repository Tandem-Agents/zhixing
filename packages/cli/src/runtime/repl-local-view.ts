/**
 * ReplLocalView —— cli 接入面的本地派生视图。
 *
 * 核心宿主是会话与 workspace 解析权威;REPL 仍需要少量本地派生状态:
 * 配置显示、网络代理诊断、@file 补全/解析 root。它们随 /config 宿主换代
 * 刷新,集中在这里避免命令层各自捕获旧快照。
 */

import type { ServerInfoResult } from "./rpc-management-facade.js";
import {
  createRuntimeConfigurationProvider,
  type ReplRuntimeConfigurationProjection,
  type RuntimeConfigurationProvider,
  type RuntimeNetworkProxyDisplayProjection,
  type RuntimePrimaryModelDisplayProjection,
} from "./runtime-configuration-provider.js";

export interface ReplLocalViewManagement {
  serverInfo(): Promise<ServerInfoResult>;
}

export interface ReplLocalViewOptions {
  readonly management: ReplLocalViewManagement;
  readonly configuration?: Pick<RuntimeConfigurationProvider, "readReplSurface">;
}

export interface ReplLocalViewSnapshot {
  readonly primaryModel: RuntimePrimaryModelDisplayProjection;
  readonly hostInfo: ServerInfoResult | null;
  readonly workspaceRoot: string | null;
  readonly networkProxy: RuntimeNetworkProxyDisplayProjection;
}

export class ReplLocalView {
  private readonly configuration: Pick<
    RuntimeConfigurationProvider,
    "readReplSurface"
  >;
  private snapshot: ReplLocalViewSnapshot;

  constructor(private readonly opts: ReplLocalViewOptions) {
    this.configuration =
      opts.configuration ?? createRuntimeConfigurationProvider();
    this.snapshot = this.buildSnapshot(
      this.configuration.readReplSurface(),
      null,
    );
  }

  get primaryModel(): RuntimePrimaryModelDisplayProjection {
    return this.snapshot.primaryModel;
  }

  get hostInfo(): ServerInfoResult | null {
    return this.snapshot.hostInfo;
  }

  get workspaceRoot(): string | null {
    return this.snapshot.workspaceRoot;
  }

  get networkProxy(): RuntimeNetworkProxyDisplayProjection {
    return this.snapshot.networkProxy;
  }

  async refresh(): Promise<ReplLocalViewSnapshot> {
    const configuration = this.configuration.readReplSurface();
    const hostInfo = await this.opts.management.serverInfo().catch(() => null);
    this.snapshot = this.buildSnapshot(configuration, hostInfo);
    return this.snapshot;
  }

  private buildSnapshot(
    configuration: ReplRuntimeConfigurationProjection,
    hostInfo: ServerInfoResult | null,
  ): ReplLocalViewSnapshot {
    return Object.freeze({
      primaryModel: configuration.primaryModel,
      hostInfo,
      workspaceRoot: hostInfo?.workspace ?? null,
      networkProxy: configuration.networkProxy,
    });
  }
}
