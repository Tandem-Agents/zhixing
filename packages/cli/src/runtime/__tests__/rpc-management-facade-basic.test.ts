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

  it("值班设备迁移只使用四个 canonical 管理方法", async () => {
    const fake = makeFakeHostLink();
    fake.setResponder((method) => {
      if (method === "dutyMigration.targets") {
        return {
          devices: [{ deviceId: "device-ready", displayName: "客厅主机", ready: true }],
        };
      }
      if (method === "dutyMigration.prepare") return { stage: "ready" };
      if (method === "dutyMigration.commit") return { stage: "completed" };
      if (method === "dutyMigration.cancel") return { stage: "cancelled" };
      throw new Error(`unexpected method: ${method}`);
    });
    const facade = new RpcManagementFacade(fake.link);
    const identity = { requestId: "request:duty-1", transferId: "duty-1" };

    await expect(facade.dutyMigrationTargets()).resolves.toEqual([
      { deviceId: "device-ready", displayName: "客厅主机", ready: true },
    ]);
    await expect(facade.dutyMigrationPrepare({
      ...identity,
      targetDeviceId: "device-ready",
    })).resolves.toEqual({ stage: "ready" });
    await expect(facade.dutyMigrationCommit(identity)).resolves.toEqual({
      stage: "completed",
    });
    await expect(facade.dutyMigrationCancel(identity)).resolves.toEqual({
      stage: "cancelled",
    });
    expect(fake.requests).toEqual([
      { method: "dutyMigration.targets", params: undefined },
      {
        method: "dutyMigration.prepare",
        params: { ...identity, targetDeviceId: "device-ready" },
      },
      { method: "dutyMigration.commit", params: identity },
      { method: "dutyMigration.cancel", params: identity },
    ]);
  });

  it("严格拒绝目标列表中的内部或未知字段", async () => {
    const fake = makeFakeHostLink();
    fake.setResponder((method) => {
      if (method !== "dutyMigration.targets") throw new Error(`unexpected method: ${method}`);
      return {
        devices: [{
          deviceId: "device-ready",
          displayName: "客厅主机",
          ready: true,
          issuerKeyId: "must-not-cross-the-public-dto",
        }],
      };
    });

    await expect(new RpcManagementFacade(fake.link).dutyMigrationTargets())
      .rejects.toThrow("fields are invalid");
  });
});
