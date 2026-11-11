/**
 * model section 每行就绪态派生 —— 守护"辅助角色与 main 同 provider 且该
 * provider 缺 key"时的显示语义。
 *
 * 关键不变量：一行是否 ready 取决于"该角色 provider 是否真有 key"，不能用
 * "本行 myIssues 是否为空"代替 —— checkModel 对同 provider 的辅助角色会把
 * 缺-key issue 去重并归到 main（单一动作），此时辅助行名下无 issue 却并未就绪。
 */

import { describe, expect, it } from "vitest";
import { createInitialState } from "../state.js";
import { modelSection } from "../sections/model.js";
import { buildProviderListMeta } from "../model/list.js";
import { deriveEntryIssues } from "../entry.js";
import type { SectionEntry } from "../types.js";
import type { ZhixingConfig, ZhixingCredentials } from "@zhixing-ai/providers";

function entriesOf(
  config: ZhixingConfig,
  credentials: ZhixingCredentials,
): Record<"main" | "light" | "power", SectionEntry> {
  const list = modelSection.entries(
    createInitialState(config, credentials),
  );
  const find = (zh: string) =>
    list.find((e) => e.label.startsWith(zh))!;
  return {
    main: find("主模型"),
    light: find("轻量模型"),
    power: find("强力模型"),
  };
}

describe("model section · 可选角色就绪态派生（永不阻断，恒暗色咨询）", () => {
  it("缺共享 key：main blocked（持有单一动作），light 不绿且不重复计数", () => {
    const { main, light } = entriesOf(
      {
        llm: {
          main: { provider: "deepseek", model: "deepseek-v4-pro" },
          light: { provider: "deepseek", model: "deepseek-v4-flash" },
        },
      },
      {},
    );

    // main 持有那把 deepseek key 的可执行动作
    expect(main.state.kind).toBe("blocked");
    expect(deriveEntryIssues(main)).toHaveLength(1);

    // light 不能伪装就绪（绿 ✓）；归 disabled、文案点向 main、零 issue（不被
    // "待补充 N 项"重复计数 —— 单一动作仍在 main）
    expect(light.state.kind).not.toBe("ready");
    expect(light.state.kind).toBe("disabled");
    expect(light.state.statusText).toContain("随主模型补 API Key");
    expect(deriveEntryIssues(light)).toHaveLength(0);
  });

  it("补上共享 key：main 与 light 同时 ready", () => {
    const { main, light } = entriesOf(
      {
        llm: {
          main: { provider: "deepseek", model: "deepseek-v4-pro" },
          light: { provider: "deepseek", model: "deepseek-v4-flash" },
        },
      },
      { providers: { deepseek: { apiKey: "sk-ds" } } },
    );

    expect(main.state.kind).toBe("ready");
    expect(light.state.kind).toBe("ready");
    expect(light.state.statusText).toBe("deepseek · deepseek-v4-flash");
  });

  it("异 provider 缺 key：light 仍恒暗色 disabled，永不 blocked、不计数", () => {
    // 选填角色【永不阻断流程】是硬约束：即便配了独立 provider 且无凭证，
    // 也只能暗色咨询，不能强提示/不计入"待补充"、不卡完成或启动。运行时
    // 该角色会回退 main + 可见告警（resolve.ts + create-agent-runtime）。
    const { main, light } = entriesOf(
      {
        llm: {
          main: { provider: "deepseek", model: "deepseek-v4-pro" },
          light: { provider: "siliconflow", model: "deepseek-ai/DeepSeek-V4-Flash" },
        },
      },
      { providers: { deepseek: { apiKey: "sk-ds" } } }, // 无 siliconflow key
    );

    expect(main.state.kind).toBe("ready");
    expect(light.state.kind).toBe("disabled"); // 不是 blocked
    expect(deriveEntryIssues(light)).toHaveLength(0); // 不计入待补充
    // 异 provider 的引导文案：明示运行时缺则回退主模型
    expect(light.state.statusText).toContain("待补 API Key，缺则回退主模型");
  });

  it("辅助角色未配置（沿用 main）：disabled 未启用，与缺共享 key 语义区分", () => {
    const { light } = entriesOf(
      { llm: { main: { provider: "deepseek", model: "deepseek-v4-pro" } } },
      {},
    );
    expect(light.state.kind).toBe("disabled");
    // 未配置文案是"未启用"，不是"随主模型补 API Key"——两种 disabled 经
    // statusText 明确区分，用户不混淆
    expect(light.state.statusText).not.toContain("随主模型补 API Key");
  });
});

describe("optional role revert", () => {
  it("offers 沿用主模型 only for a configured optional role and clears that role", () => {
    const state = createInitialState({
      llm: { main: { provider: "siliconflow", model: "m-main" }, light: { provider: "deepseek", model: "m-light" } },
    } as unknown as ZhixingConfig, {} as ZhixingCredentials);
    const light = buildProviderListMeta(state, { kind: "provider-list", role: "light" });
    expect(light.items[0]!.label).toBe("沿用主模型");
    const action = light.items[0]!.onEnter(state);
    expect(action.type).toBe("pop");
    if (action.type === "pop") {
      expect(action.state.config.llm?.light).toBeUndefined();
      expect(action.state.config.llm?.main).toEqual({ provider: "siliconflow", model: "m-main" });
    }
    // 主模型必填、强力模型未单独配置：都不出现撤回项
    expect(buildProviderListMeta(state, { kind: "provider-list", role: "main" }).items.some(item => item.label === "沿用主模型")).toBe(false);
    expect(buildProviderListMeta(state, { kind: "provider-list", role: "power" }).items.some(item => item.label === "沿用主模型")).toBe(false);
  });
});

describe("服务商列表的当前项", () => {
  const state = createInitialState({
    llm: { main: { provider: "siliconflow", model: "m-main" }, light: { provider: "deepseek", model: "m-light" } },
  } as unknown as ZhixingConfig, {} as ZhixingCredentials);
  const current = (role: "main" | "light" | "power") =>
    buildProviderListMeta(state, { kind: "provider-list", role }).items.filter(item => item.current).map(item => item.label);

  it("标出角色显式配置的服务商，页头说明带标记含义", () => {
    expect(current("main")).toEqual(["硅基流动"]);
    expect(current("light")).toEqual(["DeepSeek 官方"]);
    expect(buildProviderListMeta(state, { kind: "provider-list", role: "light" }).description).toBe("选择 API 服务商作为轻量模型来源；带 ● 的是当前已选");
  });

  it("未配置的角色没有当前项，“沿用主模型”也不当作当前项，页头不提标记", () => {
    expect(current("power")).toEqual([]);
    expect(buildProviderListMeta(state, { kind: "provider-list", role: "power" }).description).toBe("选择 API 服务商作为强力模型来源");
    const light = buildProviderListMeta(state, { kind: "provider-list", role: "light" });
    expect(light.items.find(item => item.label === "沿用主模型")?.current).toBeFalsy();
  });
});
