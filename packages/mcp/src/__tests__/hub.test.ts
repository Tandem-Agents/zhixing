import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { createMcpHub } from "../hub.js";
import type { McpServerSpec } from "../types.js";

/**
 * 起一个 in-memory MCP server（不 spawn 子进程），连上 server 端 transport，
 * 返回 client 端 transport 供 hub 通过注入的 createTransport 使用。
 */
async function startTestServer(tools: Array<Record<string, unknown>>) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: "test-server", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [
      {
        type: "text",
        text: `called ${req.params.name} args=${JSON.stringify(
          req.params.arguments ?? {},
        )}`,
      },
    ],
  }));
  await server.connect(serverTransport);
  return clientTransport;
}

const spec = (serverId: string): McpServerSpec => ({
  serverId,
  transport: "stdio",
  command: "noop",
});

/**
 * 每次调用都起一个全新 in-memory MCP server（工具名 = serverId），供 applyConfig
 * 的增量重连测试 —— 不同于一次性的 startTestServer，重连会拿到可用的新连接。
 */
function freshTransportFactory(): (s: McpServerSpec) => {
  transport: InMemoryTransport;
} {
  return (s) => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = new Server(
      { name: "fresh", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: s.serverId, inputSchema: { type: "object", properties: {} } }],
    }));
    // 不 await：InMemoryTransport 有消息队列，client 的 initialize 会被缓冲到
    // server 端 connect 完成后处理。
    void server.connect(serverTransport);
    return { transport: clientTransport };
  };
}

/**
 * 可追踪 / 可注入失败的 transport 工厂 —— 后台重连测试用。
 *
 * 每次建链起一个全新 in-memory server，并保留 server 端 transport 句柄：测试 close 它
 * 即可模拟"对端断线"（触发 client.onclose）。`failFrom` 指定从第几次调用起抛错，用于
 * 模拟重连持续失败、断言退避递增。
 */
function trackingFactory(opts: { failFrom?: number } = {}) {
  const created: Array<{ serverTransport: InMemoryTransport }> = [];
  let calls = 0;
  const factory = (s: McpServerSpec): { transport: InMemoryTransport } => {
    calls += 1;
    if (opts.failFrom !== undefined && calls >= opts.failFrom) {
      throw new Error("spawn failed");
    }
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = new Server(
      { name: "fresh", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: s.serverId, inputSchema: { type: "object", properties: {} } },
      ],
    }));
    void server.connect(serverTransport);
    created.push({ serverTransport });
    return { transport: clientTransport };
  };
  return { factory, created, calls: () => calls };
}

