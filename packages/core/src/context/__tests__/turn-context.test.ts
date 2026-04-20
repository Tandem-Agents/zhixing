import { describe, it, expect } from "vitest";
import {
  TurnContextInjector,
  TimeProvider,
  SchedulerProvider,
  type TurnContextProvider,
  type TurnContextSection,
} from "../turn-context.js";
import type { TaskStatusSummary } from "../../scheduler/types.js";
import { userMessage, type Message } from "../../types/messages.js";

// ─── TurnContextInjector ───

describe("TurnContextInjector", () => {
  it("build() returns null when no providers registered", () => {
    const injector = new TurnContextInjector();
    expect(injector.build()).toBeNull();
  });

  it("build() returns null when all providers skip", () => {
    const injector = new TurnContextInjector();
    injector.register(stubProvider("test", false, { title: "T", body: "B" }));
    expect(injector.build()).toBeNull();
  });

  it("build() assembles active providers in registration order", () => {
    const injector = new TurnContextInjector();
    injector.register(stubProvider("a", true, { title: "时间", body: "15:00" }));
    injector.register(stubProvider("b", false, { title: "跳过", body: "N/A" }));
    injector.register(stubProvider("c", true, { title: "任务", body: "1 个活跃" }));

    const result = injector.build()!;
    expect(result).toContain("<turn-context>");
    expect(result).toContain("[时间] 15:00");
    expect(result).toContain("[任务] 1 个活跃");
    expect(result).not.toContain("跳过");
    expect(result).toContain("</turn-context>");
  });

  it("inject() prepends to last user message", () => {
    const injector = new TurnContextInjector();
    injector.register(stubProvider("t", true, { title: "时间", body: "15:00" }));

    const messages: Message[] = [
      userMessage("第一条"),
      { role: "assistant", content: [{ type: "text", text: "回复" }] },
      userMessage("第二条"),
    ];

    const result = injector.inject(messages);
    // 第一条不变
    expect(extractText(result[0]!)).toBe("第一条");
    // 最后一条 user message 被注入
    const lastText = extractText(result[2]!);
    expect(lastText).toContain("<turn-context>");
    expect(lastText).toContain("[时间] 15:00");
    expect(lastText).toContain("第二条");
  });

  it("inject() does not modify original array", () => {
    const injector = new TurnContextInjector();
    injector.register(stubProvider("t", true, { title: "T", body: "B" }));
    const messages: Message[] = [userMessage("原始")];
    const result = injector.inject(messages);
    expect(result).not.toBe(messages);
    expect(extractText(messages[0]!)).toBe("原始");
  });

  it("inject() returns copy when no providers active", () => {
    const injector = new TurnContextInjector();
    const messages: Message[] = [userMessage("hello")];
    const result = injector.inject(messages);
    expect(extractText(result[0]!)).toBe("hello");
  });

  it("inject() strips old turn-context to prevent duplication", () => {
    const injector = new TurnContextInjector();
    injector.register(stubProvider("t", true, { title: "时间", body: "16:00" }));

    const alreadyInjected = userMessage(
      "<turn-context>\n[时间] 15:00\n</turn-context>\n\n用户消息",
    );
    const result = injector.inject([alreadyInjected]);
    const text = extractText(result[0]!);

    // 只出现一次 turn-context
    const matches = text.match(/<turn-context>/g);
    expect(matches).toHaveLength(1);
    expect(text).toContain("[时间] 16:00");
    expect(text).not.toContain("[时间] 15:00");
    expect(text).toContain("用户消息");
  });

  it("inject() handles messages with only tool_result blocks", () => {
    const injector = new TurnContextInjector();
    injector.register(stubProvider("t", true, { title: "T", body: "B" }));

    const toolResultMsg: Message = {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "id1", content: "result" },
      ],
    };
    // tool_result 消息也是 user role，但不应被误注入
    // inject 找最后一个 user message 并在 text 前注入
    // 如果没有 text block，会在 content 前插入一个
    const result = injector.inject([toolResultMsg]);
    expect(result[0]!.content.length).toBe(2); // text + tool_result
    expect(result[0]!.content[0]!.type).toBe("text");
  });
});

// ─── TimeProvider ───

