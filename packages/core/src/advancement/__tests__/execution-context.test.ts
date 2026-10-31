import { describe, expect, it } from "vitest";
import {
  AdvancementExecutionInputError,
  adjudicateAdvancementExecution,
  advancementExecutionContextBlock,
  readAdvancementExecutionContext,
} from "../execution-context.js";
import type { AdvancementSession } from "../types.js";

const TASK_IMAGE = { type: "base64" as const, mediaType: "image/png", data: "AA==" };
const SUPPLEMENT_IMAGE = { type: "base64" as const, mediaType: "image/jpeg", data: "/9j/" };

/** 来自提议、已冻结执行意向的会话：确认执行（active、带契约）或降级执行（已取消、无契约）。 */
function session(id: string, task: string, mode: "advancement" | "direct", criterion = `CRITERION_${id}`): AdvancementSession {
  const binding = mode === "advancement" ? { sessionId: id, mode, draftId: "draft-1" } : { sessionId: id, mode };
  return {
    id,
    conversationId: "conv-1",
    status: mode === "advancement" ? "active" : "cancelled",
    originalUserTask: { parts: [{ type: "text", text: task }, { type: "image", source: TASK_IMAGE }] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    rubricDraftVersion: 1,
    ...(mode === "advancement" ? { confirmedRubric: {
      source: { kind: "library", rubricId: "rubric-1", rubricVersion: "v1" },
      title: "验收", description: "验收",
      content: { passCriteria: [{ id: "pc-1", text: criterion }], evidenceRequirements: [], failureHandling: [] },
      confirmedAt: "2026-01-01T00:01:00.000Z", confirmedBy: "user",
    } } : {}),
    runs: [],
    proxyMessages: [],
    proposal: { proposalId: `p-${id}`, runId: `run-${id}`, originalTurnId: "turn-1",
      supplements: [{ parts: [{ type: "image", source: SUPPLEMENT_IMAGE }] }] } as never,
    originalTaskAdmission: {
      mode, status: "admitted", runId: `run-exec-${id}`,
      intent: { turnId: mode === "advancement" ? "turn-1:advancement:draft-1" : "turn-1:direct", surfacePrincipal: "rpc:test",
        turnOrigin: { channel: "rpc", triggeredBy: "rpc:test", advancementExecution: binding }, inputDigest: `sha256:${"1".repeat(64)}` },
    } as never,
  } as AdvancementSession;
}

function run(target: AdvancementSession) {
  const intent = target.originalTaskAdmission!.intent;
  return { turnId: intent.turnId, turnOrigin: intent.turnOrigin };
}

describe("推进执行材料：宿主按冻结执行身份裁决", () => {
  it("确认执行：同一会话的契约在前，原任务与补充（文字和图片）在后", () => {
    const a = session("session-a", "TASK_A", "advancement");
    const material = adjudicateAdvancementExecution(a, run(a).turnOrigin.advancementExecution!, run(a).turnId);
    expect(material.status).toBe("ready");
    if (material.status !== "ready") return;
    expect(material.context[0]!.text).toContain("CRITERION_session-a");
    expect(material.context[1]!.text).toContain("TASK_A（附图：随本消息附上的第 1 张）");
    expect(material.context[1]!.images).toEqual([TASK_IMAGE, SUPPLEMENT_IMAGE]);
  });

  it("降级执行：只有原任务，不带任何契约（不夹入别的会话的契约）", () => {
    const a = session("session-a", "TASK_A", "direct");
    const material = adjudicateAdvancementExecution(a, run(a).turnOrigin.advancementExecution!, run(a).turnId);
    expect(material).toMatchObject({ status: "ready" });
    if (material.status !== "ready") return;
    expect(material.context).toHaveLength(1);
    expect(material.context[0]!.text).toContain("TASK_A");
    expect(JSON.stringify(material.context)).not.toContain("CRITERION");
  });

  it("不是来自提议的会话：执行输入本身是原任务，材料只带契约", () => {
    const plain = { ...session("session-a", "TASK_A", "advancement"), proposal: undefined };
    const material = adjudicateAdvancementExecution(plain, run(plain).turnOrigin.advancementExecution!, run(plain).turnId);
    expect(material.status === "ready" && material.context.map((item) => item.text)).toEqual([expect.stringContaining("CRITERION_session-a")]);
  });

  it.each([
    ["会话不存在", null, undefined, /不存在/u],
    ["turnId 不符", "turnId", undefined, /turnId/u],
    ["模式不符", "mode", undefined, /模式/u],
    ["草案不符", "draft", undefined, /执行标记/u],
    ["没有执行意向", "admission", undefined, /没有执行意向/u],
    ["确认执行却没有契约", "rubric", undefined, /没有已确认的契约/u],
  ] as const)("%s：裁决为不可用并给出原因", (_label, change, _unused, reason) => {
    const a = session("session-a", "TASK_A", "advancement");
    const binding = run(a).turnOrigin.advancementExecution!;
    const target = change === null ? null
      : change === "admission" ? { ...a, originalTaskAdmission: undefined }
      : change === "rubric" ? { ...a, confirmedRubric: undefined }
      : a;
    const turnId = change === "turnId" ? "turn-1:advancement:other" : run(a).turnId;
    const marker = change === "mode" ? { sessionId: binding.sessionId, mode: "direct" as const }
      : change === "draft" ? { ...binding, draftId: "draft-2" } : binding;
    const material = adjudicateAdvancementExecution(target, marker, turnId);
    expect(material.status).toBe("unavailable");
    if (material.status === "unavailable") expect(material.reason).toMatch(reason);
  });
});

describe("推进执行材料：执行体按本次运行耐久身份读取", () => {
  const a = session("session-a", "TASK_A", "advancement");
  const ready = advancementExecutionContextBlock(adjudicateAdvancementExecution(a, run(a).turnOrigin.advancementExecution!, run(a).turnId));

  it("绑定一致：原样交出必需上下文", () => {
    const context = readAdvancementExecutionContext([{ source: "workscene-tasks", block: "[]" }, ready], run(a));
    expect(context?.map((item) => item.text)).toEqual([expect.stringContaining("CRITERION_session-a"), expect.stringContaining("TASK_A")]);
    expect(context?.[1]?.images).toEqual([TASK_IMAGE, SUPPLEMENT_IMAGE]);
  });

  it("没有执行标记的运行：不需要材料；收到材料反而失败", () => {
    expect(readAdvancementExecutionContext([], { turnId: "turn-x" })).toBeUndefined();
    expect(() => readAdvancementExecutionContext([ready], { turnId: "turn-x", turnOrigin: { channel: "rpc" } })).toThrow(AdvancementExecutionInputError);
  });

  it.each([
    ["没有材料", [] as { source: string; block: string }[], run(a)],
    ["材料是给别的草案的", [ready], { ...run(a), turnOrigin: { ...run(a).turnOrigin, advancementExecution: { sessionId: "session-a", mode: "advancement" as const, draftId: "draft-2" } } }],
    ["材料是给别的运行的", [ready], { ...run(a), turnId: "turn-1:advancement:other" }],
    ["宿主裁决为不可用", [advancementExecutionContextBlock(adjudicateAdvancementExecution(null, run(a).turnOrigin.advancementExecution!, run(a).turnId))], run(a)],
    ["材料无法解析", [{ source: "advancement-execution", block: "{" }], run(a)],
    ["多份材料", [ready, ready], run(a)],
  ] as const)("%s：输入准备失败", (_label, blocks, target) => {
    expect(() => readAdvancementExecutionContext(blocks, target)).toThrow(AdvancementExecutionInputError);
  });
});
