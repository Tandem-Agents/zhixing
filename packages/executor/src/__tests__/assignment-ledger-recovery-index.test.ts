// 派发账本领域索引的对话恢复候选目录：与三个恢复查询同一口径，结束的派发离开目录，损坏的派发留在目录里照旧报错。
import { FileAuthorityCommitLog } from "@zhixing/core/authority";
import { createSignedConversationEnvelope } from "@zhixing/core/protocol";
import { describe, expect, it, vi } from "vitest";
import { InProcessAssignmentSubmission } from "../assignment-ledger.js";
import { ASSIGNMENT_LEDGER_INDEX_ID, readRecoveryCandidates } from "../assignment-ledger-index.js";
import { ABORT_TICKET_DIGEST, ASSIGNMENT_ID, NOW, RUN_ID, createHarness, createUnsignedEnvelope, ownerContext, submissionContext } from "./assignment-ledger-fixture.js";

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function candidates(h: Harness): Promise<readonly string[]> {
  return (await h.log.transactDurableProjection<unknown, readonly string[]>(ASSIGNMENT_LEDGER_INDEX_ID,
    async current => ({ kind: "return", value: await readRecoveryCandidates(current) }))).value;
}

async function rejectedDispatch(h: Harness, assignmentId: string): Promise<void> {
  const envelope = createSignedConversationEnvelope(createUnsignedEnvelope(h.identity, { assignmentId, runId: `run-${assignmentId}` }), h.identity, h.identity);
  // 激活证明属于另一个派发：控制接受后按拒绝收束
  expect(await h.ledger.dispatch(envelope, h.dispatch.activation, ownerContext(assignmentId, "executor.dispatch"))).toMatchObject({ accepted: false });
}

describe("assignment ledger recovery directory", () => {
  it("follows each conversation through receipt, execution, ticket cancellation and rejection", async () => {
    const h = await createHarness();
    await rejectedDispatch(h, "rejected-1");
    expect(await candidates(h)).toEqual([]);
    await h.ledger.dispatch(h.dispatch.envelope, h.dispatch.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    expect(await candidates(h)).toEqual([ASSIGNMENT_ID]);
    // 开始执行后不再是待执行派发
    await h.ledger.start(ASSIGNMENT_ID);
    expect(await candidates(h)).toEqual([]);
    expect(await h.ledger.recoverableConversationAssignments()).toEqual([]);
    // 票据取消后作为待重提的取消回到目录
    await h.ledger.abortFromSurface(ASSIGNMENT_ID, { ticketDigest: ABORT_TICKET_DIGEST, surfacePrincipal: "surface:user-1" });
    expect(await candidates(h)).toEqual([ASSIGNMENT_ID]);
    expect(await h.ledger.recoverableConversationCancellations()).toEqual([h.dispatch.envelope]);
    expect(await h.ledger.recoverableConversationAssignments()).toEqual([]);
  });

  it.each([true, false])("retires a ticket-cancelled conversation once the owner durably processed its proof (v2 record writes: %s)", async (v2) => {
    const h = await createHarness({ assignmentRecordV2Writes: v2 });
    await h.ledger.dispatch(h.dispatch.envelope, h.dispatch.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    await h.ledger.start(ASSIGNMENT_ID);
    await h.journal.reportStarted(ASSIGNMENT_ID, submissionContext(h.unsigned));
    await h.ledger.abortFromSurface(ASSIGNMENT_ID, { ticketDigest: ABORT_TICKET_DIGEST, surfacePrincipal: "surface:user-1" });
    expect(await candidates(h)).toEqual([ASSIGNMENT_ID]);
    const submission = new InProcessAssignmentSubmission({ ledger: h.ledger, owner: h.journal });
    // 提交失败（owner 不可达）：重提义务保留
    const submit = vi.spyOn(h.journal, "submitCancelProof").mockRejectedValueOnce(new Error("owner unreachable"));
    await expect(submission.submitCancellation(ASSIGNMENT_ID, submissionContext(h.unsigned))).rejects.toThrow("owner unreachable");
    submit.mockRestore();
    expect(await h.ledger.recoverableConversationCancellations()).toEqual([h.dispatch.envelope]);
    // owner 已耐久处理、本地尚未落退休记录：重提同一证明按耐久重放成功，随即退休
    await h.journal.submitCancelProof(ASSIGNMENT_ID, (await h.ledger.cancelProof(ASSIGNMENT_ID))!, submissionContext(h.unsigned));
    expect(await h.journal.currentState(RUN_ID)).toBe("cancelled");
    await expect(submission.submitCancellation(ASSIGNMENT_ID, submissionContext(h.unsigned))).resolves.toBe(true);
    if (v2) {
      expect(await candidates(h)).toEqual([]);
      expect(await h.ledger.recoverableConversationCancellations()).toEqual([]);
      expect(await h.ledger.hasPendingTicketCancellation(ASSIGNMENT_ID)).toBe(false);
      // 退休可重复，结果不变
      await expect(h.ledger.markTicketCancellationProofOwnerAccepted(ASSIGNMENT_ID)).resolves.toBe(true);
    } else {
      // 旧写法写不出退休记录：义务保留，恢复时照旧重提，owner 按耐久重放处理
      expect(await candidates(h)).toEqual([ASSIGNMENT_ID]);
      expect(await h.ledger.recoverableConversationCancellations()).toEqual([h.dispatch.envelope]);
      await expect(submission.submitCancellation(ASSIGNMENT_ID, submissionContext(h.unsigned))).resolves.toBe(true);
    }
  });

  it("refuses to retire a ticket cancellation before the halted proof exists", async () => {
    const h = await createHarness({ assignmentRecordV2Writes: true });
    await h.ledger.dispatch(h.dispatch.envelope, h.dispatch.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    await expect(h.ledger.markTicketCancellationProofOwnerAccepted(ASSIGNMENT_ID)).rejects.toThrow("before its durable halted proof");
    expect(await candidates(h)).toEqual([ASSIGNMENT_ID]);
  });

  it("keeps an assignment whose record fails validation in the directory so recovery reports it", async () => {
    const h = await createHarness();
    await h.ledger.dispatch(h.dispatch.envelope, h.dispatch.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    // 不登记任何派生投影的写者写下一条没有前缀的执行记录
    const raw = new FileAuthorityCommitLog(h.log.rootDir, h.artifacts, { clock: () => NOW, lockWaitMs: 2_000 });
    try {
      await raw.append<unknown>([{ stream: "assignment:broken", body: { recordSeq: 1, body: { v: 1, t: "started" } } }]);
    } finally { await raw.stopStorageMaintenance(); }
    expect(await candidates(h)).toEqual(expect.arrayContaining(["broken", ASSIGNMENT_ID]));
    await expect(h.ledger.recoverableConversationAssignments()).rejects.toThrow();
  });
});
