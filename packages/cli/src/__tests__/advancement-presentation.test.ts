import { describe, expect, it } from "vitest";
import type { AdvancementRunReview } from "@zhixing/core";
import {
  ADVANCEMENT_TURN_LABEL,
  describeAdvancementExitReason,
  renderAdvancementControlEventLines,
  renderAdvancementDetailLines,
  summarizeReview,
} from "../advancement-presentation.js";
import { stripAnsi } from "../tui/ansi.js";

const WIDTH = 120;

function review(
  overrides: Partial<AdvancementRunReview> = {},
): AdvancementRunReview {
  return {
    id: "review-1",
    runIndex: 2,
    reviewedAt: "2026-01-01T00:02:00.000Z",
    decision: "failed",
    evidence: [],
    attribution: {
      criteria: [
        { criterionId: "pc-1", verdict: "met", reason: "已实现。" },
        { criterionId: "pc-2", verdict: "unmet", reason: "测试未全绿。" },
      ],
    },
    unmetCriteria: ["测试仍未全绿"],
    selectedFailureHandlingId: "fix-tests",
    ...overrides,
  };
}

function plain(lines: string[]): string[] {
  return lines.map((line) => stripAnsi(line));
}

describe("summarizeReview", () => {
  it("failed 摘要含会话内轮次、达标计数与首条未满足项，逐条归因不上屏", () => {
    // 轮次来自事件携带的会话内 review 计数——runIndex 是对话全局序号不作轮次
    const text = summarizeReview(review(), 1);
    expect(text).toBe("推进验收 第 1 轮：未通过（1/2 条达标）——测试仍未全绿");
    expect(text).not.toContain("已实现");
  });

  it("passed 摘要一行通过；轮次缺失时不显示轮次", () => {
    expect(
      summarizeReview(review({ decision: "passed", unmetCriteria: [] }), 2),
    ).toBe("推进验收 第 2 轮：已通过");
    expect(
      summarizeReview(review({ decision: "passed", unmetCriteria: [] })),
    ).toBe("推进验收：已通过");
  });
});

