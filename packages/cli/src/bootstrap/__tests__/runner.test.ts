/**
 * 引导流程编排测试。
 *
 * 关键不变量：
 *   - 用户取消 → 不写盘，writers 不被调用
 *   - 用户填齐 → batch 写盘，patch 内容反映 working state
 *   - 已齐全 → 不问任何字段，不写盘
 *   - 字段域追踪精准：仅缺 apiKey 时不写 config；仅缺 model 时不写 credentials
 *   - close 一定被调（finally 路径）
 */

import { describe, expect, it } from "vitest";
import type {
  ZhixingConfig,
  ZhixingCredentials,
} from "@zhixing/providers";
import { runBootstrap, type BootstrapWriters } from "../runner.js";
import type {
  BootstrapAskAnswer,
  BootstrapAskRequest,
  BootstrapInteraction,
} from "../types.js";

// ─── Mock helpers ───

interface MockInteractionLog {
  intros: Array<{ configPath: string; credentialsPath: string }>;
  questions: BootstrapAskRequest[];
  summaries: Array<{
    written: { config: boolean; credentials: boolean };
  }>;
  closes: number;
}

interface MockWriterLog {
  configPatches: Partial<ZhixingConfig>[];
  credentialsPatches: Partial<ZhixingCredentials>[];
}

/** answers 按问题顺序逐个 pop；"cancel" 转为 cancel 信号。耗尽时默认 cancel */
function makeMockInteraction(answers: ReadonlyArray<string | "cancel">): {
  interaction: BootstrapInteraction;
  log: MockInteractionLog;
} {
  let idx = 0;
  const log: MockInteractionLog = {
    intros: [],
    questions: [],
    summaries: [],
    closes: 0,
  };
  return {
    log,
    interaction: {
      async printIntro(args) {
        log.intros.push({
          configPath: args.configPath,
          credentialsPath: args.credentialsPath,
        });
      },
      async askField(req: BootstrapAskRequest): Promise<BootstrapAskAnswer> {
        log.questions.push(req);
        const next = answers[idx++];
        if (next === undefined || next === "cancel") {
          return { kind: "cancel" };
        }
        return { kind: "value", value: next };
      },
      async printSummary(args) {
        log.summaries.push({ written: args.written });
      },
      async close() {
        log.closes++;
      },
    },
  };
}

function makeMockWriters(): { writers: BootstrapWriters; log: MockWriterLog } {
  const log: MockWriterLog = { configPatches: [], credentialsPatches: [] };
  return {
    log,
    writers: {
      async writeConfig(patch) {
        log.configPatches.push(patch);
      },
      async writeCredentials(patch) {
        log.credentialsPatches.push(patch);
      },
    },
  };
}

const FIXTURE_PATHS = {
  configPath: "/fake/.zhixing/config.json",
  credentialsPath: "/fake/.zhixing/credentials.json",
};

// ─── Tests ───

describe("runBootstrap · 完整填充", () => {
  it("空 config 全填三字段 → completed + 双文件写入", async () => {
    const { interaction, log: i } = makeMockInteraction([
      "siliconflow",
      "Pro/MiniMaxAI/MiniMax-M2.5",
      "sk-sf",
    ]);
    const { writers, log: w } = makeMockWriters();

    const result = await runBootstrap({
      ...FIXTURE_PATHS,
      initialConfig: {},
      initialCredentials: { version: 1 },
      interaction,
      writers,
    });

    expect(result).toBe("completed");

    expect(i.questions).toHaveLength(3);
    expect(i.questions[0]?.field.path).toBe("config.llm.main.provider");
    expect(i.questions[1]?.field.path).toBe("config.llm.main.model");
    expect(i.questions[2]?.field.path).toBe(
      "credentials.providers.siliconflow.apiKey",
    );

    // apiKey 字段必须 silent
    expect(i.questions[2]?.silent).toBe(true);
    expect(i.questions[0]?.silent).toBe(false);

    expect(w.configPatches).toHaveLength(1);
    expect(w.configPatches[0]?.llm).toEqual({
      main: { provider: "siliconflow", model: "Pro/MiniMaxAI/MiniMax-M2.5" },
    });

    expect(w.credentialsPatches).toHaveLength(1);
    expect(w.credentialsPatches[0]?.providers?.siliconflow?.apiKey).toBe("sk-sf");

    expect(i.summaries).toHaveLength(1);
    expect(i.summaries[0]?.written).toEqual({ config: true, credentials: true });
    expect(i.closes).toBe(1);
  });
});

describe("runBootstrap · 取消", () => {
  it("第一字段 cancel → cancelled，writers 与 summary 都不被调用", async () => {
    const { interaction, log: i } = makeMockInteraction(["cancel"]);
    const { writers, log: w } = makeMockWriters();

    const result = await runBootstrap({
      ...FIXTURE_PATHS,
      initialConfig: {},
      initialCredentials: { version: 1 },
      interaction,
      writers,
    });

    expect(result).toBe("cancelled");
    expect(w.configPatches).toEqual([]);
    expect(w.credentialsPatches).toEqual([]);
    expect(i.summaries).toEqual([]);
    expect(i.closes).toBe(1); // 仍要清理资源
  });

  it("中途 cancel → cancelled，已填字段不落盘", async () => {
    const { interaction, log: i } = makeMockInteraction(["siliconflow", "cancel"]);
    const { writers, log: w } = makeMockWriters();

    const result = await runBootstrap({
      ...FIXTURE_PATHS,
      initialConfig: {},
      initialCredentials: { version: 1 },
      interaction,
      writers,
    });

    expect(result).toBe("cancelled");
    expect(i.questions).toHaveLength(2);
    expect(w.configPatches).toEqual([]);
    expect(w.credentialsPatches).toEqual([]);
    expect(i.closes).toBe(1);
  });
});

