/**
 * 配置缺失检测函数测试——sections 与 startup 共用此规则源。
 *
 * checkModel：主/辅模型必要字段缺失检测
 * checkMessaging：已启用 channel 的字段完整性检测
 */

import { describe, expect, it } from "vitest";
import { checkModel } from "../checks/model.js";
import { checkMessaging } from "../checks/messaging.js";

describe("checkModel", () => {
  it("空 config + 空 credentials → main provider/model 缺失", () => {
    const missing = checkModel({}, {});
    const paths = missing.map((m) => m.path);
    expect(paths).toContain("config.llm.main.provider");
    expect(paths).toContain("config.llm.main.model");
  });

  it("main 已配且 apiKey 已填 → []", () => {
    const missing = checkModel(
      { llm: { main: { provider: "siliconflow", model: "Pro/M1" } } },
      { providers: { siliconflow: { apiKey: "sk-test" } } },
    );
    expect(missing).toEqual([]);
  });

  it("main 已配但 apiKey 缺 → 报 apiKey 缺失", () => {
    const missing = checkModel(
      { llm: { main: { provider: "siliconflow", model: "Pro/M1" } } },
      {},
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.path).toBe("credentials.providers.siliconflow.apiKey");
  });

  it("main provider 缺失时不查 apiKey（不知查哪个）", () => {
    const missing = checkModel(
      { llm: { main: { provider: "", model: "" } } },
      {},
    );
    expect(missing.some((m) => m.path.endsWith(".apiKey"))).toBe(false);
  });

  it("light 异 provider 且缺凭证 → 不进阻断清单（可选角色永不阻断）", () => {
    // checkModel 只覆盖 required(main)。可选角色缺配回退 main（resolve.ts
    // 记录降级 + 边缘层告警），不产生 blocking issue —— 否则一个选填项会
    // 卡住启动/完成。其配置完善度由 section 层就地暗色派生，不在此。
    const missing = checkModel(
      {
        llm: {
          main: { provider: "siliconflow", model: "Pro/M1" },
          light: { provider: "anthropic", model: "claude-haiku" },
        },
      },
      { providers: { siliconflow: { apiKey: "sk-sf" } } },
    );
    expect(missing).toEqual([]);
  });

  it("可选角色无论同/异 provider 都不进阻断清单", () => {
    const missing = checkModel(
      {
        llm: {
          main: { provider: "siliconflow", model: "Pro/M1" },
          light: { provider: "siliconflow", model: "Pro/M2" },
          power: { provider: "anthropic", model: "claude-haiku" },
        },
      },
      { providers: { siliconflow: { apiKey: "sk-sf" } } },
    );
    expect(missing).toEqual([]);
  });

  it("ModelIssue discriminated union: apiKey variant 必带 providerId", () => {
    const missing = checkModel(
      { llm: { main: { provider: "siliconflow", model: "Pro/M1" } } },
      {},
    );
    expect(missing).toHaveLength(1);
    const issue = missing[0]!;
    expect(issue.field).toBe("apiKey");
    // 类型层断言 + 运行期验证：apiKey variant 必有 providerId
    if (issue.field === "apiKey") {
      expect(issue.providerId).toBe("siliconflow");
      expect(issue.fieldLabel).toBe("API Key");
    }
  });

  it("ModelIssue: provider/model variant 携带 fieldLabel", () => {
    const missing = checkModel({}, {});
    const fields = missing.map((m) => ({ field: m.field, fieldLabel: m.fieldLabel }));
    expect(fields).toContainEqual({ field: "provider", fieldLabel: "服务商" });
    expect(fields).toContainEqual({ field: "model", fieldLabel: "模型" });
  });

  it("role 字段存在且恒为 main（sections 用此过滤；可选角色不进清单）", () => {
    const missing = checkModel(
      {
        llm: {
          main: { provider: "siliconflow", model: "Pro/M1" },
          light: { provider: "anthropic", model: "claude-haiku" },
        },
      },
      {}, // 连 main 的 siliconflow key 也缺
    );
    // 即便 light 异 provider 也无凭证，清单里也只有 main 的阻断项
    expect(missing.every((m) => m.role === "main")).toBe(true);
    expect(missing.some((m) => m.role === "light")).toBe(false);
  });
});

describe("checkMessaging", () => {
  it("messaging 空 → 无 missing（不强制启用 channel）", () => {
    expect(checkMessaging({}, {})).toEqual([]);
    expect(checkMessaging({ messaging: {} }, {})).toEqual([]);
  });

  it("启用 feishu 但凭证字段全缺 → appId + appSecret 都报", () => {
    const missing = checkMessaging(
      { messaging: { feishu: {} } },
      {},
    );
    expect(missing).toHaveLength(2);
    expect(missing.map((m) => m.field).sort()).toEqual(["appId", "appSecret"]);
  });

  it("启用 feishu 仅缺 appSecret → 只报 appSecret", () => {
    const missing = checkMessaging(
      { messaging: { feishu: {} } },
      { channels: { feishu: { appId: "cli_xxx" } } },
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.field).toBe("appSecret");
  });

  it("MessagingIssue 携带 fieldLabel（用于 entity 短消息）", () => {
    const missing = checkMessaging({ messaging: { feishu: {} } }, {});
    const labels = missing.map((m) => m.fieldLabel).sort();
    expect(labels).toEqual(["App ID", "App Secret"]);
  });

  it("启用 feishu 字段齐全 → []", () => {
    const missing = checkMessaging(
      { messaging: { feishu: {} } },
      {
        channels: {
          feishu: { appId: "cli_xxx", appSecret: "sec_yyy" },
        },
      },
    );
    expect(missing).toEqual([]);
  });

  it("未启用的 channel 不查（即使凭证字段缺）", () => {
    // messaging 不含 feishu → checker 不查
    expect(
      checkMessaging({ messaging: {} }, { channels: { feishu: {} } }),
    ).toEqual([]);
  });

  it("未在内置 channel 注册表的启用项不报（保守）", () => {
    // 当前 channel registry 仅含 feishu；其他 channel id 无定义 → 不报
    expect(
      checkMessaging(
        { messaging: { unknown_channel: {} } as never },
        {},
      ),
    ).toEqual([]);
  });
});
