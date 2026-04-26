import { Agent, EnvHttpProxyAgent, ProxyAgent } from "undici";
import { describe, expect, it } from "vitest";
import {
  createDispatcher,
  describeProxy,
  hasProxyEnvConfigured,
  redactProxyUrl,
  resolveProxy,
} from "../safe-fetcher-internal.js";
import { DEFAULT_BLOCKED_NETWORKS } from "../url-guard.js";

const EMPTY_ENV: NodeJS.ProcessEnv = {};
const PROXY_URL = "http://127.0.0.1:7890";

describe("hasProxyEnvConfigured", () => {
  it("空 env 返回 false", () => {
    expect(hasProxyEnvConfigured(EMPTY_ENV)).toBe(false);
  });

  it.each([
    ["HTTP_PROXY", "大写 HTTP"],
    ["HTTPS_PROXY", "大写 HTTPS"],
    ["http_proxy", "小写 http"],
    ["https_proxy", "小写 https"],
  ])("识别 %s (%s)", (key) => {
    expect(hasProxyEnvConfigured({ [key]: PROXY_URL })).toBe(true);
  });

  it("两种大小写同时存在也是 true", () => {
    expect(
      hasProxyEnvConfigured({ HTTP_PROXY: PROXY_URL, https_proxy: PROXY_URL }),
    ).toBe(true);
  });
});

describe("resolveProxy", () => {
  it('"off" 返回 null', () => {
    expect(resolveProxy("off", { HTTPS_PROXY: PROXY_URL })).toBeNull();
  });

  it('"off" 即使 env 有也返回 null', () => {
    expect(resolveProxy("off", { HTTPS_PROXY: PROXY_URL, HTTP_PROXY: PROXY_URL })).toBeNull();
  });

  it("undefined + 无 env 返回 null", () => {
    expect(resolveProxy(undefined, EMPTY_ENV)).toBeNull();
  });

  it('"auto" + 无 env 返回 null', () => {
    expect(resolveProxy("auto", EMPTY_ENV)).toBeNull();
  });

  it('"auto" + HTTPS_PROXY 优先于 HTTP_PROXY', () => {
    const result = resolveProxy("auto", {
      HTTPS_PROXY: "http://https-proxy:9000",
      HTTP_PROXY: "http://http-proxy:8000",
    });
    expect(result).toBe("http://https-proxy:9000");
  });

  it('"auto" + 大写优先于小写', () => {
    const result = resolveProxy("auto", {
      HTTP_PROXY: "http://upper:8000",
      https_proxy: "http://lower:9000",
    });
    expect(result).toBe("http://upper:8000");
  });

  it('"auto" + 仅小写 https_proxy', () => {
    const result = resolveProxy("auto", { https_proxy: "http://lower-https:9000" });
    expect(result).toBe("http://lower-https:9000");
  });

  it('"auto" + 仅小写 http_proxy(优先级最低)', () => {
    const result = resolveProxy("auto", { http_proxy: "http://lower-http:8000" });
    expect(result).toBe("http://lower-http:8000");
  });

  it("undefined 等价于 auto(行为一致)", () => {
    const env = { HTTPS_PROXY: PROXY_URL };
    expect(resolveProxy(undefined, env)).toBe(resolveProxy("auto", env));
  });

  it("显式 URL 直接返回(不查 env)", () => {
    expect(resolveProxy("http://explicit:1234", { HTTPS_PROXY: PROXY_URL })).toBe(
      "http://explicit:1234",
    );
  });
});

