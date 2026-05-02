/**
 * 配置语义校验测试。
 *
 * 关键不变量：
 *   - config.providers 字段（任何形态）→ 整个字段都不允许，违反
 *   - config.channels 字段（旧名）→ 视为旧 schema 残留，违反并引导迁移
 *   - config.messaging.<id>.credentials 字段 → 违反，凭证字段必须在 credentials.json
 *   - 干净 config（仅含 llm / messaging / workspace 等功能层字段）→ 通过
 *   - 多个 issue 一次扫出
 *   - issue 三段式（field / reason / fix）
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

  it("messaging 含启用列表（仅功能选项）→ 无 issue", () => {
    const config: ZhixingConfig = {
      messaging: {
        feishu: { type: "feishu", options: { logLevel: "info" } },
      },
    };
    expect(validateConfigSemantics(config)).toEqual([]);
  });

  it("messaging 多 channel 都仅功能层字段 → 无 issue", () => {
    const config: ZhixingConfig = {
      messaging: {
        feishu: {},
        slack: { defaultTarget: { to: "C12345" } },
        wecom: { type: "wecom" },
      },
    };
    expect(validateConfigSemantics(config)).toEqual([]);
  });
});

describe("validateNoConfigProviders · config.providers 整个字段废弃", () => {
  it("config.providers 任何形态出现 → 整个字段 issue", () => {
    const config = {
      providers: { siliconflow: { baseUrl: "https://x" } },
    } as unknown as ZhixingConfig;

    const issues = validateConfigSemantics(config);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("providers");
  });

  it("即使 providers 是空对象也违反（schema 字段已删除）", () => {
    const config = { providers: {} } as unknown as ZhixingConfig;
    expect(validateConfigSemantics(config)).toHaveLength(1);
  });

  it("多 provider 不影响——issue 数仍是 1（整个字段被拒绝）", () => {
    const config = {
      providers: {
        siliconflow: { apiKey: "sk-sf" },
        openai: { apiKey: "sk-oai", baseUrl: "https://x" },
      },
    } as unknown as ZhixingConfig;

    const issues = validateConfigSemantics(config);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("providers");
  });

  it("issue.fix 引导迁移到 credentials.providers", () => {
    const config = { providers: {} } as unknown as ZhixingConfig;
    const issue = validateConfigSemantics(config)[0]!;
    expect(issue.fix).toContain("credentials.json");
    expect(issue.fix).toContain("providers");
    expect(issue.fix).toContain("llm.main.provider");
  });

  it("issue.reason 引用 credentials.providers 内容层位置", () => {
    const config = { providers: {} } as unknown as ZhixingConfig;
    const issue = validateConfigSemantics(config)[0]!;
    expect(issue.reason).toContain("credentials.providers");
  });
});

describe("validateNoConfigChannels · 旧 channels 字段引导迁移", () => {
  it("config.channels 出现 → 整个字段违反", () => {
    const config = {
      channels: { feishu: { credentials: { appId: "x" } } },
    } as unknown as ZhixingConfig;

    const issues = validateConfigSemantics(config);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("channels");
  });

  it("即使空对象也违反", () => {
    const config = { channels: {} } as unknown as ZhixingConfig;
    expect(validateConfigSemantics(config)).toHaveLength(1);
  });

  it("issue.fix 引导改名 messaging + 凭证迁移", () => {
    const config = { channels: {} } as unknown as ZhixingConfig;
    const issue = validateConfigSemantics(config)[0]!;
    expect(issue.fix).toContain("messaging");
    expect(issue.fix).toContain("credentials.json");
    expect(issue.fix).toContain("channels");
  });
});

describe("validateNoMessagingCredentials · messaging 条目不允许 credentials 字段", () => {
  it("messaging.<id>.credentials 出现 → 命中", () => {
    const config = {
      messaging: {
        feishu: { credentials: { appId: "x", appSecret: "y" } },
      },
    } as unknown as ZhixingConfig;

    const issues = validateConfigSemantics(config);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("messaging.feishu.credentials");
  });

  it("多 channel 各自含 credentials → 多 issue", () => {
    const config = {
      messaging: {
        feishu: { credentials: { appSecret: "x" } },
        wecom: { credentials: { agentSecret: "y" } },
      },
    } as unknown as ZhixingConfig;

    const issues = validateConfigSemantics(config);
    expect(issues).toHaveLength(2);
  });

  it("issue.fix 引导迁移到 credentials.channels.<id>", () => {
    const config = {
      messaging: { feishu: { credentials: { appId: "x" } } },
    } as unknown as ZhixingConfig;

    const issue = validateConfigSemantics(config)[0]!;
    expect(issue.fix).toContain("credentials.json");
    expect(issue.fix).toContain("feishu");
  });
});

describe("validateConfigSemantics · 多类违反一次报全", () => {
  it("providers + channels + messaging.<id>.credentials 同时违反 → 累计 issue", () => {
    const config = {
      providers: { siliconflow: { apiKey: "sk-sf" } },
      channels: { feishu: {} },
      messaging: { wecom: { credentials: { agentSecret: "y" } } },
    } as unknown as ZhixingConfig;

    const issues = validateConfigSemantics(config);
    expect(issues).toHaveLength(3);
    const fields = issues.map((i) => i.field).sort();
    expect(fields).toEqual(["channels", "messaging.wecom.credentials", "providers"]);
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
    expect(issues).toHaveLength(2); // providers 1 + custom 1
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
      messaging: { feishu: { credentials: { appSecret: "x" } } },
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
