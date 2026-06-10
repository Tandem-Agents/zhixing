/**
 * 启动装填器契约。
 *
 * 重点：预算化装组（组数是结果不是参数）、最近一组必装（超预算降级压缩核）、
 * 摘要选择（未退役 + 严格早于原文起点，回退更旧、宁缺毋滥）、clear 边界、
 * 工具轮渲染为可读文本。
 *
 * 用真实分片 store + 快照 store（临时目录）驱动——装填器是"持久化 → 窗口"
 * 的桥，桥的契约理应在真实两端上验证。
 */

import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { ShardedTranscriptStore } from "../../../transcript/shard/store.js";
import { SnapshotStore } from "../../../transcript/snapshot/store.js";
import type { Message } from "../../../types/messages.js";
import { extractFirstText } from "../../../types/messages.js";
import { buildStartupBootstrap } from "../build-startup-bootstrap.js";

let clock = Date.now();
function runMessages(text: string, extra: Message[] = []): Message[] {
  return [
    { role: "user", content: [{ type: "text", text }] },
    ...extra,
    { role: "assistant", content: [{ type: "text", text: `re:${text}` }] },
  ];
}

async function appendRun(
  store: ShardedTranscriptStore,
  id: string,
  text: string,
  extra: Message[] = [],
) {
  clock += 1000;
  return await store.appendRunRecord(id, {
    timestamp: new Date(clock).toISOString(),
    messages: runMessages(text, extra),
  });
}

// 确定性估算：每条消息 10 token —— 一组 [user, assistant] = 20
const perMessageEstimator = {
  estimateMessages: (m: readonly unknown[]) => m.length * 10,
};

let store: ShardedTranscriptStore;
let snapshots: SnapshotStore;

beforeEach(async () => {
  const tmp = await createTempDir("startup-bootstrap");
  const convDir = path.join(tmp, "conversations");
  store = new ShardedTranscriptStore(convDir, { platform: "linux" });
  snapshots = new SnapshotStore(convDir, { platform: "linux" });
});

function deps(optimalMaxTokens: number) {
  return {
    conversationId: "c1",
    store,
    snapshots,
    capability: { optimalMaxTokens },
    estimator: perMessageEstimator,
  };
}

function bootstrapText(pair: readonly [Message, Message]): string {
  return extractFirstText(pair[0]!);
}

