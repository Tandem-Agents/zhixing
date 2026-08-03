import { describe, expect, it } from "vitest";
import {
  buildClosureFacts,
  renderClosureReport,
  sumAdvancementUsage,
} from "../closure.js";
import { projectConfirmedRubricToDraftContent } from "../contract.js";
import type {
  AdvancementRunReview,
  AdvancementSession,
  ConfirmedRubricSnapshot,
} from "../types.js";

function rubric(): ConfirmedRubricSnapshot {
  return {
    source: {
      kind: "library",
      rubricId: "rubric-1",
      rubricVersion: "v1",
    },
    title: "代码任务验收",
    description: "验收代码任务。",
    confirmedAt: "2026-01-01T00:01:00.000Z",
    confirmedBy: "user",
    content: {
      passCriteria: [
        { id: "pc-1", text: "需求已实现" },
        { id: "pc-2", text: "相关测试通过" },
        { id: "pc-3", text: "文档已更新" },
      ],
      evidenceRequirements: [
        {
          id: "tests",
          kind: "test-result",
          description: "测试必须通过。",
          required: true,
        },
      ],
      failureHandling: [
        { id: "fix-tests", scenario: "测试失败", reply: "请修复失败测试。" },
        { id: "add-docs", scenario: "文档缺失", reply: "请补充文档。" },
      ],
    },
  };
}

function review(
  overrides: Partial<AdvancementRunReview> & { id: string; runIndex: number },
): AdvancementRunReview {
  return {
    reviewedAt: "2026-01-01T00:02:00.000Z",
    decision: "failed",
    evidence: [],
    attribution: { criteria: [] },
    unmetCriteria: [],
    ...overrides,
  };
}

