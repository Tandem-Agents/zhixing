/**
 * 二级 LLM 能力解析与工厂行为
 *
 * 覆盖：
 * - main 三段优先级（modelOverride > providerOverride+defaultModel > config 原值）
 * - secondary 解析链（显式 / 用 main 兜底）—— 不预设任何 vendor 默认
 * - Provider 实例复用（同 provider 共享）
 * - 错误文案（缺 llm.main / providerOverride 无默认 / 显式 secondary 缺凭证）
 * - bindRole 的 model 实绑契约
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChatRequest,
  LLMProvider,
  StreamEvent,
} from "@zhixing/core";
import { ProviderConfigError, resolveLLMRoles } from "../resolve.js";
import { bindRole, createProviderRoles } from "../create-provider.js";
import type {
  ProviderCredentialEntry,
  ZhixingConfig,
  ZhixingCredentials,
} from "../types.js";

const noCreds = (): ZhixingCredentials => ({});

const credsFor = (entries: Record<string, string>): ZhixingCredentials => ({
  providers: Object.fromEntries(
    Object.entries(entries).map(([id, apiKey]) => [id, { apiKey }]),
  ),
});

const credsWith = (
  entries: Record<string, ProviderCredentialEntry>,
): ZhixingCredentials => ({
  providers: { ...entries },
});

const baseConfig = (overrides: Partial<ZhixingConfig> = {}): ZhixingConfig => ({
  llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
  ...overrides,
});

const baseCreds = (): ZhixingCredentials => credsFor({ deepseek: "sk-ds" });

describe("resolveLLMRoles · main 三段优先级", () => {
  it("无 override → 使用 config.llm.main", () => {
    const result = resolveLLMRoles(baseConfig(), baseCreds(), {});
    expect(result.main.resolved.id).toBe("deepseek");
    expect(result.main.model).toBe("deepseek-chat");
  });

  it("modelOverride 单独 → provider 不变，model 替换", () => {
    const result = resolveLLMRoles(
      baseConfig(),
      baseCreds(),
      { modelOverride: "deepseek-reasoner" },
    );
    expect(result.main.resolved.id).toBe("deepseek");
    expect(result.main.model).toBe("deepseek-reasoner");
  });

  it("providerOverride 单独 → 切换 provider，model 跟随新 provider 预设默认", () => {
    const result = resolveLLMRoles(
      baseConfig(),
      credsFor({ deepseek: "sk-ds", openai: "sk-oai" }),
      { providerOverride: "openai" },
    );
    expect(result.main.resolved.id).toBe("openai");
    // openai preset 默认 model
    expect(result.main.model).toBe("gpt-4o");
  });

  it("providerOverride + 新自定义 provider 无 defaultModel → throw", () => {
    expect(() => {
      resolveLLMRoles(
        baseConfig(),
        credsWith({
          deepseek: { apiKey: "sk-ds" },
          "my-local": {
            apiKey: "sk-local",
            baseUrl: "http://localhost:8080",
            protocol: "openai-compatible",
          },
        }),
        { providerOverride: "my-local" },
      );
    }).toThrow(/--provider "my-local" requires --model/);
  });

  it("providerOverride + modelOverride → 完全自定义组合", () => {
    const result = resolveLLMRoles(
      baseConfig(),
      credsFor({ deepseek: "sk-ds", openai: "sk-oai" }),
      { providerOverride: "openai", modelOverride: "gpt-4o-mini" },
    );
    expect(result.main.resolved.id).toBe("openai");
    expect(result.main.model).toBe("gpt-4o-mini");
  });

  it("缺 llm.main → throw 含迁移提示", () => {
    expect(() => {
      resolveLLMRoles({} as ZhixingConfig, noCreds(), {});
    }).toThrow(ProviderConfigError);
    expect(() => {
      resolveLLMRoles({} as ZhixingConfig, noCreds(), {});
    }).toThrow(/llm\.main is required/);
  });
});

describe("resolveLLMRoles · secondary 解析链（2 段）", () => {
  // 解析链刻意保持 2 段——显式 / 用 main 兜底。**不**预设任何 vendor 默认。
  // 历史上的 SECONDARY_DEFAULT=anthropic 是 vendor lock-in 错误，已删除：知行
  // provider 中立，不替用户挑选 secondary vendor；用户想专门化就显式配
  // llm.secondary，不配就用 main 兜底（仍保留调用上下文隔离价值）。

  it("显式 secondary 配置 → 直接使用", () => {
    const result = resolveLLMRoles(
      baseConfig({
        llm: {
          main: { provider: "deepseek", model: "deepseek-chat" },
          secondary: { provider: "openai", model: "gpt-4o-mini" },
        },
      }),
      credsFor({ deepseek: "sk-ds", openai: "sk-oai" }),
      {},
    );
    expect(result.secondary.resolved.id).toBe("openai");
    expect(result.secondary.model).toBe("gpt-4o-mini");
  });

  it("缺省 secondary → 直接用 main 实例 + main.model 兜底", () => {
    const result = resolveLLMRoles(baseConfig(), baseCreds(), {});
    // 用 main 兜底——secondary === main 在配置层
    expect(result.secondary.resolved).toBe(result.main.resolved);
    expect(result.secondary.model).toBe(result.main.model);
    expect(result.secondary.resolved.id).toBe("deepseek");
    expect(result.secondary.model).toBe("deepseek-chat");
  });

  it("缺省 secondary + main 用任意 provider → 兜底语义对所有 vendor 一致", () => {
    // 验证兜底逻辑无 vendor 偏见——main 是 anthropic / openai / siliconflow 等
    // 任何 provider 时，缺省路径行为一致：secondary === main。
    for (const [providerId, model, apiKey] of [
      ["anthropic", "claude-opus-4-5", "sk-ant"],
      ["openai", "gpt-4o", "sk-oai"],
      ["siliconflow", "Pro/MiniMaxAI/MiniMax-M2", "sk-sf"],
      ["qwen", "qwen3-coder-plus", "sk-qwen"],
    ] as const) {
      const result = resolveLLMRoles(
        { llm: { main: { provider: providerId, model } } },
        credsFor({ [providerId]: apiKey }),
        {},
      );
      expect(result.secondary.resolved).toBe(result.main.resolved);
      expect(result.secondary.model).toBe(model);
    }
  });

  it("显式 secondary 缺凭证 → fail-fast 不静默兜底", () => {
    // 显式配置代表用户意图，必须 fail-fast——不能静默把"用户期望的双 provider
    // 架构"伪装成单 provider 在跑。
    expect(() => {
      resolveLLMRoles(
        baseConfig({
          llm: {
            main: { provider: "deepseek", model: "deepseek-chat" },
            secondary: { provider: "openai", model: "gpt-4o-mini" },
          },
        }),
        credsFor({ deepseek: "sk-ds" }), // openai 凭证缺失
        {},
      );
    }).toThrow(ProviderConfigError);
  });

  it("main 任一 override 不影响 secondary 解析路径", () => {
    const result = resolveLLMRoles(
      baseConfig({
        llm: {
          main: { provider: "deepseek", model: "deepseek-chat" },
          secondary: { provider: "openai", model: "gpt-4o-mini" },
        },
      }),
      credsFor({ deepseek: "sk-ds", openai: "sk-oai" }),
      { providerOverride: "openai", modelOverride: "gpt-4o" },
    );
    expect(result.main.resolved.id).toBe("openai");
    expect(result.main.model).toBe("gpt-4o");
    // secondary 不动——但因为现在 main 也变成 openai，触发同 id 复用
    expect(result.secondary.resolved.id).toBe("openai");
    expect(result.secondary.model).toBe("gpt-4o-mini");
    expect(result.secondary.resolved).toBe(result.main.resolved); // 同 id 复用
  });
});

describe("resolveLLMRoles · 同 provider id 复用（避免重复 resolveProvider）", () => {
  it("显式 secondary 同 id 时复用 main.resolved（不重 resolveProvider）", () => {
    const result = resolveLLMRoles(
      baseConfig({
        llm: {
          main: { provider: "deepseek", model: "deepseek-reasoner" },
          secondary: { provider: "deepseek", model: "deepseek-chat" },
        },
      }),
      baseCreds(),
      {},
    );
    expect(result.main.resolved.id).toBe("deepseek");
    expect(result.secondary.resolved).toBe(result.main.resolved); // 复用引用
    expect(result.main.model).toBe("deepseek-reasoner");
    expect(result.secondary.model).toBe("deepseek-chat"); // 各自 model 独立
  });

  it("不同 id 时不触发短路（回归保护）", () => {
    const result = resolveLLMRoles(
      baseConfig({
        llm: {
          main: { provider: "deepseek", model: "deepseek-chat" },
          secondary: { provider: "openai", model: "gpt-4o-mini" },
        },
      }),
      credsFor({ deepseek: "sk-ds", openai: "sk-oai" }),
      {},
    );
    expect(result.secondary.resolved).not.toBe(result.main.resolved);
    expect(result.main.resolved.id).toBe("deepseek");
    expect(result.secondary.resolved.id).toBe("openai");
  });
});

describe("bindRole · chat 调用时 model 字段实绑契约", () => {
  function makeSpyProvider(): { provider: LLMProvider; calls: ChatRequest[] } {
    const calls: ChatRequest[] = [];
    const provider: LLMProvider = {
      id: "spy",
      models: [],
      // eslint-disable-next-line require-yield
      chat: async function* (
        request: ChatRequest,
      ): AsyncGenerator<StreamEvent, void, undefined> {
        calls.push(request);
        yield { type: "message_start" };
        yield {
          type: "message_end",
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    return { provider, calls };
  }

  async function drain(role: ReturnType<typeof bindRole>): Promise<void> {
    for await (const _ of role.chat({ messages: [] })) {
      // 不消费，仅驱动 generator
    }
  }

  it("chat({...}) 调用时 provider 收到 request.model === 绑定 model", async () => {
    const { provider, calls } = makeSpyProvider();
    const role = bindRole(provider, "bound-model-xyz");

    await drain(role);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("bound-model-xyz");
  });

  it("多个 role 共享同一 provider 时各自绑定独立 model 不串", async () => {
    const { provider, calls } = makeSpyProvider();
    const roleA = bindRole(provider, "model-A");
    const roleB = bindRole(provider, "model-B");

    await drain(roleA);
    await drain(roleB);
    await drain(roleA); // 再调一次 A 验证 closure 不会被 B 污染

    expect(calls.map((c) => c.model)).toEqual(["model-A", "model-B", "model-A"]);
  });

  it("role.provider / role.model 暴露绑定时的引用与值", () => {
    const { provider } = makeSpyProvider();
    const role = bindRole(provider, "static-model");

    expect(role.provider).toBe(provider);
    expect(role.model).toBe("static-model");
  });
});

describe("createProviderRoles · 实例化与角色装配", () => {
  let tmpDir: string;
  let configPath: string;
  let credentialsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhixing-llm-roles-"));
    configPath = path.join(tmpDir, "config.jsonc");
    credentialsPath = path.join(tmpDir, "credentials.json");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function writeFixture(config: ZhixingConfig, creds: ZhixingCredentials): void {
    fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");
    fs.writeFileSync(credentialsPath, JSON.stringify(creds), "utf-8");
  }

  function envFor(): Record<string, string | undefined> {
    return { ZHIXING_CONFIG_PATH: configPath };
  }

  it("缺省 secondary → main/secondary 共享同一 LLMProvider 实例", () => {
    writeFixture(baseConfig(), baseCreds());
    const { roles } = createProviderRoles({ env: envFor() });

    expect(roles.main.provider).toBe(roles.secondary.provider);
    expect(roles.main.model).toBe(roles.secondary.model);
  });

  it("不同 provider id → 各自独立 LLMProvider 实例", () => {
    writeFixture(
      {
        llm: {
          main: { provider: "deepseek", model: "deepseek-chat" },
          secondary: { provider: "openai", model: "gpt-4o-mini" },
        },
      },
      credsFor({ deepseek: "sk-ds", openai: "sk-oai" }),
    );
    const { roles } = createProviderRoles({ env: envFor() });

    expect(roles.main.provider).not.toBe(roles.secondary.provider);
    expect(roles.main.provider.id).toBe("deepseek");
    expect(roles.secondary.provider.id).toBe("openai");
  });

  it("LLMRole.chat 调用透传 model（caller 不传 model）", async () => {
    writeFixture(
      { llm: { main: { provider: "deepseek", model: "deepseek-reasoner" } } },
      baseCreds(),
    );
    const { roles } = createProviderRoles({ env: envFor() });

    expect(roles.main.model).toBe("deepseek-reasoner");
    // chat() 是绑定方法——签名不再需要 model 字段
    const chatFn = roles.main.chat;
    expect(typeof chatFn).toBe("function");
  });

  it("CLI override 同时透传到 effective state（roles.main.{provider.id, model}）", () => {
    writeFixture(
      baseConfig(),
      credsFor({ deepseek: "sk-ds", openai: "sk-oai" }),
    );
    const { roles } = createProviderRoles({
      env: envFor(),
      providerOverride: "openai",
      modelOverride: "gpt-4o-mini",
    });

    expect(roles.main.provider.id).toBe("openai");
    expect(roles.main.model).toBe("gpt-4o-mini");
  });

  it("resolvedRoles 暴露 protocol 等中间产物（CLI 用于 budget 解析）", () => {
    writeFixture(
      { llm: { main: { provider: "anthropic", model: "claude-sonnet-4-20250514" } } },
      credsFor({ anthropic: "sk-ant" }),
    );
    const { resolvedRoles } = createProviderRoles({ env: envFor() });

    expect(resolvedRoles.main.resolved.protocol).toBe("anthropic-messages");
    expect(resolvedRoles.main.model).toBe("claude-sonnet-4-20250514");
    // 当前 preset 不内嵌 catalog——budget 兜底交给 protocol-default
    expect(resolvedRoles.main.resolved.declaredModels).toEqual([]);
  });

  it("modelOverrides 从 credentials 透传到 ResolvedProvider", () => {
    writeFixture(
      { llm: { main: { provider: "deepseek", model: "deepseek-chat" } } },
      credsWith({
        deepseek: {
          apiKey: "sk-ds",
          modelOverrides: {
            "deepseek-chat": { contextWindow: 64000 },
          },
        },
      }),
    );
    const { resolvedRoles } = createProviderRoles({ env: envFor() });

    expect(resolvedRoles.main.resolved.modelOverrides).toEqual({
      "deepseek-chat": { contextWindow: 64000 },
    });
  });

  it("网关型 provider（无 preset）走空 declaredModels —— catalog 兜底交给 protocol-default", () => {
    writeFixture(
      { llm: { main: { provider: "siliconflow", model: "Pro/MiniMaxAI/MiniMax-M2.5" } } },
      credsFor({ siliconflow: "sk-sf" }),
    );
    const { roles, resolvedRoles } = createProviderRoles({ env: envFor() });

    expect(resolvedRoles.main.resolved.protocol).toBe("openai-compatible");
    expect(resolvedRoles.main.resolved.declaredModels).toEqual([]);
    expect(roles.main.provider.models).toEqual([]);
  });
});