describe("resolveProxy - scheme-aware (targetUrl)", () => {
  const ENV = {
    HTTPS_PROXY: "http://https-proxy:9000",
    HTTP_PROXY: "http://http-proxy:8000",
  };

  it("不传 targetUrl → HTTPS_PROXY 优先(legacy 行为)", () => {
    expect(resolveProxy("auto", ENV)).toBe("http://https-proxy:9000");
  });

  it("https target → HTTPS_PROXY 优先", () => {
    expect(resolveProxy("auto", ENV, "https://docs.python.org/3/")).toBe(
      "http://https-proxy:9000",
    );
  });

  it("http target → HTTP_PROXY 优先(对齐 EnvHttpProxyAgent)", () => {
    expect(resolveProxy("auto", ENV, "http://example.com/")).toBe(
      "http://http-proxy:8000",
    );
  });

  it("http target + 仅 HTTPS_PROXY → fallback HTTPS_PROXY", () => {
    expect(
      resolveProxy("auto", { HTTPS_PROXY: "http://https-proxy:9000" }, "http://example.com/"),
    ).toBe("http://https-proxy:9000");
  });

  it("https target + 仅 HTTP_PROXY → fallback HTTP_PROXY", () => {
    expect(
      resolveProxy("auto", { HTTP_PROXY: "http://http-proxy:8000" }, "https://example.com/"),
    ).toBe("http://http-proxy:8000");
  });

  it("URL 实例参数也支持(避免 string 解析重复)", () => {
    expect(resolveProxy("auto", ENV, new URL("http://example.com/"))).toBe(
      "http://http-proxy:8000",
    );
  });

  it("非法 targetUrl → 沿用 https-first(防御,不抛错)", () => {
    expect(resolveProxy("auto", ENV, "not-a-url")).toBe("http://https-proxy:9000");
  });

  it("非 http(s) 协议(如 ftp:) → 沿用 https-first(防御)", () => {
    expect(resolveProxy("auto", ENV, "ftp://example.com/")).toBe("http://https-proxy:9000");
  });

  it("explicit URL 不受 targetUrl 影响", () => {
    expect(
      resolveProxy("http://forced:1111", ENV, "http://example.com/"),
    ).toBe("http://forced:1111");
  });

  it('"off" 不受 targetUrl 影响,始终 null', () => {
    expect(resolveProxy("off", ENV, "https://example.com/")).toBeNull();
  });
});

describe("redactProxyUrl", () => {
  it("无 auth 的 URL 原样返回", () => {
    expect(redactProxyUrl("http://proxy.example:8080")).toBe("http://proxy.example:8080");
  });

  it("user:password 完全脱敏(明文不出现)", () => {
    const out = redactProxyUrl("http://admin:secret@proxy.example:8080");
    expect(out).toContain("***");
    expect(out).toContain("proxy.example");
    expect(out).toContain("8080");
    expect(out).not.toContain("secret");
    expect(out).not.toContain("admin");
  });

  it("仅 username(无 password)也脱敏(username 本身可能敏感)", () => {
    const out = redactProxyUrl("http://admin@proxy.example:8080");
    expect(out).toContain("***");
    expect(out).not.toContain("admin");
  });

  it("非法 URL 原样返回(不抛异常)", () => {
    expect(redactProxyUrl("not-a-url")).toBe("not-a-url");
    expect(redactProxyUrl("")).toBe("");
  });

  it("幂等(已脱敏的 URL 再传 hostname/port 不变)", () => {
    const once = redactProxyUrl("http://admin:secret@proxy.example:8080");
    const twice = redactProxyUrl(once);
    expect(twice).toBe(once);
  });

  it("HTTPS proxy URL 也支持", () => {
    const out = redactProxyUrl("https://user:pwd@corp:443");
    expect(out).not.toContain("pwd");
    expect(out).not.toContain("user@");
    expect(out).toContain("corp");
  });

  it("URL 编码的特殊字符密码也完全脱敏", () => {
    const out = redactProxyUrl("http://u:p%40ss@host:80");
    expect(out).not.toContain("p%40ss");
    expect(out).not.toContain("p@ss");
  });
});

