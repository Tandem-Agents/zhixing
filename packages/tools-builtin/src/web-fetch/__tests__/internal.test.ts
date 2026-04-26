import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cacheKey,
  contentCache,
  decodeBody,
  detectCharset,
  isHtmlContent,
  processContent,
} from "../internal.js";

beforeEach(() => {
  contentCache.clear();
});

afterEach(() => {
  contentCache.clear();
});

describe("contentCache LRU", () => {
  it("set / get 基础", () => {
    contentCache.set("a", "value-a");
    expect(contentCache.get("a")).toBe("value-a");
  });

  it("get 未命中返回 undefined", () => {
    expect(contentCache.get("missing")).toBeUndefined();
  });

  it("clear 清空所有", () => {
    contentCache.set("a", "1");
    contentCache.set("b", "2");
    contentCache.clear();
    expect(contentCache.size).toBe(0);
  });

  it("超容量时驱逐最旧条目", () => {
    // 容量 50,塞 51 个,第一个应被驱逐
    for (let i = 0; i < 51; i++) {
      contentCache.set(`k${i}`, `v${i}`);
    }
    expect(contentCache.size).toBe(50);
    expect(contentCache.get("k0")).toBeUndefined();
    expect(contentCache.get("k50")).toBe("v50");
  });

  it("get 命中后该项变为最新(LRU 行为)", () => {
    for (let i = 0; i < 50; i++) {
      contentCache.set(`k${i}`, `v${i}`);
    }
    // 访问 k0,使其变为最新
    expect(contentCache.get("k0")).toBe("v0");
    // 再插入一个新 key,容量满 → 驱逐次最旧 k1(不是 k0)
    contentCache.set("k50", "v50");
    expect(contentCache.get("k0")).toBe("v0");
    expect(contentCache.get("k1")).toBeUndefined();
  });

  it("set 已存在 key 更新且变为最新", () => {
    contentCache.set("a", "v1");
    contentCache.set("b", "v2");
    contentCache.set("a", "v1-updated");
    expect(contentCache.get("a")).toBe("v1-updated");
    expect(contentCache.size).toBe(2);
  });
});

describe("cacheKey", () => {
  it("拼接 url 与 format", () => {
    expect(cacheKey("https://a.com/", "markdown")).toBe("https://a.com/|markdown");
    expect(cacheKey("https://a.com/", "text")).toBe("https://a.com/|text");
  });
});

describe("detectCharset", () => {
  it("Content-Type charset 优先", () => {
    const headers = new Headers({ "content-type": "text/html; charset=GBK" });
    expect(detectCharset(headers, new Uint8Array())).toBe("gbk");
  });

  it("charset 带引号也能解析", () => {
    const headers = new Headers({ "content-type": 'text/html; charset="utf-8"' });
    expect(detectCharset(headers, new Uint8Array())).toBe("utf-8");
  });

  it("UTF-8 BOM 识别", () => {
    const body = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    expect(detectCharset(new Headers(), body)).toBe("utf-8");
  });

  it("UTF-16 LE BOM 识别", () => {
    const body = new Uint8Array([0xff, 0xfe, 0x68, 0x00]);
    expect(detectCharset(new Headers(), body)).toBe("utf-16le");
  });

  it("UTF-16 BE BOM 识别", () => {
    const body = new Uint8Array([0xfe, 0xff, 0x00, 0x68]);
    expect(detectCharset(new Headers(), body)).toBe("utf-16be");
  });

  it("无 header 无 BOM 默认 utf-8", () => {
    expect(detectCharset(new Headers(), new Uint8Array([0x68, 0x69]))).toBe("utf-8");
  });

  it("Content-Type 无 charset 参数时不命中,继续走 BOM/默认", () => {
    const headers = new Headers({ "content-type": "text/html" });
    expect(detectCharset(headers, new Uint8Array())).toBe("utf-8");
  });
});

describe("decodeBody", () => {
  it("utf-8 正常解码", () => {
    const body = new TextEncoder().encode("hello 你好");
    expect(decodeBody(body, "utf-8")).toBe("hello 你好");
  });

  it("不支持的 charset 退回 utf-8 不抛异常", () => {
    const body = new TextEncoder().encode("hello");
    expect(decodeBody(body, "fake-charset-xyz")).toBe("hello");
  });
});

describe("isHtmlContent", () => {
  it("text/html 返回 true", () => {
    expect(isHtmlContent(new Headers({ "content-type": "text/html" }))).toBe(true);
  });

  it("text/html; charset=utf-8 返回 true", () => {
    expect(isHtmlContent(new Headers({ "content-type": "text/html; charset=utf-8" }))).toBe(true);
  });

  it("application/xhtml+xml 返回 true", () => {
    expect(isHtmlContent(new Headers({ "content-type": "application/xhtml+xml" }))).toBe(true);
  });

  it("application/json 返回 false", () => {
    expect(isHtmlContent(new Headers({ "content-type": "application/json" }))).toBe(false);
  });

  it("无 Content-Type header 返回 false", () => {
    expect(isHtmlContent(new Headers())).toBe(false);
  });

  it("大小写不敏感", () => {
    expect(isHtmlContent(new Headers({ "content-type": "TEXT/HTML" }))).toBe(true);
  });
});

describe("processContent", () => {
  function makeResult(contentType: string, bodyText: string) {
    return {
      status: 200,
      headers: new Headers({ "content-type": contentType }),
      body: new TextEncoder().encode(bodyText),
      finalUrl: "https://example.com/",
      redirectChain: ["https://example.com/"] as readonly string[],
    };
  }

  it("HTML markdown 模式: 用 turndown 转 markdown", async () => {
    const html = "<h1>Title</h1><p>Hello <strong>world</strong></p>";
    const result = makeResult("text/html", html);
    const md = await processContent(result, "markdown");
    expect(md).toContain("# Title");
    expect(md).toContain("**world**");
  });

  it("HTML text 模式: 去标签", async () => {
    const html = "<h1>Title</h1><p>Hello <strong>world</strong></p>";
    const result = makeResult("text/html", html);
    const text = await processContent(result, "text");
    expect(text).not.toContain("<");
    expect(text).toContain("Title");
    expect(text).toContain("Hello");
    expect(text).toContain("world");
  });

  it("非 HTML(text/plain): 原样返回", async () => {
    const result = makeResult("text/plain", "raw text content");
    expect(await processContent(result, "markdown")).toBe("raw text content");
  });

  it("非 HTML(application/json): 原样返回", async () => {
    const result = makeResult("application/json", '{"key":"value"}');
    expect(await processContent(result, "markdown")).toBe('{"key":"value"}');
  });

  it("HTML 无标签内容: turndown 输出空白或近似空", async () => {
    const result = makeResult("text/html", "<div></div>");
    const md = await processContent(result, "markdown");
    expect(md.trim()).toBe("");
  });

  it("含 charset 标签时按声明解码", async () => {
    const text = "你好 hello";
    const body = new TextEncoder().encode(text);
    const result = {
      status: 200,
      headers: new Headers({ "content-type": "text/plain; charset=utf-8" }),
      body,
      finalUrl: "https://example.com/",
      redirectChain: ["https://example.com/"] as readonly string[],
    };
    expect(await processContent(result, "text")).toBe(text);
  });
});
