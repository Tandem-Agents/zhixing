import { describe, expect, it } from "vitest";
import { createTransport } from "../transport.js";

describe("createTransport", () => {
  it("stdio：构造成功（仅构造，不 spawn 子进程）", () => {
    const t = createTransport({
      serverId: "demo",
      transport: "stdio",
      command: "echo",
    });
    expect(t.transport).toBeDefined();
    expect(t.dispose).toBeUndefined(); // stdio 无额外连接池资源
  });

  it("stdio 缺 command → 抛错", () => {
    expect(() =>
      createTransport({ serverId: "demo", transport: "stdio" }),
    ).toThrow(/command/);
  });

  it("http：构造成功（注入 SSRF-safe fetch，仅构造、不连接）", () => {
    const t = createTransport(
      { serverId: "demo", transport: "http", url: "https://example.com/mcp" },
      { proxy: "off" },
    );
    expect(t.transport).toBeDefined();
    expect(t.dispose).toBeDefined(); // http 持有连接池，需 dispose 释放
  });

  it("http 缺 url → 抛错", () => {
    expect(() =>
      createTransport({ serverId: "demo", transport: "http" }),
    ).toThrow(/url/);
  });
});
