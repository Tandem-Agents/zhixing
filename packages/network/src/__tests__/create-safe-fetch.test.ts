import { describe, expect, it } from "vitest";
import { createSafeFetch } from "../safe-fetcher.js";

describe("createSafeFetch", () => {
  it("返回标准 fetch 形态的函数", () => {
    expect(typeof createSafeFetch()).toBe("function");
  });

  it("字面内网 IP 同步抛 SSRF（不发起连接）", async () => {
    const fetch = createSafeFetch();
    await expect(fetch("http://127.0.0.1:8080/x")).rejects.toThrow(/SSRF/);
    await expect(fetch("http://10.1.2.3/x")).rejects.toThrow(/SSRF/);
    await expect(fetch("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
      /SSRF/,
    );
  });

  it("非法 URL / 受限协议被网络策略拒（不发起连接）", async () => {
    const fetch = createSafeFetch();
    await expect(fetch("ftp://example.com")).rejects.toThrow(/network policy/);
    await expect(fetch("not-a-url")).rejects.toThrow(/network policy/);
  });

  it("proxy=off 时仍构造成功（直连 + SSRF 防护）", () => {
    expect(typeof createSafeFetch({ proxy: "off" })).toBe("function");
  });

  it("close 释放连接池且不抛", async () => {
    await expect(createSafeFetch().close()).resolves.toBeUndefined();
  });
});
