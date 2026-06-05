import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { RpcSchedulerFacade } from "../rpc-scheduler-facade.js";
import { JsonTaskStore } from "@zhixing/core";
import type { RpcClient, ServerEndpoint } from "@zhixing/server";
import type { SchedulerFacadeEvent } from "@zhixing/core";

const endpoint: ServerEndpoint = {
  url: "ws://127.0.0.1:18900/ws",
  httpBase: "http://127.0.0.1:18900",
  token: "tok",
  pid: { pidFileVersion: 2, pid: 1, port: 18900, startTime: null, startedAt: "" },
};

function makeFakeClient() {
  let closed = false;
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const client = {
    connect: vi.fn(async () => {}),
    authenticate: vi.fn(async () => ({
      protocol: 1,
      server: { version: "test" },
      capabilities: [] as string[],
    })),
    request: vi.fn(async () => ({})),
    onNotification: vi.fn((m: string, h: (p: unknown) => void) => {
      const arr = handlers.get(m) ?? [];
      arr.push(h);
      handlers.set(m, arr);
      return () => {};
    }),
    onAnyNotification: vi.fn(() => () => {}),
    close: vi.fn(async () => {
      closed = true;
    }),
    emit(m: string, p: unknown) {
      for (const h of handlers.get(m) ?? []) h(p);
    },
  };
  Object.defineProperty(client, "closed", { get: () => closed });
  return client;
}

type FakeClient = ReturnType<typeof makeFakeClient>;
const asClient = (c: FakeClient) => c as unknown as RpcClient;

describe("RpcSchedulerFacade", () => {
  let storePath: string;

  beforeEach(async () => {
    storePath = join(await createTempDir("rpcfacade"), "scheduler.json");
  });

  it("list 读 scheduler.json 投影、不连宿主", async () => {
    const store = new JsonTaskStore(storePath);
    await store.load();
    await store.addTask({
      id: "t1",
      name: "x",
      enabled: true,
      priority: "normal",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "p" },
      state: { consecutiveErrors: 0, runCount: 0 },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const discover = vi.fn(async (): Promise<ServerEndpoint> => {
      throw new Error("list 不应连宿主");
    });
    const facade = new RpcSchedulerFacade({
      storePath,
      connectionDeps: {
        discover,
        spawn: async () => ({ ok: true }),
        createClient: () => asClient(makeFakeClient()),
      },
    });

    const list = await facade.list();
    expect(list.map((t) => t.id)).toEqual(["t1"]);
    expect(discover).not.toHaveBeenCalled();
  });

  it("create / run 走 RPC", async () => {
    const client = makeFakeClient();
    client.request = vi.fn(async (method: string) =>
      method === "schedule.create"
        ? { id: "new1" }
        : { status: "ok", durationMs: 3 },
    ) as FakeClient["request"];

    const facade = new RpcSchedulerFacade({
      storePath,
      connectionDeps: {
        discover: async () => endpoint,
        spawn: async () => ({ ok: true }),
        createClient: () => asClient(client),
      },
    });

    const task = await facade.create({
      name: "x",
      enabled: true,
      priority: "normal",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "p" },
    });
    expect(task.id).toBe("new1");

    const result = await facade.run("new1");
    expect(result.status).toBe("ok");
    expect(client.request).toHaveBeenCalledWith("schedule.run", { id: "new1" });
  });

  it("onEvent 映射 RPC notification（completed 含 error）", async () => {
    const client = makeFakeClient();
    const facade = new RpcSchedulerFacade({
      storePath,
      connectionDeps: {
        discover: async () => endpoint,
        spawn: async () => ({ ok: true }),
        createClient: () => asClient(client),
      },
    });

    const events: SchedulerFacadeEvent[] = [];
    facade.onEvent((e) => events.push(e));
    await facade.run("t1"); // 触发连接 + establish 重订阅

    client.emit("schedule.completed", {
      taskId: "t1",
      name: "x",
      status: "error",
      error: "boom",
    });
    expect(events).toContainEqual({
      kind: "completed",
      taskId: "t1",
      name: "x",
      status: "error",
      durationMs: undefined,
      summary: undefined,
      error: "boom",
    });
  });
});