describe("describeProxy", () => {
  const EMPTY: NodeJS.ProcessEnv = {};
  const WITH_ENV: NodeJS.ProcessEnv = { HTTPS_PROXY: PROXY_URL };

  it('"off" → mode=off, resolved=null, display 含 "off"', () => {
    const d = describeProxy("off", WITH_ENV);
    expect(d.mode).toBe("off");
    expect(d.resolved).toBeNull();
    expect(d.display).toContain("off");
    expect(d.display).toContain("disabled");
  });

  it('"auto" + 有 env → mode=auto, resolved=URL, display 含 "auto: from env"', () => {
    const d = describeProxy("auto", WITH_ENV);
    expect(d.mode).toBe("auto");
    expect(d.resolved).toBe(PROXY_URL);
    expect(d.display).toContain("auto");
    expect(d.display).toContain("from env");
    expect(d.display).toContain("127.0.0.1:7890");
  });

  it('"auto" + 无 env → mode=auto, resolved=null, display 含 "direct"', () => {
    const d = describeProxy("auto", EMPTY);
    expect(d.mode).toBe("auto");
    expect(d.resolved).toBeNull();
    expect(d.display).toContain("direct");
    expect(d.display).toContain("no");
  });

  it("undefined 等价于 auto(任何 env 下行为一致)", () => {
    expect(describeProxy(undefined, EMPTY)).toEqual(describeProxy("auto", EMPTY));
    expect(describeProxy(undefined, WITH_ENV)).toEqual(describeProxy("auto", WITH_ENV));
  });

  it('explicit URL → mode=explicit, resolved=URL, display 含 "from config"', () => {
    const d = describeProxy("http://explicit:1234", EMPTY);
    expect(d.mode).toBe("explicit");
    expect(d.resolved).toBe("http://explicit:1234");
    expect(d.display).toContain("config");
    expect(d.display).toContain("explicit:1234");
  });

  it("display 永远脱敏(含凭证 URL — explicit 路径)", () => {
    const d = describeProxy("http://admin:secret@corp:8443", EMPTY);
    expect(d.mode).toBe("explicit");
    expect(d.display).not.toContain("secret");
    expect(d.display).not.toContain("admin");
    // resolved 保留原始(供未来需要重连/比对)
    expect(d.resolved).toBe("http://admin:secret@corp:8443");
  });

  it("display 永远脱敏(含凭证 URL — auto/env 路径)", () => {
    const d = describeProxy("auto", { HTTPS_PROXY: "http://admin:secret@proxy:8080" });
    expect(d.mode).toBe("auto");
    expect(d.display).not.toContain("secret");
    expect(d.display).not.toContain("admin");
    expect(d.resolved).toBe("http://admin:secret@proxy:8080");
  });

  it("四态判别穷尽 — TS 编译时即穷尽,运行时可用 mode 字段 switch", () => {
    const cases = [
      describeProxy("off"),
      describeProxy("auto", EMPTY),
      describeProxy("auto", WITH_ENV),
      describeProxy("http://explicit:1234"),
    ];
    const modes = cases.map((c) => c.mode);
    expect(modes).toEqual(["off", "auto", "auto", "explicit"]);
  });
});

describe("createDispatcher", () => {
  // 注: 不能用 vi.stubEnv 因为 createDispatcher 内部 hasProxyEnvConfigured() 走默认 process.env
  // 真实场景 process.env 可能含 HTTP_PROXY,所以"auto + 无 env"分支不能在所有运行环境稳定测
  // 此处测试 4 种分支的"返回 dispatcher 类型"——靠 instanceof 区分

  it('"off" 返回 Agent (带 lookup hook 的 PinnedAgent)', () => {
    const d = createDispatcher(DEFAULT_BLOCKED_NETWORKS, "off");
    expect(d).toBeInstanceOf(Agent);
    expect(d).not.toBeInstanceOf(EnvHttpProxyAgent);
    expect(d).not.toBeInstanceOf(ProxyAgent);
  });

  it("显式 proxy URL 返回 ProxyAgent", () => {
    const d = createDispatcher(DEFAULT_BLOCKED_NETWORKS, PROXY_URL);
    expect(d).toBeInstanceOf(ProxyAgent);
  });

  it("显式 https proxy URL 也返回 ProxyAgent", () => {
    const d = createDispatcher(DEFAULT_BLOCKED_NETWORKS, "https://proxy:443");
    expect(d).toBeInstanceOf(ProxyAgent);
  });

  // "auto" 分支的行为依赖 process.env 实际状态,不在单测覆盖
  // (有 env 时返回 EnvHttpProxyAgent,无 env 时返回 PinnedAgent)
  // 安全契约层面: 4 个分支返回的 dispatcher 都不应抛异常
  it('"auto" 分支构造不抛异常(行为依赖 process.env 实际状态)', () => {
    expect(() => createDispatcher(DEFAULT_BLOCKED_NETWORKS, "auto")).not.toThrow();
    expect(() => createDispatcher(DEFAULT_BLOCKED_NETWORKS, undefined)).not.toThrow();
  });
});
