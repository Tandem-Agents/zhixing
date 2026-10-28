import path from "node:path";
import { AuthorityCacheIntegrity, FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import type { ProtocolSignatureVerifier } from "@zhixing/core/protocol";
import { captureFileIo, createTempDir } from "@zhixing/test-utils";
import { expect, it } from "vitest";
import { readConversationTransferEnvelopes, registerConversationTransferSources, selectConversationAuthorityRecords } from "../conversation-transfer.js";
import { trackAuthorityLog } from "./durable-io-test-support.js";

const NOW = "2026-10-27T00:00:00.000Z";
// 用到的记录都不走派发验签，验签器不会被调用
const verifier = {} as ProtocolSignatureVerifier;
type Entry = { stream: string; body: unknown };

async function fixture(name: string) {
  const root = await createTempDir(name);
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"), { lockWaitMs: 2_000 });
  // 与生产一致带完整性密钥：认证帧索引可用，按位置读不必从头校验
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, "log"), artifacts,
    { clock: () => NOW, lockWaitMs: 2_000, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 29)) }));
  registerConversationTransferSources(log, artifacts);
  return { root, artifacts, log, append: (entries: Entry[]) => log.append(entries as never) };
}
/** 原整读路径：冻点前的全部信封交给选择器。 */
async function fullSelection(log: FileAuthorityCommitLog, artifacts: FileArtifactStore, conversationId: string, through: number) {
  const all = (await log.readAll<unknown>()).filter((envelope) => envelope.lsn <= through);
  return selectConversationAuthorityRecords(all, conversationId, artifacts, verifier);
}

it("selects exactly what the full two-pass selector selects, including late and cross-conversation relations", async () => {
  const { log, artifacts, append } = await fixture("transfer-sources-equivalence");
  // 同一信封里交错两个会话；publish 早于 run 里出现它的 assignmentId
  await append([
    { stream: "publish", body: { t: "published", assignmentId: "a1", value: 1 } },
    { stream: "run:conv-A", body: { t: "submitted", runIndex: 0 } },
    { stream: "run:conv-B", body: { t: "submitted", runIndex: 0 } },
    { stream: "final-outbox", body: { t: "queued", conversationId: "conv-B" } },
  ]);
  await append([
    { stream: "run:conv-A", body: { t: "dispatched", nested: { assignmentId: "a1" } } },
    { stream: "intent:conv-A", body: { t: "intent" } },
    { stream: "session-activity:conv-A", body: { t: "activity" } },
    // 一个 control 同时绑定两个会话；同 requestId 的后续记录不带会话
    { stream: "control", body: { t: "noted", requestId: "rq1", targets: [{ conversationId: "conv-A" }], other: { conversationId: "conv-B" } } },
  ]);
  await append([
    { stream: "control", body: { t: "settled", requestId: "rq1" } },
    { stream: "control", body: { t: "noted", requestId: "rq2", conversationId: "conv-B" } },
    { stream: "publish", body: { t: "published", assignmentId: "a2", value: 2 } },
    { stream: "final-outbox", body: { t: "queued", conversationId: "conv-A" } },
    { stream: "control", body: { t: "noted", requestId: "rq3", list: [{ conversationId: "conv-A" }] } },
  ]);
  const freeze = await log.checkpoint();
  // 冻点之后才建立的归属：冻点前的 a2 publish 不能被收进来
  await append([
    { stream: "run:conv-A", body: { t: "dispatched", assignmentId: "a2" } },
    { stream: "control", body: { t: "noted", requestId: "rq2", conversationId: "conv-A" } },
    { stream: "publish", body: { t: "published", assignmentId: "a1", value: 3 } },
  ]);
  for (const conversationId of ["conv-A", "conv-B"]) {
    const indexed = await selectConversationAuthorityRecords(
      await readConversationTransferEnvelopes(log, artifacts, conversationId, freeze), conversationId, artifacts, verifier);
    expect(indexed).toEqual(await fullSelection(log, artifacts, conversationId, freeze.lsn));
  }
  // 没有任何直属记录的会话：两条路径都按原合同拒绝
  await expect(fullSelection(log, artifacts, "conv-missing", freeze.lsn)).rejects.toThrow("no authoritative conversation stream");
  await expect(selectConversationAuthorityRecords(await readConversationTransferEnvelopes(log, artifacts, "conv-missing", freeze),
    "conv-missing", artifacts, verifier)).rejects.toThrow("no authoritative conversation stream");
  // 冻点包含全部之后，两条路径仍一致（a2 与 rq2 的归属此时成立）
  const head = await log.checkpoint();
  for (const conversationId of ["conv-A", "conv-B"]) {
    const indexed = await selectConversationAuthorityRecords(
      await readConversationTransferEnvelopes(log, artifacts, conversationId, head), conversationId, artifacts, verifier);
    expect(indexed).toEqual(await fullSelection(log, artifacts, conversationId, head.lsn));
  }
}, 60_000);

it("reads only the target conversation's envelopes as unrelated history grows", async () => {
  const measured: { logBytes: number; projectionBytes: number; envelopes: number }[] = [];
  for (const unrelated of [20, 320]) {
    const { root, log, artifacts, append } = await fixture(`transfer-sources-scale-${unrelated}`);
    for (let n = 0; n < 8; n++) await append([
      { stream: "run:target", body: { t: "dispatched", assignmentId: `t${n}` } },
      { stream: "publish", body: { t: "published", assignmentId: `t${n}` } },
    ]);
    for (let n = 0; n < unrelated; n++) await append([
      { stream: `run:other-${n}`, body: { t: "dispatched", assignmentId: `o${n}` } },
      { stream: "publish", body: { t: "published", assignmentId: `o${n}` } },
      { stream: "control", body: { t: "noted", requestId: `r${n}`, conversationId: `other-${n}` } },
    ]);
    const freeze = await log.checkpoint();
    await readConversationTransferEnvelopes(log, artifacts, "target", freeze);
    const capture = await captureFileIo(root);
    capture.reset();
    const envelopes = await readConversationTransferEnvelopes(log, artifacts, "target", freeze);
    const read = capture.snapshot();
    measured.push({ logBytes: read.byCategory.log?.readBytes ?? 0, projectionBytes: read.byCategory.projection?.readBytes ?? 0, envelopes: envelopes.length });
  }
  const [small, large] = measured as [typeof measured[0], typeof measured[0]];
  expect(large.envelopes).toBe(small.envelopes);
  // 16 倍无关历史：日志读取只覆盖目标会话自己的信封，投影读取不随无关历史按比例增长
  expect(large.logBytes, JSON.stringify(measured)).toBeLessThanOrEqual(small.logBytes * 1.5);
  expect(large.projectionBytes, JSON.stringify(measured)).toBeLessThanOrEqual(Math.max(small.projectionBytes * 3, 4096));
}, 120_000);
