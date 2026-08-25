import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { connect } from "node:net";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bindServer, startServer, type ZhixingServerInstance } from "../server.js";
import { createServerContext } from "../context.js";
import { DEFAULT_SERVER_CONFIG } from "../types.js";

const TEST_VERSION = "0.1.0-test";
const TEST_TOKEN = "test-token-abc";

async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url);
  const body = await res.json();
  return { status: res.status, body };
}

describe("HTTP Server (S2.B)", () => {
  let server: ZhixingServerInstance;

  beforeEach(async () => {
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 }, // OS 分配端口
      version: TEST_VERSION,
      token: TEST_TOKEN,
    });
    server = await startServer({ context: ctx });
  });

  afterEach(async () => {
    await server.close();
  });

  it("listens on a non-zero port assigned by OS", () => {
    expect(server.port).toBeGreaterThan(0);
  });

  it("GET /api/health returns 200 with status ok", async () => {
    const { status, body } = await fetchJson(`http://127.0.0.1:${server.port}/api/health`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "ok",
      version: TEST_VERSION,
    });
    expect((body as { uptime: number }).uptime).toBeGreaterThanOrEqual(0);
  });

  it("GET /api/status returns only the stable public host projection", async () => {
    const { status, body } = await fetchJson(`http://127.0.0.1:${server.port}/api/status`);
    expect(status).toBe(200);
    expect(body).toEqual({ state: "ready", label: "可以使用" });
    expect(Object.keys(body as Record<string, unknown>).sort()).toEqual(["label", "state"]);
    expect(JSON.stringify(body)).not.toMatch(
      /pid|port|host|version|uptime|memory|scheduler|path|device|role|epoch|secret/iu,
    );
  });

  it("GET /api/status uses the composition root projection without widening keys", async () => {
    await server.close();
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      managedHostPublicStatus: async () => ({
        state: "needs-attention",
        label: "需要处理",
        action: "请解锁本机凭据",
      }),
    });
    server = await startServer({ context: ctx });
    const { body } = await fetchJson(`http://127.0.0.1:${server.port}/api/status`);
    expect(body).toEqual({
      state: "needs-attention",
      label: "需要处理",
      action: "请解锁本机凭据",
    });
  });

  it("unknown /api/* path returns 404 JSON", async () => {
    const { status, body } = await fetchJson(`http://127.0.0.1:${server.port}/api/nonexistent`);
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: "Not Found", path: "/api/nonexistent" });
  });

  it("non-API path returns 404 plain text", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/random`);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toBe("Not Found");
  });

  it("port collision throws EADDRINUSE", async () => {
    const collisionPort = server.port;
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: collisionPort },
      version: TEST_VERSION,
      token: TEST_TOKEN,
    });

    await expect(startServer({ context: ctx })).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  });

  it("binds an inactive final endpoint and activates the same server object", async () => {
    await server.close();
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
    });
    const bound = await bindServer({ config: ctx.config });
    const boundObject = bound.httpServer;

    const inactive = await fetch(`http://127.0.0.1:${bound.port}/api/health`);
    expect(inactive.status).toBe(503);
    expect(await inactive.text()).toBe("Server starting");
    expect(await rawWebSocketUpgrade(bound.port)).toContain(
      "HTTP/1.1 503 Service Unavailable",
    );
    expect(ctx.listenAddr).toBeUndefined();

    server = await startServer({ context: ctx, boundServer: bound });
    expect(server.httpServer).toBe(boundObject);
    const active = await fetchJson(`http://127.0.0.1:${server.port}/api/health`);
    expect(active.status).toBe(200);
    expect(active.body).toMatchObject({ status: "ok" });
  });

  it("lets exactly one real process own the same fixed endpoint", async () => {
    const fixedPort = server.port;
    await server.close();
    const fixture = fileURLToPath(
      new URL("./fixtures/bound-server-owner-child.ts", import.meta.url),
    );
    const spawnOwner = (root: string) => fork(fixture, [String(fixedPort), root], {
      execArgv: ["--import=tsx/esm"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const children = [spawnOwner("anchor"), spawnOwner("executor")];
    try {
      const outcomes = await Promise.all(children.map(waitForOwnerOutcome));
      expect(outcomes.filter((item) => item.outcome === "bound")).toHaveLength(1);
      expect(outcomes.filter((item) => item.outcome === "rejected")).toEqual([
        expect.objectContaining({ code: "EADDRINUSE" }),
      ]);

      const winnerIndex = outcomes.findIndex((item) => item.outcome === "bound");
      const winner = children[winnerIndex]!;
      winner.send("crash");
      await waitForExit(winner);

      const successor = spawnOwner("successor");
      children.push(successor);
      await expect(waitForOwnerOutcome(successor)).resolves.toMatchObject({
        root: "successor",
        outcome: "bound",
        port: fixedPort,
      });
    } finally {
      for (const child of children) {
        if (child.connected) child.send("close");
      }
      await Promise.all(children.map(waitForExit));
    }
  }, 120_000);

  it("close() resolves and stops accepting connections", async () => {
    const port = server.port;
    await server.close();

    // 关闭后再请求应失败
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();

    // 重新开同一个端口应该成功（端口已释放）
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port },
      version: TEST_VERSION,
      token: TEST_TOKEN,
    });
    const newServer = await startServer({ context: ctx });
    expect(newServer.port).toBe(port);
    await newServer.close();

    // 替换 server 引用避免 afterEach 的双重 close
    server = newServer;
  });
});

function rawWebSocketUpgrade(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        "GET /ws HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("close", () => resolve(response));
    socket.on("error", reject);
  });
}

interface OwnerOutcome {
  readonly root: string;
  readonly outcome: "bound" | "rejected";
  readonly port?: number;
  readonly code?: string;
}

function waitForOwnerOutcome(child: ChildProcess): Promise<OwnerOutcome> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("owner child did not report")), 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message as OwnerOutcome);
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
    }, 15_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
