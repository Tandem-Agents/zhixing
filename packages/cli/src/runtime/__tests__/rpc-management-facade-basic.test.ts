import { describe, expect, it } from "vitest";
import { RpcManagementFacade } from "../rpc-management-facade.js";
import { makeFakeHostLink } from "./fake-host-link.js";

describe("RpcManagementFacade · 基础宿主信息面", () => {
  it("serverInfo 映射到 server.info 并原样返回宿主状态", async () => {
    const fake = makeFakeHostLink();
    const info = {
      version: "0.1.0",
      protocol: 1,
      pid: 123,
      startedAt: "2026-01-01T00:00:00.000Z",
      uptimeSec: 9,
      activeConversations: 2,
      busyConversations: 1,
      connectionCount: 3,
      memoryRssBytes: 4096,
      workspace: "/workspace",
      logPath: "/logs/zhixing.log",
    };
    fake.setResponder(() => info);
    const facade = new RpcManagementFacade(fake.link);

    await expect(facade.serverInfo()).resolves.toEqual(info);
    expect(fake.requests).toEqual([{ method: "server.info", params: undefined }]);
  });

  it("serverInfoIfConnected 有连接时查询 server.info", async () => {
    const fake = makeFakeHostLink();
    const info = {
      version: "0.1.0",
      protocol: 1,
      pid: 123,
      startedAt: "2026-01-01T00:00:00.000Z",
      uptimeSec: 9,
      activeConversations: 0,
      busyConversations: 0,
      connectionCount: 1,
      memoryRssBytes: 4096,
    };
    fake.setResponder(() => info);
    const facade = new RpcManagementFacade(fake.link);

    await expect(facade.serverInfoIfConnected()).resolves.toEqual(info);
    expect(fake.requests).toEqual([{ method: "server.info", params: undefined }]);
  });

  it("serverInfoIfConnected 无连接时不拉起宿主", async () => {
    const fake = makeFakeHostLink({ connected: false });
    const facade = new RpcManagementFacade(fake.link);

    await expect(facade.serverInfoIfConnected()).resolves.toBeNull();
    expect(fake.requests).toEqual([]);
  });
});
