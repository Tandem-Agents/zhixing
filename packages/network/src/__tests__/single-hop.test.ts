import http from "node:http";
import type net from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  ALWAYS_BLOCKED_NETWORKS,
  createControlledSingleHopTransport,
  isNoProxyMatch,
  resolveSingleHopRoute,
  validateSingleHopHeaderName,
} from "../single-hop.js";

describe("controlled single-hop transport primitives", () => {
  it("matches NO_PROXY rules and routes matched hosts to local controlled direct DNS", () => {
    const env = {
      HTTPS_PROXY: "http://user:pass@127.0.0.1:7890",
      NO_PROXY: "localhost,127.0.0.1,.internal.example,10.0.0.0/8,api.custom.dev:8443",
    };
    expect(isNoProxyMatch(new URL("https://sub.internal.example/v1"), env)).toBe(true);
    expect(isNoProxyMatch(new URL("http://10.1.2.3:8080/v1"), env)).toBe(true);
    expect(isNoProxyMatch(new URL("https://api.custom.dev:8443/v1"), env)).toBe(true);
    expect(isNoProxyMatch(new URL("https://api.custom.dev:443/v1"), env)).toBe(false);

    const directRoute = resolveSingleHopRoute(new URL("https://sub.internal.example/v1"), {
      proxyPolicy: "inherit",
      networkProxy: "auto",
      env,
    });
    expect(directRoute).toEqual({
      mode: "direct",
      reason: "no-proxy",
      dnsResolvedBy: "local-controlled",
      proxyDisplay: null,
    });

    const proxyRoute = resolveSingleHopRoute(new URL("https://api.openai.com/v1"), {
      proxyPolicy: "inherit",
      networkProxy: "auto",
      env,
    });
    expect(proxyRoute).toEqual({
      mode: "proxy",
      proxyUrl: "http://user:pass@127.0.0.1:7890",
      proxyDisplay: "http://***@127.0.0.1:7890/",
      dnsResolvedBy: "proxy",
    });

    const forcedDirect = resolveSingleHopRoute(new URL("https://api.openai.com/v1"), {
      proxyPolicy: "direct",
      networkProxy: "http://127.0.0.1:7890",
      env,
    });
    expect(forcedDirect.mode).toBe("direct");
    expect(forcedDirect.reason).toBe("connection-direct");
  });

  it("scopes private origin allowance strictly to confirmedOrigin and always blocks link-local/metadata", () => {
    const transport = createControlledSingleHopTransport({
      proxyPolicy: "direct",
      allowPrivateOrigin: true,
      confirmedOrigin: "http://127.0.0.1:11434",
    });

    const allowedBlockedSet = transport.validateUrl(new URL("http://127.0.0.1:11434/v1/chat/completions"));
    expect(allowedBlockedSet).toEqual(ALWAYS_BLOCKED_NETWORKS);

    expect(() => transport.validateUrl(new URL("http://127.0.0.1:8080/v1"))).toThrow(/未获确认的本机\/私网地址/);
    expect(() => transport.validateUrl(new URL("http://192.168.1.10:11434/v1"))).toThrow(/未获确认的本机\/私网地址/);
    expect(() => transport.validateUrl(new URL("http://169.254.169.254/latest/meta-data"))).toThrow(/链路本地/);
    expect(() => transport.validateUrl(new URL("http://[fe80::1]/v1"))).toThrow(/链路本地/);
  });

  it("blocks public HTTP, URL userinfo, sensitive query params, and unsafe auth headers", () => {
    const transport = createControlledSingleHopTransport({ proxyPolicy: "direct" });
    expect(() => transport.validateUrl(new URL("http://api.example.com/v1"))).toThrow(/默认要求 HTTPS/);
    expect(() => transport.validateUrl(new URL("https://user:secret@api.example.com/v1"))).toThrow(/userinfo/);
    expect(() => transport.validateUrl(new URL("https://api.example.com/v1?api_key=sk-123"))).toThrow(/查询字段/);
    expect(() => transport.validateUrl(new URL("ftp://api.example.com/v1"))).toThrow(/仅允许 HTTP\(S\)/);

    expect(validateSingleHopHeaderName("X-Api-Key")).toBeNull();
    expect(validateSingleHopHeaderName("Host")).not.toBeNull();
    expect(validateSingleHopHeaderName("Proxy-Authorization")).not.toBeNull();
    expect(validateSingleHopHeaderName("X-Forwarded-For")).not.toBeNull();
    expect(validateSingleHopHeaderName("Connection")).not.toBeNull();
    expect(validateSingleHopHeaderName("Bad Header")).not.toBeNull();
  });

  it("closes only owned dispatchers cleanly and rejects calls after close", async () => {
    const closeSpy = vi.fn(async () => undefined);
    const transport = createControlledSingleHopTransport({
      proxyPolicy: "direct",
      createDispatcher: () => ({ close: closeSpy }) as unknown as import("undici").Dispatcher,
      rawFetch: async () => new Response("ok", { status: 200 }),
    });
    const res = await transport.fetchHop(new URL("https://api.example.com/v1"));
    expect(res.response.status).toBe(200);
    await transport.close();
    await expect(transport.fetchHop(new URL("https://api.example.com/v1"))).rejects.toThrow(/已退役关闭/);
  });

  it("supports wildcard *.example.test, whitespace-separated NO_PROXY, and lowercase env precedence", () => {
    const env = {
      HTTP_PROXY: "http://upper-proxy:8000",
      http_proxy: "http://lower-proxy:8001",
      NO_PROXY: "*.example.test   api.space.dev\t.dot.test",
    };
    expect(isNoProxyMatch(new URL("https://sub.example.test/v1"), env)).toBe(true);
    expect(isNoProxyMatch(new URL("https://example.test/v1"), env)).toBe(true);
    expect(isNoProxyMatch(new URL("https://api.space.dev/v1"), env)).toBe(true);
    expect(isNoProxyMatch(new URL("https://x.dot.test/v1"), env)).toBe(true);

    const noProxyRoute = resolveSingleHopRoute(new URL("https://sub.example.test/v1"), {
      proxyPolicy: "inherit",
      networkProxy: "auto",
      env,
    });
    expect(noProxyRoute.mode).toBe("direct");
    expect(noProxyRoute.dnsResolvedBy).toBe("local-controlled");

    const lowerPrecedenceRoute = resolveSingleHopRoute(new URL("http://public.other.test/v1"), {
      proxyPolicy: "inherit",
      networkProxy: "auto",
      env,
    });
    expect(lowerPrecedenceRoute.mode).toBe("proxy");
    expect(lowerPrecedenceRoute.proxyUrl).toBe("http://lower-proxy:8001");
  });

  it("connects cleanly to real localhost HTTP socket on Node 24 when explicitly permitted for that origin", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const transport = createControlledSingleHopTransport({
      proxyPolicy: "direct",
      allowPrivateOrigin: true,
      confirmedOrigin: `http://localhost:${port}`,
    });
    try {
      const { response } = await transport.fetchHop(new URL(`http://localhost:${port}/health`));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await transport.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
