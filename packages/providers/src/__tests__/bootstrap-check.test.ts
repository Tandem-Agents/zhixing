/**
 * checkBootstrap 必要字段判定纯函数测试。
 *
 * 关键不变量：
 *   - 必要字段缺失检测：main provider / model / apiKey + 异 provider secondary apiKey
 *   - fallback 路径认作合法填充：用户在 config.providers.<id>.apiKey 写
 *     env: / helper: / 明文 → checkBootstrap 视为已填，wizard 不重复询问
 *   - main provider 不存在时不"假装"查 apiKey（避免无意义的 missing 项）
 *   - secondary 同 main provider 时不重复加 secondary apiKey（复用 main）
 *   - humanLabel 对预设 provider 用 preset.name；非预设兜底用 providerId
 *   - 纯函数：不抛错 / 不读 fs / 多次调用结果一致
 */

import { describe, expect, it } from "vitest";
import { checkBootstrap } from "../bootstrap-check.js";
import type { ZhixingConfig, ZhixingCredentials } from "../types.js";

const empty = (): ZhixingConfig => ({});
const noCreds = (): ZhixingCredentials => ({ version: 1 });

const credsWith = (entries: Record<string, string>): ZhixingCredentials => ({
  version: 1,
  providers: Object.fromEntries(
    Object.entries(entries).map(([id, apiKey]) => [id, { apiKey }]),
  ),
});

describe("checkBootstrap · 必要字段判定", () => {
  it("完全空 config + 空 credentials → 报 main provider/model 缺失，不假装查 apiKey", () => {
    const missing = checkBootstrap(empty(), noCreds());
    const paths = missing.map((m) => m.path);

    expect(paths).toContain("config.llm.main.provider");
    expect(paths).toContain("config.llm.main.model");
    // mainProvider undefined → apiKey 检查跳过（不知道查哪个 provider）
    expect(paths.some((p) => p.endsWith(".apiKey"))).toBe(false);
  });

  it("完整 main + credentials 主路径 ✓ → []", () => {
    const missing = checkBootstrap(
      {
        llm: { main: { provider: "siliconflow", model: "Pro/MiniMaxAI/MiniMax-M2.5" } },
      },
      credsWith({ siliconflow: "sk-sf" }),
    );
    expect(missing).toEqual([]);
  });

  it("完整 main + config.apiKey fallback (env:VAR) → [] —— fallback 认作合法填充", () => {
    // 关键回归保护：CI / vault 高级用户走 fallback 路径，wizard 不应误触发
    const missing = checkBootstrap(
      {
        llm: { main: { provider: "siliconflow", model: "Pro/MiniMaxAI/MiniMax-M2.5" } },
        providers: { siliconflow: { apiKey: "env:SILICONFLOW_API_KEY" } },
      },
      noCreds(),
    );
    expect(missing).toEqual([]);
  });

  it("完整 main + config.apiKey fallback (helper:cmd) → [] —— vault helper 路径", () => {
    const missing = checkBootstrap(
      {
        llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
        providers: { deepseek: { apiKey: "helper:vault read /zhixing/deepseek-key" } },
      },
      noCreds(),
    );
    expect(missing).toEqual([]);
  });

  it("完整 main + config.apiKey 明文 → []", () => {
    const missing = checkBootstrap(
      {
        llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
        providers: { deepseek: { apiKey: "sk-plaintext" } },
      },
      noCreds(),
    );
    expect(missing).toEqual([]);
  });

  it("完整 main + 缺 apiKey → 报 credentials.providers.<main>.apiKey 缺失", () => {
    const missing = checkBootstrap(
      {
        llm: { main: { provider: "siliconflow", model: "Pro/MiniMaxAI/MiniMax-M2.5" } },
      },
      noCreds(),
    );

    expect(missing).toHaveLength(1);
    expect(missing[0]?.path).toBe("credentials.providers.siliconflow.apiKey");
    expect(missing[0]?.file).toBe("credentials");
  });

  it("main provider 配但 model 空字符串 → 报 main.model 缺失", () => {
    const missing = checkBootstrap(
      { llm: { main: { provider: "deepseek", model: "" } } },
      credsWith({ deepseek: "sk-ds" }),
    );
    const paths = missing.map((m) => m.path);
    expect(paths).toContain("config.llm.main.model");
  });

  it("secondary 显式同 provider → 不重复加 secondary apiKey（复用 main）", () => {
    const missing = checkBootstrap(
      {
        llm: {
          main: { provider: "deepseek", model: "deepseek-chat" },
          secondary: { provider: "deepseek", model: "deepseek-reasoner" },
        },
      },
      credsWith({ deepseek: "sk-ds" }),
    );
    expect(missing).toEqual([]);
  });

  it("secondary 显式不同 provider + 缺 secondary key → 报 secondary apiKey 缺", () => {
    const missing = checkBootstrap(
      {
        llm: {
          main: { provider: "deepseek", model: "deepseek-chat" },
          secondary: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
        },
      },
      credsWith({ deepseek: "sk-ds" }),
    );

    expect(missing).toHaveLength(1);
    expect(missing[0]?.path).toBe("credentials.providers.anthropic.apiKey");
    expect(missing[0]?.humanLabel).toContain("secondary");
  });

  it("secondary 显式不同 provider + 完整双 key → []", () => {
    const missing = checkBootstrap(
      {
        llm: {
          main: { provider: "deepseek", model: "deepseek-chat" },
          secondary: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
        },
      },
      credsWith({ deepseek: "sk-ds", anthropic: "sk-ant" }),
    );
    expect(missing).toEqual([]);
  });

  it("secondary 不同 provider 走 fallback (env:) → [] —— secondary 也认 fallback", () => {
    // secondary 解析链与 main 共用 resolveApiKey；fallback 等价对待
    const missing = checkBootstrap(
      {
        llm: {
          main: { provider: "deepseek", model: "deepseek-chat" },
          secondary: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
        },
        providers: {
          deepseek: { apiKey: "sk-ds" },
          anthropic: { apiKey: "env:ANTHROPIC_API_KEY" },
        },
      },
      noCreds(),
    );
    expect(missing).toEqual([]);
  });

  it("humanLabel 对预设 provider 包含 preset.name", () => {
    const missing = checkBootstrap(
      {
        llm: { main: { provider: "siliconflow", model: "Pro/MiniMaxAI/MiniMax-M2.5" } },
      },
      noCreds(),
    );
    expect(missing[0]?.humanLabel).toContain("硅基流动");
  });

  it("humanLabel 对非预设 provider 兜底用 providerId", () => {
    const missing = checkBootstrap(
      { llm: { main: { provider: "my-custom-gateway", model: "x" } } },
      noCreds(),
    );
    expect(missing[0]?.humanLabel).toContain("my-custom-gateway");
  });

  it("纯函数：相同输入多次调用结果一致，不副作用", () => {
    const config: ZhixingConfig = {
      llm: { main: { provider: "siliconflow", model: "Pro/MiniMaxAI/MiniMax-M2.5" } },
    };
    const creds = credsWith({ siliconflow: "sk-sf" });

    const a = checkBootstrap(config, creds);
    const b = checkBootstrap(config, creds);
    const c = checkBootstrap(config, creds);

    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("空字符串 apiKey 算缺失（与 undefined 同样视作未填）", () => {
    const missing = checkBootstrap(
      {
        llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
        providers: { deepseek: { apiKey: "" } },
      },
      { version: 1, providers: { deepseek: { apiKey: "" } } },
    );

    expect(missing).toHaveLength(1);
    expect(missing[0]?.path).toBe("credentials.providers.deepseek.apiKey");
  });
});
