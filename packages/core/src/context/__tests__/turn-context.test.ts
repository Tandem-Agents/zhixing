import { describe, it, expect } from "vitest";
import {
  TurnContextInjector,
  TimeProvider,
  SchedulerProvider,
  TaskListProvider,
  type TurnContextProvider,
  type TurnContextSection,
} from "../turn-context.js";
import type { TaskStatusSummary } from "../../scheduler/types.js";
import type { TaskItem } from "../../conversation/types.js";
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

  // ─── skipTurnContext: 缓存安全分叉路径 ───

  it("inject({ skipTurnContext: true }) 完全跳过注入，返回 messages 浅拷贝", () => {
    const injector = new TurnContextInjector();
    injector.register(stubProvider("t", true, { title: "T", body: "B" }));

    const original: Message[] = [userMessage("user 1"), userMessage("user 2")];
    const result = injector.inject(original, { skipTurnContext: true });

    // 内容完全不变 —— 没有 turn-context 块注入
    expect(extractText(result[0]!)).toBe("user 1");
    expect(extractText(result[1]!)).toBe("user 2");
    expect(extractText(result[1]!)).not.toContain("<turn-context>");
    // 返回是浅拷贝 —— 不污染原数组
    expect(result).not.toBe(original);
  });

  it("inject({ skipTurnContext: true }) 保留已有的 <turn-context> 块（与上一轮 byte-equal）", () => {
    const injector = new TurnContextInjector();
    injector.register(stubProvider("t", true, { title: "T", body: "新值" }));

    // 模拟上一轮 inject 留下的 messages（最末 user 含旧 turn-context 块）
    const previousRoundText =
      "<turn-context>\n[T] 旧值\n</turn-context>\n\n用户原文";
    const messages: Message[] = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: previousRoundText }],
      },
    ];

    const result = injector.inject(messages, { skipTurnContext: true });

    // 旧块保留 —— 与上一轮 byte-equal
    expect(extractText(result[0]!)).toBe(previousRoundText);
    expect(extractText(result[0]!)).toContain("[T] 旧值");
    // 不被新 provider 值替换
    expect(extractText(result[0]!)).not.toContain("[T] 新值");
  });

  it("inject({ skipTurnContext: false }) 等价于默认行为（注入新块）", () => {
    const injector = new TurnContextInjector();
    injector.register(stubProvider("t", true, { title: "T", body: "B" }));

    const messages: Message[] = [userMessage("hi")];
    const withFlag = injector.inject(messages, { skipTurnContext: false });
    const withoutOpts = injector.inject(messages);

    expect(extractText(withFlag[0]!)).toBe(extractText(withoutOpts[0]!));
    expect(extractText(withFlag[0]!)).toContain("<turn-context>");
    expect(extractText(withFlag[0]!)).toContain("[T] B");
  });

  it("inject({ skipTurnContext: true }) 即使无 provider 也不注入", () => {
    const injector = new TurnContextInjector();
    // 不 register 任何 provider

    const messages: Message[] = [userMessage("solo")];
    const result = injector.inject(messages, { skipTurnContext: true });

    expect(extractText(result[0]!)).toBe("solo");
    expect(result).not.toBe(messages);
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

// ─── TaskListProvider ───

describe("TaskListProvider", () => {
  it("shouldInject 在空列表时返回 false（不污染 turn-context）", () => {
    const tp = new TaskListProvider(() => []);
    expect(tp.shouldInject()).toBe(false);
  });

  it("shouldInject 在有任务时返回 true", () => {
    const tp = new TaskListProvider(() => [
      { id: "a", content: "任务 A", status: "pending" },
    ]);
    expect(tp.shouldInject()).toBe(true);
  });

  it("render 输出 markdown todo list 格式 + status 字符", () => {
    const items: TaskItem[] = [
      { id: "1", content: "已完成", status: "completed" },
      { id: "2", content: "进行中", status: "in_progress" },
      { id: "3", content: "待办", status: "pending" },
    ];
    const tp = new TaskListProvider(() => items);
    const section = tp.render();

    expect(section.title).toContain("当前任务列表");
    expect(section.body).toContain("1. [x] 已完成");
    expect(section.body).toContain("2. [~] 进行中");
    expect(section.body).toContain("3. [ ] 待办");
  });

  it("render 保留 LLM set 时的顺序", () => {
    const items: TaskItem[] = [
      { id: "1", content: "C", status: "pending" },
      { id: "2", content: "A", status: "pending" },
      { id: "3", content: "B", status: "pending" },
    ];
    const tp = new TaskListProvider(() => items);
    const section = tp.render();

    // 编号 1/2/3 对应 C/A/B（不重排）
    const cIdx = section.body.indexOf("1. [ ] C");
    const aIdx = section.body.indexOf("2. [ ] A");
    const bIdx = section.body.indexOf("3. [ ] B");
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeGreaterThan(cIdx);
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  it("getItems 每次调用都重新读 —— state 变化在下一个 turn 立即可见", () => {
    let currentItems: TaskItem[] = [];
    const tp = new TaskListProvider(() => currentItems);

    expect(tp.shouldInject()).toBe(false);

    currentItems = [{ id: "x", content: "新增", status: "in_progress" }];
    expect(tp.shouldInject()).toBe(true);
    expect(tp.render().body).toContain("新增");

    currentItems = [];
    expect(tp.shouldInject()).toBe(false);
  });

  it("通过 TurnContextInjector 集成 —— 空列表时整段消失", () => {
    const injector = new TurnContextInjector();
    injector.register(new TaskListProvider(() => []));

    expect(injector.build()).toBeNull();
  });

  it("通过 TurnContextInjector 集成 —— 有任务时注入到 user message", () => {
    const injector = new TurnContextInjector();
    injector.register(
      new TaskListProvider(() => [
        { id: "1", content: "构建编辑器", status: "in_progress" },
      ]),
    );

    const messages: Message[] = [userMessage("继续吧")];
    const result = injector.inject(messages);
    const lastText = extractText(result[0]!);

    expect(lastText).toContain("<turn-context>");
    expect(lastText).toContain("当前任务列表");
    expect(lastText).toContain("[~] 构建编辑器");
    expect(lastText).toContain("继续吧");
  });

  it("混合 provider（含 Time + TaskList）—— 多个 provider 协同注入", () => {
    const injector = new TurnContextInjector();
    injector.register(new TimeProvider("Asia/Shanghai"));
    injector.register(
      new TaskListProvider(() => [
        { id: "1", content: "测试", status: "pending" },
      ]),
    );

    const result = injector.build();
    expect(result).not.toBeNull();
    expect(result).toContain("当前时间");
    expect(result).toContain("当前任务列表");
    expect(result).toContain("[ ] 测试");
  });

  it("ephemeral 场景模拟 —— getItems 始终返回空（自然降级，与无 ALS 等价）", () => {
    // 装配方在 ALS 取不到 conversationId 时让 getItems 返回 [] ——
    // provider 自身不感知 ALS，行为完全由 closure 决定
    const tp = new TaskListProvider(() => []);
    expect(tp.shouldInject()).toBe(false);
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
