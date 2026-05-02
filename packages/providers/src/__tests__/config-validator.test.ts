/**
 * 配置语义校验测试。
 *
 * 关键不变量：
 *   - 凭证字段（任何形态）出现在 config.providers.<id>.apiKey → 违反
 *   - 密字段（含 secret/token/password/apiKey 命名）出现在 config.channels.<id>.credentials → 违反
 *   - 非密字段（appId / clientId / accountId / botId / agentId / userId 等）通过
 *   - 多个 issue 一次扫出
 *   - issue 三段式（field / reason / fix），fix 含具体 schema 示例
 *   - 可插拔：自定义 validator 替换或扩展内置
 *   - 纯函数：不抛错 / 不读 fs
 */

import { describe, expect, it } from "vitest";
import {
  BUILTIN_VALIDATORS,
  ConfigSemanticError,
  validateConfigSemantics,
  type ConfigValidator,
} from "../config-validator.js";
import type { ZhixingConfig } from "../types.js";

describe("validateConfigSemantics · 干净 config", () => {
  it("空 config → 无 issue", () => {
    expect(validateConfigSemantics({})).toEqual([]);
  });

  it("只有 llm.main → 无 issue", () => {
    const config: ZhixingConfig = {
      llm: { main: { provider: "siliconflow", model: "Pro/MiniMaxAI/MiniMax-M2.5" } },
    };
    expect(validateConfigSemantics(config)).toEqual([]);
  });

  it("providers 含非 apiKey 字段（baseUrl/protocol/quirks）→ 无 issue", () => {
    const config: ZhixingConfig = {
      providers: {
        "my-gateway": {
          baseUrl: "http://localhost:8080",
          protocol: "openai-compatible",
          quirks: { supportsTools: true },
        },
      },
    };
    expect(validateConfigSemantics(config)).toEqual([]);
  });

  it("channels 仅含非密字段（appId / clientId / accountId 等）→ 无 issue", () => {
    const config: ZhixingConfig = {
      channels: {
        feishu: {
          credentials: { appId: "cli_xxxxx" },
        },
        wecom: {
          credentials: { clientId: "ww_xxxxx", accountId: "acc_xxxxx" },
        },
        slack: {
          credentials: { botId: "B12345", agentId: "A12345", userId: "U12345" },
        },
      },
    };
    expect(validateConfigSemantics(config)).toEqual([]);
  });
});

describe("validateNoApiKeyInConfig · providers.<id>.apiKey 字段废弃", () => {
  it("config.providers.<id>.apiKey 明文 → 命中", () => {
    const config = {
      providers: { siliconflow: { apiKey: "sk-plaintext" } },
    } as unknown as ZhixingConfig;

    const issues = validateConfigSemantics(config);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("providers.siliconflow.apiKey");
  });

  it("env:VAR 形态也命中（不再保留 fallback 语法）", () => {
    const config = {
      providers: { siliconflow: { apiKey: "env:SILICONFLOW_API_KEY" } },
    } as unknown as ZhixingConfig;

    const issues = validateConfigSemantics(config);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("providers.siliconflow.apiKey");
  });

  it("helper:cmd 形态也命中", () => {
    const config = {
      providers: { siliconflow: { apiKey: "helper:vault read /zhixing/sf-key" } },
    } as unknown as ZhixingConfig;

    expect(validateConfigSemantics(config)).toHaveLength(1);
  });

  it("多个 provider 各自命中 → 多 issue", () => {
    const config = {
      providers: {
        siliconflow: { apiKey: "sk-sf" },
        openai: { apiKey: "sk-oai" },
        anthropic: { apiKey: "sk-ant" },
      },
    } as unknown as ZhixingConfig;

    const issues = validateConfigSemantics(config);
    expect(issues).toHaveLength(3);
    const fields = issues.map((i) => i.field);
    expect(fields).toContain("providers.siliconflow.apiKey");
    expect(fields).toContain("providers.openai.apiKey");
    expect(fields).toContain("providers.anthropic.apiKey");
  });

  it("issue.fix 含 credentials.json schema 示例", () => {
    const config = {
      providers: { siliconflow: { apiKey: "sk-sf" } },
    } as unknown as ZhixingConfig;

    const issue = validateConfigSemantics(config)[0]!;
    expect(issue.fix).toContain("credentials.json");
    expect(issue.fix).toContain("apiKey");
    expect(issue.fix).toContain("siliconflow");
    expect(issue.fix).toContain("zhixing"); // wizard 引导
  });

  it("issue.reason 引用凭证唯一入口", () => {
    const config = {
      providers: { siliconflow: { apiKey: "sk-sf" } },
    } as unknown as ZhixingConfig;

    const issue = validateConfigSemantics(config)[0]!;
    expect(issue.reason).toContain("credentials.json");
  });
});

