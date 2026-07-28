import { describe, expect, it } from "vitest";
import { FEISHU_DEFAULTS, resolveConfig } from "./config.js";

const credentials = {
  appId: "id",
  appSecret: "secret",
  verificationToken: "verification",
  encryptKey: "encryption",
};

describe("resolveConfig", () => {
  it("resolves with required credentials", () => {
    const config = resolveConfig(credentials);
    expect(config.appId).toBe("id");
    expect(config.appSecret).toBe("secret");
    expect(config.verificationToken).toBe("verification");
    expect(config.encryptKey).toBe("encryption");
    expect(config.domain).toBe("feishu");
  });

  it("throws when appId is missing", () => {
    expect(() => resolveConfig({ appSecret: "s" })).toThrow("appId");
  });

  it("throws when appSecret is missing", () => {
    expect(() => resolveConfig({ appId: "id" })).toThrow("appSecret");
  });

  it("requires the complete signed callback credential pair", () => {
    expect(() =>
      resolveConfig({ appId: "id", appSecret: "secret" }),
    ).toThrow("verificationToken");
    expect(() =>
      resolveConfig({
        appId: "id",
        appSecret: "secret",
        verificationToken: "verification",
      }),
    ).toThrow("encryptKey");
  });

  it("applies domain override from options", () => {
    const config = resolveConfig(credentials, { domain: "lark" });
    expect(config.domain).toBe("lark");
  });

  it("rejects invalid domain", () => {
    expect(() =>
      resolveConfig(credentials, { domain: "wechat" }),
    ).toThrow("Invalid Feishu domain");
  });

  it("applies dedup options", () => {
    const config = resolveConfig(
      credentials,
      { dedupTtlMs: 5000, dedupMaxSize: 100 },
    );
    expect(config.dedupTtlMs).toBe(5000);
    expect(config.dedupMaxSize).toBe(100);
  });

  it("rejects non-number dedupTtlMs", () => {
    expect(() =>
      resolveConfig({ appId: "id", appSecret: "s" }, { dedupTtlMs: "abc" }),
    ).toThrow("Invalid dedupTtlMs");
  });

  it("rejects negative dedupMaxSize", () => {
    expect(() =>
      resolveConfig({ appId: "id", appSecret: "s" }, { dedupMaxSize: -1 }),
    ).toThrow("Invalid dedupMaxSize");
  });

  it("accepts botOpenId string", () => {
    const config = resolveConfig(
      credentials,
      { botOpenId: "ou_bot1" },
    );
    expect(config.botOpenId).toBe("ou_bot1");
  });

  it("rejects non-string botOpenId", () => {
    expect(() =>
      resolveConfig(credentials, { botOpenId: 123 }),
    ).toThrow("Invalid botOpenId");
  });

  it("uses defaults for unspecified options", () => {
    const config = resolveConfig(credentials);
    expect(config.dedupTtlMs).toBe(FEISHU_DEFAULTS.dedupTtlMs);
    expect(config.dedupMaxSize).toBe(FEISHU_DEFAULTS.dedupMaxSize);
    expect(config.botOpenId).toBeUndefined();
  });
});
