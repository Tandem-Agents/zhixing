import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startServer, type ZhixingServerInstance } from "../server.js";
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

  it("GET /api/status returns server runtime details", async () => {
    const { status, body } = await fetchJson(`http://127.0.0.1:${server.port}/api/status`);
    expect(status).toBe(200);
    const s = body as Record<string, unknown>;
    expect(s.running).toBe(true);
    expect(s.pid).toBe(process.pid);
    expect(s.port).toBe(server.port);
    expect(s.version).toBe(TEST_VERSION);
    expect(typeof s.uptime).toBe("number");
    expect(typeof s.startedAt).toBe("string");
    const memory = s.memory as { rss: number; heapUsed: number };
    expect(memory.rss).toBeGreaterThan(0);
    expect(memory.heapUsed).toBeGreaterThan(0);
    // S2.B: scheduler 还未集成
    expect(s.scheduler).toBeUndefined();
  });

  it("GET /api/status omits scheduler when not provided", async () => {
    const { body } = await fetchJson(`http://127.0.0.1:${server.port}/api/status`);
    expect((body as { scheduler?: unknown }).scheduler).toBeUndefined();
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

  it("starts workflow recovery after listen without blocking startup", async () => {
    await server.close();
    let recovered!: () => void;
    const recoveredPromise = new Promise<void>((resolve) => {
      recovered = resolve;
    });
    const recoverUnfinished = vi.fn(async () => {
      recovered();
      return [];
    });
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      workflow: { recoverUnfinished } as never,
    });

    server = await startServer({ context: ctx });
    expect(server.port).toBeGreaterThan(0);
    await recoveredPromise;
    expect(recoverUnfinished).toHaveBeenCalledOnce();
  });
});
