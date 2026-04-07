import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS } from "../presets.js";
import { ProviderConfigError, resolveFromConfig, resolveProvider } from "../resolve.js";
import { DEFAULT_QUIRKS } from "../types.js";

// 测试用的 mock 环境变量
const mockEnv = (overrides: Record<string, string> = {}): Record<string, string | undefined> => ({
  ...overrides,
});

describe("resolveProvider", () => {
  // ─── 内置预设场景 ───

  describe("内置预设 provider", () => {
    it("只提供 apiKey 时应使用预设的所有默认值", () => {
      const resolved = resolveProvider(
        "deepseek",
        { apiKey: "sk-test-key" },
        mockEnv(),
      );

      expect(resolved.id).toBe("deepseek");
      expect(resolved.name).toBe("DeepSeek");
      expect(resolved.baseUrl).toBe("https://api.deepseek.com");
      expect(resolved.protocol).toBe("openai-compatible");
      expect(resolved.apiKey).toBe("sk-test-key");
      expect(resolved.defaultModel).toBe("deepseek-chat");
    });

    it("apiKey 为空对象时应从环境变量自动解析", () => {
      const resolved = resolveProvider(
        "deepseek",
        {},
        mockEnv({ DEEPSEEK_API_KEY: "sk-from-env" }),
      );

      expect(resolved.apiKey).toBe("sk-from-env");
    });

    it("用户配置应覆盖预设的 baseUrl", () => {
      const resolved = resolveProvider(
        "deepseek",
        {
          baseUrl: "https://my-proxy.com/v1",
          apiKey: "sk-proxy-key",
        },
        mockEnv(),
      );

      expect(resolved.baseUrl).toBe("https://my-proxy.com/v1");
      expect(resolved.protocol).toBe("openai-compatible");
    });

    it("用户配置应覆盖预设的 defaultModel", () => {
      const resolved = resolveProvider(
        "deepseek",
        {
          apiKey: "sk-test",
          defaultModel: "deepseek-reasoner",
        },
        mockEnv(),
      );

      expect(resolved.defaultModel).toBe("deepseek-reasoner");
    });

    it("用户 quirks 应与预设 quirks 合并（用户优先）", () => {
      const resolved = resolveProvider(
        "openai",
        {
          apiKey: "sk-test",
          quirks: { supportsThinking: true },
        },
        mockEnv(),
      );

      expect(resolved.quirks.supportsThinking).toBe(true);
      // 预设的 maxTokensField 应保留
      expect(resolved.quirks.maxTokensField).toBe("max_completion_tokens");
    });
  });

  // ─── env: 格式 ───

  describe("apiKey env: 格式", () => {
    it("应从指定环境变量读取 apiKey", () => {
      const resolved = resolveProvider(
        "deepseek",
        { apiKey: "env:MY_CUSTOM_KEY" },
        mockEnv({ MY_CUSTOM_KEY: "sk-custom" }),
      );

      expect(resolved.apiKey).toBe("sk-custom");
    });

    it("环境变量不存在时应报错", () => {
      expect(() => {
        resolveProvider(
          "deepseek",
          { apiKey: "env:NONEXISTENT_KEY" },
          mockEnv(),
        );
      }).toThrow(ProviderConfigError);
      expect(() => {
        resolveProvider(
          "deepseek",
          { apiKey: "env:NONEXISTENT_KEY" },
          mockEnv(),
        );
      }).toThrow("NONEXISTENT_KEY");
    });
  });

  // ─── 自定义 provider ───

  describe("自定义 provider（不在预设列表）", () => {
    it("提供完整配置时应正常解析", () => {
      const resolved = resolveProvider(
        "my-local-llm",
        {
          baseUrl: "http://localhost:11434/v1",
          protocol: "openai-compatible",
          apiKey: "not-needed",
        },
        mockEnv(),
      );

      expect(resolved.id).toBe("my-local-llm");
      expect(resolved.name).toBe("my-local-llm");
      expect(resolved.baseUrl).toBe("http://localhost:11434/v1");
      expect(resolved.protocol).toBe("openai-compatible");
      // 自定义 provider 应使用最保守的默认 quirks
      expect(resolved.quirks).toEqual(DEFAULT_QUIRKS);
    });

    it("缺少 baseUrl 时应报错", () => {
      expect(() => {
        resolveProvider(
          "unknown-provider",
          { apiKey: "sk-test" },
          mockEnv(),
        );
      }).toThrow(ProviderConfigError);
      expect(() => {
        resolveProvider(
          "unknown-provider",
          { apiKey: "sk-test" },
          mockEnv(),
        );
      }).toThrow("baseUrl");
    });

    it("缺少 protocol 时应报错", () => {
      expect(() => {
        resolveProvider(
          "unknown-provider",
          { baseUrl: "http://localhost:8080", apiKey: "sk-test" },
          mockEnv(),
        );
      }).toThrow(ProviderConfigError);
      expect(() => {
        resolveProvider(
          "unknown-provider",
          { baseUrl: "http://localhost:8080", apiKey: "sk-test" },
          mockEnv(),
        );
      }).toThrow("protocol");
    });
  });

  // ─── API Key 缺失 ───

  describe("API Key 缺失", () => {
    it("预设 provider 无 key、无环境变量时应报错并提示", () => {
      expect(() => {
        resolveProvider("deepseek", {}, mockEnv());
      }).toThrow(ProviderConfigError);
      expect(() => {
        resolveProvider("deepseek", {}, mockEnv());
      }).toThrow("DEEPSEEK_API_KEY");
    });

    it("自定义 provider 无 key 时应报错", () => {
      expect(() => {
        resolveProvider(
          "custom",
          { baseUrl: "http://x", protocol: "openai-compatible" },
          mockEnv(),
        );
      }).toThrow(ProviderConfigError);
    });
  });

  // ─── baseUrl 规范化 ───

  describe("baseUrl 规范化", () => {
    it("应移除末尾斜杠", () => {
      const resolved = resolveProvider(
        "deepseek",
        { baseUrl: "https://api.deepseek.com/v1/", apiKey: "sk-test" },
        mockEnv(),
      );

      expect(resolved.baseUrl).toBe("https://api.deepseek.com/v1");
    });

    it("应移除多个末尾斜杠", () => {
      const resolved = resolveProvider(
        "deepseek",
        { baseUrl: "https://example.com///", apiKey: "sk-test" },
        mockEnv(),
      );

      expect(resolved.baseUrl).toBe("https://example.com");
    });
  });

  // ─── 所有内置预设的完整性 ───

  describe("内置预设完整性", () => {
    const requiredPresets = [
      "deepseek", "minimax", "siliconflow", "qwen", "kimi", "glm", "openai", "anthropic",
    ];

    for (const id of requiredPresets) {
      it(`预设 "${id}" 应存在且有完整必填字段`, () => {
        const preset = PROVIDER_PRESETS[id];
        expect(preset).toBeDefined();
        expect(preset?.name).toBeTruthy();
        expect(preset?.baseUrl).toBeTruthy();
        expect(preset?.protocol).toBeTruthy();
      });
    }

    it("每个预设在提供 apiKey 后应能成功解析", () => {
      for (const id of requiredPresets) {
        const resolved = resolveProvider(id, { apiKey: "sk-test" }, mockEnv());
        expect(resolved.id).toBe(id);
        expect(resolved.baseUrl).toBeTruthy();
        expect(resolved.protocol).toBeTruthy();
        expect(resolved.apiKey).toBe("sk-test");
      }
    });
  });
});