function session(
  overrides?: Partial<AdvancementSession>,
): AdvancementSession {
  return {
    id: "adv-1",
    conversationId: "conv-1",
    status: "exited",
    originalUserTask: { parts: [{ type: "text", text: "把任务做完" }] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
    rubricDraftVersion: 1,
    confirmedRubric: rubric(),
    runs: [],
    proxyMessages: [],
    ...overrides,
  };
}

describe("buildClosureFacts", () => {
  it("标准矩阵按 criterionId 锚定，取最后一次覆盖该条的判定", async () => {
    const runs = [
      review({
        id: "review-1",
        runIndex: 0,
        attribution: {
          criteria: [
            { criterionId: "pc-1", verdict: "unmet", reason: "还没实现。" },
            { criterionId: "pc-2", verdict: "unmet", reason: "测试红。" },
          ],
        },
        selectedFailureHandlingId: "fix-tests",
      }),
      review({
        id: "review-2",
        runIndex: 1,
        attribution: {
          criteria: [
            { criterionId: "pc-1", verdict: "met", reason: "已实现。" },
            {
              criterionId: "pc-2",
              verdict: "unknown",
              reason: "无独立测试证据。",
              evidenceExcerpt: "执行侧自述测试通过",
            },
          ],
        },
        selectedFailureHandlingId: "fix-tests",
      }),
    ];
    const facts = buildClosureFacts(session({ runs }));

    expect(facts.criteria).toEqual([
      {
        criterionId: "pc-1",
        text: "需求已实现",
        verdict: "met",
        reason: "已实现。",
      },
      {
        criterionId: "pc-2",
        text: "相关测试通过",
        verdict: "unknown",
        reason: "无独立测试证据。",
        evidenceExcerpt: "执行侧自述测试通过",
      },
      { criterionId: "pc-3", text: "文档已更新", verdict: "unreviewed" },
    ]);
    expect(facts.reviewedRunCount).toBe(2);
  });

  it("已试策略按 failureHandlingId 计数并反查 scenario", () => {
    const runs = [
      review({ id: "r1", runIndex: 0, selectedFailureHandlingId: "fix-tests" }),
      review({ id: "r2", runIndex: 1, selectedFailureHandlingId: "fix-tests" }),
      review({ id: "r3", runIndex: 2, selectedFailureHandlingId: "add-docs" }),
    ];
    const facts = buildClosureFacts(session({ runs }));

    expect(facts.attemptedStrategies).toEqual([
      { failureHandlingId: "fix-tests", attempts: 2, scenario: "测试失败" },
      { failureHandlingId: "add-docs", attempts: 1, scenario: "文档缺失" },
    ]);
  });

  it("保险丝/dead-end 转化轮裁判选了策略但续推未发出，不计入已试", () => {
    const runs = [
      review({ id: "r1", runIndex: 0, selectedFailureHandlingId: "fix-tests" }),
      review({
        id: "r2",
        runIndex: 1,
        decision: "exit",
        exitReason: "budget-exceeded",
        selectedFailureHandlingId: "fix-tests",
      }),
    ];
    const facts = buildClosureFacts(session({ runs }));

    expect(facts.attemptedStrategies).toEqual([
      { failureHandlingId: "fix-tests", attempts: 1, scenario: "测试失败" },
    ]);
  });

  it("usage 合计沿 review 序列累加两半快照", () => {
    const runs = [
      review({
        id: "r1",
        runIndex: 0,
        usage: {
          judge: { inputTokens: 100, outputTokens: 50 },
          run: { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 300 },
        },
      }),
      review({
        id: "r2",
        runIndex: 1,
        usage: {
          judge: { inputTokens: 120, outputTokens: 60 },
          run: {
            inputTokens: 1100,
            outputTokens: 500,
            totalInputTokens: 1500,
          },
        },
      }),
    ];
    const totals = sumAdvancementUsage(runs);

    expect(totals.judge.inputTokens).toBe(220);
    expect(totals.judge.outputTokens).toBe(110);
    expect(totals.run.inputTokens).toBe(2100);
    expect(totals.run.outputTokens).toBe(900);
    // 规范口径：judge (220+110) + run ((1000+1500)+900)
    expect(totals.totalTokens).toBe(220 + 110 + 1000 + 1500 + 900);
  });

  it("无已确认契约时标准矩阵为空，不抛错", () => {
    const facts = buildClosureFacts(
      session({ confirmedRubric: undefined, status: "cancelled" }),
    );
    expect(facts.criteria).toEqual([]);
    expect(facts.attemptedStrategies).toEqual([]);
    expect(facts.usage.totalTokens).toBe(0);
  });
});

describe("renderClosureReport", () => {
  it("exited 报告直出标准矩阵、已试策略与退出原因，unknown 翻译为采信语义", () => {
    const facts = buildClosureFacts(
      session({
        status: "exited",
        exit: {
          reason: "dead-end",
          message: "连续推进无新证据。",
          occurredAt: "2026-01-01T00:05:00.000Z",
        },
        runs: [
          review({
            id: "r1",
            runIndex: 0,
            attribution: {
              criteria: [
                { criterionId: "pc-1", verdict: "met", reason: "已实现。" },
                {
                  criterionId: "pc-2",
                  verdict: "unknown",
                  reason: "无独立证据。",
                },
                { criterionId: "pc-3", verdict: "unmet", reason: "缺文档。" },
              ],
            },
            selectedFailureHandlingId: "add-docs",
          }),
        ],
      }),
    );
    const text = renderClosureReport(facts);

    expect(text).toContain("任务推进已退出：代码任务验收");
    expect(text).toContain("共验收 1 轮。");
    expect(text).toContain("退出原因：连续推进无新证据。");
    expect(text).toContain("需求已实现：已满足");
    expect(text).toContain("无法独立核验，已按执行侧报告采信");
    expect(text).not.toContain("unknown");
    expect(text).toContain("文档已更新：未满足");
    expect(text).toContain("文档缺失（1 次）");
  });

  it("completed 报告携带验收证据链", () => {
    const facts = buildClosureFacts(
      session({
        status: "completed",
        runs: [
          review({
            id: "r1",
            runIndex: 0,
            decision: "passed",
            evidence: [
              {
                id: "tests-green",
                kind: "test-result",
                summary: "vitest: 210 passed",
                source: "independent",
                passed: true,
              },
            ],
            attribution: {
              criteria: [
                { criterionId: "pc-1", verdict: "met", reason: "已实现。" },
                { criterionId: "pc-2", verdict: "met", reason: "测试全绿。" },
                { criterionId: "pc-3", verdict: "met", reason: "文档已更新。" },
              ],
            },
          }),
        ],
      }),
    );
    const text = renderClosureReport(facts);

    expect(text).toContain("任务推进已验收通过");
    expect(text).toContain("【验收证据】");
    expect(text).toContain("vitest: 210 passed");
    expect(text).toContain("tokens");
  });
});

describe("projectConfirmedRubricToDraftContent", () => {
  it("反投影回自然列表草案 content，条目 id 去除、其余素材保留", () => {
    const content = projectConfirmedRubricToDraftContent(rubric());

    expect(content.passCriteria).toEqual([
      "需求已实现",
      "相关测试通过",
      "文档已更新",
    ]);
    expect(content.evidenceRequirements).toEqual(
      rubric().content.evidenceRequirements,
    );
    expect(content.failureHandling).toEqual(rubric().content.failureHandling);
  });
});
