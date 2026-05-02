import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS } from "../presets.js";
import { ProviderConfigError, resolveFromConfig, resolveProvider } from "../resolve.js";
import { DEFAULT_QUIRKS, type ZhixingCredentials } from "../types.js";

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
    it("只填 credentials 即用预设的所有默认值", () => {
      const resolved = resolveProvider(
        "deepseek",
        {},
        credsFor({ deepseek: "sk-test-key" }),
      );

      expect(resolved.id).toBe("deepseek");
      expect(resolved.name).toBe("DeepSeek");
      expect(resolved.baseUrl).toBe("https://api.deepseek.com");
      expect(resolved.protocol).toBe("openai-compatible");
      expect(resolved.apiKey).toBe("sk-test-key");
      expect(resolved.defaultModel).toBe("deepseek-chat");
    });

    it("用户配置覆盖预设的 baseUrl", () => {
      const resolved = resolveProvider(
        "deepseek",
        { baseUrl: "https://my-proxy.com/v1" },
        credsFor({ deepseek: "sk-proxy-key" }),
      );

      expect(resolved.baseUrl).toBe("https://my-proxy.com/v1");
      expect(resolved.protocol).toBe("openai-compatible");
    });

    it("用户配置覆盖预设的 defaultModel", () => {
      const resolved = resolveProvider(
        "deepseek",
        { defaultModel: "deepseek-reasoner" },
        credsFor({ deepseek: "sk-test" }),
      );

      expect(resolved.defaultModel).toBe("deepseek-reasoner");
    });

    it("用户 quirks 与预设 quirks 合并（用户优先）", () => {
      const resolved = resolveProvider(
        "openai",
        { quirks: { supportsThinking: true } },
        credsFor({ openai: "sk-test" }),
      );

      expect(resolved.quirks.supportsThinking).toBe(true);
      // 预设的 maxTokensField 应保留
      expect(resolved.quirks.maxTokensField).toBe("max_completion_tokens");
    });
  });

  // ─── 自定义 provider ───

  describe("自定义 provider（不在预设列表）", () => {
    it("提供完整配置 + credentials 时应正常解析", () => {
      const resolved = resolveProvider(
        "my-local-llm",
        {
          baseUrl: "http://localhost:11434/v1",
          protocol: "openai-compatible",
        },
        credsFor({ "my-local-llm": "not-needed" }),
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
          {},
          credsFor({ "unknown-provider": "sk-test" }),
        );
      }).toThrow(ProviderConfigError);
      expect(() => {
        resolveProvider(
          "unknown-provider",
          {},
          credsFor({ "unknown-provider": "sk-test" }),
        );
      }).toThrow("baseUrl");
    });

    it("缺少 protocol 时应报错", () => {
      expect(() => {
        resolveProvider(
          "unknown-provider",
          { baseUrl: "http://localhost:8080" },
          credsFor({ "unknown-provider": "sk-test" }),
        );
      }).toThrow(ProviderConfigError);
      expect(() => {
        resolveProvider(
          "unknown-provider",
          { baseUrl: "http://localhost:8080" },
          credsFor({ "unknown-provider": "sk-test" }),
        );
      }).toThrow("protocol");
    });
  });

  // ─── API Key 缺失（凭证唯一入口） ───

  describe("API Key 缺失", () => {
    it("credentials 没填时抛错并引向 credentials.json", () => {
      expect(() => {
        resolveProvider("deepseek", {}, noCreds());
      }).toThrow(ProviderConfigError);
      expect(() => {
        resolveProvider("deepseek", {}, noCreds());
      }).toThrow(/credentials\.json/);
      expect(() => {
        resolveProvider("deepseek", {}, noCreds());
      }).toThrow(/缺少 API Key/);
    });

    it("错误消息含 schema 示例引导用户编辑", () => {
      try {
        resolveProvider("deepseek", {}, noCreds());
        expect.fail("应抛 ProviderConfigError");
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain("providers");
        expect(message).toContain("apiKey");
        expect(message).toContain("zhixing");
      }
    });

    it("自定义 provider 无 key 时报错", () => {
      expect(() => {
        resolveProvider(
          "custom",
          { baseUrl: "http://x", protocol: "openai-compatible" },
          noCreds(),
        );
      }).toThrow(ProviderConfigError);
    });

    it("错误消息不再提及废弃的 fallback 语法（契约：单档 credentials.json）", () => {
      // 回归保护：未来谁把 env:VAR / helper:cmd 引导加回错误消息时触发——凭证唯一入口
      // 必须是 credentials.json，错误消息不应推荐任何替代路径。
      try {
        resolveProvider("deepseek", {}, noCreds());
        expect.fail("应抛 ProviderConfigError");
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toMatch(/env:VAR/i);
        expect(message).not.toMatch(/helper:/i);
        expect(message).not.toMatch(/fallback/i);
      }
    });
  });

  // ─── baseUrl 规范化 ───

  describe("baseUrl 规范化", () => {
    it("应移除末尾斜杠", () => {
      const resolved = resolveProvider(
        "deepseek",
        { baseUrl: "https://api.deepseek.com/v1/" },
        credsFor({ deepseek: "sk-test" }),
      );

      expect(resolved.baseUrl).toBe("https://api.deepseek.com/v1");
    });

    it("应移除多个末尾斜杠", () => {
      const resolved = resolveProvider(
        "deepseek",
        { baseUrl: "https://example.com///" },
        credsFor({ deepseek: "sk-test" }),
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

    it("每个预设在 credentials 提供 apiKey 后能成功解析", () => {
      for (const id of requiredPresets) {
        const resolved = resolveProvider(id, {}, credsFor({ [id]: "sk-test" }));
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
      { llm: { main: { provider: "deepseek", model: "deepseek-chat" } } },
      credsFor({ deepseek: "sk-test" }),
    );

    expect(resolved.id).toBe("deepseek");
  });

  it("显式指定 providerId 应覆盖 llm.main.provider", () => {
    const resolved = resolveFromConfig(
      { llm: { main: { provider: "deepseek", model: "deepseek-chat" } } },
      credsFor({ deepseek: "sk-ds", openai: "sk-oai" }),
      "openai",
    );

    expect(resolved.id).toBe("openai");
    expect(resolved.apiKey).toBe("sk-oai");
  });

  it("无 llm.main 时应报错并提示迁移路径", () => {
    expect(() => {
      resolveFromConfig({} as never, noCreds());
    }).toThrow(ProviderConfigError);
    expect(() => {
      resolveFromConfig({} as never, noCreds());
    }).toThrow(/llm\.main is required/);
  });

  it("provider 未在 config.providers 中时凭证仍命中", () => {
    const resolved = resolveFromConfig(
      { llm: { main: { provider: "deepseek", model: "deepseek-chat" } } },
      credsFor({ deepseek: "sk-from-credentials" }),
    );

    expect(resolved.apiKey).toBe("sk-from-credentials");
  });
});