describe("TimeProvider", () => {
  it("always injects", () => {
    const tp = new TimeProvider("Asia/Shanghai");
    expect(tp.shouldInject()).toBe(true);
  });

  it("renders with timezone", () => {
    const tp = new TimeProvider("Asia/Shanghai");
    const section = tp.render();
    expect(section.title).toBe("当前时间");
    expect(section.body).toContain("Asia/Shanghai");
  });
});

// ─── SchedulerProvider ───

describe("SchedulerProvider", () => {
  const emptyStatus: TaskStatusSummary = {
    active: [],
    recentlyCompleted: [],
    recentlyFailed: [],
  };

  it("shouldInject() returns false when no tasks", () => {
    const sp = new SchedulerProvider(() => emptyStatus);
    expect(sp.shouldInject()).toBe(false);
  });

  it("shouldInject() returns true when active tasks exist", () => {
    const sp = new SchedulerProvider(() => ({
      ...emptyStatus,
      active: [{ name: "早报", schedule: "cron 0 8 * * *", nextRunAt: "2026-04-21T08:00:00Z" }],
    }));
    expect(sp.shouldInject()).toBe(true);
  });

  it("shouldInject() returns true when recently completed tasks exist", () => {
    const sp = new SchedulerProvider(() => ({
      ...emptyStatus,
      recentlyCompleted: [{ name: "提醒", completedAt: "2026-04-20T15:45:00Z" }],
    }));
    expect(sp.shouldInject()).toBe(true);
  });

  it("renders active tasks with schedule info", () => {
    const sp = new SchedulerProvider(() => ({
      ...emptyStatus,
      active: [
        { name: "早报", schedule: "cron 0 8 * * *", nextRunAt: "2026-04-21T08:00:00Z" },
        { name: "监控", schedule: "每 5 分钟" },
      ],
    }));
    const section = sp.render();
    expect(section.title).toContain("定时任务");
    expect(section.body).toContain("2 个活跃");
    expect(section.body).toContain("早报");
    expect(section.body).toContain("监控");
  });

  it("renders completed and failed tasks", () => {
    const sp = new SchedulerProvider(() => ({
      active: [],
      recentlyCompleted: [{ name: "备份", completedAt: "2026-04-20T15:48:00Z", summary: "成功" }],
      recentlyFailed: [{ name: "同步", failedAt: "2026-04-20T15:30:00Z", error: "timeout" }],
    }));
    const section = sp.render();
    expect(section.body).toContain("1 个最近完成");
    expect(section.body).toContain("1 个最近失败");
    expect(section.body).toContain("✅");
    expect(section.body).toContain("备份");
    expect(section.body).toContain("❌");
    expect(section.body).toContain("timeout");
  });

  it("renders delivery status for completed tasks", () => {
    const sp = new SchedulerProvider(() => ({
      active: [],
      recentlyCompleted: [
        { name: "已投递", completedAt: "2026-04-20T15:48:00Z", delivered: true },
        { name: "未投递", completedAt: "2026-04-20T15:47:00Z", delivered: false },
        { name: "无状态", completedAt: "2026-04-20T15:46:00Z" },
      ],
      recentlyFailed: [],
    }));
    const section = sp.render();
    expect(section.body).toContain('"已投递" — 完成于');
    expect(section.body).toContain("结果已发送");
    // 未投递和无状态的不显示"结果已发送"
    expect(section.body).toMatch(/"未投递" — 完成于[^]*?(?!结果已发送)/);
  });

  it("respects maxActive limit", () => {
    const manyActive = Array.from({ length: 15 }, (_, i) => ({
      name: `task-${i}`,
      schedule: "每 1 分钟",
    }));
    const sp = new SchedulerProvider(
      () => ({ active: manyActive, recentlyCompleted: [], recentlyFailed: [] }),
      { maxActive: 3 },
    );
    const section = sp.render();
    expect(section.body).toContain("15 个活跃");
    expect(section.body).toContain("task-0");
    expect(section.body).toContain("task-2");
    expect(section.body).not.toContain("task-3");
    expect(section.body).toContain("还有 12 个活跃任务");
  });
});

// ─── Helpers ───

function stubProvider(
  id: string,
  active: boolean,
  section: TurnContextSection,
): TurnContextProvider {
  return {
    id,
    shouldInject: () => active,
    render: () => section,
  };
}

function extractText(msg: Message): string {
  const tb = msg.content.find(
    (b): b is { type: "text"; text: string } => b.type === "text",
  );
  return tb?.text ?? "";
}
