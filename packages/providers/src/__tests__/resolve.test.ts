import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS } from "../presets.js";
import { ProviderConfigError, resolveFromConfig, resolveProvider } from "../resolve.js";
import { DEFAULT_QUIRKS, type ZhixingCredentials } from "../types.js";

const mockEnv = (overrides: Record<string, string> = {}): Record<string, string | undefined> => ({
  ...overrides,
});

const noCreds = (): ZhixingCredentials => ({ version: 1 });

const credsFor = (entries: Record<string, string>): ZhixingCredentials => ({
  version: 1,
  providers: Object.fromEntries(
    Object.entries(entries).map(([id, apiKey]) => [id, { apiKey }]),
  ),
});

describe("resolveProvider", () => {
  // ─── 内置预设场景 ───

  describe("内置预设 provider", () => {
    it("只提供 apiKey 时应使用预设的所有默认值", () => {
      const resolved = resolveProvider(
        "deepseek",
        { apiKey: "sk-test-key" },
        noCreds(),
        mockEnv(),
      );

      expect(resolved.id).toBe("deepseek");
      expect(resolved.name).toBe("DeepSeek");
      expect(resolved.baseUrl).toBe("https://api.deepseek.com");
      expect(resolved.protocol).toBe("openai-compatible");
      expect(resolved.apiKey).toBe("sk-test-key");
      expect(resolved.defaultModel).toBe("deepseek-chat");
    });

    it("credentials.providers.<id>.apiKey 是主路径，无 config.apiKey 也命中", () => {
      const resolved = resolveProvider(
        "deepseek",
        {},
        credsFor({ deepseek: "sk-from-credentials" }),
        mockEnv(),
      );

      expect(resolved.apiKey).toBe("sk-from-credentials");
    });

    it("credentials 与 config.apiKey 同时存在时 credentials 优先", () => {
      const resolved = resolveProvider(
        "deepseek",
        { apiKey: "sk-config-fallback" },
        credsFor({ deepseek: "sk-credentials-primary" }),
        mockEnv(),
      );

      expect(resolved.apiKey).toBe("sk-credentials-primary");
    });

    it("用户配置应覆盖预设的 baseUrl", () => {
      const resolved = resolveProvider(
        "deepseek",
        {
          baseUrl: "https://my-proxy.com/v1",
          apiKey: "sk-proxy-key",
        },
        noCreds(),
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
        noCreds(),
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
        noCreds(),
        mockEnv(),
      );

      expect(resolved.quirks.supportsThinking).toBe(true);
      // 预设的 maxTokensField 应保留
      expect(resolved.quirks.maxTokensField).toBe("max_completion_tokens");
    });
  });

  // ─── config.apiKey fallback 三种格式 ───

  describe("config.apiKey fallback：env: 格式", () => {
    it("应从指定环境变量读取 apiKey", () => {
      const resolved = resolveProvider(
        "deepseek",
        { apiKey: "env:MY_CUSTOM_KEY" },
        noCreds(),
        mockEnv({ MY_CUSTOM_KEY: "sk-custom" }),
      );

      expect(resolved.apiKey).toBe("sk-custom");
    });

    it("环境变量不存在时应报错", () => {
      expect(() => {
        resolveProvider(
          "deepseek",
          { apiKey: "env:NONEXISTENT_KEY" },
          noCreds(),
          mockEnv(),
        );
      }).toThrow(ProviderConfigError);
      expect(() => {
        resolveProvider(
          "deepseek",
          { apiKey: "env:NONEXISTENT_KEY" },
          noCreds(),
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
        noCreds(),
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
          noCreds(),
          mockEnv(),
        );
      }).toThrow(ProviderConfigError);
      expect(() => {
        resolveProvider(
          "unknown-provider",
          { apiKey: "sk-test" },
          noCreds(),
          mockEnv(),
        );
      }).toThrow("baseUrl");
    });

    it("缺少 protocol 时应报错", () => {
      expect(() => {
        resolveProvider(
          "unknown-provider",
          { baseUrl: "http://localhost:8080", apiKey: "sk-test" },
          noCreds(),
          mockEnv(),
        );
      }).toThrow(ProviderConfigError);
      expect(() => {
        resolveProvider(
          "unknown-provider",
          { baseUrl: "http://localhost:8080", apiKey: "sk-test" },
          noCreds(),
          mockEnv(),
        );
      }).toThrow("protocol");
    });
  });

  // ─── API Key 缺失 ───

  describe("API Key 缺失", () => {
    it("credentials 与 config.apiKey 都没填时应抛错并引导首次配置", () => {
      expect(() => {
        resolveProvider("deepseek", {}, noCreds(), mockEnv());
      }).toThrow(ProviderConfigError);
      expect(() => {
        resolveProvider("deepseek", {}, noCreds(), mockEnv());
      }).toThrow(/credentials\.json/);
      expect(() => {
        resolveProvider("deepseek", {}, noCreds(), mockEnv());
      }).toThrow(/缺少 API Key/);
    });

    it("自定义 provider 无 key 时应报错", () => {
      expect(() => {
        resolveProvider(
          "custom",
          { baseUrl: "http://x", protocol: "openai-compatible" },
          noCreds(),
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
        noCreds(),
        mockEnv(),
      );

      expect(resolved.baseUrl).toBe("https://api.deepseek.com/v1");
    });

    it("应移除多个末尾斜杠", () => {
      const resolved = resolveProvider(
        "deepseek",
        { baseUrl: "https://example.com///", apiKey: "sk-test" },
        noCreds(),
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
        const resolved = resolveProvider(id, { apiKey: "sk-test" }, noCreds(), mockEnv());
        expect(resolved.id).toBe(id);
        expect(resolved.baseUrl).toBeTruthy();
        expect(resolved.protocol).toBeTruthy();
        expect(resolved.apiKey).toBe("sk-test");
      }
    });
  });
});

describe("resolveFromConfig", () => {
  it("应使用 config.llm.main.provider 作为默认", () => {
    const resolved = resolveFromConfig(
      {
        llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
        providers: {
          deepseek: { apiKey: "sk-test" },
        },
      },
      noCreds(),
      undefined,
      mockEnv(),
    );

    expect(resolved.id).toBe("deepseek");
  });

  it("显式指定 providerId 应覆盖 llm.main.provider", () => {
    const resolved = resolveFromConfig(
      {
        llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
        providers: {
          deepseek: { apiKey: "sk-ds" },
          openai: { apiKey: "sk-oai" },
        },
      },
      noCreds(),
      "openai",
      mockEnv(),
    );

    expect(resolved.id).toBe("openai");
    expect(resolved.apiKey).toBe("sk-oai");
  });

  it("无 llm.main 时应报错并提示迁移路径", () => {
    expect(() => {
      resolveFromConfig({} as never, noCreds(), undefined, mockEnv());
    }).toThrow(ProviderConfigError);
    expect(() => {
      resolveFromConfig({} as never, noCreds(), undefined, mockEnv());
    }).toThrow(/llm\.main is required/);
  });

  it("provider 未在 config.providers 中时凭证仍命中（credentials.json 主路径）", () => {
    const resolved = resolveFromConfig(
      { llm: { main: { provider: "deepseek", model: "deepseek-chat" } } },
      credsFor({ deepseek: "sk-from-credentials" }),
      undefined,
      mockEnv(),
    );

    expect(resolved.apiKey).toBe("sk-from-credentials");
  });
});
