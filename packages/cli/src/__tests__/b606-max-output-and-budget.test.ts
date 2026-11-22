import { describe, expect, it } from "vitest";
import { createLeaseBudgetTracker, type ModelCallResourceMeter } from "@zhixing-ai/core/contracts";
import {
  markRequestUndelivered,
  parseModelBudgetStop,
  withRetry,
} from "@zhixing-ai/core/resilience";
import type { ChatRequest, StreamEvent } from "@zhixing-ai/core/types";
import { meteredProviderCall } from "@zhixing-ai/orchestrator/runtime";
import type { ZhixingConfig } from "@zhixing-ai/providers";
import { createHostKernelModelProviderFactory } from "../runtime/kernel-runtime-bindings.js";
import { createHostAdvancementModelProviderFactory } from "../runtime/advancement-model-provider.js";
import { modelFailureText } from "../terminal/model-failure.js";

function makeGovMeter(budget: {
  readonly maxTokens?: number;
  readonly maxCalls?: number;
  readonly maxCostMinor?: number;
  readonly childReservedTokens?: number;
}): {
  readonly meter: ModelCallResourceMeter;
  readonly nextCallIndex: () => number;
  readonly reservedCalls: Array<{ readonly usageId: string; readonly tokenUpperBound: number }>;
  readonly consumedCalls: Array<{ readonly usageId: string; readonly tokens: number }>;
} {
  let callIndex = 0;
  const tracker = createLeaseBudgetTracker(budget);
  const open = new Map<string, number>();
  let usedTokens = 0;
  let usedCalls = 0;
  const childReserved = budget.childReservedTokens ?? 0;
  const reservedCalls: Array<{ readonly usageId: string; readonly tokenUpperBound: number }> = [];
  const consumedCalls: Array<{ readonly usageId: string; readonly tokens: number }> = [];

  const meter: ModelCallResourceMeter = {
    budgetSnapshot: () => tracker.snapshot(),
    async reserve({ callIndex: idx, tokenUpperBound }) {
      const usageId = `usage:test:${idx}`;
      let pendingTokens = 0;
      for (const t of open.values()) pendingTokens += t;
      const nextCalls = usedCalls + open.size + 1;
      const nextTokens = usedTokens + pendingTokens + childReserved + tokenUpperBound;
      if (budget.maxCalls === undefined || nextCalls > budget.maxCalls) {
        throw new TypeError("Resource commitments calls exceeds budget");
      }
      if (budget.maxTokens === undefined || nextTokens > budget.maxTokens) {
        throw new TypeError("Resource commitments tokens exceeds budget");
      }
      open.set(usageId, tokenUpperBound);
      tracker.recordReserved(usageId, tokenUpperBound);
      reservedCalls.push({ usageId, tokenUpperBound });
      return { usageId };
    },
    async consume({ usageId, tokens }) {
      open.delete(usageId);
      usedTokens += tokens;
      usedCalls += 1;
      tracker.recordConsumed(usageId, tokens);
      consumedCalls.push({ usageId, tokens });
    },
  };

  return {
    meter,
    nextCallIndex: () => ++callIndex,
    reservedCalls,
    consumedCalls,
  };
}