describe("resolveFromConfig", () => {
  it("应使用 config.defaultProvider 作为默认", () => {
    const resolved = resolveFromConfig(
      {
        defaultProvider: "deepseek",
        providers: {
          deepseek: { apiKey: "sk-test" },
        },
      },
      undefined,
      mockEnv(),
    );

    expect(resolved.id).toBe("deepseek");
  });

  it("显式指定 providerId 应覆盖 defaultProvider", () => {
    const resolved = resolveFromConfig(
      {
        defaultProvider: "deepseek",
        providers: {
          deepseek: { apiKey: "sk-ds" },
          openai: { apiKey: "sk-oai" },
        },
      },
      "openai",
      mockEnv(),
    );

    expect(resolved.id).toBe("openai");
    expect(resolved.apiKey).toBe("sk-oai");
  });

  it("config.defaultModel 应作为 fallback", () => {
    const resolved = resolveFromConfig(
      {
        defaultProvider: "siliconflow",
        defaultModel: "Pro/MiniMaxAI/MiniMax-M2.5",
        providers: {
          siliconflow: { apiKey: "sk-test" },
        },
      },
      undefined,
      mockEnv(),
    );

    expect(resolved.defaultModel).toBe("Pro/MiniMaxAI/MiniMax-M2.5");
  });

  it("provider 自己的 defaultModel 应优先于 config.defaultModel", () => {
    const resolved = resolveFromConfig(
      {
        defaultProvider: "deepseek",
        defaultModel: "global-model",
        providers: {
          deepseek: { apiKey: "sk-test" },
        },
      },
      undefined,
      mockEnv(),
    );

    // deepseek 预设有 defaultModel: "deepseek-chat"，应优先
    expect(resolved.defaultModel).toBe("deepseek-chat");
  });

  it("未指定 provider 且无 defaultProvider 时应报错", () => {
    expect(() => {
      resolveFromConfig({}, undefined, mockEnv());
    }).toThrow(ProviderConfigError);
  });

  it("provider 未在 config.providers 中配置时应尝试纯预设解析", () => {
    const resolved = resolveFromConfig(
      { defaultProvider: "deepseek" },
      undefined,
      mockEnv({ DEEPSEEK_API_KEY: "sk-env" }),
    );

    expect(resolved.apiKey).toBe("sk-env");
  });
});