describe("buildStartupBootstrap", () => {
  it("无历史 → null（新对话空窗起步）", async () => {
    expect(await buildStartupBootstrap(deps(100_000))).toBeNull();
  });

  it("clear 后 → null（倒读止于清空事件）", async () => {
    await appendRun(store, "c1", "清空前");
    await store.appendClear("c1");
    expect(await buildStartupBootstrap(deps(100_000))).toBeNull();
  });

  it("装填对：原文按时间正序、标签为机制插入的 startup-bootstrap", async () => {
    await appendRun(store, "c1", "第一句");
    await appendRun(store, "c1", "第二句");

    const pair = await buildStartupBootstrap(deps(100_000));
    expect(pair).not.toBeNull();
    const text = bootstrapText(pair!);
    expect(text).toContain('<system-meta kind="startup-bootstrap">');
    expect(text.indexOf("第一句")).toBeLessThan(text.indexOf("第二句"));
    expect(text).toContain("用户：第一句");
    expect(text).toContain("助手：re:第二句");
    expect(pair![1]!.role).toBe("assistant");
  });

  it("预算化装组：装满即止，组数是结果（最旧的组装不下被舍弃）", async () => {
    for (const t of ["零", "一", "二", "三"]) {
      await appendRun(store, "c1", t);
    }
    // 无快照 → 预算全给原文。optimal=160 → budget=40：首组 20、次组累计 40
    // 装满即止，更早的两组舍弃
    const pair = await buildStartupBootstrap(deps(160));
    const text = bootstrapText(pair!);
    expect(text).toContain("三"); // 最近组必在
    expect(text).toContain("二"); // 余额装下一组
    expect(text).not.toContain("用户：一"); // 更早的装不下
    expect(text).not.toContain("用户：零");
  });

  it("最近一组超预算 → 压缩核（开头意图 + 末尾原话 + 省略标注），绝不丢弃", async () => {
    // 一组 42 条消息（user + 40 tool 轮 + assistant）→ 420 token 远超 budgetBase
    const extra: Message[] = [];
    for (let i = 0; i < 20; i++) {
      extra.push(
        {
          role: "assistant",
          content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: `t${i}`, content: `body-${i}` },
          ],
        },
      );
    }
    await appendRun(store, "c1", "超长任务", extra);

    // budgetBase=400 < fullCost 420 → 触发压缩核；骨架文本本身远小于 400，
    // 形态完整可断言（极小预算下骨架被进一步收敛属硬上限语义，由专测覆盖）
    const pair = await buildStartupBootstrap(deps(1600));
    expect(pair).not.toBeNull();
    const text = bootstrapText(pair!);
    expect(text).toContain("用户：超长任务"); // 开头意图
    expect(text).toContain("中间过程已省略"); // 省略标注
    expect(text).toContain("助手：re:超长任务"); // 末尾结论
    expect(text).not.toContain("body-0"); // 中段工具轮被省略
  });

  it("压缩核硬上限：末尾消息为超长文本 → 文本级收敛到预算内（保头意图、保尾结论）", async () => {
    // 单组 [user 超长, assistant 超长]：消息条数少、单条文本巨大——
    // 既不满足"多消息走压缩骨架"，也不能让原样渲染绕过预算
    clock += 1000;
    await store.appendRunRecord("c1", {
      timestamp: new Date(clock).toISOString(),
      messages: [
        { role: "user", content: [{ type: "text", text: `开头意图。${"中段甲".repeat(3000)}` }] },
        {
          role: "assistant",
          content: [{ type: "text", text: `${"中段乙".repeat(3000)}最终结论。` }],
        },
      ],
    });

    // 真实字符级估算器（与 estimateTextTokensRaw 同量级），预算基准 = 400/4 = 100
    const charDeps = {
      conversationId: "c1",
      store,
      snapshots,
      capability: { optimalMaxTokens: 400 },
      estimator: {
        estimateMessages: (m: readonly Message[]) =>
          m.reduce(
            (sum, msg) =>
              sum +
              msg.content.reduce(
                (acc, b) => acc + (b.type === "text" ? b.text.length : 0),
                0,
              ),
            0,
          ),
      },
    };
    const pair = await buildStartupBootstrap(charDeps);
    expect(pair).not.toBeNull();
    const text = bootstrapText(pair!);
    // 硬上限：装填对总量与预算同量级（基准 100 token + 摘要预留 + 标签开销），
    // 决不被 18000 字的原文顶到失控
    expect(text.length).toBeLessThan(2000);
    expect(text).toContain("内容过长已截断");
    expect(text).toContain("开头意图"); // 保头（任务意图）
    expect(text).toContain("最终结论"); // 保尾（最终答复）
  });

  it("压缩核硬上限：末尾原话中含超长文本块同样被收敛", async () => {
    const extra: Message[] = [];
    for (let i = 0; i < 10; i++) {
      extra.push(
        {
          role: "assistant",
          content: [{ type: "tool_use", id: `t${i}`, name: "Read", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: `t${i}`, content: `r${i}` },
          ],
        },
      );
    }
    // 末条 assistant 是超长结论 —— 落在压缩核"末尾原话"区间内
    clock += 1000;
    await store.appendRunRecord("c1", {
      timestamp: new Date(clock).toISOString(),
      messages: [
        { role: "user", content: [{ type: "text", text: "任务" }] },
        ...extra,
        {
          role: "assistant",
          content: [{ type: "text", text: `${"超长尾部".repeat(4000)}收束。` }],
        },
      ],
    });
    const charDeps = {
      conversationId: "c1",
      store,
      snapshots,
      capability: { optimalMaxTokens: 400 },
      estimator: {
        estimateMessages: (m: readonly Message[]) =>
          m.reduce(
            (sum, msg) =>
              sum +
              msg.content.reduce(
                (acc, b) => acc + (b.type === "text" ? b.text.length : 0),
                0,
              ),
          0,
          ),
      },
    };
    const pair = await buildStartupBootstrap(charDeps);
    const text = bootstrapText(pair!);
    expect(text.length).toBeLessThan(2000); // 预算硬上限不被末尾长文本击穿
    expect(text).toContain("内容过长已截断");
  });

  it("工具轮渲染为可读文本（调用标注 + 结果截断），不伪装协议消息", async () => {
    await appendRun(store, "c1", "读文件", [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t1", content: "x".repeat(500) },
        ],
      },
    ]);
    const pair = await buildStartupBootstrap(deps(100_000));
    const text = bootstrapText(pair!);
    expect(text).toContain("[调用工具 Read]");
    expect(text).toContain("[工具结果] xxx");
    expect(text).not.toContain("x".repeat(300)); // 结果被截断
  });

  describe("摘要选择", () => {
    it("有效快照（未退役 + 严格早于原文起点）→ 摘要在前", async () => {
      for (const t of ["零", "一", "二", "三"]) {
        await appendRun(store, "c1", t);
      }
      await snapshots.write("c1", {
        coveredThroughRunIndex: 1,
        structuredSummary: { facts: "早期事实", state: "", active: "" },
        tokensBefore: 100,
        tokensAfter: 10,
      });
      // 有快照 → 摘要预留 400。optimal=1760 → budget=440：原文装后两组
      //（runIndex 2、3）→ earliest=2 > covered=1 → 摘要采用
      const pair = await buildStartupBootstrap(deps(1760));
      const text = bootstrapText(pair!);
      expect(text).toContain("早期事实");
      expect(text.indexOf("早期事实")).toBeLessThan(text.indexOf("用户：二"));
    });

    it("快照与已装原文重叠 → 回退更旧；无满足者 → 纯原文", async () => {
      for (const t of ["零", "一", "二", "三"]) {
        await appendRun(store, "c1", t);
      }
      await snapshots.write("c1", {
        coveredThroughRunIndex: 1,
        structuredSummary: { facts: "旧摘要", state: "", active: "" },
        tokensBefore: 100,
        tokensAfter: 10,
      });
      await new Promise((r) => setTimeout(r, 5));
      await snapshots.write("c1", {
        coveredThroughRunIndex: 3, // 覆盖到 run3，与已装原文（2 起）重叠
        structuredSummary: { facts: "新摘要", state: "", active: "" },
        tokensBefore: 100,
        tokensAfter: 10,
      });

      // 预算含摘要预留 → 原文只装最近一组（earliest=3）；新摘要 covered=3
      // 不满足"严格早于"→ 跳过，回退旧摘要（covered=1 < 3）
      const pair = await buildStartupBootstrap(deps(400));
      const text = bootstrapText(pair!);
      expect(text).not.toContain("新摘要"); // 重叠 → 跳过
      expect(text).toContain("旧摘要"); // 回退到更旧的有效快照
    });

    it("清空前的快照已退役 → 不采用", async () => {
      await appendRun(store, "c1", "旧世界");
      await snapshots.write("c1", {
        coveredThroughRunIndex: 0,
        structuredSummary: { facts: "旧世界摘要", state: "", active: "" },
        tokensBefore: 100,
        tokensAfter: 10,
      });
      await new Promise((r) => setTimeout(r, 5));
      await store.appendClear("c1");
      await appendRun(store, "c1", "新世界");

      const pair = await buildStartupBootstrap(deps(100_000));
      const text = bootstrapText(pair!);
      expect(text).toContain("新世界");
      expect(text).not.toContain("旧世界摘要");
    });

    it("摘要超封顶 → 截 active 尾、保 facts/state", async () => {
      await appendRun(store, "c1", "近况");
      await appendRun(store, "c1", "更近");
      await snapshots.write("c1", {
        coveredThroughRunIndex: 0,
        structuredSummary: {
          facts: "事实段",
          state: "状态段",
          active: "进行中".repeat(400), // 远超封顶
        },
        tokensBefore: 100,
        tokensAfter: 10,
      });
      // 只装最近一组（earliest=1 > covered=0）
      const pair = await buildStartupBootstrap(deps(80));
      const text = bootstrapText(pair!);
      expect(text).toContain("事实段");
      expect(text).toContain("状态段");
      expect(text).not.toContain("进行中".repeat(300)); // active 被截
    });
  });
});