describe("validateNoChannelSecrets · channel credentials 密字段拒绝", () => {
  it("appSecret 命中（典型飞书 / 企微 / 钉钉密字段）", () => {
    const config: ZhixingConfig = {
      channels: {
        feishu: {
          credentials: { appId: "cli_xxx", appSecret: "secret_xxx" },
        },
      },
    };
    const issues = validateConfigSemantics(config);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("channels.feishu.credentials.appSecret");
  });

  it("botToken 命中（含 token 子串）", () => {
    const config: ZhixingConfig = {
      channels: {
        slack: {
          credentials: { botToken: "xoxb-xxx" },
        },
      },
    };
    expect(validateConfigSemantics(config)).toHaveLength(1);
  });

  it("password 命中", () => {
    const config: ZhixingConfig = {
      channels: {
        smtp: {
          credentials: { username: "user", password: "p@ss" },
        },
      },
    };
    const issues = validateConfigSemantics(config);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("channels.smtp.credentials.password");
  });

  it("apiKey 命中（含 apikey 子串，大小写不敏感）", () => {
    const config: ZhixingConfig = {
      channels: {
        webhook: {
          credentials: { apiKey: "wh-xxx" },
        },
      },
    };
    expect(validateConfigSemantics(config)).toHaveLength(1);
  });

  it("大写命名同样命中（SECRET / Token / Password）", () => {
    const config: ZhixingConfig = {
      channels: {
        custom: {
          credentials: {
            CLIENT_SECRET: "x",
            AccessToken: "y",
            UserPassword: "z",
          },
        },
      },
    };
    expect(validateConfigSemantics(config)).toHaveLength(3);
  });

  it("多 channel 多字段一次报全", () => {
    const config: ZhixingConfig = {
      channels: {
        feishu: {
          credentials: { appId: "cli_xxx", appSecret: "fs_secret" },
        },
        wecom: {
          credentials: { agentId: "ag_xxx", agentSecret: "ww_secret" },
        },
        slack: {
          credentials: { botId: "B1", botToken: "tok" },
        },
      },
    };
    const issues = validateConfigSemantics(config);
    expect(issues).toHaveLength(3);
    const fields = issues.map((i) => i.field).sort();
    expect(fields).toEqual([
      "channels.feishu.credentials.appSecret",
      "channels.slack.credentials.botToken",
      "channels.wecom.credentials.agentSecret",
    ]);
  });

  it("issue.fix 含 credentials.json schema 与 channelId / fieldName", () => {
    const config: ZhixingConfig = {
      channels: {
        feishu: {
          credentials: { appSecret: "secret_xxx" },
        },
      },
    };
    const issue = validateConfigSemantics(config)[0]!;
    expect(issue.fix).toContain("credentials.json");
    expect(issue.fix).toContain("feishu");
    expect(issue.fix).toContain("appSecret");
  });

  it("issue.fix 提示非密字段保留在 config.json", () => {
    const config: ZhixingConfig = {
      channels: {
        feishu: {
          credentials: { appSecret: "secret_xxx" },
        },
      },
    };
    const issue = validateConfigSemantics(config)[0]!;
    expect(issue.fix).toContain("appId");
  });
});

describe("validateConfigSemantics · 多类违反一次报全", () => {
  it("provider apiKey + channel secret 同时违反 → 累计 issue", () => {
    const config = {
      providers: {
        siliconflow: { apiKey: "sk-sf" },
        openai: { apiKey: "sk-oai" },
      },
      channels: {
        feishu: {
          credentials: { appId: "cli_xxx", appSecret: "fs_secret" },
        },
      },
    } as unknown as ZhixingConfig;

    const issues = validateConfigSemantics(config);
    expect(issues).toHaveLength(3);
  });
});

describe("ConfigValidator · 可插拔", () => {
  it("默认跑 BUILTIN_VALIDATORS（与显式传等价）", () => {
    const config = {
      providers: { siliconflow: { apiKey: "sk-sf" } },
    } as unknown as ZhixingConfig;

    const a = validateConfigSemantics(config);
    const b = validateConfigSemantics(config, BUILTIN_VALIDATORS);
    expect(a).toEqual(b);
  });

  it("传空 validator 数组 → 永远通过（即使含废弃字段）", () => {
    const config = {
      providers: { siliconflow: { apiKey: "sk-sf" } },
    } as unknown as ZhixingConfig;

    expect(validateConfigSemantics(config, [])).toEqual([]);
  });

  it("传自定义 validator → 内置不参与（替换语义）", () => {
    const customValidator: ConfigValidator = () => [
      { field: "custom", reason: "custom rule", fix: "custom fix" },
    ];

    const issues = validateConfigSemantics({}, [customValidator]);
    expect(issues).toEqual([
      { field: "custom", reason: "custom rule", fix: "custom fix" },
    ]);
  });

  it("自定义 + 内置组合扩展（caller 显式合并）", () => {
    const customValidator: ConfigValidator = () => [
      { field: "custom", reason: "r", fix: "f" },
    ];

    const config = {
      providers: { siliconflow: { apiKey: "sk-sf" } },
    } as unknown as ZhixingConfig;

    const issues = validateConfigSemantics(config, [
      ...BUILTIN_VALIDATORS,
      customValidator,
    ]);
    expect(issues).toHaveLength(2); // apiKey 1 + custom 1
  });
});

describe("ConfigSemanticError", () => {
  it("封装 issues 与 filePath，name 是 ConfigSemanticError", () => {
    const issues = [{ field: "x", reason: "y", fix: "z" }];
    const err = new ConfigSemanticError(issues, "/tmp/config.json");

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ConfigSemanticError");
    expect(err.issues).toEqual(issues);
    expect(err.filePath).toBe("/tmp/config.json");
    expect(err.message).toContain("1 处违反");
  });
});

describe("纯函数性质", () => {
  it("相同输入多次调用结果一致", () => {
    const config = {
      providers: { siliconflow: { apiKey: "sk-sf" } },
      channels: { feishu: { credentials: { appSecret: "x" } } },
    } as unknown as ZhixingConfig;

    const a = validateConfigSemantics(config);
    const b = validateConfigSemantics(config);
    const c = validateConfigSemantics(config);

    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("不修改输入 config", () => {
    const config = {
      providers: { siliconflow: { apiKey: "sk-sf" } },
    } as unknown as ZhixingConfig;
    const snapshot = JSON.parse(JSON.stringify(config));

    validateConfigSemantics(config);

    expect(config).toEqual(snapshot);
  });
});
