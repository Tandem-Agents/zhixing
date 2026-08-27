import { describe, expect, it, vi } from "vitest";
import type { SessionEventEnvelope } from "@zhixing/rpc";
import { createPublishResultPresenter } from "../publish-result-presenter.js";

function createHarness(filter?: (envelope: SessionEventEnvelope) => boolean) {
  let handler: ((params: unknown) => void) | undefined;
  const unsubscribe = vi.fn();
  const lines: string[] = [];
  const presenter = createPublishResultPresenter({
    link: {
      onNotification: vi.fn((_method: string, callback: (params: unknown) => void) => {
        handler = callback;
        return unsubscribe;
      }),
    } as never,
    writer: {
      ensureSegmentBreak: vi.fn(),
      line: (text: string) => lines.push(text),
    },
    ...(filter ? { filter } : {}),
  });
  const emit = (payload: unknown, envelopeSeq?: number) => handler?.({
    conversationId: "conv-1",
    scope: "control",
    runId: "run-1",
    seq: envelopeSeq ?? (
      typeof payload === "object" && payload !== null &&
      "seq" in payload && Number.isSafeInteger(payload.seq)
        ? Number(payload.seq)
        : 1
    ),
    event: "publish:result",
    payload,
    meta: {},
  } satisfies SessionEventEnvelope);
  return {
    emit,
    emitRaw: (value: unknown) => handler?.(value),
    lines,
    presenter,
    unsubscribe,
  };
}

describe("PublishResultPresenter", () => {
  it("renders a durable conflict once across live and history replay", () => {
    const { emit, lines } = createHarness();
    const notice = {
      conversationId: "conv-1",
      runId: "run-1",
      commitRevision: 4,
      assignmentId: "assignment-1",
      seq: 2,
      mutation: {
        kind: "schedule-delete",
        taskId: "task-1",
        taskRevision: 3,
      },
      decision: {
        t: "conflicted",
        error: {
          code: "revision-conflict",
          message: "anchor owner internal diagnostic",
          retryable: false,
        },
      },
    };

    emit(notice);
    emit(structuredClone(notice));

    expect(lines).toEqual([
      "这次未能完成“删除定时任务”：相关内容已被其他修改更新。查看最新内容后重试，放弃这项修改。",
    ]);
  });

  it("renders the owner-projected workscene result without reconstructing identity", () => {
    const { emit, lines, presenter, unsubscribe } = createHarness();
    emit({
      conversationId: "conv-1",
      runId: "run-1",
      commitRevision: 4,
      assignmentId: "assignment-1",
      seq: 1,
      mutation: { kind: "workscene-create", name: "专注" },
      decision: {
        t: "granted",
        targetRevision: 7,
        appliedResult: {
          kind: "workscene-applied",
          operation: "create",
          revision: 7,
          scene: {
            id: "scene-1",
            name: "专注",
            revision: 1,
            createdAt: "2026-08-05T00:00:00.000Z",
            lastActiveAt: "2026-08-05T00:00:00.000Z",
          },
        },
      },
    });

    expect(lines).toEqual(["场景「专注」已创建。"]);
    presenter.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("fails closed on malformed or envelope-misbound results and reports once", () => {
    const { emit, lines } = createHarness();
    const malformed = {
      conversationId: "conv-1",
      runId: "run-1",
      commitRevision: 4,
      assignmentId: "assignment-1",
      seq: 3,
      mutation: { kind: "schedule-delete", taskId: "task-a", taskRevision: 1 },
      decision: {
        t: "conflicted",
        error: { code: "revision-conflict", message: "changed", retryable: false },
        unexpected: true,
      },
    };
    emit(malformed);
    emit(structuredClone(malformed));
    emit({ ...malformed, decision: { t: "conflicted", error: malformed.decision.error } }, 4);

    expect(lines).toEqual([
      "这次修改结果无法安全确认。请重新进入当前会话，或查询当前状态后再继续。",
      "这次修改结果无法安全确认。请重新进入当前会话，或查询当前状态后再继续。",
    ]);
  });

  it("reports a target envelope that is malformed before session filtering", () => {
    const { emitRaw, lines } = createHarness(() => false);
    const malformedEnvelope = {
      scope: "control",
      event: "publish:result",
      payload: null,
    };

    emitRaw(null);
    emitRaw(malformedEnvelope);
    emitRaw(structuredClone(malformedEnvelope));

    expect(lines).toEqual([
      "这次修改结果无法安全确认。请重新进入当前会话，或查询当前状态后再继续。",
    ]);
  });
});
