/**
 * ReplLocalView —— cli 接入面的本地派生视图。
 *
 * 核心宿主是会话与 workspace 解析权威;REPL 仍需要少量本地派生状态:
 * 配置显示、网络代理诊断、@file 补全/解析 root。它们随 /config 宿主换代
 * 刷新,集中在这里避免命令层各自捕获旧快照。
 */

import { describeProxy, type ProxyDescription } from "@zhixing/network";
import { loadConfig, type ZhixingConfig } from "@zhixing/providers";
import type { ServerInfoResult } from "./rpc-management-facade.js";

export interface ReplLocalViewManagement {
  serverInfo(): Promise<ServerInfoResult>;
}

export interface ReplLocalViewOptions {
  readonly management: ReplLocalViewManagement;
  readonly loadConfig?: () => ZhixingConfig;
}

export interface ReplLocalViewSnapshot {
  readonly config: ZhixingConfig;
  readonly hostInfo: ServerInfoResult | null;
  readonly workspaceRoot: string | null;
  readonly networkProxy: ProxyDescription;
}

export class ReplLocalView {
  private readonly loadConfig: () => ZhixingConfig;
  private snapshot: ReplLocalViewSnapshot;

  constructor(private readonly opts: ReplLocalViewOptions) {
    this.loadConfig = opts.loadConfig ?? loadConfig;
    this.snapshot = this.buildSnapshot(this.loadConfig(), null);
  }

  get config(): ZhixingConfig {
    return this.snapshot.config;
  }

  get hostInfo(): ServerInfoResult | null {
    return this.snapshot.hostInfo;
  }

  get workspaceRoot(): string | null {
    return this.snapshot.workspaceRoot;
  }

  get networkProxy(): ProxyDescription {
    return this.snapshot.networkProxy;
  }

  async refresh(): Promise<ReplLocalViewSnapshot> {
    const config = this.loadConfig();
    const hostInfo = await this.opts.management.serverInfo().catch(() => null);
    this.snapshot = this.buildSnapshot(config, hostInfo);
    return this.snapshot;
  }

  private buildSnapshot(
    config: ZhixingConfig,
    hostInfo: ServerInfoResult | null,
  ): ReplLocalViewSnapshot {
    return {
      config,
      hostInfo,
      workspaceRoot: hostInfo?.workspace ?? null,
      networkProxy: describeProxy(config.network?.proxy),
    };
  }
}
