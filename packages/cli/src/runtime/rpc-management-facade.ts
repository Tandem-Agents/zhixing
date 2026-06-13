/**
 * RpcManagementFacade —— cli 管理面方法域的 RPC 门面。
 *
 * 本单元只建立本地派生视图需要的宿主信息读取面；trust / skill / memory /
 * llm 等管理域方法在后续命令域收编单元再接入，避免把能力域混进连接地基。
 */

import type { CoreHostLink } from "./core-host-connection.js";

export interface ServerInfoResult {
  version: string;
  protocol: number;
  pid: number;
  startedAt: string;
  uptimeSec: number;
  activeConversations: number;
  busyConversations: number;
  connectionCount: number;
  memoryRssBytes: number;
  workspace?: string | null;
  logPath?: string;
  [key: string]: unknown;
}

export class RpcManagementFacade {
  constructor(private readonly link: CoreHostLink) {}

  async serverInfo(): Promise<ServerInfoResult> {
    const client = await this.link.getClient();
    return client.request<ServerInfoResult>("server.info");
  }
}
