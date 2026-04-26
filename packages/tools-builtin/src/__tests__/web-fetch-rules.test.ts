import { describe, expect, it } from "vitest";
import { WEB_FETCH_DEFAULT_RULES } from "../web-fetch-rules.js";

describe("WEB_FETCH_DEFAULT_RULES", () => {
  it("非空规则集", () => {
    expect(WEB_FETCH_DEFAULT_RULES.length).toBeGreaterThan(0);
  });

  it("每条规则 scope 必须是 builtin(防误用 global 写盘)", () => {
    for (const rule of WEB_FETCH_DEFAULT_RULES) {
      expect(rule.scope).toBe("builtin");
    }
  });

  it("每条规则 pattern.tool 必须是 web_fetch", () => {
    for (const rule of WEB_FETCH_DEFAULT_RULES) {
      expect(rule.pattern.tool).toBe("web_fetch");
    }
  });

  it("每条规则 decision 必须是 allow", () => {
    for (const rule of WEB_FETCH_DEFAULT_RULES) {
      expect(rule.decision).toBe("allow");
    }
  });

  it("每条规则 argument 形如 https://{host}/** ", () => {
    for (const rule of WEB_FETCH_DEFAULT_RULES) {
      expect(rule.pattern.argument).toMatch(/^https:\/\/[a-z0-9.-]+\/\*\*$/);
    }
  });

  it("每条规则有 id (UUID 形态)", () => {
    for (const rule of WEB_FETCH_DEFAULT_RULES) {
      expect(rule.id).toMatch(/^[0-9a-f-]{36}$/i);
    }
  });

  it("覆盖关键文档站点", () => {
    const args = WEB_FETCH_DEFAULT_RULES.map((r) => r.pattern.argument);
    const expected = [
      "https://developer.mozilla.org/**",
      "https://github.com/**",
      "https://docs.python.org/**",
      "https://en.wikipedia.org/**",
      "https://docs.anthropic.com/**",
    ];
    for (const e of expected) {
      expect(args).toContain(e);
    }
  });

  it("无重复规则(host 唯一)", () => {
    const args = WEB_FETCH_DEFAULT_RULES.map((r) => r.pattern.argument);
    expect(new Set(args).size).toBe(args.length);
  });

  it("每条规则 id 唯一", () => {
    const ids = WEB_FETCH_DEFAULT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