async function drainEvents(gen: AsyncGenerator<StreamEvent, void, undefined>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("B6-06: 模型输出上限解析、租约协调收紧与可证事实错误反馈", () => {
  it("区分型号策展建议与物理上限：未知型号大覆盖走协议默认，DeepSeek V4 Pro/Flash 走 16384/8192，紧上限与角色/会话覆盖互不串", () => {
    const config: ZhixingConfig = {
      llm: {
        schemaVersion: 2,
        connections: {
          custom_oa: {
            name: "Custom Loopback",
            adapter: "openai-compatible",
            endpoint: "http://127.0.0.1:18080/v1",
            auth: { mode: "none" },
            network: { allowPrivateHosts: true },
            customModels: ["unknown-huge", "tight-64", "deepseek-v4-pro"],
            modelOverrides: {
              "unknown-huge": { maxOutputTokens: 999_999 },
              "tight-64": { maxOutputTokens: 64 },
              "deepseek-v4-pro": { maxOutputTokens: 999_999 },
            },
          },
          ds_official: {
            presetId: "deepseek",
            name: "DeepSeek Loopback",
            adapter: "openai-compatible",
            endpoint: "http://127.0.0.1:18080/v1",
            auth: { mode: "api-key", secretRef: "ds_key" },
            network: { allowPrivateHosts: true },
          },
        },
        main: { connectionId: "custom_oa", model: "unknown-huge" },
        light: { connectionId: "ds_official", model: "deepseek-v4-flash" },
        power: { connectionId: "ds_official", model: "deepseek-v4-pro" },
      },
    };
    const credentials = {
      modelSecrets: {
        ds_key: { kind: "api-key" as const, value: "sk-test-local" },
      },
    };

    const factory = createHostKernelModelProviderFactory({
      configuration: config,
      credentials,
    });
    const baseBinding = factory.create({ primaryRole: "main" });
    // custom_oa unknown-huge (maxOutputTokens=999999, contextWindow=128000, no curated rec) -> protocolDefault 4096!
    expect(baseBinding.defaultMaxOutputTokens.main).toBe(4_096);
    // ds_official deepseek-v4-flash (physical 384000, curated rec 8192) -> 8192!
    expect(baseBinding.defaultMaxOutputTokens.light).toBe(8_192);
    // ds_official deepseek-v4-pro (physical 384000, curated rec 16384) -> 16384!
    expect(baseBinding.defaultMaxOutputTokens.power).toBe(16_384);

    // Custom connection without presetId sharing model name "deepseek-v4-pro" MUST NOT steal curated 16384
    const sameNameCustom = factory.create({
      primaryRole: "main",
      sessionOverride: {
        mode: "override",
        connectionId: "custom_oa",
        model: "deepseek-v4-pro",
      },
    });
    expect(sameNameCustom.sessionPrimaryMaxOutputTokens).toBe(4_096);
    expect(sameNameCustom.defaultMaxOutputTokens.light).toBe(8_192);

    // Tight physical ceiling (64) clamps protocol default (4096) down to 64
    const tightBinding = factory.create({
      primaryRole: "main",
      sessionOverride: {
        mode: "override",
        connectionId: "custom_oa",
        model: "tight-64",
      },
    });
    expect(tightBinding.sessionPrimaryMaxOutputTokens).toBe(64);

    // Explicit low preference (2048) and high preference (350000 <= physical 384000) honored without crushing to protocol default
    const lowPref = factory.create({
      primaryRole: "power",
      primaryRoleOverrides: { maxOutputPreference: 2_048 },
    });
    expect(lowPref.sessionPrimaryMaxOutputTokens).toBe(2_048);

    const highPref = factory.create({
      primaryRole: "power",
      primaryRoleOverrides: { maxOutputPreference: 350_000 },
    });
    expect(highPref.sessionPrimaryMaxOutputTokens).toBe(350_000);
    // Roles remain unpolluted
    expect(highPref.defaultMaxOutputTokens.light).toBe(8_192);

    // Advancement runtime binding uses the exact same rule for main & light
    const advFactory = createHostAdvancementModelProviderFactory({
      configuration: {
        llm: {
          ...config.llm!,
          main: { connectionId: "ds_official", model: "deepseek-v4-pro" },
        },
      },
      credentials,
    });
    const adv = advFactory.create({
      evidenceCapabilities: { hasCommand: false, hasFileRead: false, hasGit: false },
      workingDirectory: process.cwd(),
      resourceMeter: {
        reserveUsage: async () => {},
        consume: async () => {},
      },
    });
    void adv.dispose?.();
  });

  it("meteredProviderCall 按租约真实剩余额度协调收紧显式 350000 高偏好，保证预占与实际出站请求完全一致，并在多步消耗后按剩余量继续收紧", async () => {
    const seenMaxTokens: number[] = [];
    const gov = makeGovMeter({ maxCalls: 8, maxTokens: 256_000 });
    const call = meteredProviderCall({
      async *call(req) {
        seenMaxTokens.push(req.maxTokens!);
        yield { type: "message_start" };
        yield { type: "text_delta", text: "ok" };
        yield {
          type: "message_end",
          stopReason: "end_turn",
          usage: { inputTokens: 4_000, outputTokens: 6_000 },
        };
      },
      meter: gov.meter,
      nextCallIndex: gov.nextCallIndex,
      defaultMaxOutputTokens: 350_000,
    });

    const baseReq: ChatRequest = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: [{ type: "text", text: "短消息测试" }] }],
    };

    // Call #1: tightened to fit 256_000, sent & settled at 10_000 actual tokens
    await drainEvents(call(baseReq));
    expect(seenMaxTokens).toHaveLength(1);
    expect(seenMaxTokens[0]!).toBeGreaterThan(250_000);
    expect(seenMaxTokens[0]!).toBeLessThan(256_000);
    expect(gov.reservedCalls[0]!.tokenUpperBound).toBeLessThanOrEqual(256_000);
    expect(gov.consumedCalls[0]!.tokens).toBe(10_000);

    // Call #2 on same lease: remaining is 246_000 (NOT 256_000!), tightened further and succeeds
    await drainEvents(call(baseReq));
    expect(seenMaxTokens).toHaveLength(2);
    expect(seenMaxTokens[1]!).toBeLessThan(seenMaxTokens[0]!);
    expect(seenMaxTokens[1]!).toBeGreaterThan(240_000);
    expect(seenMaxTokens[1]!).toBeLessThanOrEqual(246_000);

    // Explicit business call maxTokens (1024) is preserved as 1024
    await drainEvents(call({ ...baseReq, maxTokens: 1_024 }));
    expect(seenMaxTokens[2]).toBe(1_024);
  });

  it("零额度、输入超限、思考预算冲突、累计耗尽、调用次数超限与重试首因均零请求拦截并给出准确可操作中文说明", async () => {
    const shortReq: ChatRequest = {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };

    // 1) 零 token 许可：不把 0 当缺省，不强行保留 1 token，0 次出站请求
    let outbound = 0;
    const zeroGov = makeGovMeter({ maxCalls: 2, maxTokens: 0 });
    await expect(
      drainEvents(
        meteredProviderCall({
          async *call() {
            outbound += 1;
            yield { type: "message_start" };
          },
          meter: zeroGov.meter,
          nextCallIndex: zeroGov.nextCallIndex,
          defaultMaxOutputTokens: 4_096,
        })(shortReq),
      ),
    ).rejects.toThrow("Model call resource budget stop: zero-token-grant");
    expect(outbound).toBe(0);
    expect(modelFailureText("Model call resource budget stop: zero-token-grant")).toContain("许可上限为 0");

    // 2) 输入本身已超单次许可：0 请求，明确说明输入预留超限且不说成已消耗模型 tokens
    const smallLease = makeGovMeter({ maxCalls: 2, maxTokens: 80 });
    const hugeInputReq: ChatRequest = {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(200) }] }],
    };
    await expect(
      drainEvents(
        meteredProviderCall({
          async *call() {
            outbound += 1;
            yield { type: "message_start" };
          },
          meter: smallLease.meter,
          nextCallIndex: smallLease.nextCallIndex,
          defaultMaxOutputTokens: 4_096,
        })(hugeInputReq),
      ),
    ).rejects.toThrow("Model call resource budget stop: input-exceeds-grant");
    expect(outbound).toBe(0);
    const inputErrText = modelFailureText("Model call resource budget stop: input-exceeds-grant");
    expect(inputErrText).toContain("本次请求未发出");
    expect(inputErrText).not.toContain("发送新消息会按新的额度继续");

    // 3) 思考预算不允许把 maxTokens 裁到 budget 以下：0 请求，指明思考预算冲突
    const thinkGov = makeGovMeter({ maxCalls: 2, maxTokens: 50_000 });
    await expect(
      drainEvents(
        meteredProviderCall({
          async *call() {
            outbound += 1;
            yield { type: "message_start" };
          },
          meter: thinkGov.meter,
          nextCallIndex: thinkGov.nextCallIndex,
          defaultMaxOutputTokens: 100_000,
        })({
          ...shortReq,
          thinking: { mode: "budget", budget: 60_000 },
        }),
      ),
    ).rejects.toThrow("Model call resource budget stop: thinking-exceeds-grant");
    expect(outbound).toBe(0);
    expect(modelFailureText("Model call resource budget stop: thinking-exceeds-grant")).toContain("思考预算");

    // 4) 调用次数拒绝：绝不误报成输入太长
    const callsGov = makeGovMeter({ maxCalls: 0, maxTokens: 256_000 });
    await expect(
      drainEvents(
        meteredProviderCall({
          async *call() {
            outbound += 1;
            yield { type: "message_start" };
          },
          meter: callsGov.meter,
          nextCallIndex: callsGov.nextCallIndex,
          defaultMaxOutputTokens: 4_096,
        })(shortReq),
      ),
    ).rejects.toThrow("Model call resource budget stop: calls-limit");
    const callsText = modelFailureText("Model call resource budget stop: calls-limit");
    expect(callsText).toContain("调用次数");
    expect(callsText).not.toContain("输入");

    // 5) 未送达连接错误按 0 token 回收后，同一租约重试仍保有完整 token 容量；
    //    而真实送达失败（如 HTTP 502）占用预留致使重试被额度拦下时，保留 502 真实首因
    const retryGov = makeGovMeter({ maxCalls: 4, maxTokens: 8_120 });
    let attempt = 0;
    const meteredForRetry = meteredProviderCall({
      async *call() {
        attempt += 1;
        if (attempt === 1) {
          const unsent = Object.assign(
            new Error("connect ECONNREFUSED 127.0.0.1:9"),
            { code: "ECONNREFUSED" },
          );
          markRequestUndelivered(unsent);
          yield { type: "error", error: unsent };
          return;
        }
        if (attempt === 2) {
          yield { type: "message_start" };
          yield {
            type: "error",
            error: Object.assign(new Error("HTTP 502: bad gateway"), { status: 502 }),
          };
          return;
        }
        yield { type: "message_start" };
      },
      meter: retryGov.meter,
      nextCallIndex: retryGov.nextCallIndex,
      defaultMaxOutputTokens: 8_000,
    });

    const resilient = withRetry((req) => meteredForRetry(req), {
      config: {
        maxRetries: 3,
        backoff: { baseDelayMs: 1, maxDelayMs: 2, jitter: false },
      },
    });
    const retriedEvents = await drainEvents(resilient(shortReq));
    const terminalErr = retriedEvents.at(-1) as Extract<StreamEvent, { type: "error" }>;
    expect(terminalErr.type).toBe("error");
    expect(terminalErr.error.message).toContain("Model usage budget exhausted while retrying after:");
    expect(terminalErr.error.message).toContain("502");
    const retryUserText = modelFailureText(terminalErr.error.message);
    expect(retryUserText).toBe(
      "模型服务暂时出错：请稍后重试。（重试时本次运行的模型用量已达上限，已停止重试。）",
    );
  });

  it("R2-1: 已知总上下文窗口（如 32768）下按 TokenEstimator 为当前请求输入留出真实余量，普通多字节文本不误拒，窗口耗尽或思考预算冲突零请求诚实报错", async () => {
    const seen: ChatRequest[] = [];
    const gov = makeGovMeter({ maxCalls: 8, maxTokens: 256_000 });
    const call32k = meteredProviderCall({
      async *call(req) {
        seen.push(req);
        yield { type: "message_start" };
        yield {
          type: "message_end",
          stopReason: "end_turn",
          usage: { inputTokens: 100, outputTokens: 10 },
        };
      },
      meter: gov.meter,
      nextCallIndex: gov.nextCallIndex,
      defaultMaxOutputTokens: 32_768,
      contextWindow: 32_768,
    });

    // 非空 systemPrompt + messages：出站 maxTokens 必须真实扣除估算输入（远大于 1，绝非硬减 1），且与 reserve 预占基于同一请求
    await drainEvents(
      call32k({
        model: "model-a",
        systemPrompt: "你是知行智能体，负责准确协助用户完成日常与工作任务。".repeat(20),
        messages: [{ role: "user", content: [{ type: "text", text: "第 1 轮，请简单问好" }] }],
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.maxTokens!).toBeLessThan(32_000);
    expect(seen[0]!.maxTokens!).toBeGreaterThan(30_000);

    // UTF-8 字节数 > 32768（如 45000 字节英文 = ~11258 tokens < 32768）：绝不拿 UTF-8 字节上界冒充模型输入 token 误拒！
    await drainEvents(
      call32k({
        model: "model-a",
        messages: [{ role: "user", content: [{ type: "text", text: "a".repeat(45_000) }] }],
      }),
    );
    expect(seen).toHaveLength(2);
    expect(seen[1]!.maxTokens!).toBeGreaterThan(20_000);
    expect(seen[1]!.maxTokens!).toBeLessThan(22_000);

    // 显式小请求（321）在 32768 窗口下原样保留
    await drainEvents(
      call32k({
        model: "model-a",
        maxTokens: 321,
        messages: [{ role: "user", content: [{ type: "text", text: "短问题" }] }],
      }),
    );
    expect(seen[2]!.maxTokens).toBe(321);

    // 输入 token 真实耗尽 32768 窗口：0 预占、0 出站，分类为上下文超限
    const prevReserved = gov.reservedCalls.length;
    await expect(
      drainEvents(
        call32k({
          model: "model-a",
          messages: [{ role: "user", content: [{ type: "text", text: "中".repeat(25_000) }] }],
        }),
      ),
    ).rejects.toThrow(/Context window overflow/);
    expect(seen).toHaveLength(3);
    expect(gov.reservedCalls).toHaveLength(prevReserved);
    expect(
      modelFailureText("Context window overflow: request input leaves no remaining output token capacity"),
    ).toContain("上下文长度超过模型限制");

    // 剩余上下文窗口小于思考预算：0 预占、0 出站，不暗中放大窗口或抹掉思考预算
    await expect(
      drainEvents(
        call32k({
          model: "model-a",
          thinking: { mode: "budget", budget: 30_000 },
          messages: [{ role: "user", content: [{ type: "text", text: "中".repeat(4_000) }] }],
        }),
      ),
    ).rejects.toThrow(/当前模型剩余上下文窗口不足以容纳已配置的思考预算/);
    expect(seen).toHaveLength(3);
    expect(gov.reservedCalls).toHaveLength(prevReserved);
  });

  it("R2-2: 单次固有限制优先于已有小额消耗判别（避免已有 16 token 消耗时把永不可装下的 6500 字节请求误报为累计不足）", async () => {
    const cases: Array<
      readonly [name: string, used: number, length: number, thinking: number | undefined, expected: string]
    > = [
      ["fresh-too-large", 0, 6_500, undefined, "input-exceeds-grant"],
      ["prior-small-then-too-large", 16, 6_500, undefined, "input-exceeds-grant"],
      ["only-remaining-too-small", 3_500, 1_000, undefined, "cumulative-tokens"],
      ["thinking-alone-cannot-fit", 16, 25, 5_000, "thinking-exceeds-grant"],
    ];

    for (const [name, used, length, thinking, expected] of cases) {
      const tracker = createLeaseBudgetTracker({ maxCalls: 20, maxTokens: 4_000 });
      if (used > 0) {
        tracker.recordReserved("prev", used);
        tracker.recordConsumed("prev", used);
      }
      let outbound = 0;
      const call = meteredProviderCall({
        async *call() {
          outbound += 1;
          yield { type: "message_start" };
        },
        defaultMaxOutputTokens: thinking ? 6_000 : 64,
        nextCallIndex: () => (used > 0 ? 2 : 1),
        meter: {
          budgetSnapshot: () => tracker.snapshot(),
          async reserve({ tokenUpperBound }) {
            if (tokenUpperBound + used > 4_000) {
              throw new TypeError("Resource cumulative usage tokens exceeds budget");
            }
            return { usageId: "next" };
          },
          async consume() {},
        },
      });
      let actualReason = "";
      try {
        await drainEvents(
          call({
            model: "test",
            messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(length) }] }],
            ...(thinking ? { thinking: { mode: "budget", budget: thinking } } : {}),
          }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        actualReason = parseModelBudgetStop(msg)?.reason ?? msg;
      }
      expect({ name, outbound, actualReason }).toEqual({
        name,
        outbound: 0,
        actualReason: expected,
      });
    }
  });

  it("R3: 手动思考预算仅在目录推荐/协议兜底下按容量上调默认输出，绝不放大显式上限，冲突零请求报错且不影响 adaptive 与非约束协议", async () => {
    const config: ZhixingConfig = {
      llm: {
        schemaVersion: 2,
        connections: {
          anth: {
            presetId: "anthropic",
            name: "Anthropic Loopback",
            adapter: "anthropic-messages",
            endpoint: "http://127.0.0.1:18080",
            auth: { mode: "api-key", secretRef: "anth_key" },
            network: { allowPrivateHosts: true },
          },
          qwen_conn: {
            presetId: "qwen",
            name: "Qwen Loopback",
            adapter: "openai-compatible",
            endpoint: "http://127.0.0.1:18080/v1",
            auth: { mode: "api-key", secretRef: "qwen_key" },
            network: { allowPrivateHosts: true },
          },
        },
        main: {
          connectionId: "anth",
          model: "claude-sonnet-4-5-20250929",
          params: { thinking: { mode: "budget", budget: 12_000 } },
        },
        light: {
          connectionId: "anth",
          model: "claude-sonnet-4-5-20250929",
          params: { thinking: { mode: "budget", budget: 4_096 } },
        },
        power: {
          connectionId: "qwen_conn",
          model: "qwen-plus",
          params: { thinking: { mode: "budget", budget: 36_000 } },
        },
      },
    };
    const credentials = {
      modelSecrets: {
        anth_key: { kind: "api-key" as const, value: "sk-ant-local" },
        qwen_key: { kind: "api-key" as const, value: "sk-qwen-local" },
      },
    };

    const factory = createHostKernelModelProviderFactory({
      configuration: config,
      credentials,
    });
    const binding = factory.create({ primaryRole: "main" });
    // Sonnet 4.5 (recommended 8192, physical 16384): budget 12000 raises default 8192 -> clamped at physical 16384!
    expect(binding.defaultMaxOutputTokens.main).toBe(16_384);
    // Sonnet 4.5 with budget 4096 (< 8192): keeps recommended 8192!
    expect(binding.defaultMaxOutputTokens.light).toBe(8_192);
    // Qwen Plus with thinking_budget 36000 (> physical 32768, separate DashScope field): keeps recommended 8192!
    expect(binding.defaultMaxOutputTokens.power).toBe(8_192);

    // Explicit user ceiling (8000 <= budget 12000) MUST NOT be enlarged!
    const explicitConflict = factory.create({
      primaryRole: "main",
      primaryRoleOverrides: { maxOutputPreference: 8_000 },
    });
    expect(explicitConflict.sessionPrimaryMaxOutputTokens).toBe(8_000);

    // Outbound precheck blocks 8000 <= 12000 with 0 reservations and 0 outbound calls
    const gov = makeGovMeter({ maxCalls: 4, maxTokens: 256_000 });
    let outbound = 0;
    const callAnth = meteredProviderCall({
      async *call() {
        outbound += 1;
        yield { type: "message_start" };
      },
      meter: gov.meter,
      nextCallIndex: gov.nextCallIndex,
      defaultMaxOutputTokens: 8_000,
      protocol: "anthropic-messages",
      contextWindow: 200_000,
    });
    await expect(
      drainEvents(
        callAnth({
          model: "claude-sonnet-4-5-20250929",
          thinking: { mode: "budget", budget: 12_000 },
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }),
      ),
    ).rejects.toThrow(/手动思考预算（12000 tokens）必须小于单次有效输出上限（当前上限 8000 tokens）/);
    expect(outbound).toBe(0);
    expect(gov.reservedCalls).toHaveLength(0);

    // Claude 4.7 adaptive model is NOT constrained by legacy budget_tokens < max_tokens
    await drainEvents(
      meteredProviderCall({
        async *call() {
          outbound += 1;
          yield { type: "message_start" };
          yield {
            type: "message_end",
            stopReason: "end_turn",
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
        meter: gov.meter,
        nextCallIndex: gov.nextCallIndex,
        defaultMaxOutputTokens: 8_000,
        protocol: "anthropic-messages",
        contextWindow: 200_000,
      })({
        model: "claude-sonnet-4-7",
        thinking: { mode: "budget", budget: 12_000 },
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    );
    expect(outbound).toBe(1);
  });
});