/** 可手动 resolve 的 promise —— 用于把异步建链卡在某一步，制造可控的时序窗口。 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("McpHub — 连接 / 发现 / 调用 / 关闭", () => {
  it("连接后暴露工具目录并能调用", async () => {
    const clientTransport = await startTestServer([
      {
        name: "echo",
        description: "echoes input",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ]);
    const hub = createMcpHub([spec("demo")], {
      createTransport: () => ({ transport: clientTransport }),
    });
    await hub.connectAll();

    const catalog = hub.catalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]!.server).toEqual({ serverId: "demo", transport: "stdio" });
    expect(catalog[0]!.tools[0]!.name).toBe("echo");
    expect(catalog[0]!.tools[0]!.readOnlyHint).toBe(true);

    const result = await hub.callTool("demo", "echo", { a: 1 }, {});
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("called echo");
    expect(result.content).toContain('"a":1');

    await hub.dispose();
    expect(hub.catalog()).toEqual([]);
  });

  it("abort 触发时让异常冒泡（交 tool-executor 统一中断），不吞成 isError", async () => {
    const clientTransport = await startTestServer([
      { name: "echo", inputSchema: { type: "object", properties: {} } },
    ]);
    const hub = createMcpHub([spec("demo")], {
      createTransport: () => ({ transport: clientTransport }),
    });
    await hub.connectAll();

    const controller = new AbortController();
    controller.abort(new Error("user aborted"));
    await expect(
      hub.callTool("demo", "echo", {}, { signal: controller.signal }),
    ).rejects.toThrow("user aborted");

    await hub.dispose();
  });

  it("单 server 连接失败被隔离，其余照常", async () => {
    const clientTransport = await startTestServer([
      { name: "ok", inputSchema: { type: "object", properties: {} } },
    ]);
    const hub = createMcpHub([spec("good"), spec("bad")], {
      createTransport: (s) => {
        if (s.serverId === "bad") throw new Error("spawn failed");
        return { transport: clientTransport };
      },
    });
    await hub.connectAll();

    expect(hub.catalog().map((c) => c.server.serverId)).toEqual(["good"]);
    const bad = await hub.callTool("bad", "x", {}, {});
    expect(bad.isError).toBe(true);
    await hub.dispose();
  });

  it("连接失败时关闭 transport（避免 stdio 子进程残留）", async () => {
    const closeSpy = vi.fn(async () => {});
    const failingTransport = {
      start: async () => {
        throw new Error("connect failed");
      },
      close: closeSpy,
      send: async () => {},
    };
    const hub = createMcpHub([spec("bad")], {
      createTransport: () => ({ transport: failingTransport as never }),
    });

    await hub.connectAll();

    // 失败分支必须 close transport，否则已 spawn 的 stdio 子进程成孤儿。
    expect(closeSpy).toHaveBeenCalled();
    expect(hub.catalog()).toEqual([]);
    await hub.dispose();
  });
});

describe("McpHub — no-op（空配置）", () => {
  it("空 spec 列表所有方法 no-op、调用方零判空", async () => {
    const hub = createMcpHub([]);
    await hub.connectAll();
    expect(hub.catalog()).toEqual([]);
    const r = await hub.callTool("ghost", "x", {}, {});
    expect(r.isError).toBe(true);
    expect(r.content).toContain("ghost");
    await hub.dispose(); // 不抛
  });
});

describe("McpHub — applyConfig 增量热重载", () => {
  it("新增 connect / 移除 disconnect / 未变不重连 / 变更重连", async () => {
    const factory = vi.fn(freshTransportFactory());
    const hub = createMcpHub([spec("A")], { createTransport: factory });

    await hub.connectAll();
    expect(hub.catalog().map((c) => c.server.serverId)).toEqual(["A"]);
    expect(factory).toHaveBeenCalledTimes(1);

    // 新增 B，A 未变 → 只连 B，不重连 A
    await hub.applyConfig([spec("A"), spec("B")]);
    expect(hub.catalog().map((c) => c.server.serverId).sort()).toEqual([
      "A",
      "B",
    ]);
    expect(factory).toHaveBeenCalledTimes(2);

    // 移除 B → disconnect，无新连接
    await hub.applyConfig([spec("A")]);
    expect(hub.catalog().map((c) => c.server.serverId)).toEqual(["A"]);
    expect(factory).toHaveBeenCalledTimes(2);

    // 变更 A（command 改）→ 先断后连
    await hub.applyConfig([
      { serverId: "A", transport: "stdio", command: "changed" },
    ]);
    expect(hub.catalog().map((c) => c.server.serverId)).toEqual(["A"]);
    expect(factory).toHaveBeenCalledTimes(3);

    await hub.dispose();
  });

  it("applyConfig 到空 → 全部 disconnect", async () => {
    const factory = vi.fn(freshTransportFactory());
    const hub = createMcpHub([spec("A"), spec("B")], {
      createTransport: factory,
    });
    await hub.connectAll();
    expect(hub.catalog()).toHaveLength(2);

    await hub.applyConfig([]);
    expect(hub.catalog()).toEqual([]);
    await hub.dispose();
  });
});

describe("McpHub — serverStatuses 全量运行态", () => {
  it("暴露所有已配置 server 的状态（含 failed），按配置顺序", async () => {
    const okClient = await startTestServer([
      { name: "echo", inputSchema: { type: "object", properties: {} } },
    ]);
    const hub = createMcpHub([spec("good"), spec("bad")], {
      createTransport: (s) => {
        if (s.serverId === "bad") throw new Error("spawn failed");
        return { transport: okClient };
      },
    });
    await hub.connectAll();

    expect(hub.serverStatuses()).toEqual([
      { serverId: "good", transport: "stdio", status: "connected", toolCount: 1 },
      { serverId: "bad", transport: "stdio", status: "connecting", toolCount: 0, error: "spawn failed" },
    ]);
    await hub.dispose();
  });
});

describe("McpHub — 后台断线重连", () => {
  it("对端断线后进入 connecting，指数退避重连恢复 connected", async () => {
    const t = trackingFactory();
    const hub = createMcpHub([spec("A")], { createTransport: t.factory });
    await hub.connectAll();
    expect(hub.serverStatuses()[0]!.status).toBe("connected");
    expect(t.calls()).toBe(1);

    // 首连用真实定时器；只对重连时序切假定时器，避免等待未推进的定时器挂死。
    vi.useFakeTimers();
    try {
      // 关 server 端 transport → client.onclose → 转 reconnecting + 排首次重连
      await t.created[0]!.serverTransport.close();
      expect(hub.serverStatuses()[0]!.status).toBe("connecting");
      expect(hub.catalog()).toEqual([]);

      // 首次重连在 1s 后，成功恢复
      await vi.advanceTimersByTimeAsync(1000);
      expect(t.calls()).toBe(2);
      expect(hub.serverStatuses()[0]!.status).toBe("connected");
      expect(hub.catalog().map((c) => c.server.serverId)).toEqual(["A"]);
    } finally {
      vi.useRealTimers();
    }
    await hub.dispose();
  });

  it("applyConfig 移除的 server 不触发重连（主动 close 已解绑 onclose）", async () => {
    const t = trackingFactory();
    const hub = createMcpHub([spec("A")], { createTransport: t.factory });
    await hub.connectAll();
    expect(t.calls()).toBe(1);

    vi.useFakeTimers();
    try {
      await hub.applyConfig([]); // 主动断开 A
      expect(hub.serverStatuses()).toEqual([]);
      // 远超退避间隔也不应有任何重连尝试
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.calls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    await hub.dispose();
  });

  it("dispose 清除待触发的重连定时器", async () => {
    const t = trackingFactory();
    const hub = createMcpHub([spec("A")], { createTransport: t.factory });
    await hub.connectAll();

    vi.useFakeTimers();
    try {
      await t.created[0]!.serverTransport.close(); // 进入 connecting，排了定时器
      expect(hub.serverStatuses()[0]!.status).toBe("connecting");
      await hub.dispose(); // 应清除定时器
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.calls()).toBe(1); // 无重连尝试
    } finally {
      vi.useRealTimers();
    }
  });

  it("重连持续失败时按指数退避递增间隔（1s → 2s → 4s）", async () => {
    const t = trackingFactory({ failFrom: 2 }); // 第 2 次调用起（即所有重连）建链失败
    const hub = createMcpHub([spec("A")], { createTransport: t.factory });
    await hub.connectAll();
    expect(t.calls()).toBe(1);

    vi.useFakeTimers();
    try {
      await t.created[0]!.serverTransport.close(); // connecting，排 attempt0 @ +1000

      await vi.advanceTimersByTimeAsync(999);
      expect(t.calls()).toBe(1); // 未到
      await vi.advanceTimersByTimeAsync(1);
      expect(t.calls()).toBe(2); // attempt0 触发并失败，排 attempt1 @ +2000

      await vi.advanceTimersByTimeAsync(1999);
      expect(t.calls()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.calls()).toBe(3); // attempt1 @ 2000 触发，排 attempt2 @ +4000

      await vi.advanceTimersByTimeAsync(3999);
      expect(t.calls()).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.calls()).toBe(4); // attempt2 @ 4000 触发

      expect(hub.serverStatuses()[0]!.status).toBe("connecting");
    } finally {
      vi.useRealTimers();
    }
    await hub.dispose();
  });

  it("首次连接失败也进入后台重试，server 就绪后自动连上", async () => {
    // 第 1 次建链同步失败（server 未就绪），之后正常。首次失败应进入退避重试而非终止。
    let attempt = 0;
    const factory = (s: McpServerSpec): { transport: InMemoryTransport } => {
      attempt += 1;
      if (attempt === 1) throw new Error("server down");
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const server = new Server(
        { name: "fresh", version: "0.0.1" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          { name: s.serverId, inputSchema: { type: "object", properties: {} } },
        ],
      }));
      void server.connect(serverTransport);
      return { transport: clientTransport };
    };

    const hub = createMcpHub([spec("A")], { createTransport: factory });
    // 首次失败是同步抛错（不经真实 connect），故全程可用假定时器、不会挂死。
    vi.useFakeTimers();
    try {
      await hub.connectAll();
      expect(hub.serverStatuses()[0]!.status).toBe("connecting");
      expect(hub.serverStatuses()[0]!.error).toBe("server down");
      expect(hub.catalog()).toEqual([]);

      await vi.advanceTimersByTimeAsync(1000); // 首次重试 @1s，这次成功
      expect(hub.serverStatuses()[0]!.status).toBe("connected");
      expect(hub.catalog().map((c) => c.server.serverId)).toEqual(["A"]);
    } finally {
      vi.useRealTimers();
    }
    await hub.dispose();
  });

  it("重连建链进行中 server 被移除 → 丢弃孤儿连接、不冒充 connected", async () => {
    const gate = deferred(); // 控制"重连这次"的 tools/list 何时返回
    let call = 0;
    let firstServerTransport: InMemoryTransport | undefined;
    let orphanClose: ReturnType<typeof vi.fn> | undefined;
    const factory = (s: McpServerSpec): { transport: InMemoryTransport } => {
      call += 1;
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const server = new Server(
        { name: "fresh", version: "0.0.1" },
        { capabilities: { tools: {} } },
      );
      const tools = [
        { name: s.serverId, inputSchema: { type: "object", properties: {} } },
      ];
      if (call === 1) {
        firstServerTransport = serverTransport;
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      } else {
        // 重连这次：tools/list 卡在 gate 上，留出"建链进行中移除 server"的窗口。
        server.setRequestHandler(ListToolsRequestSchema, async () => {
          await gate.promise;
          return { tools };
        });
        orphanClose = vi.fn(clientTransport.close.bind(clientTransport));
        clientTransport.close = orphanClose;
      }
      void server.connect(serverTransport);
      return { transport: clientTransport };
    };

    const hub = createMcpHub([spec("A")], { createTransport: factory });
    await hub.connectAll(); // 真实定时器下首连成功

    vi.useFakeTimers();
    try {
      await firstServerTransport!.close(); // 断线 → connecting，排重连 @1000
      await vi.advanceTimersByTimeAsync(1000); // 重连触发，卡在 gate（establish 未完成）
      expect(hub.serverStatuses()[0]!.status).toBe("connecting");

      await hub.applyConfig([]); // 建链进行中移除 A
      gate.resolve(); // 放行 tools/list → establish 完成 → 应判定为孤儿丢弃
      await vi.advanceTimersByTimeAsync(1); // 排空 establish 完成后的微任务

      // catalog 看 connections，能识破"已被移除却又冒充 connected"
      expect(hub.catalog()).toEqual([]);
      expect(hub.serverStatuses()).toEqual([]);
      expect(orphanClose).toHaveBeenCalled(); // 孤儿连接已被关闭、未泄漏
    } finally {
      vi.useRealTimers();
    }
    await hub.dispose();
  });

  it("重连建链进行中 server 被改规格 → 丢弃旧建链、不卡在旧 spec", async () => {
    const gate = deferred(); // 卡住"旧规格重连这次"的 tools/list
    let call = 0;
    let firstServerTransport: InMemoryTransport | undefined;
    let orphanClose: ReturnType<typeof vi.fn> | undefined;
    const factory = (s: McpServerSpec): { transport: InMemoryTransport } => {
      call += 1;
      // call 3 = 改规格后的新建链：令其失败，使 A 以新规格重新回到 connecting——
      // 这正是"只看状态"的旧判据会误采纳旧建链的条件。
      if (call === 3) throw new Error("new spec not ready");
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const server = new Server(
        { name: "fresh", version: "0.0.1" },
        { capabilities: { tools: {} } },
      );
      const tools = [
        { name: s.serverId, inputSchema: { type: "object", properties: {} } },
      ];
      if (call === 1) {
        firstServerTransport = serverTransport;
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      } else {
        // call 2：旧规格的重连，tools/list 卡在 gate 上，留出"建链在途改规格"的窗口。
        server.setRequestHandler(ListToolsRequestSchema, async () => {
          await gate.promise;
          return { tools };
        });
        orphanClose = vi.fn(clientTransport.close.bind(clientTransport));
        clientTransport.close = orphanClose;
      }
      void server.connect(serverTransport);
      return { transport: clientTransport };
    };

    const hub = createMcpHub(
      [{ serverId: "A", transport: "stdio", command: "c1" }],
      { createTransport: factory },
    );
    await hub.connectAll(); // 首连成功（旧规格 c1）

    vi.useFakeTimers();
    try {
      await firstServerTransport!.close(); // 断线 → connecting，排重连 @1000
      await vi.advanceTimersByTimeAsync(1000); // 旧规格重连触发，卡在 gate
      expect(hub.serverStatuses()[0]!.status).toBe("connecting");

      // 建链在途时改 A 规格（c1→c2）：断旧 → 连新（call 3 失败）→ A 以新规格回到 connecting
      await hub.applyConfig([
        { serverId: "A", transport: "stdio", command: "c2" },
      ]);
      gate.resolve(); // 放行旧规格建链 → 应判为孤儿丢弃，而非冒充 connected
      await vi.advanceTimersByTimeAsync(1);

      // 旧建链不得被采纳：catalog（看 connections）不应出现 A connected
      expect(hub.catalog()).toEqual([]);
      expect(hub.serverStatuses()[0]!.status).toBe("connecting"); // 仍是新规格的重试
      expect(orphanClose).toHaveBeenCalled(); // 旧建链已关闭、未泄漏
    } finally {
      vi.useRealTimers();
    }
    await hub.dispose();
  });
});
