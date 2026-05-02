/**
 * Boot 检测函数测试。
 *
 * checkBootModel：主/辅模型必要字段缺失检测
 * checkBootMessaging：已启用 channel 的字段完整性检测
 */

import { describe, expect, it } from "vitest";
import { checkBootModel } from "../checks/model.js";
import { checkBootMessaging } from "../checks/messaging.js";

describe("checkBootModel", () => {
  it("空 config + 空 credentials → main provider/model 缺失", () => {
    const missing = checkBootModel({}, {});
    const paths = missing.map((m) => m.path);
    expect(paths).toContain("config.llm.main.provider");
    expect(paths).toContain("config.llm.main.model");
  });

  it("main 已配且 apiKey 已填 → []", () => {
    const missing = checkBootModel(
      { llm: { main: { provider: "siliconflow", model: "Pro/M1" } } },
      { providers: { siliconflow: { apiKey: "sk-test" } } },
    );
    expect(missing).toEqual([]);
  });

  it("main 已配但 apiKey 缺 → 报 apiKey 缺失", () => {
    const missing = checkBootModel(
      { llm: { main: { provider: "siliconflow", model: "Pro/M1" } } },
      {},
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.path).toBe("credentials.providers.siliconflow.apiKey");
  });

  it("main provider 缺失时不查 apiKey（不知查哪个）", () => {
    const missing = checkBootModel(
      { llm: { main: { provider: "", model: "" } } },
      {},
    );
    expect(missing.some((m) => m.path.endsWith(".apiKey"))).toBe(false);
  });

  it("secondary 异 provider 且缺凭证 → 独立报", () => {
    const missing = checkBootModel(
      {
        llm: {
          main: { provider: "siliconflow", model: "Pro/M1" },
          secondary: { provider: "anthropic", model: "claude-haiku" },
        },
      },
      { providers: { siliconflow: { apiKey: "sk-sf" } } },
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.path).toBe("credentials.providers.anthropic.apiKey");
  });

  it("secondary 同 provider 时复用 main 凭证（不重复报）", () => {
    const missing = checkBootModel(
      {
        llm: {
          main: { provider: "siliconflow", model: "Pro/M1" },
          secondary: { provider: "siliconflow", model: "Pro/M2" },
        },
      },
      { providers: { siliconflow: { apiKey: "sk-sf" } } },
    );
    expect(missing).toEqual([]);
  });
});

describe("checkBootMessaging", () => {
  it("messaging 空 → 无 missing（不强制启用 channel）", () => {
    expect(checkBootMessaging({}, {})).toEqual([]);
    expect(checkBootMessaging({ messaging: {} }, {})).toEqual([]);
  });

  it("启用 feishu 但凭证字段全缺 → appId + appSecret 都报", () => {
    const missing = checkBootMessaging(
      { messaging: { feishu: {} } },
      {},
    );
    expect(missing).toHaveLength(2);
    expect(missing.map((m) => m.field).sort()).toEqual(["appId", "appSecret"]);
  });

  it("启用 feishu 仅缺 appSecret → 只报 appSecret", () => {
    const missing = checkBootMessaging(
      { messaging: { feishu: {} } },
      { channels: { feishu: { appId: "cli_xxx" } } },
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]?.field).toBe("appSecret");
  });

  it("启用 feishu 字段齐全 → []", () => {
    const missing = checkBootMessaging(
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
      checkBootMessaging({ messaging: {} }, { channels: { feishu: {} } }),
    ).toEqual([]);
  });

  it("未在内置 channel 注册表的启用项不报（保守）", () => {
    // 当前 channel registry 仅含 feishu；其他 channel id 无定义 → 不报
    expect(
      checkBootMessaging(
        { messaging: { unknown_channel: {} } as never },
        {},
      ),
    ).toEqual([]);
  });
});