describe("renderAdvancementControlEventLines", () => {
  it("run_reviewed 渲染验收摘要一行；exit 结论交由 exited 收场承载", () => {
    const lines = plain(
      renderAdvancementControlEventLines(
        "advancement:run_reviewed",
        { advancementSessionId: "adv-1", review: review(), reviewRound: 1 },
        WIDTH,
      ),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("推进验收 第 1 轮：未通过");

    // 多个卡点时全部列出——用户看全卡点，逐条归因仍折叠
    const multi = plain(
      renderAdvancementControlEventLines(
        "advancement:run_reviewed",
        {
          advancementSessionId: "adv-1",
          review: review({ unmetCriteria: ["测试仍未全绿", "文档未更新"] }),
        },
        WIDTH,
      ),
    );
    expect(multi).toHaveLength(2);
    expect(multi[0]).toContain("测试仍未全绿");
    expect(multi[1]).toContain("· 文档未更新");

    expect(
      renderAdvancementControlEventLines(
        "advancement:run_reviewed",
        {
          advancementSessionId: "adv-1",
          review: review({ decision: "exit", exitReason: "dead-end" }),
        },
        WIDTH,
      ),
    ).toEqual([]);
  });

  it("proxy_enqueued 渲染自动续推提示（与来源标记同源）", () => {
    const lines = plain(
      renderAdvancementControlEventLines(
        "advancement:proxy_enqueued",
        { advancementSessionId: "adv-1", proxyMessageId: "proxy-1" },
        WIDTH,
      ),
    );
    expect(lines[0]).toContain(ADVANCEMENT_TURN_LABEL);
  });

  it("completed 渲染完成标题与收场报告多行", () => {
    const lines = plain(
      renderAdvancementControlEventLines(
        "advancement:completed",
        {
          advancementSessionId: "adv-1",
          exit: { reason: "passed", message: "done", occurredAt: "t" },
          closure: {
            summary: "任务推进已验收通过\n共验收 3 轮。",
            synthesized: false,
            facts: {},
          },
        },
        WIDTH,
      ),
    );
    expect(lines[0]).toContain("✓ 任务推进完成");
    expect(lines[1]).toContain("任务推进已验收通过");
    expect(lines[2]).toContain("共验收 3 轮。");
  });

  it("exited 标题用退出原因人话并携带收场；保险丝原因可读", () => {
    const lines = plain(
      renderAdvancementControlEventLines(
        "advancement:exited",
        {
          advancementSessionId: "adv-1",
          exit: {
            reason: "budget-exceeded",
            message: "已达单任务成本上限",
            occurredAt: "t",
          },
          closure: { summary: "任务推进已退出", synthesized: false, facts: {} },
        },
        WIDTH,
      ),
    );
    expect(lines[0]).toContain("推进已退出：达到单任务成本上限");
    expect(lines[1]).toContain("任务推进已退出");
  });

  it("review_deferred 按 cause 区分挂起与中止提示", () => {
    expect(
      plain(
        renderAdvancementControlEventLines(
          "advancement:review_deferred",
          { cause: "infrastructure", reason: "rate limited" },
          WIDTH,
        ),
      )[0],
    ).toContain("本轮验收暂缓");
    expect(
      plain(
        renderAdvancementControlEventLines(
          "advancement:review_deferred",
          { cause: "aborted", reason: "user input" },
          WIDTH,
        ),
      )[0],
    ).toContain("本轮验收已中止");
  });

  it("contract_* 事件不渲染（发起端同步流承载，避免双渲染）", () => {
    for (const event of [
      "advancement:contract_draft",
      "advancement:contract_confirmed",
      "advancement:contract_cancelled",
      "advancement:contract_failed",
    ]) {
      expect(
        renderAdvancementControlEventLines(event, { any: 1 }, WIDTH),
      ).toEqual([]);
    }
  });

  it("payload 形状不符时静默跳过，不抛错", () => {
    expect(
      renderAdvancementControlEventLines(
        "advancement:run_reviewed",
        { review: "not-a-review" },
        WIDTH,
      ),
    ).toEqual([]);
    expect(
      renderAdvancementControlEventLines("advancement:completed", null, WIDTH),
    ).toHaveLength(1);
  });
});

describe("renderAdvancementDetailLines", () => {
  const facts = {
    sessionId: "adv-1",
    conversationId: "conv-1",
    status: "active" as const,
    rubricTitle: "代码任务验收",
    reviewedRunCount: 2,
    criteria: [
      {
        criterionId: "pc-1",
        text: "测试通过",
        verdict: "unmet" as const,
        reason: "测试仍未全绿。",
        evidenceExcerpt: "vitest: 1 failed",
      },
      {
        criterionId: "pc-2",
        text: "实现满足需求",
        verdict: "unknown" as const,
        reason: "无独立证据。",
      },
    ],
    attemptedStrategies: [
      { failureHandlingId: "fix-tests", attempts: 2, scenario: "测试失败" },
    ],
    lastEvidence: [],
    usage: {
      judge: { inputTokens: 0, outputTokens: 0 },
      run: { inputTokens: 0, outputTokens: 0 },
      totalTokens: 12345,
    },
  };

  it("active 会话展开逐条归因：判定人话、理由、证据摘录、采信证据与策略", () => {
    const lines = plain(
      renderAdvancementDetailLines(
        {
          conversationId: "conv-1",
          detail: {
            advancementSessionId: "adv-1",
            status: "active",
            rubricTitle: "代码任务验收",
            facts,
            lastReview: {
              ...review(),
              evidence: [
                {
                  id: "git",
                  kind: "file-diff",
                  summary: "git status: 2 changed",
                  source: "independent",
                },
              ],
            },
          },
        },
        WIDTH,
      ),
    );
    const text = lines.join("\n");
    expect(text).toContain("任务推进：代码任务验收（进行中 · 已验收 2 轮）");
    expect(text).toContain("1. 测试通过：未满足。测试仍未全绿。");
    expect(text).toContain("证据：vitest: 1 failed");
    expect(text).toContain("无法独立核验，已按执行侧报告采信");
    expect(text).not.toContain("unknown");
    expect(text).toContain("git status: 2 changed（独立核验）");
    expect(text).toContain("测试失败（2 次）");
    expect(text).toContain("12345 tokens");
  });

  it("终态会话直出收场报告（离线回看）", () => {
    const lines = plain(
      renderAdvancementDetailLines(
        {
          conversationId: "conv-1",
          detail: {
            advancementSessionId: "adv-1",
            status: "exited",
            facts: { ...facts, status: "exited" as const },
          },
        },
        WIDTH,
      ),
    );
    expect(lines.join("\n")).toContain("任务推进已退出");
  });

  it("无推进记录时明确说明", () => {
    const lines = plain(
      renderAdvancementDetailLines(
        { conversationId: "conv-1", detail: null },
        WIDTH,
      ),
    );
    expect(lines[0]).toContain("没有推进任务记录");
  });
});

describe("describeAdvancementExitReason", () => {
  it("全部枚举值都有人话，不裸露枚举", () => {
    for (const reason of [
      "passed",
      "dead-end",
      "user-cancelled",
      "user-took-over",
      "superseded",
      "system-error",
      "capability-gap",
      "budget-exceeded",
    ] as const) {
      const text = describeAdvancementExitReason(reason);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain(reason);
    }
  });
});