describe("runBootstrap · 已齐全 / 部分缺", () => {
  it("初始已齐全 → 不问任何字段、不写盘、completed", async () => {
    const { interaction, log: i } = makeMockInteraction([]);
    const { writers, log: w } = makeMockWriters();

    const result = await runBootstrap({
      ...FIXTURE_PATHS,
      initialConfig: {
        llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
      },
      initialCredentials: {
        version: 1,
        providers: { deepseek: { apiKey: "sk-existing" } },
      },
      interaction,
      writers,
    });

    expect(result).toBe("completed");
    expect(i.questions).toEqual([]);
    expect(w.configPatches).toEqual([]);
    expect(w.credentialsPatches).toEqual([]);
    expect(i.summaries[0]?.written).toEqual({ config: false, credentials: false });
    expect(i.closes).toBe(1);
  });

  it("仅缺 apiKey → 只问 apiKey，仅写 credentials（不写 config）", async () => {
    const { interaction, log: i } = makeMockInteraction(["sk-ds"]);
    const { writers, log: w } = makeMockWriters();

    const result = await runBootstrap({
      ...FIXTURE_PATHS,
      initialConfig: {
        llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
      },
      initialCredentials: { version: 1 },
      interaction,
      writers,
    });

    expect(result).toBe("completed");
    expect(i.questions).toHaveLength(1);
    expect(i.questions[0]?.field.path).toBe(
      "credentials.providers.deepseek.apiKey",
    );

    expect(w.configPatches).toEqual([]);
    expect(w.credentialsPatches).toHaveLength(1);
    expect(w.credentialsPatches[0]?.providers?.deepseek?.apiKey).toBe("sk-ds");

    expect(i.summaries[0]?.written).toEqual({ config: false, credentials: true });
  });

  it("secondary 不同 provider 缺 key → 引导询问 secondary apiKey", async () => {
    const { interaction, log: i } = makeMockInteraction(["sk-ant"]);
    const { writers, log: w } = makeMockWriters();

    const result = await runBootstrap({
      ...FIXTURE_PATHS,
      initialConfig: {
        llm: {
          main: { provider: "deepseek", model: "deepseek-chat" },
          secondary: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
        },
      },
      initialCredentials: {
        version: 1,
        providers: { deepseek: { apiKey: "sk-ds" } },
      },
      interaction,
      writers,
    });

    expect(result).toBe("completed");
    expect(i.questions[0]?.field.path).toBe(
      "credentials.providers.anthropic.apiKey",
    );
    expect(w.credentialsPatches[0]?.providers?.anthropic?.apiKey).toBe("sk-ant");
    // 已存在的 deepseek 凭证保留在 working state（patch 包含完整 providers 子表）
    expect(w.credentialsPatches[0]?.providers?.deepseek?.apiKey).toBe("sk-ds");
  });
});

describe("runBootstrap · 不变量", () => {
  it("intro 总会被调用一次（无论字段是否齐全）", async () => {
    const { interaction, log } = makeMockInteraction([]);
    const { writers } = makeMockWriters();

    await runBootstrap({
      ...FIXTURE_PATHS,
      initialConfig: {
        llm: { main: { provider: "siliconflow", model: "X" } },
      },
      initialCredentials: {
        version: 1,
        providers: { siliconflow: { apiKey: "sk" } },
      },
      interaction,
      writers,
    });

    expect(log.intros).toHaveLength(1);
    expect(log.intros[0]?.configPath).toBe(FIXTURE_PATHS.configPath);
    expect(log.intros[0]?.credentialsPath).toBe(FIXTURE_PATHS.credentialsPath);
  });

  it("writers 抛错时 close 仍被调（finally 路径）", async () => {
    const { interaction, log: i } = makeMockInteraction(["siliconflow", "X", "sk"]);
    const failingWriters: BootstrapWriters = {
      async writeConfig() {
        throw new Error("disk full");
      },
      async writeCredentials() {
        throw new Error("disk full");
      },
    };

    await expect(
      runBootstrap({
        ...FIXTURE_PATHS,
        initialConfig: {},
        initialCredentials: { version: 1 },
        interaction,
        writers: failingWriters,
      }),
    ).rejects.toThrow(/disk full/);

    expect(i.closes).toBe(1);
  });

  it("apiKey 字段 silent=true，其它字段 silent=false", async () => {
    const { interaction, log } = makeMockInteraction([
      "siliconflow",
      "model-x",
      "sk-y",
    ]);
    const { writers } = makeMockWriters();

    await runBootstrap({
      ...FIXTURE_PATHS,
      initialConfig: {},
      initialCredentials: { version: 1 },
      interaction,
      writers,
    });

    const silentMap = log.questions.map((q) => q.silent);
    expect(silentMap).toEqual([false, false, true]);
  });
});
