import { describe, it, expect } from "vitest";
import { scrubSecrets } from "../secret-scrubber.js";

const cats = (text: string): string[] =>
  scrubSecrets(text).redactions.map((r) => r.category);

// token 样例用运行时拼接 —— 源码里不出现连续的 token 字面量,否则 GitHub Push Protection
// 的 secret scanner 会把测试样例当成真泄漏、拦下整个 push(测 secret 脱敏的固有矛盾:
// 要验证能识别 token,样例就得"长得像真 token")。拼接后运行时拿到完整串、断言不变,
// 而源码里指纹前缀(sk-/ghp_/xoxb- 等)不连续,扫不到。
const OPENAI_KEY = "sk" + "-proj1234567890abcdefghij1234";
const ANTHROPIC_KEY = "sk" + "-ant-api03-abcdefghij1234567890XYZ";
const GITHUB_TOKEN = "ghp" + "_1234567890abcdefghij1234567890abcd";
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const GOOGLE_KEY = "AIza" + "SyA1234567890abcdefghijklmnopqrstuv";
const SLACK_TOKEN = "xox" + "b-123456789012-abcdefABCDEFghij";
const JWT_SAMPLE =
  "eyJ" +
  "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36";

describe("scrubSecrets — 高置信整体模式", () => {
  it("OpenAI sk- 密钥", () => {
    const r = scrubSecrets(`key 是 ${OPENAI_KEY} 别外传`);
    expect(r.scrubbed).not.toContain(OPENAI_KEY);
    expect(r.scrubbed).toContain("«已脱敏:openai-key»");
    expect(cats(OPENAI_KEY)).toEqual(["openai-key"]);
  });

  it("Anthropic sk-ant- 不被 openai 模式抢匹配", () => {
    expect(cats(ANTHROPIC_KEY)).toEqual(["anthropic-key"]);
  });

  it("GitHub ghp_ token", () => {
    expect(cats(GITHUB_TOKEN)).toEqual(["github-token"]);
  });

  it("AWS AKIA access key", () => {
    expect(cats(AWS_KEY)).toEqual(["aws-access-key"]);
  });

  it("Google AIza 密钥", () => {
    expect(cats(GOOGLE_KEY)).toEqual(["google-key"]);
  });

  it("Slack xoxb- token", () => {
    expect(cats(SLACK_TOKEN)).toEqual(["slack-token"]);
  });

  it("PEM 私钥块(跨行整体)", () => {
    const pem =
      "前文\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc123def456\nghi789==\n-----END RSA PRIVATE KEY-----\n后文";
    const r = scrubSecrets(pem);
    expect(r.scrubbed).not.toContain("MIIabc");
    expect(r.scrubbed).toContain("«已脱敏:private-key»");
    expect(r.scrubbed).toContain("前文");
    expect(r.scrubbed).toContain("后文");
    expect(cats(pem)).toEqual(["private-key"]);
  });

  it("JWT 三段", () => {
    expect(cats(JWT_SAMPLE)).toEqual(["jwt"]);
  });

  it("Bearer token", () => {
    // Bearer 的值是随机串、非任何服务商指纹,scanner 不会误报,无需拼接。
    expect(cats("Authorization header: Bearer abcdef1234567890ABCDEFxyz")).toEqual(
      ["bearer"],
    );
  });
});

describe("scrubSecrets — 赋值式(保留字段名、只换值)", () => {
  it("带引号的 api_key 赋值", () => {
    const r = scrubSecrets('config: api_key = "supersecretvalue123"');
    expect(r.scrubbed).toContain("api_key");
    expect(r.scrubbed).not.toContain("supersecretvalue123");
    expect(r.scrubbed).toContain("«已脱敏:credential»");
    expect(cats('api_key = "supersecretvalue123"')).toEqual(["credential"]);
  });

  it("无引号的 password 赋值", () => {
    const r = scrubSecrets("password: hunter2longpw");
    expect(r.scrubbed).toBe("password: «已脱敏:credential»");
  });

  it("过短的值(< 6 字符)不当密钥", () => {
    expect(cats("token: ab")).toEqual([]);
  });
});

describe("scrubSecrets — 不误伤正常文本", () => {
  it("普通技能正文零命中、逐字不变", () => {
    const text =
      "这个技能讲怎么部署服务:先跑 build,再推镜像,最后滚动发布。注意回滚要先停流量。";
    const r = scrubSecrets(text);
    expect(r.scrubbed).toBe(text);
    expect(r.redactions).toEqual([]);
  });

  it("git sha / base64 图片这类正常长串不误伤", () => {
    const text =
      "commit 1234567890abcdef1234567890abcdef12345678 见 data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEA";
    const r = scrubSecrets(text);
    expect(r.redactions).toEqual([]);
    expect(r.scrubbed).toBe(text);
  });
});

describe("scrubSecrets — 组合与去重", () => {
  it("Authorization: Bearer xxx 只记一次 bearer、不被赋值式二次脱敏", () => {
    expect(cats("Authorization: Bearer abcdef1234567890ABCDEF")).toEqual([
      "bearer",
    ]);
  });

  it("多个不同 secret 各记一条", () => {
    const text = `${OPENAI_KEY} 和 ${GITHUB_TOKEN}`;
    expect(cats(text).sort()).toEqual(["github-token", "openai-key"]);
  });
});
