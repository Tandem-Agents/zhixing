import { describe, expect, it } from "vitest";
import { renderClosureReport, type AdvancementRunReview } from "@zhixing-ai/core/advancement";
import type { TerminalSummary } from "@zhixing-ai/terminal-ui/protocol";
import {
  ADVANCEMENT_TURN_LABEL,
  describeAdvancementExitReason,
  advancementDetailSummary,
  renderAdvancementControlEventLines,
  renderAdvancementEmptyLine,
  renderResumedAdvancementNotice,
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

describe("推进提议阶段的呈现", () => {
  it("草案失败或结果不明：说明原任务保留与可继续的操作", () => {
    const failed = plain(renderAdvancementControlEventLines(
      "advancement:proposal_draft_failed",
      { advancementSessionId: "adv-1", outcome: "failed", message: "模型不可用" },
      WIDTH * 2,
    ));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain("验收标准起草失败：模型不可用。原任务保留");
    expect(failed[0]).toContain("“直接执行”或“取消”");
    const uncertain = plain(renderAdvancementControlEventLines(
      "advancement:proposal_draft_failed",
      { advancementSessionId: "adv-1", outcome: "uncertain" },
      WIDTH * 2,
    ));
    expect(uncertain[0]).toContain("起草结果不明");
    expect(uncertain[0]).toContain("原任务保留");
    // 草案就绪由确认面承载，不出系统行
    expect(renderAdvancementControlEventLines("advancement:contract_draft", { advancementSessionId: "adv-1" }, WIDTH)).toEqual([]);
  });

  it("推进恢复未完成：给类别与去处，不展示内部错误原文", () => {
    const raw = 'AdvancementStore: session "advancement-proposal-x" has no pending original-task admission';
    const failed = plain(renderAdvancementControlEventLines(
      "advancement:recovery_failed",
      { status: "failed", advancementSessionId: "adv-1", message: raw },
      WIDTH * 2,
    )).join("\n");
    expect(failed).toContain("推进恢复未完成：恢复时出错。可在 /advancement 查看任务状态。");
    expect(failed).not.toContain("AdvancementStore");
    expect(plain(renderAdvancementControlEventLines("advancement:recovery_failed", { status: "busy" }, WIDTH * 2)).join("\n"))
      .toContain("推进正在处理中，稍后会自动继续");
  });

  it("恢复提示覆盖提议阶段状态", () => {
    expect(stripAnsi(renderResumedAdvancementNotice({ status: "drafting" }, WIDTH))).toContain("已提出推进，正在起草验收标准");
    expect(stripAnsi(renderResumedAdvancementNotice({ status: "draft-failed" }, WIDTH))).toContain("起草失败，原任务保留");
    expect(stripAnsi(renderResumedAdvancementNotice({ status: "awaiting-rubric-confirmation" }, WIDTH))).toContain("待确认");
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

describe("advancementDetailSummary", () => {
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
      { criterionId: "pc-3", text: "文档已更新", verdict: "unreviewed" as const },
      { criterionId: "pc-4", text: "无回归", verdict: "met" as const },
    ],
    attemptedStrategies: [
      { failureHandlingId: "fix-tests", attempts: 2, scenario: "测试失败" },
      { failureHandlingId: "retry-build", attempts: 1 },
    ],
    lastEvidence: [{ id: "ci", kind: "command-output" as const, summary: "CI 全绿", source: "user" as const }],
    usage: {
      judge: { inputTokens: 0, outputTokens: 0 },
      run: { inputTokens: 0, outputTokens: 0 },
      totalTokens: 12345,
    },
  };
  const section = (summary: TerminalSummary, title: string) => summary.sections.find((item) => item.title === title);
  const one = (pages: TerminalSummary[] | undefined) => { expect(pages).toHaveLength(1); return pages![0]!; };

  it("active：页首写标题与 reviewedRunCount，逐条判定用 core 人话，未满足警示、未验收另行表述，理由与证据在行下", () => {
    const summary = one(advancementDetailSummary({
      conversationId: "conv-1",
      detail: {
        advancementSessionId: "adv-1",
        status: "active",
        rubricTitle: "代码任务验收",
        facts,
        lastReview: {
          ...review({ runIndex: 7 }),
          evidence: [{ id: "git", kind: "file-diff", summary: "git status: 2 changed", source: "independent" }],
        },
      },
    }));
    expect(summary.lead).toEqual([
      [{ text: "任务推进：代码任务验收", tone: "accent" }],
      [{ text: "进行中 · 已验收 2 轮" }],
    ]);
    expect(section(summary, "验收标准 · 最近判定")!.rows).toEqual([
      { label: "1. 测试通过", value: "未满足", tone: "warn", note: "测试仍未全绿。  证据：vitest: 1 failed" },
      { label: "2. 实现满足需求", value: "无法独立核验，已按执行侧报告采信", note: "无独立证据。" },
      { label: "3. 文档已更新", value: "未验收" },
      { label: "4. 无回归", value: "已满足" },
    ]);
    expect(section(summary, "最近一轮采信证据")!.rows).toEqual([{ label: "独立核验", value: "git status: 2 changed" }]);
    expect(section(summary, "已尝试策略")!.rows).toEqual([{ label: "测试失败", value: "2 次" }, { label: "retry-build", value: "1 次" }]);
    expect(summary.sections.at(-1)!.notes).toEqual(["本次推进已消耗约 12345 tokens。"]);
    const all = JSON.stringify(summary);
    expect(all).not.toContain("unknown"); expect(all).not.toContain("已验收 7 轮");
  });

  it("待确认：状态写“等待确认验收标准”，没有证据与策略时只列已有区块，用量仍在", () => {
    const summary = one(advancementDetailSummary({
      conversationId: "conv-1",
      detail: { advancementSessionId: "adv-1", status: "awaiting-rubric-confirmation", facts: { ...facts, criteria: [], attemptedStrategies: [] } },
    }));
    expect(summary.lead).toEqual([[{ text: "任务推进", tone: "accent" }], [{ text: "等待确认验收标准" }],
      [{ text: "本次推进已消耗约 12345 tokens。", tone: "dim" }]]);
    expect(summary.sections).toEqual([]);
  });

  it("终态回看与收场报告同一份 facts：标题、轮次、退出原因、标准、策略、总消耗；cancelled 先写已取消", () => {
    const exited = one(advancementDetailSummary({
      conversationId: "conv-1",
      detail: { advancementSessionId: "adv-1", status: "exited",
        facts: { ...facts, status: "exited" as const, exit: { reason: "dead-end", message: "继续推进没有新进展" } } },
    }));
    expect(exited.lead).toEqual([
      [{ text: "任务推进已退出：代码任务验收", tone: "accent" }],
      [{ text: "共验收 2 轮。" }],
      [{ text: "退出原因：继续推进没有新进展" }],
    ]);
    expect(section(exited, "验收标准")!.rows!.map((row) => row.value)).toEqual(["未满足", "无法独立核验，已按执行侧报告采信", "未验收", "已满足"]);
    expect(section(exited, "已尝试策略")).toBeDefined();
    expect(section(exited, "验收证据")).toBeUndefined();
    expect(exited.sections.at(-1)!.notes).toEqual(["本次推进共消耗约 12345 tokens。"]);

    const completed = one(advancementDetailSummary({
      conversationId: "conv-1",
      detail: { advancementSessionId: "adv-1", status: "completed", facts: { ...facts, status: "completed" as const } },
    }));
    expect(completed.lead[0]).toEqual([{ text: "任务推进已验收通过：代码任务验收", tone: "accent" }]);
    expect(section(completed, "验收证据")!.rows).toEqual([{ label: "用户提供", value: "CI 全绿" }]);

    const cancelled = one(advancementDetailSummary({
      conversationId: "conv-1",
      detail: { advancementSessionId: "adv-1", status: "cancelled", facts: { ...facts, status: "cancelled" as const, criteria: [], attemptedStrategies: [] } },
    }));
    expect(cancelled.lead.slice(0, 2)).toEqual([[{ text: "推进任务已取消", tone: "accent" }], [{ text: "任务推进已退出：代码任务验收", tone: "normal" }]]);
    expect(cancelled.lead.at(-1)).toEqual([{ text: "本次推进共消耗约 12345 tokens。", tone: "dim" }]);
  });

  it("终态标题与 core 收场报告首行一致", () => {
    for (const status of ["completed", "exited"] as const) {
      const summary = one(advancementDetailSummary({ conversationId: "conv-1", detail: { advancementSessionId: "adv-1", status, facts: { ...facts, status } } }));
      expect(summary.lead[0]![0]!.text).toBe(renderClosureReport({ ...facts, status }).split("\n")[0]);
    }
  });

  it("提议阶段不是终态：说明所处阶段与可继续的操作，不显示“已退出”", () => {
    const render = (status: "drafting" | "draft-failed" | "draft-uncertain") => JSON.stringify(advancementDetailSummary(
      { conversationId: "conv-1", detail: { advancementSessionId: "adv-1", status, facts: { ...facts, status } } },
    ));
    expect(render("drafting")).toContain("已提出推进，正在起草验收标准");
    const failed = render("draft-failed");
    expect(failed).toContain("起草失败，原任务保留");
    expect(failed).toContain("“直接执行”或“取消”");
    expect(failed).not.toContain("已退出");
    expect(render("draft-uncertain")).toContain("起草结果不明");
  });

  it("标准、证据与策略很多时按页拆分，末项可达，用量写在最后一个区块的末尾", () => {
    const criteria = Array.from({ length: 600 }, (_, index) => ({ criterionId: `c-${index}`, text: `标准 ${index + 1}`, verdict: "met" as const, reason: "已核对。" }));
    const pages = advancementDetailSummary({ conversationId: "conv-1", detail: { advancementSessionId: "adv-1", status: "active", rubricTitle: "长清单",
      facts: { ...facts, criteria, attemptedStrategies: [] } } })!;
    expect(pages.length).toBeGreaterThan(1);
    const rows = pages.flatMap((page) => page.sections).filter((item) => item.title.startsWith("验收标准")).flatMap((item) => item.rows ?? []);
    expect(rows).toHaveLength(600); expect(rows.at(-1)!.label).toBe("600. 标准 600");
    expect(pages[0]!.sections[0]!.notes).toBeUndefined();
    expect(pages.at(-1)!.sections.at(-1)!.notes).toEqual(["本次推进已消耗约 12345 tokens。"]);
    expect(JSON.stringify(pages)).not.toContain("未能显示");
  });

  it("无推进记录时不给分节，沿用原来的一句话页面", () => {
    expect(advancementDetailSummary({ conversationId: "conv-1", detail: null })).toBeUndefined();
    expect(stripAnsi(renderAdvancementEmptyLine(WIDTH))).toContain("◆ 当前对话没有推进任务记录。");
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
