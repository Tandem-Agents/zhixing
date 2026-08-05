import { describe, expect, it, vi } from "vitest";
import type { SessionEventEnvelope } from "@zhixing/rpc";
import { createPublishResultPresenter } from "../publish-result-presenter.js";

function createHarness() {
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
  });
  const emit = (payload: unknown) => handler?.({
    conversationId: "conv-1",
    scope: "control",
    runId: "run-1",
    seq: 1,
    event: "publish:result",
    payload,
    meta: {},
  } satisfies SessionEventEnvelope);
  return { emit, lines, presenter, unsubscribe };
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
      mutation: { kind: "memory-delete" },
      decision: {
        t: "conflicted",
        error: { code: "revision-conflict", message: "内容已变化", retryable: false },
      },
    };

    emit(notice);
    emit(structuredClone(notice));

    expect(lines).toEqual([
      "这次未能保存“记忆修改”：内容已变化。请检查当前内容后重试，或放弃这项修改。",
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
            revision: 7,
            createdAt: "2026-08-05T00:00:00.000Z",
            updatedAt: "2026-08-05T00:00:00.000Z",
          },
        },
      },
    });

    expect(lines).toEqual(["场景「专注」已创建。"]);
    presenter.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
