/**
 * checkBootstrap 必要字段判定纯函数测试。
 *
 * 关键不变量：
 *   - 必要字段缺失检测：main provider / model / apiKey + 异 provider secondary apiKey
 *   - apiKey 唯一来源：credentials.providers.<id>.apiKey；
 *     config.json 不参与凭证判定（任何 apiKey 字段在 config 都会被 schema 校验拒绝）
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

  it("完整 main + 缺 credentials apiKey → 报 credentials.providers.<main>.apiKey 缺失", () => {
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
      { llm: { main: { provider: "deepseek", model: "deepseek-chat" } } },
      { version: 1, providers: { deepseek: { apiKey: "" } } },
    );

    expect(missing).toHaveLength(1);
    expect(missing[0]?.path).toBe("credentials.providers.deepseek.apiKey");
  });
});
