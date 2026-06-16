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

const nextEndpoint: ServerEndpoint = {
  url: "ws://127.0.0.1:18901/ws",
  httpBase: "http://127.0.0.1:18901",
  token: "tok",
  pid: {
    pidFileVersion: 2,
    pid: 2,
    port: 18901,
    startTime: 2,
    startedAt: "2026-01-01T00:00:01.000Z",
  },
};

function makeFakeClient(opts: {
  connect?: () => Promise<void>;
  authenticate?: () => Promise<{
    protocol: number;
    protocolRange?: { min: number; max: number };
    server: { version: string };
    capabilities: string[];
  }>;
  request?: (method: string, params?: unknown) => Promise<unknown>;
} = {}) {
  let closed = false;
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  const client = {
    connect: vi.fn(opts.connect ?? (async () => {})),
    authenticate: vi.fn(
      opts.authenticate ??
        (async () => ({
          protocol: 1,
          protocolRange: { min: 1, max: 1 },
          server: { version: "0.1.0" },
          capabilities: [] as string[],
        })),
    ),
    request: vi.fn(opts.request ?? (async () => ({}))),
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
    expect(client.authenticate).toHaveBeenCalledWith("tok", {
      id: "zhixing-cli",
      version: "0.1.0",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("协议不兼容 → 阻断可写连接且不替换宿主", async () => {
    const client = makeFakeClient({
      authenticate: async () => ({
        protocol: 2,
        protocolRange: { min: 2, max: 2 },
        server: { version: "0.1.0" },
        capabilities: [],
      }),
    });
    const stopUnresponsiveHost = vi.fn(async () => ({ ok: true }));
    const spawn = vi.fn(async () => ({ ok: true }));
    const conn = new CoreHostConnection({
      discover: async () => endpoint,
      spawn,
      stopUnresponsiveHost,
      createClient: () => asClient(client),
    });

    await expect(conn.getClient()).rejects.toThrow(/RPC 协议不兼容/);
    expect(stopUnresponsiveHost).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
    expect(conn.getStatus()).toEqual({ kind: "disconnected" });
  });

  it("旧版本宿主且无其它活跃接入面 → 请求优雅退出、拉起新宿主并连接", async () => {
    const c1 = makeFakeClient({
      authenticate: async () => ({
        protocol: 1,
        protocolRange: { min: 1, max: 1 },
        server: { version: "0.0.9" },
        capabilities: ["session"],
      }),
      request: async (method) => {
        if (method === "server.info") {
          return { version: "0.0.9", protocol: 1, connectionCount: 1 };
        }
        if (method === "server.shutdown") {
          return { accepted: true };
        }
        return {};
      },
    });
    const c2 = makeFakeClient();
    const clients = [c1, c2];
    let i = 0;
    let currentEndpoint = endpoint;
    const notices: unknown[] = [];
    const discover = vi.fn(async () => currentEndpoint);
    const spawn = vi.fn(async () => {
      currentEndpoint = nextEndpoint;
      return { ok: true };
    });
    const sleep = vi.fn(async () => {
      currentEndpoint = nextEndpoint;
    });
    const conn = new CoreHostConnection({
      discover,
      spawn,
      createClient: () => asClient(clients[i++]!),
      sleep,
      onLifecycleNotice: (notice) => notices.push(notice),
    });

    const got = await conn.getClient();

    expect(got).toBe(asClient(c2));
    expect(c1.request).toHaveBeenCalledWith("server.shutdown", {
      reason: "client-version-change",
    });
    expect(c1.close).toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(100);
    expect(conn.getStatus()).toMatchObject({
      kind: "connected",
      serverVersion: "0.1.0",
      versionState: "current",
    });
    expect(notices).toContainEqual({
      kind: "host-replaced",
      reason: "version-mismatch",
      oldVersion: "0.0.9",
      newVersion: "0.1.0",
    });
  });

  it("host-replaced 通知在新连接成为当前连接后发出，handler 可安全重入 getClient", async () => {
    const c1 = makeFakeClient({
      authenticate: async () => ({
        protocol: 1,
        protocolRange: { min: 1, max: 1 },
        server: { version: "0.0.9" },
        capabilities: ["session"],
      }),
      request: async (method) => {
        if (method === "server.info") {
          return { version: "0.0.9", protocol: 1, connectionCount: 1 };
        }
        if (method === "server.shutdown") return { accepted: true };
        return {};
      },
    });
    const c2 = makeFakeClient();
    const clients = [c1, c2];
    let i = 0;
    let currentEndpoint = endpoint;
    let conn!: CoreHostConnection;
    let clientSeenByNotice: RpcClient | null = null;
    const sleep = vi.fn(async () => {
      currentEndpoint = nextEndpoint;
    });
    conn = new CoreHostConnection({
      discover: vi.fn(async () => currentEndpoint),
      spawn: vi.fn(async () => {
        currentEndpoint = nextEndpoint;
        return { ok: true };
      }),
      createClient: () => asClient(clients[i++]!),
      sleep,
      onLifecycleNotice: async (notice) => {
        if (notice.kind === "host-replaced") {
          clientSeenByNotice = await conn.getClient();
        }
      },
    });

    const got = await conn.getClient();

    expect(got).toBe(asClient(c2));
    expect(clientSeenByNotice).toBe(asClient(c2));
  });

  it("host-replaced 等待异步生命周期订阅者完成后才返回连接", async () => {
    const c1 = makeFakeClient({
      authenticate: async () => ({
        protocol: 1,
        protocolRange: { min: 1, max: 1 },
        server: { version: "0.0.9" },
        capabilities: ["session"],
      }),
      request: async (method) => {
        if (method === "server.info") {
          return { version: "0.0.9", protocol: 1, connectionCount: 1 };
        }
        if (method === "server.shutdown") return { accepted: true };
        return {};
      },
    });
    const c2 = makeFakeClient();
    const clients = [c1, c2];
    let i = 0;
    let currentEndpoint = endpoint;
    let releaseNotice!: () => void;
    const noticeGate = new Promise<void>((resolve) => {
      releaseNotice = resolve;
    });
    let noticeCompleted = false;
    let resolved = false;
    const sleep = vi.fn(async () => {
      currentEndpoint = nextEndpoint;
    });
    const conn = new CoreHostConnection({
      discover: vi.fn(async () => currentEndpoint),
      spawn: vi.fn(async () => {
        currentEndpoint = nextEndpoint;
        return { ok: true };
      }),
      createClient: () => asClient(clients[i++]!),
      sleep,
      onLifecycleNotice: async (notice) => {
        if (notice.kind === "host-replaced") {
          await noticeGate;
          noticeCompleted = true;
        }
      },
    });

    const pending = conn.getClient().then((client) => {
      resolved = true;
      return client;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolved).toBe(false);
    expect(noticeCompleted).toBe(false);
    releaseNotice();
    await expect(pending).resolves.toBe(asClient(c2));
    expect(resolved).toBe(true);
    expect(noticeCompleted).toBe(true);
  });

  it("生命周期通知订阅者失败不阻断连接，也不影响后续订阅者", async () => {
    const c1 = makeFakeClient({
      authenticate: async () => ({
        protocol: 1,
        protocolRange: { min: 1, max: 1 },
        server: { version: "0.0.9" },
        capabilities: ["session"],
      }),
      request: async (method) => {
        if (method === "server.info") {
          return { version: "0.0.9", protocol: 1, connectionCount: 1 };
        }
        if (method === "server.shutdown") return { accepted: true };
        return {};
      },
    });
    const c2 = makeFakeClient();
    const clients = [c1, c2];
    let i = 0;
    let currentEndpoint = endpoint;
    const seen: unknown[] = [];
    const sleep = vi.fn(async () => {
      currentEndpoint = nextEndpoint;
    });
    const conn = new CoreHostConnection({
      discover: vi.fn(async () => currentEndpoint),
      spawn: vi.fn(async () => {
        currentEndpoint = nextEndpoint;
        return { ok: true };
      }),
      createClient: () => asClient(clients[i++]!),
      sleep,
      onLifecycleNotice: () => {
        throw new Error("notice renderer failed");
      },
    });
    conn.onLifecycleNotice((notice) => seen.push(notice));

    await expect(conn.getClient()).resolves.toBe(asClient(c2));

    expect(conn.getStatus()).toMatchObject({
      kind: "connected",
      serverVersion: "0.1.0",
      versionState: "current",
    });
    expect(seen).toContainEqual({
      kind: "host-replaced",
      reason: "version-mismatch",
      oldVersion: "0.0.9",
      newVersion: "0.1.0",
    });
  });

  it("旧版本宿主但有其它活跃接入面 → 保持连接并标记待更新", async () => {
    const client = makeFakeClient({
      authenticate: async () => ({
        protocol: 1,
        protocolRange: { min: 1, max: 1 },
        server: { version: "0.0.9" },
        capabilities: ["session"],
      }),
      request: async (method) => {
        if (method === "server.info") {
          return { version: "0.0.9", protocol: 1, connectionCount: 2 };
        }
        return {};
      },
    });
    const notices: unknown[] = [];
    const spawn = vi.fn(async () => ({ ok: true }));
    const conn = new CoreHostConnection({
      discover: async () => endpoint,
      spawn,
      createClient: () => asClient(client),
      onLifecycleNotice: (notice) => notices.push(notice),
    });

    await expect(conn.getClient()).resolves.toBe(asClient(client));

    expect(spawn).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalledWith(
      "server.shutdown",
      expect.anything(),
    );
    expect(conn.getStatus()).toMatchObject({
      kind: "connected",
      serverVersion: "0.0.9",
      versionState: "pending-update",
      connectionCount: 2,
    });
    expect(notices).toContainEqual({
      kind: "version-pending",
      clientVersion: "0.1.0",
      serverVersion: "0.0.9",
      connectionCount: 2,
    });
  });

  it("旧版本宿主待更新后，其它接入面离开时自动换代", async () => {
    let infoCalls = 0;
    const c1 = makeFakeClient({
      authenticate: async () => ({
        protocol: 1,
        protocolRange: { min: 1, max: 1 },
        server: { version: "0.0.9" },
        capabilities: ["session"],
      }),
      request: async (method) => {
        if (method === "server.info") {
          infoCalls += 1;
          return {
            version: "0.0.9",
            protocol: 1,
            connectionCount: infoCalls === 1 ? 2 : 1,
          };
        }
        if (method === "server.shutdown") return { accepted: true };
        return {};
      },
    });
    const c2 = makeFakeClient();
    const clients = [c1, c2];
    let i = 0;
    let currentEndpoint = endpoint;
    const notices: unknown[] = [];
    const sleep = vi.fn(async () => {
      currentEndpoint = nextEndpoint;
    });
    const spawn = vi.fn(async () => {
      currentEndpoint = nextEndpoint;
      return { ok: true };
    });
    const conn = new CoreHostConnection({
      discover: vi.fn(async () => currentEndpoint),
      spawn,
      createClient: () => asClient(clients[i++]!),
      sleep,
      versionRecheckIntervalMs: 1,
      onLifecycleNotice: (notice) => notices.push(notice),
    });

    try {
      await expect(conn.getClient()).resolves.toBe(asClient(c1));
      expect(conn.getStatus()).toMatchObject({
        serverVersion: "0.0.9",
        versionState: "pending-update",
        connectionCount: 2,
      });

      await vi.waitFor(() => {
        expect(conn.getStatus()).toMatchObject({
          serverVersion: "0.1.0",
          versionState: "current",
        });
      });

      expect(c1.request).toHaveBeenCalledWith("server.shutdown", {
        reason: "client-version-change",
      });
      expect(c1.close).toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledOnce();
      expect(notices).toContainEqual({
        kind: "host-replaced",
        reason: "version-mismatch",
        oldVersion: "0.0.9",
        newVersion: "0.1.0",
      });
    } finally {
      await conn.dispose();
    }
  });

  it("版本换代后新服务仍在启动时持续发现，随后连接新 endpoint", async () => {
    let currentEndpoint: ServerEndpoint | null = endpoint;
    const c1 = makeFakeClient({
      authenticate: async () => ({
        protocol: 1,
        protocolRange: { min: 1, max: 1 },
        server: { version: "0.0.9" },
        capabilities: ["session"],
      }),
      request: async (method) => {
        if (method === "server.info") {
          return { version: "0.0.9", protocol: 1, connectionCount: 1 };
        }
        if (method === "server.shutdown") {
          currentEndpoint = null;
          return { accepted: true };
        }
        return {};
      },
    });
    const c2 = makeFakeClient();
    const clients = [c1, c2];
    let i = 0;
    const notices: unknown[] = [];
    const discover = vi.fn(async () => {
      if (!currentEndpoint) throw new ServerNotRunningError("starting");
      return currentEndpoint;
    });
    const spawn = vi.fn(async () => ({
      ok: false,
      recoverable: true,
      reason: "知行服务仍在启动",
    }));
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
      currentEndpoint = nextEndpoint;
    });
    const conn = new CoreHostConnection({
      discover,
      spawn,
      createClient: () => asClient(clients[i++]!),
      clock: () => now,
      sleep,
      startupRecoveryTimeoutMs: 1000,
      startupRecoveryPollMs: 50,
      onLifecycleNotice: (notice) => notices.push(notice),
    });

    await expect(conn.getClient()).resolves.toBe(asClient(c2));

    expect(spawn).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(50);
    expect(notices).toContainEqual({ kind: "starting" });
    expect(notices).toContainEqual({
      kind: "host-replaced",
      reason: "version-mismatch",
      oldVersion: "0.0.9",
      newVersion: "0.1.0",
    });
  });

  it("旧版本宿主但 server.info 不可读 → 保守保持连接并标记待更新", async () => {
    const client = makeFakeClient({
      authenticate: async () => ({
        protocol: 1,
        protocolRange: { min: 1, max: 1 },
        server: { version: "0.0.9" },
        capabilities: ["session"],
      }),
      request: async (method) => {
        if (method === "server.info") throw new Error("info unavailable");
        if (method === "server.shutdown") throw new Error("must not shutdown");
        return {};
      },
    });
    const notices: unknown[] = [];
    const spawn = vi.fn(async () => ({ ok: true }));
    const conn = new CoreHostConnection({
      discover: async () => endpoint,
      spawn,
      createClient: () => asClient(client),
      onLifecycleNotice: (notice) => notices.push(notice),
    });

    await expect(conn.getClient()).resolves.toBe(asClient(client));

    expect(spawn).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalledWith(
      "server.shutdown",
      expect.anything(),
    );
    expect(conn.getStatus()).toMatchObject({
      kind: "connected",
      serverVersion: "0.0.9",
      versionState: "pending-update",
    });
    expect(notices).toContainEqual({
      kind: "version-pending",
      clientVersion: "0.1.0",
      serverVersion: "0.0.9",
    });
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

  it("拉起仍在进行时持续发现，服务随后可用则正常连接", async () => {
    const client = makeFakeClient();
    const notices: unknown[] = [];
    let discoverCalls = 0;
    const discover = vi.fn(async () => {
      discoverCalls += 1;
      if (discoverCalls < 3) throw new ServerNotRunningError("not running yet");
      return endpoint;
    });
    const spawn = vi.fn(async () => ({
      ok: false,
      recoverable: true,
      reason: "知行服务仍在启动",
    }));
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const conn = new CoreHostConnection({
      discover,
      spawn,
      createClient: () => asClient(client),
      clock: () => now,
      sleep,
      startupRecoveryTimeoutMs: 1000,
      startupRecoveryPollMs: 50,
      onLifecycleNotice: (notice) => notices.push(notice),
    });

    await expect(conn.getClient()).resolves.toBe(asClient(client));

    expect(spawn).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(50);
    expect(notices).toContainEqual({ kind: "starting" });
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

  it("发现到 PID 存活但连接不可用 → 清理旧宿主、拉起新宿主并连接新 endpoint", async () => {
    const c1 = makeFakeClient({
      connect: async () => {
        throw new Error("connect timeout");
      },
    });
    const c2 = makeFakeClient();
    const clients = [c1, c2];
    let i = 0;
    let currentEndpoint = endpoint;
    const discover = vi.fn(async () => currentEndpoint);
    const stopUnresponsiveHost = vi.fn(async () => ({ ok: true }));
    const spawn = vi.fn(async () => {
      currentEndpoint = nextEndpoint;
      return { ok: true };
    });
    const conn = new CoreHostConnection({
      discover,
      spawn,
      stopUnresponsiveHost,
      createClient: () => asClient(clients[i++]!),
    });

    const got = await conn.getClient();

    expect(got).toBe(asClient(c2));
    expect(stopUnresponsiveHost).toHaveBeenCalledOnce();
    expect(stopUnresponsiveHost).toHaveBeenCalledWith(
      endpoint,
      expect.any(Error),
    );
    expect(spawn).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledTimes(3);
    expect(c1.close).toHaveBeenCalledOnce();
    expect(c2.authenticate).toHaveBeenCalledWith("tok", {
      id: "zhixing-cli",
      version: "0.1.0",
    });
  });

  it("僵死宿主清理后新服务仍在启动时持续发现，随后连接新 endpoint", async () => {
    const c1 = makeFakeClient({
      connect: async () => {
        throw new Error("connect timeout");
      },
    });
    const c2 = makeFakeClient();
    const clients = [c1, c2];
    let i = 0;
    let currentEndpoint: ServerEndpoint | null = endpoint;
    const discover = vi.fn(async () => {
      if (!currentEndpoint) throw new ServerNotRunningError("starting");
      return currentEndpoint;
    });
    const stopUnresponsiveHost = vi.fn(async () => {
      currentEndpoint = null;
      return { ok: true };
    });
    const spawn = vi.fn(async () => ({
      ok: false,
      recoverable: true,
      reason: "知行服务仍在启动",
    }));
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
      currentEndpoint = nextEndpoint;
    });
    const conn = new CoreHostConnection({
      discover,
      spawn,
      stopUnresponsiveHost,
      createClient: () => asClient(clients[i++]!),
      clock: () => now,
      sleep,
      startupRecoveryTimeoutMs: 1000,
      startupRecoveryPollMs: 50,
    });

    await expect(conn.getClient()).resolves.toBe(asClient(c2));

    expect(stopUnresponsiveHost).toHaveBeenCalledWith(
      endpoint,
      expect.any(Error),
    );
    expect(spawn).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it("僵死清理后发现锁已换代 → 直接连接新 endpoint，不再拉起宿主", async () => {
    const c1 = makeFakeClient({
      connect: async () => {
        throw new Error("connect timeout");
      },
    });
    const c2 = makeFakeClient();
    const clients = [c1, c2];
    let i = 0;
    let currentEndpoint = endpoint;
    const stopUnresponsiveHost = vi.fn(async () => {
      currentEndpoint = nextEndpoint;
      return { ok: true };
    });
    const spawn = vi.fn(async () => ({ ok: true }));
    const conn = new CoreHostConnection({
      discover: vi.fn(async () => currentEndpoint),
      spawn,
      stopUnresponsiveHost,
      createClient: () => asClient(clients[i++]!),
    });

    await expect(conn.getClient()).resolves.toBe(asClient(c2));

    expect(stopUnresponsiveHost).toHaveBeenCalledWith(
      endpoint,
      expect.any(Error),
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("僵死宿主清理失败 → 返回 CoreHostUnavailableError 且不拉起新宿主", async () => {
    const client = makeFakeClient({
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const spawn = vi.fn(async () => ({ ok: true }));
    const conn = new CoreHostConnection({
      discover: async () => endpoint,
      spawn,
      stopUnresponsiveHost: vi.fn(async () => ({
        ok: false,
        reason: "permission denied",
      })),
      createClient: () => asClient(client),
    });

    const attempt = conn.getClient();
    await expect(attempt).rejects.toThrow(CoreHostUnavailableError);
    await expect(attempt).rejects.toThrow(/清理失败/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("认证失败不触发僵死替换，避免误杀可连接宿主", async () => {
    const client = makeFakeClient({
      authenticate: async () => {
        throw new Error("invalid token");
      },
    });
    const stopUnresponsiveHost = vi.fn(async () => ({ ok: true }));
    const spawn = vi.fn(async () => ({ ok: true }));
    const conn = new CoreHostConnection({
      discover: async () => endpoint,
      spawn,
      stopUnresponsiveHost,
      createClient: () => asClient(client),
    });

    await expect(conn.getClient()).rejects.toThrow(/invalid token/);
    expect(stopUnresponsiveHost).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
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

  it("活连接上退订即生效——client 再 emit 不触达（回归锚）", async () => {
    const client = makeFakeClient();
    const conn = new CoreHostConnection({
      discover: async () => endpoint,
      spawn: vi.fn(async () => ({ ok: true })),
      createClient: () => asClient(client),
    });
    await conn.getClient();

    const received: unknown[] = [];
    const off = conn.onNotification("session.event", (p) => received.push(p));
    client.emit("session.event", { seq: 0 });
    expect(received).toHaveLength(1);

    // 连接仍存活时退订——生效面与订阅表是同一张表,删表即停止触达
    off();
    client.emit("session.event", { seq: 1 });
    expect(received).toHaveLength(1);
  });

  it("同 method 多 handler:单 emit 各触发一次（转发器唯一）,退订其一另一仍触达", async () => {
    const client = makeFakeClient();
    const conn = new CoreHostConnection({
      discover: async () => endpoint,
      spawn: vi.fn(async () => ({ ok: true })),
      createClient: () => asClient(client),
    });
    await conn.getClient();

    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = conn.onNotification("session.delta", (p) => a.push(p));
    conn.onNotification("session.delta", (p) => b.push(p));

    client.emit("session.delta", { n: 1 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    offA();
    client.emit("session.delta", { n: 2 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it("订阅者级错误隔离:同 method 第一个 handler 抛错,后续 handler 仍触达（回归锚）", async () => {
    const client = makeFakeClient();
    const conn = new CoreHostConnection({
      discover: async () => endpoint,
      spawn: vi.fn(async () => ({ ok: true })),
      createClient: () => asClient(client),
    });
    await conn.getClient();

    const received: unknown[] = [];
    conn.onNotification("session.event", () => {
      throw new Error("订阅者崩了");
    });
    conn.onNotification("session.event", (p) => received.push(p));

    // 转发器是 client 眼里的单个 handler——隔离粒度必须在转发器内恢复为订阅者
    client.emit("session.event", { seq: 0 });
    expect(received).toEqual([{ seq: 0 }]);
  });

  it("断线重连后订阅仍生效,重连后退订同样立即生效", async () => {
    const c1 = makeFakeClient();
    const c2 = makeFakeClient();
    const clients = [c1, c2];
    let i = 0;
    const conn = new CoreHostConnection({
      discover: async () => endpoint,
      spawn: vi.fn(async () => ({ ok: true })),
      createClient: () => asClient(clients[i++]!),
    });

    const received: unknown[] = [];
    const off = conn.onNotification("schedule.completed", (p) => received.push(p));
    await conn.getClient();
    c1.markClosed();
    await conn.getClient(); // 重建到 c2,转发器重挂

    c2.emit("schedule.completed", { taskId: "t1" });
    expect(received).toHaveLength(1);

    off();
    c2.emit("schedule.completed", { taskId: "t2" });
    expect(received).toHaveLength(1);
  });

  it("reconnect 主动关闭旧连接,等待旧 endpoint 换代后重连且保留订阅", async () => {
    const c1 = makeFakeClient();
    const c2 = makeFakeClient();
    const clients = [c1, c2];
    let i = 0;
    let currentEndpoint = endpoint;
    const discover = vi.fn(async () => currentEndpoint);
    const sleep = vi.fn(async () => {
      currentEndpoint = nextEndpoint;
    });
    const conn = new CoreHostConnection({
      discover,
      spawn: vi.fn(async () => ({ ok: true })),
      createClient: () => asClient(clients[i++]!),
      sleep,
    });

    await conn.getClient();
    const received: unknown[] = [];
    conn.onNotification("session.delta", (p) => received.push(p));

    await conn.reconnect({ timeoutMs: 1000, pollIntervalMs: 1 });

    expect(c1.close).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1);
    expect(await conn.getClient()).toBe(asClient(c2));
    c2.emit("session.delta", { n: 1 });
    expect(received).toEqual([{ n: 1 }]);
  });

  it("reconnect 撞在建立在途时丢弃旧连接,等待旧 endpoint 换代后连到新 owner", async () => {
    const c1 = makeFakeClient();
    const c2 = makeFakeClient();
    const clients = [c1, c2];
    let i = 0;
    let currentEndpoint = endpoint;
    let firstDiscover = true;
    let releaseDiscover!: () => void;
    const discoverGate = new Promise<void>((resolve) => {
      releaseDiscover = resolve;
    });
    const discover = vi.fn(async () => {
      if (firstDiscover) {
        firstDiscover = false;
        await discoverGate;
        return endpoint;
      }
      return currentEndpoint;
    });
    const sleep = vi.fn(async () => {
      currentEndpoint = nextEndpoint;
    });
    const conn = new CoreHostConnection({
      discover,
      spawn: vi.fn(async () => ({ ok: true })),
      createClient: () => asClient(clients[i++]!),
      sleep,
    });

    const pending = conn.getClient();
    const reconnecting = conn.reconnect({ timeoutMs: 1000, pollIntervalMs: 1 });
    const duringReconnect = conn.getClient();
    releaseDiscover();

    await expect(pending).rejects.toThrow(/换代/);
    await reconnecting;
    await expect(duringReconnect).resolves.toBe(asClient(c2));
    expect(c1.close).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(await conn.getClient()).toBe(asClient(c2));
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
