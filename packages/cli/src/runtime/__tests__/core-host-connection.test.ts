import { describe, it, expect, vi } from "vitest";
import {
  CoreHostConnection,
  CoreHostUnavailableError,
} from "../core-host-connection.js";
import {
  ServerNotRunningError,
  type RpcClient,
  type ServerEndpoint,
} from "@zhixing/server";

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
    markClosed() {
      closed = true;
    },
  };
  Object.defineProperty(client, "closed", { get: () => closed });
  return client;
}

type FakeClient = ReturnType<typeof makeFakeClient>;
const asClient = (c: FakeClient) => c as unknown as RpcClient;

describe("CoreHostConnection", () => {
  it("发现成功即连接并认证", async () => {
    const client = makeFakeClient();
    const spawn = vi.fn(async () => ({ ok: true }));
    const conn = new CoreHostConnection({
      discover: async () => endpoint,
      spawn,
      createClient: () => asClient(client),
    });

    const got = await conn.getClient();
    expect(got).toBe(asClient(client));
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.authenticate).toHaveBeenCalledWith("tok");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("发现不到则拉起宿主再连", async () => {
    const client = makeFakeClient();
    let started = false;
    const discover = vi.fn(async () => {
      if (!started) throw new ServerNotRunningError("not running");
      return endpoint;
    });
    const spawn = vi.fn(async () => {
      started = true;
      return { ok: true };
    });
    const conn = new CoreHostConnection({
      discover,
      spawn,
      createClient: () => asClient(client),
    });

    await conn.getClient();
    expect(spawn).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("并发 getClient 共享同一次建立", async () => {
    const client = makeFakeClient();
    const discover = vi.fn(async () => endpoint);
    const conn = new CoreHostConnection({
      discover,
      spawn: vi.fn(async () => ({ ok: true })),
      createClient: () => asClient(client),
    });

    const [a, b] = await Promise.all([conn.getClient(), conn.getClient()]);
    expect(a).toBe(b);
    expect(discover).toHaveBeenCalledOnce();
    expect(client.connect).toHaveBeenCalledOnce();
  });

  it("连接关闭后重建（重新发现）", async () => {
    const c1 = makeFakeClient();
    const c2 = makeFakeClient();
    const clients = [c1, c2];
    let i = 0;
    const discover = vi.fn(async () => endpoint);
    const conn = new CoreHostConnection({
      discover,
      spawn: vi.fn(async () => ({ ok: true })),
      createClient: () => asClient(clients[i++]!),
    });

    await conn.getClient();
    c1.markClosed();
    const got = await conn.getClient();
    expect(got).toBe(asClient(c2));
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("拉起失败且重新发现仍不到 → CoreHostUnavailableError", async () => {
    const discover = vi.fn(async () => {
      throw new ServerNotRunningError("no host");
    });
    const spawn = vi.fn(async () => ({ ok: false, reason: "boom" }));
    const conn = new CoreHostConnection({
      discover,
      spawn,
      createClient: () => asClient(makeFakeClient()),
    });

    await expect(conn.getClient()).rejects.toBeInstanceOf(CoreHostUnavailableError);
  });

  it("onNotification 在连接建立 / 重建后仍生效", async () => {
    const client = makeFakeClient();
    const conn = new CoreHostConnection({
      discover: async () => endpoint,
      spawn: vi.fn(async () => ({ ok: true })),
      createClient: () => asClient(client),
    });

    const received: unknown[] = [];
    // 连接前订阅（被动）：存入持久订阅
    conn.onNotification("schedule.completed", (p) => received.push(p));
    await conn.getClient(); // establish 时重订阅到 client
    client.emit("schedule.completed", { taskId: "t" });
    expect(received).toEqual([{ taskId: "t" }]);
  });

  it("dispose 后 getClient 抛「已释放」", async () => {
    const conn = new CoreHostConnection({
      discover: async () => endpoint,
      spawn: vi.fn(async () => ({ ok: true })),
      createClient: () => asClient(makeFakeClient()),
    });
    await conn.dispose();
    await expect(conn.getClient()).rejects.toThrow(/已释放/);
  });

  it("dispose 关闭已建立的连接", async () => {
    const client = makeFakeClient();
    const conn = new CoreHostConnection({
      discover: async () => endpoint,
      spawn: vi.fn(async () => ({ ok: true })),
      createClient: () => asClient(client),
    });
    await conn.getClient();
    await conn.dispose();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("dispose 撞在 establish 在途：关掉建立中的连接、不泄漏、getClient 拒绝", async () => {
    const client = makeFakeClient();
    let releaseDiscover!: () => void;
    const gate = new Promise<void>((r) => {
      releaseDiscover = r;
    });
    const conn = new CoreHostConnection({
      discover: async () => {
        await gate;
        return endpoint;
      },
      spawn: vi.fn(async () => ({ ok: true })),
      createClient: () => asClient(client),
    });

    const pending = conn.getClient(); // establish 卡在 discover gate（在途）
    const disposing = conn.dispose(); // dispose 撞在在途：抓住 inflight、等其 settle 再关
    releaseDiscover(); // 放行 → establish 建好 client

    // getClient 见 disposed → 不把建立中的连接赋给 this.client，关掉并拒绝
    await expect(pending).rejects.toThrow(/连接建立期间被释放/);
    await disposing;
    // 建立中的连接被关闭（无 ws 泄漏 + 不守活宿主）
    expect(client.close).toHaveBeenCalled();
  });
});
