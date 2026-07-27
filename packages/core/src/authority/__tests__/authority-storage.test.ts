import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { Buffer } from "node:buffer";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import type {
  ArtifactRef,
  ContentAssetRef,
  ControlRecord,
  Signature,
} from "../../contracts/index.js";
import {
  byteDigest,
  canonicalize,
  createJobCommitFence,
  createJobSealedBundle,
  createSignedSurfaceAssetGrant,
  jobDeliveryPlanDigest,
  protocolDigest,
  sealedBundleArtifact,
  type ProtocolSigner,
} from "../../protocol/index.js";
import {
  AuthorityStorageError,
  bindDurableProjectionMutations,
  collectArtifactRefs,
  durableProjectionDirectoryName,
  FileArtifactStore,
  FileAuthorityCommitLog,
  FileDurableProjectionIndex,
} from "../index.js";
import {
  AUTHORITY_WAL_FILE_HEADER_BYTES,
  AUTHORITY_WAL_HEADER_BYTES,
  AUTHORITY_WAL_TRAILER_BYTES,
  encodeAuthorityWalFileHeader,
  encodeAuthorityWalFrame,
  scanAuthorityWalFrames,
} from "../wal-frame.js";

const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;

const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "test-sha256",
      keyId: "device:test-anchor",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

function inputControlEnvelope(
  requestId: string,
  attachment: ContentAssetRef,
) {
  const body = {
    t: "input" as const,
    conversationId: "conversation-external",
    ingress: { ingressId: "ingress-external", source: "first-party" as const },
    input: { parts: [{ type: "text" as const, text: "inspect" }] },
    attachments: [attachment],
    invocation: { kind: "agent" as const, source: "interactive" as const },
    ownerEpoch: 1,
  };
  const dependencyArtifacts: ArtifactRef[] = [];
  return {
    v: 1 as const,
    requestId,
    principal: {
      surfacePrincipal: "surface:user-external",
      deviceId: "device-external",
      connectionId: "connection-external",
    },
    at: "2026-07-24T00:00:00.000Z",
    dependencyArtifacts,
    body,
    payloadDigest: protocolDigest("ControlEnvelopePayload", 1, {
      body,
      dependencyArtifacts,
    }),
  };
}

async function createStores() {
  const root = await createTempDir("authority-storage");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"), {
    lockWaitMs: 2_000,
  });
  const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
    lockWaitMs: 2_000,
  });
  return { root, artifacts, log };
}

async function replaceRetainedProjectionValue(
  log: FileAuthorityCommitLog,
  key: string,
  value: unknown,
): Promise<void> {
  const index = new FileDurableProjectionIndex({
    rootDir: path.join(
      log.rootDir,
      "projections",
      durableProjectionDirectoryName("authority-retained-references"),
    ),
    projectionId: "authority-retained-references",
    reducerVersion: 3,
  });
  await index.initialize({ authority: await log.originCheckpoint() });
  const prepared = await index.prepare(
    bindDurableProjectionMutations([{
      kind: "put",
      key,
      value: JSON.parse(canonicalize(value)),
    }]),
  );
  index.publish(prepared, index.checkpoints());
  await index.flush();
}

describe("FileArtifactStore", () => {
  it("stores immutable content by digest and rejects corrupted content", async () => {
    const { artifacts } = await createStores();
    const bytes = Buffer.from("durable content", "utf8");

    const first = await artifacts.put(bytes);
    const second = await artifacts.put(bytes);

    expect(second).toEqual(first);
    expect(Buffer.from(await artifacts.get(first))).toEqual(bytes);

    await writeFile(artifacts.pathFor(first), Buffer.from("tampered", "utf8"));
    await expect(artifacts.get(first)).rejects.toMatchObject({
      code: "artifact-corrupt",
    });
  });

  it("deletes only after checking every authority log under the store lock", async () => {
    const { root, artifacts, log } = await createStores();
    const peerLog = new FileAuthorityCommitLog(
      path.join(root, "peer-log"),
      artifacts,
      { lockWaitMs: 2_000 },
    );
    const retained = await artifacts.put(Buffer.from("peer-retained", "utf8"));
    const orphan = await artifacts.put(Buffer.from("unreferenced", "utf8"));
    const authorizedBytes = Buffer.from("authorized-but-not-adopted", "utf8");
    const authorizedOnly = {
      digest: byteDigest(authorizedBytes),
      bytes: authorizedBytes.byteLength,
    };
    await peerLog.append([
      { stream: "publish", body: { t: "asset", content: retained } },
    ]);
    await log.append<ControlRecord>([
      {
        stream: "control",
        body: {
          t: "asset-grant-issued",
          grant: createSignedSurfaceAssetGrant(
            {
              v: 1,
              grantId: "grt-01ARZ3NDEKTSV4RRFFQ69G5FAV",
              scope: { domain: "global", anchorEpoch: 1 },
              surfacePrincipal: "surface:test",
              requestId: "request-authorized-only",
              kind: "asset-upload",
              assets: [authorizedOnly],
              payloadDigest: protocolDigest("ControlEnvelopePayload", 1, {}),
              issuedAt: "2026-07-24T00:00:00.000Z",
              expiry: "2026-07-24T01:00:00.000Z",
            },
            signer,
          ),
        },
      },
    ]);
    await expect(artifacts.has(authorizedOnly)).resolves.toBe(false);
    await expect(artifacts.put(authorizedBytes)).resolves.toEqual(
      authorizedOnly,
    );
    let retainedLoads = 0;
    const retainedCandidates: ArtifactRef[][] = [];
    const loadRetained = async (candidates: readonly ArtifactRef[]) => {
      retainedLoads += 1;
      retainedCandidates.push([...candidates]);
      return {
        status: "current" as const,
        retained: [
          ...(await log.retainedArtifactReferences(candidates)),
          ...(await peerLog.retainedArtifactReferences(candidates)),
        ],
      };
    };

    await expect(
      artifacts.deleteIfUnreferencedBatch(
        [retained, orphan, authorizedOnly],
        loadRetained,
      ),
    ).resolves.toEqual([
      { ref: retained, disposition: "retained" },
      { ref: orphan, disposition: "deleted" },
      { ref: authorizedOnly, disposition: "deleted" },
    ]);
    expect(retainedLoads).toBe(1);
    expect(retainedCandidates).toEqual([
      [retained, orphan, authorizedOnly],
    ]);
    await expect(artifacts.has(retained)).resolves.toBe(true);
    await expect(artifacts.has(orphan)).resolves.toBe(false);
    await expect(artifacts.has(authorizedOnly)).resolves.toBe(false);

    const appendedLater = await artifacts.put(
      Buffer.from("retained-after-first-projection", "utf8"),
    );
    await peerLog.append([
      { stream: "publish", body: { t: "asset", content: appendedLater } },
    ]);
    await expect(
      artifacts.deleteIfUnreferencedBatch([appendedLater], loadRetained),
    ).resolves.toEqual([
      { ref: appendedLater, disposition: "retained" },
    ]);
    expect(retainedLoads).toBe(2);
    expect(retainedCandidates[1]).toEqual([appendedLater]);
  });

  it("defers deletion without probing primary storage when retention is unknown", async () => {
    const { artifacts } = await createStores();
    const temporaryOnly = {
      digest: `sha256:${"e".repeat(64)}`,
      bytes: 31,
    };

    await expect(
      artifacts.deleteIfUnreferencedBatch(
        [temporaryOnly],
        async () => ({ status: "deferred" }),
      ),
    ).resolves.toEqual([
      { ref: temporaryOnly, disposition: "deferred" },
    ]);
  });

  it("releases conversation leaf retention only after every owning session is deleted", async () => {
    const { root, artifacts, log } = await createStores();
    const executorLog = new FileAuthorityCommitLog(
      path.join(root, "executor-log"),
      artifacts,
      { lockWaitMs: 2_000 },
    );
    const leaf = await artifacts.put(
      Buffer.from("conversation-attachment", "utf8"),
    );
    const leafAsset = { digest: leaf.digest, bytes: leaf.bytes, kind: "file" };

    // 会话 A 与 B 各以 admitted 附件持有同一内容叶。
    await log.append([
      {
        stream: "run:conv-a",
        body: { t: "admitted", runId: "run-a", attachments: [leafAsset] },
      },
      {
        stream: "run:conv-b",
        body: { t: "admitted", runId: "run-b", attachments: [leafAsset] },
      },
    ]);
    // executor 侧账本经注册 root(DispatchEnvelope)解引用同样引用该叶。
    const envelopeBytes = Buffer.from(
      canonicalize({
        v: 1,
        assignmentId: "asg-leaf",
        execution: "conversation",
        dependencyArtifacts: [],
        work: {
          conversationId: "conv-a",
          contentAssets: [leafAsset],
        },
      }),
      "utf8",
    );
    const envelopeRef = await artifacts.put(envelopeBytes);
    await executorLog.append([
      {
        stream: "assignment:asg-leaf",
        body: {
          body: {
            t: "received",
            envelope: { ref: envelopeRef },
            activation: { ref: { execution: "conversation" } },
          },
        },
      },
    ]);

    await expect(log.retainedArtifactReferences([leaf])).resolves.toEqual([
      leaf,
    ]);
    await expect(
      executorLog.retainedArtifactReferences([leaf]),
    ).resolves.toEqual([leaf]);

    // 删除会话 A:会话 B 仍持有,叶继续保留。
    await log.append([
      {
        stream: "run:conv-a",
        body: { t: "session-lifecycle", mutation: "delete" },
      },
    ]);
    await expect(log.retainedArtifactReferences([leaf])).resolves.toEqual([
      leaf,
    ]);
    await expect(log.releasedLeafReferences()).resolves.toEqual([]);

    // 删除会话 B:会话权威日志不再保留该叶,且它进入已死叶集合。
    await log.append([
      {
        stream: "run:conv-b",
        body: { t: "session-lifecycle", mutation: "delete" },
      },
    ]);
    await expect(log.retainedArtifactReferences([leaf])).resolves.toEqual([]);
    await expect(log.releasedLeafReferences()).resolves.toEqual([leaf]);

    // executor 日志不持有删除事实,自身查询仍保留;由调用方传入
    // 会话权威的 tombstone 并集后,死会话的叶不再被任何日志保留。
    await expect(
      executorLog.retainedArtifactReferences([leaf]),
    ).resolves.toEqual([leaf]);
    const deadConversations = await log.deadConversations();
    expect([...deadConversations].sort()).toEqual(["conv-a", "conv-b"]);
    await expect(
      executorLog.retainedArtifactReferences([leaf], { deadConversations }),
    ).resolves.toEqual([]);

    // 重放依赖(外置 dispatch envelope 容器)不随会话删除而释放。
    await expect(
      executorLog.retainedArtifactReferences([envelopeRef], {
        deadConversations,
      }),
    ).resolves.toEqual([envelopeRef]);

    // 重启重建(新实例、无内存投影)得到相同结论。
    const reopened = new FileAuthorityCommitLog(
      path.join(root, "log"),
      artifacts,
      { lockWaitMs: 2_000 },
    );
    await expect(
      reopened.retainedArtifactReferences([leaf]),
    ).resolves.toEqual([]);
    await expect(reopened.deadConversations()).resolves.toEqual(
      deadConversations,
    );
  });

  it(
    "rebuilds retained exact, leaf, and tombstone records misbound to another identity",
    async () => {
      const { artifacts, log } = await createStores();
      const first = await artifacts.put(Buffer.from("retained-first"));
      const second = await artifacts.put(Buffer.from("retained-second"));
      await log.append([
        {
          stream: "run:conversation-first",
          body: {
            t: "admitted",
            runId: "run-first",
            attachments: [{ ...first, kind: "file" }],
          },
        },
        {
          stream: "run:conversation-second",
          body: {
            t: "admitted",
            runId: "run-second",
            attachments: [{ ...second, kind: "file" }],
          },
        },
      ]);
      await expect(log.retainedArtifactReferences([first])).resolves.toEqual([
        first,
      ]);
      const reopen = () =>
        new FileAuthorityCommitLog(log.rootDir, artifacts, {
          lockWaitMs: 2_000,
        });
      await replaceRetainedProjectionValue(
        log,
        `retention/reference/${first.digest}`,
        second,
      );
      let recovered = reopen();
      await expect(
        recovered.retainedArtifactReferences([first]),
      ).resolves.toEqual([first]);

      await replaceRetainedProjectionValue(
        recovered,
        `retention/leaf/${first.digest}/${
          Buffer.from("conversation-first", "utf8").toString("base64url")
        }`,
        {
          digest: second.digest,
          conversationId: "conversation-second",
        },
      );
      recovered = reopen();
      await expect(
        recovered.retainedArtifactReferences([first]),
      ).resolves.toEqual([first]);

      await recovered.append([
        {
          stream: "run:conversation-first",
          body: { t: "session-lifecycle", mutation: "delete" },
        },
        {
          stream: "run:conversation-second",
          body: { t: "session-lifecycle", mutation: "delete" },
        },
      ]);
      recovered = reopen();
      await expect(recovered.deadConversations()).resolves.toEqual(
        new Set(["conversation-first", "conversation-second"]),
      );
      await replaceRetainedProjectionValue(
        recovered,
        `retention/dead/${
          Buffer.from("conversation-first", "utf8").toString("base64url")
        }`,
        { conversationId: "conversation-second" },
      );
      await expect(reopen().deadConversations()).resolves.toEqual(
        new Set(["conversation-first", "conversation-second"]),
      );
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it("classifies inline and external control attachments identically", async () => {
    const external = await createStores();
    const inline = await createStores();
    const bytes = Buffer.from("external control attachment");
    const externalLeaf = await external.artifacts.put(bytes);
    const inlineLeaf = await inline.artifacts.put(bytes);
    const externalAsset: ContentAssetRef = {
      ...externalLeaf,
      kind: "file",
    };
    const inlineAsset: ContentAssetRef = { ...inlineLeaf, kind: "file" };
    const externalEnvelope = inputControlEnvelope(
      "request-external",
      externalAsset,
    );
    const inlineEnvelope = inputControlEnvelope("request-inline", inlineAsset);
    const envelopeRef = await external.artifacts.put(
      Buffer.from(canonicalize(externalEnvelope)),
    );

    await external.log.append([
      {
        stream: "control",
        body: {
          t: "received",
          requestId: externalEnvelope.requestId,
          envelope: { ref: envelopeRef },
        },
      },
    ]);
    await inline.log.append([
      {
        stream: "control",
        body: {
          t: "received",
          requestId: inlineEnvelope.requestId,
          envelope: inlineEnvelope,
        },
      },
    ]);

    await expect(
      external.log.retainedArtifactReferences([externalLeaf]),
    ).resolves.toEqual([externalLeaf]);
    await expect(
      inline.log.retainedArtifactReferences([inlineLeaf]),
    ).resolves.toEqual([inlineLeaf]);

    await external.log.append([
      {
        stream: "run:conversation-external",
        body: { t: "session-lifecycle", mutation: "delete" },
      },
    ]);
    await inline.log.append([
      {
        stream: "run:conversation-external",
        body: { t: "session-lifecycle", mutation: "delete" },
      },
    ]);
    await expect(
      external.log.retainedArtifactReferences([externalLeaf]),
    ).resolves.toEqual([]);
    await expect(
      inline.log.retainedArtifactReferences([inlineLeaf]),
    ).resolves.toEqual([]);
    await expect(
      external.log.retainedArtifactReferences([envelopeRef]),
    ).resolves.toEqual([envelopeRef]);
  });

  it("rejects a corrupt external control root before commit", async () => {
    const { artifacts, log } = await createStores();
    const leaf = await artifacts.put(Buffer.from("corrupt-root-leaf"));
    const envelope = {
      ...inputControlEnvelope("request-corrupt", { ...leaf, kind: "file" }),
      payloadDigest: `sha256:${"0".repeat(64)}`,
    };
    const envelopeRef = await artifacts.put(
      Buffer.from(canonicalize(envelope)),
    );
    await expect(
      log.append([
        {
          stream: "control",
          body: {
            t: "received",
            requestId: envelope.requestId,
            envelope: { ref: envelopeRef },
          },
        },
      ]),
    ).rejects.toMatchObject({ code: "invalid-authority-record" });
    await expect(log.readAll()).resolves.toEqual([]);
  });

  it("accepts job sealed roots and rejects a mismatched execution record", async () => {
    const { root, artifacts, log } = await createStores();
    const content = await artifacts.put(Buffer.from("job retained content"));
    const bundle = createJobSealedBundle({
      assignmentId: "assignment-job",
      executorId: "executor-job",
      streamFinal: {
        finalSeq: 1,
        streamDigest: `sha256:${"1".repeat(64)}`,
      },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: {
        reportDigest: `sha256:${"1".repeat(64)}`,
        upToUsageSeq: 0,
      },
      dependencyArtifacts: [],
      body: {
        t: "job",
        taskId: "task-job",
        jobRunId: "job-run-1",
        fence: createJobCommitFence({
          taskId: "task-job",
          jobRunId: "job-run-1",
          scheduledFor: "2026-07-24T00:00:00.000Z",
          taskRevision: 1,
          deliveryPlanDigest: jobDeliveryPlanDigest({ kind: "none" }),
          anchorEpoch: 1,
          assignmentId: "assignment-job",
          executorId: "executor-job",
        }),
        outcome: { status: "completed", summary: "done" },
        contentAssets: [{ ...content, kind: "file" }],
      },
    });
    const bundleArtifact = sealedBundleArtifact(bundle);
    await expect(artifacts.put(bundleArtifact.bytes)).resolves.toEqual(
      bundleArtifact.ref,
    );
    await log.append([
      {
        stream: "job:task-job",
        body: {
          t: "committed",
          assignmentId: bundle.assignmentId,
          bundle: { ref: bundleArtifact.ref },
        },
      },
    ]);
    await expect(
      log.retainedArtifactReferences([content, bundleArtifact.ref]),
    ).resolves.toEqual([content, bundleArtifact.ref]);

    const executorLog = new FileAuthorityCommitLog(
      path.join(root, "executor-log"),
      artifacts,
      { lockWaitMs: 2_000 },
    );
    await executorLog.append([
      {
        stream: `assignment:${bundle.assignmentId}`,
        body: {
          body: {
            t: "bundle_sealed",
            bundle: { ref: bundleArtifact.ref },
          },
        },
      },
    ]);
    await expect(
      executorLog.retainedArtifactReferences([content, bundleArtifact.ref]),
    ).resolves.toEqual([content, bundleArtifact.ref]);

    const mismatched = new FileAuthorityCommitLog(
      path.join(root, "mismatched-log"),
      artifacts,
      { lockWaitMs: 2_000 },
    );
    await expect(
      mismatched.append([
        {
          stream: "run:conversation-job-mismatch",
          body: {
            t: "committed",
            assignmentId: bundle.assignmentId,
            bundle: { ref: bundleArtifact.ref },
          },
        },
      ]),
    ).rejects.toMatchObject({ code: "invalid-authority-record" });
    await expect(mismatched.readAll()).resolves.toEqual([]);
  });
});

describe("FileAuthorityCommitLog", () => {
  it("keeps the compatibility bridge on legacy frames with a stable sidecar identity", async () => {
    const { artifacts, log } = await createStores();
    // 兼容桥服务的是旧版本创建的日志:新建日志现在默认写带版本头的格式,
    // 因此必须先放一个无文件头的空日志,才能驱动 legacy 分支。
    await mkdir(path.dirname(log.logPath), { recursive: true });
    await writeFile(log.logPath, Buffer.alloc(0), { flag: "wx" });
    await log.append([{ stream: "control", body: { t: "legacy-one" } }]);
    const firstBytes = await readFile(log.logPath);
    const firstCheckpoint = await log.checkpoint();

    expect(firstBytes.readUInt16BE(4)).toBe(1);
    expect((await stat(log.identityPath)).size).toBe(
      AUTHORITY_WAL_FILE_HEADER_BYTES,
    );

    const reopened = new FileAuthorityCommitLog(log.rootDir, artifacts, {
      lockWaitMs: 2_000,
    });
    expect(await reopened.checkpoint()).toEqual(firstCheckpoint);
    await reopened.append([
      { stream: "control", body: { t: "legacy-two" } },
    ]);

    const reopenedBytes = await readFile(log.logPath);
    expect(reopenedBytes.subarray(0, firstBytes.byteLength)).toEqual(firstBytes);
    const metadata: unknown[] = [];
    const scanned = await scanAuthorityWalFrames(
      bufferWalReader(reopenedBytes),
      (_payload, _offset, frameMetadata) => {
        metadata.push(frameMetadata);
      },
    );
    expect(scanned.frameCount).toBe(2);
    expect(metadata).toEqual([undefined, undefined]);
  });

  it("dual-reads and continues an already-versioned WAL", async () => {
    const root = await createTempDir("authority-versioned-wal");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"), {
      lockWaitMs: 2_000,
    });
    const logRoot = path.join(root, "log");
    await mkdir(logRoot, { recursive: true });
    const logIdBytes = Buffer.alloc(32, 0x17);
    const logId = logIdBytes.toString("base64url");
    const at = "2026-07-27T00:00:00.000Z";
    const entries = [{ stream: "control", body: { t: "versioned-one" } }];
    const payload = { v: 1 as const, lsn: 1, at, entries };
    const envelope = {
      ...payload,
      envelopeDigest: protocolDigest("CommitEnvelope", 1, payload),
    };
    const prefixDigest = protocolDigest("AuthorityLogPrefix", 1, {
      logId,
      previousDigest: protocolDigest("AuthorityLogPrefix", 1, { logId }),
      lsn: 1,
      envelopeDigest: envelope.envelopeDigest,
    });
    await writeFile(
      path.join(logRoot, "authority.log"),
      Buffer.concat([
        encodeAuthorityWalFileHeader(logIdBytes),
        encodeAuthorityWalFrame(
          Buffer.from(canonicalize(envelope), "utf8"),
          { lsn: 1, prefixDigest },
        ),
      ]),
    );

    const log = new FileAuthorityCommitLog(logRoot, artifacts, {
      lockWaitMs: 2_000,
    });
    await expect(log.readAll()).resolves.toEqual([envelope]);
    await log.append([
      { stream: "control", body: { t: "versioned-two" } },
    ]);

    const bytes = await readFile(log.logPath);
    const frameMetadata: unknown[] = [];
    const scanned = await scanAuthorityWalFrames(
      bufferWalReader(bytes.subarray(AUTHORITY_WAL_FILE_HEADER_BYTES)),
      (_payload, _offset, metadata) => {
        frameMetadata.push(metadata);
      },
    );
    expect(scanned.frameCount).toBe(2);
    expect(frameMetadata).toMatchObject([
      { lsn: 1, prefixDigest },
      { lsn: 2 },
    ]);
  });

  it("fails closed when a legacy WAL and its sidecar identity diverge", async () => {
    const corrupted = await createStores();
    // 同上:sidecar identity 只在 legacy 日志上存在。
    await mkdir(path.dirname(corrupted.log.logPath), { recursive: true });
    await writeFile(corrupted.log.logPath, Buffer.alloc(0), { flag: "wx" });
    await corrupted.log.append([
      { stream: "control", body: { t: "stable" } },
    ]);
    await writeFile(corrupted.log.identityPath, Buffer.from("corrupt"));
    const reopened = new FileAuthorityCommitLog(
      corrupted.log.rootDir,
      corrupted.artifacts,
      { lockWaitMs: 2_000 },
    );
    await expect(reopened.readAll()).rejects.toMatchObject({
      code: "commit-log-corrupt",
    });

    const missing = await createStores();
    // sidecar identity 是 legacy 日志的产物,孤儿检查也只对它成立。
    await mkdir(path.dirname(missing.log.logPath), { recursive: true });
    await writeFile(missing.log.logPath, Buffer.alloc(0), { flag: "wx" });
    await missing.log.append([
      { stream: "control", body: { t: "stable" } },
    ]);
    await rm(missing.log.logPath);
    const missingLog = new FileAuthorityCommitLog(
      missing.log.rootDir,
      missing.artifacts,
      { lockWaitMs: 2_000 },
    );
    await expect(missingLog.readAll()).rejects.toMatchObject({
      code: "commit-log-corrupt",
    });
  });

  it("accepts executor-scoped durable streams", async () => {
    const { log } = await createStores();
    const stream =
      "executor:executor-1:data-plane-ticket-retirement-frontier";

    const committed = await log.append([
      { stream, body: { t: "retirement-frontier" } },
    ]);

    await expect(log.readStream(stream)).resolves.toEqual([
      {
        lsn: committed.lsn,
        at: committed.at,
        body: { t: "retirement-frontier" },
      },
    ]);
  });

  it("commits multiple logical streams atomically and rebuilds projections in LSN order", async () => {
    const { log } = await createStores();

    const first = await log.append([
      { stream: "control", body: { t: "received", requestId: "req-1" } },
      { stream: "run:conv-1", body: { t: "queued", runId: "run-1" } },
    ]);
    const second = await log.append([
      { stream: "run:conv-1", body: { t: "finished", runId: "run-1" } },
    ]);

    expect(first.lsn).toBe(1);
    expect(second.lsn).toBe(2);
    expect(first.envelopeDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(await log.readStream("control")).toEqual([
      { lsn: 1, at: first.at, body: { t: "received", requestId: "req-1" } },
    ]);
    await expect(
      log.rebuildProjection<string[]>(
        [],
        (state, record) => [...state, record.body.t],
        { stream: "run:conv-1" },
      ),
    ).resolves.toEqual(["queued", "finished"]);
    await expect(
      log.rebuildProjection<string[]>(
        ["queued"],
        (state, record) => [...state, record.body.t],
        { stream: "run:conv-1", afterLsn: first.lsn },
      ),
    ).resolves.toEqual(["queued", "finished"]);
    await expect(
      log.rebuildProjection([], (state) => state, { afterLsn: second.lsn + 1 }),
    ).rejects.toMatchObject({ code: "commit-log-corrupt" });
  });

  it("serializes concurrent appenders without duplicate or skipped LSNs", async () => {
    const { log } = await createStores();

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        log.append([{ stream: "control", body: { t: "event", index } }]),
      ),
    );

    const envelopes = await log.readAll();
    expect(envelopes.map((envelope) => envelope.lsn)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(new Set(envelopes.map((envelope) => JSON.stringify(envelope.entries[0]?.body))).size).toBe(12);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("atomically rebuilds a projection, decides, and appends across peer instances", async () => {
    const { artifacts, log } = await createStores();
    const peer = new FileAuthorityCommitLog(log.rootDir, artifacts, {
      lockWaitMs: 2_000,
    });

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const writer = index % 2 === 0 ? log : peer;
        return writer.transactProjection(
          0,
          (count) => count + 1,
          (count) => ({
            kind: "append",
            entries: [{ stream: "control", body: { t: "count", value: count + 1 } }],
            value: count + 1,
          }),
          { stream: "control" },
        );
      }),
    );

    expect(results.map((result) => result.value).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(await log.rebuildProjection(0, (count) => count + 1)).toBe(12);

    const replay = await peer.transactProjection(
      0,
      (count) => count + 1,
      (count) => ({ kind: "return", value: count }),
      { stream: "control" },
    );
    expect(replay).toMatchObject({ value: 12, state: 12, lastLsn: 12 });
    expect(replay.cursor.lsn).toBe(12);
    expect(await log.readAll()).toHaveLength(12);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("requires every newly referenced artifact to be protected by the transaction", async () => {
    const { artifacts, log } = await createStores();
    const ref = await artifacts.put(Buffer.from("candidate", "utf8"));
    const decide = () => ({
      kind: "append" as const,
      entries: [{ stream: "publish", body: { t: "asset", ref } }],
      value: undefined,
    });

    await expect(
      log.transactProjection(null, (state) => state, decide),
    ).rejects.toThrow("undeclared artifact reference");
    await expect(
      log.transactProjection(null, (state) => state, decide, {
        candidateReferences: [ref],
      }),
    ).resolves.toMatchObject({ commit: { lsn: 1 } });

    await expect(
      log.transactProjection(
        null,
        (state) => state,
        () => ({
          kind: "append",
          entries: [{ stream: "publish", body: { t: "alias", ref } }],
          value: undefined,
        }),
      ),
    ).rejects.toThrow("undeclared artifact reference");
    await expect(
      log.transactProjection(
        null,
        (state) => state,
        () => ({
          kind: "append",
          entries: [{ stream: "publish", body: { t: "alias", ref } }],
          value: undefined,
        }),
        { candidateReferences: [ref] },
      ),
    ).resolves.toMatchObject({ commit: { lsn: 2 } });
  });

  it("resumes a verified projection cursor across peer appends", async () => {
    const { artifacts, log } = await createStores();
    const peer = new FileAuthorityCommitLog(log.rootDir, artifacts, {
      lockWaitMs: 2_000,
    });
    const first = await log.transactProjection(
      [] as number[],
      (state, _record, envelope) => [...state, envelope.lsn],
      (state) => ({
        kind: "append",
        entries: [{ stream: "control", body: { t: "first" } }],
        value: state,
      }),
      { stream: "control" },
    );
    await peer.append([{ stream: "publish", body: { t: "peer" } }]);

    const resumed = await log.transactProjection(
      first.state,
      (state, _record, envelope) => [...state, envelope.lsn],
      (state) => ({ kind: "return", value: state }),
      { stream: "control", cursor: first.cursor },
    );

    expect(resumed.value).toEqual([1]);
    expect(resumed.lastLsn).toBe(2);
    expect(resumed.cursor.lsn).toBe(2);
  });

  it("reuses a projection after file replacement only when its logical prefix matches", async () => {
    const { root, artifacts, log } = await createStores();
    const first = await log.transactProjection(
      [] as number[],
      (state, _record, envelope) => [...state, envelope.lsn],
      () => ({
        kind: "append",
        entries: [{ stream: "control", body: { t: "first" } }],
        value: undefined,
      }),
      { stream: "control" },
    );
    const replacement = path.join(root, "authority-replacement.log");
    await copyFile(log.logPath, replacement);
    await rm(log.logPath);
    await rename(replacement, log.logPath);
    const peer = new FileAuthorityCommitLog(log.rootDir, artifacts, {
      lockWaitMs: 2_000,
    });
    await peer.append([{ stream: "control", body: { t: "second" } }]);

    const resumed = await log.transactProjection(
      first.state,
      (state, _record, envelope) => [...state, envelope.lsn],
      (state) => ({ kind: "return", value: state }),
      { stream: "control", cursor: first.cursor },
    );

    expect(resumed.value).toEqual([1, 2]);
    expect(resumed.lastLsn).toBe(2);
  });

  it("fails closed when a replacement log does not match the projected prefix", async () => {
    const original = await createStores();
    const first = await original.log.transactProjection(
      [] as string[],
      (state, record) => [...state, (record.body as { t: string }).t],
      () => ({
        kind: "append",
        entries: [{ stream: "control", body: { t: "original" } }],
        value: undefined,
      }),
      { stream: "control" },
    );
    const replacement = await createStores();
    await replacement.log.append([
      { stream: "control", body: { t: "different-prefix" } },
    ]);
    const staged = path.join(original.root, "authority-divergent.log");
    await copyFile(replacement.log.logPath, staged);
    await rm(original.log.logPath);
    await rename(staged, original.log.logPath);

    await expect(
      original.log.transactProjection(
        first.state,
        (state, record) => [...state, (record.body as { t: string }).t],
        () => ({
          kind: "append",
          entries: [{ stream: "control", body: { t: "must-not-append" } }],
          value: undefined,
        }),
        { stream: "control", cursor: first.cursor },
      ),
    ).rejects.toThrow("prefix does not match");
    expect(await original.log.readStream("control")).toEqual([
      expect.objectContaining({ body: { t: "different-prefix" } }),
    ]);
  });

  it("fails closed when the projected prefix is rewritten in place", async () => {
    const original = await createStores();
    const first = await original.log.transactProjection(
      [] as string[],
      (state, record) => [...state, (record.body as { t: string }).t],
      () => ({
        kind: "append",
        entries: [{ stream: "control", body: { t: "original" } }],
        value: undefined,
      }),
      { stream: "control" },
    );
    const replacement = await createStores();
    await replacement.log.append([{ stream: "control", body: { t: "differnt" } }]);
    const before = await stat(original.log.logPath);
    const divergent = await readFile(replacement.log.logPath);
    await writeFile(original.log.logPath, divergent);
    const after = await stat(original.log.logPath);
    expect({ device: after.dev, inode: after.ino, bytes: after.size }).toEqual({
      device: before.dev,
      inode: before.ino,
      bytes: before.size,
    });

    await expect(
      original.log.transactProjection(
        first.state,
        (state, record) => [...state, (record.body as { t: string }).t],
        () => ({
          kind: "append",
          entries: [{ stream: "control", body: { t: "must-not-append" } }],
          value: undefined,
        }),
        { stream: "control", cursor: first.cursor },
      ),
    ).rejects.toThrow("prefix does not match");
    expect(await original.log.readStream("control")).toEqual([
      expect.objectContaining({ body: { t: "differnt" } }),
    ]);
  });

  it("fails closed when an in-place rewritten prefix also grows", async () => {
    const original = await createStores();
    const first = await original.log.transactProjection(
      [] as string[],
      (state, record) => [...state, (record.body as { t: string }).t],
      () => ({
        kind: "append",
        entries: [{ stream: "control", body: { t: "original" } }],
        value: undefined,
      }),
      { stream: "control" },
    );
    const replacement = await createStores();
    await replacement.log.append([{ stream: "control", body: { t: "differnt" } }]);
    await replacement.log.append([{ stream: "control", body: { t: "second" } }]);
    const before = await stat(original.log.logPath);
    await writeFile(original.log.logPath, await readFile(replacement.log.logPath));
    const after = await stat(original.log.logPath);
    expect(after.dev).toBe(before.dev);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBeGreaterThan(before.size);

    await expect(
      original.log.transactProjection(
        first.state,
        (state, record) => [...state, (record.body as { t: string }).t],
        () => ({
          kind: "append",
          entries: [{ stream: "control", body: { t: "must-not-append" } }],
          value: undefined,
        }),
        { stream: "control", cursor: first.cursor },
      ),
    ).rejects.toThrow("prefix does not match");
    expect((await original.log.readStream("control")).map((entry) => entry.body)).toEqual([
      { t: "differnt" },
      { t: "second" },
    ]);
  });

  it("resynchronizes verified tail state when another log instance appends", async () => {
    const { artifacts, log } = await createStores();
    const peer = new FileAuthorityCommitLog(log.rootDir, artifacts, {
      lockWaitMs: 2_000,
    });

    await log.append([{ stream: "control", body: { t: "one" } }]);
    await peer.append([{ stream: "control", body: { t: "two" } }]);
    await log.append([{ stream: "control", body: { t: "three" } }]);

    expect((await log.readAll()).map((envelope) => envelope.lsn)).toEqual([1, 2, 3]);
  });

  it("refuses to commit an artifact reference until its bytes are durable", async () => {
    const { artifacts, log } = await createStores();
    const missing = { digest: `sha256:${"0".repeat(64)}`, bytes: 7 };

    await expect(
      log.append([{ stream: "publish", body: { t: "asset", content: missing } }]),
    ).rejects.toMatchObject({ code: "artifact-missing" });
    await expect(log.readAll()).resolves.toEqual([]);

    const present = await artifacts.put(Buffer.from("present", "utf8"));
    await expect(
      log.append([{ stream: "publish", body: { t: "asset", content: present } }]),
    ).resolves.toMatchObject({ lsn: 1 });
  });

  it("enforces the 32 KiB inline body boundary and accepts an artifact reference instead", async () => {
    const { artifacts, log } = await createStores();
    const emptyBodyBytes = Buffer.byteLength(JSON.stringify({ data: "" }), "utf8");
    const exact = { data: "x".repeat(32 * 1024 - emptyBodyBytes) };
    const oversized = { data: `${exact.data}x` };

    await expect(log.append([{ stream: "control", body: exact }])).resolves.toMatchObject({
      lsn: 1,
    });
    await expect(
      log.append([{ stream: "control", body: oversized }]),
    ).rejects.toThrow("inline limit");
    const ref = await artifacts.put(Buffer.from(JSON.stringify(oversized), "utf8"));
    await expect(
      log.append([{ stream: "control", body: { t: "external", ref } }]),
    ).resolves.toMatchObject({ lsn: 2 });
  });

  it("rejects non-canonical records before they can become durable facts", async () => {
    const { artifacts, root } = await createStores();
    const invalidClockLog = new FileAuthorityCommitLog(
      path.join(root, "invalid-clock-log"),
      artifacts,
      { clock: () => "2026-01-01" },
    );
    await expect(
      invalidClockLog.append([{ stream: "control", body: { t: "event" } }]),
    ).rejects.toThrow("canonical ISO");
    await expect(invalidClockLog.readAll()).resolves.toEqual([]);

    const { log } = await createStores();
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => "not-allowed",
    });
    let artifactAccessorRead = false;
    const artifactAccessor = Object.defineProperty({}, "digest", {
      enumerable: true,
      get: () => {
        artifactAccessorRead = true;
        return `sha256:${"0".repeat(64)}`;
      },
    });
    expect(() => collectArtifactRefs(artifactAccessor)).toThrow("accessor-backed");
    expect(artifactAccessorRead).toBe(false);
    await expect(
      log.append([{ stream: "control", body: accessor }]),
    ).rejects.toThrow("accessor-backed");
    await expect(
      log.append([
        { stream: "control", body: { t: "event" }, extra: true } as never,
      ]),
    ).rejects.toThrow("unknown or missing fields");
    await expect(
      log.append([{ stream: "unknown", body: { t: "event" } }]),
    ).rejects.toThrow("Invalid authority logical stream");
    await expect(log.readAll()).resolves.toEqual([]);
  });

  it("isolates a partially written tail and preserves the last complete envelope", async () => {
    const { log } = await createStores();
    await log.append([{ stream: "control", body: { t: "stable" } }]);
    const stableBytes = (await readFile(log.logPath)).byteLength;
    const partial = Buffer.alloc(9);
    partial.writeUInt32BE(100, 0);
    partial.write("{bad", 4, "utf8");
    await appendFile(log.logPath, partial);

    const recovered = await log.readAll();

    expect(recovered).toHaveLength(1);
    expect((await readdir(log.quarantineDir)).length).toBe(1);
    expect((await readFile(log.logPath)).byteLength).toBe(stableBytes);
    await expect(log.append([{ stream: "control", body: { t: "after-recovery" } }])).resolves.toMatchObject({
      lsn: 2,
    });
  });

  it("fails closed on every complete corrupt frame without discarding later commits", async () => {
    const finalTail = await createStores();
    await finalTail.log.append([{ stream: "control", body: { t: "one" } }]);
    await finalTail.log.append([{ stream: "control", body: { t: "two" } }]);
    await corruptFrame(finalTail.log.logPath, 1);
    await expect(finalTail.log.readAll()).rejects.toBeInstanceOf(AuthorityStorageError);
    await expect(readdir(finalTail.log.quarantineDir)).rejects.toMatchObject({ code: "ENOENT" });

    const interior = await createStores();
    await interior.log.append([{ stream: "control", body: { t: "one" } }]);
    await interior.log.append([{ stream: "control", body: { t: "two" } }]);
    await interior.log.append([{ stream: "control", body: { t: "three" } }]);
    await corruptFrame(interior.log.logPath, 1);

    await expect(interior.log.readAll()).rejects.toBeInstanceOf(AuthorityStorageError);
    await expect(readdir(interior.log.quarantineDir)).rejects.toMatchObject({ code: "ENOENT" });

    const corruptHeader = await createStores();
    await corruptHeader.log.append([{ stream: "control", body: { t: "one" } }]);
    await corruptHeader.log.append([{ stream: "control", body: { t: "two" } }]);
    await corruptHeader.log.append([{ stream: "control", body: { t: "three" } }]);
    const bytes = await readFile(corruptHeader.log.logPath);
    const second = frameBounds(bytes, walDataOffset(bytes)).nextOffset;
    bytes[second + 12] ^= 0xff;
    await writeFile(corruptHeader.log.logPath, bytes);
    await expect(corruptHeader.log.readAll()).rejects.toBeInstanceOf(
      AuthorityStorageError,
    );
    await expect(readdir(corruptHeader.log.quarantineDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("keeps referenced artifacts, collects old orphans, and never creates a dangling commit during GC", async () => {
    const { artifacts, log } = await createStores();
    const retained = await artifacts.put(Buffer.from("retained", "utf8"));
    const orphan = await artifacts.put(Buffer.from("orphan", "utf8"));
    await log.append([{ stream: "publish", body: { t: "asset", content: retained } }]);
    const old = new Date("2020-01-01T00:00:00.000Z");
    await utimes(artifacts.pathFor(retained), old, old);
    await utimes(artifacts.pathFor(orphan), old, old);

    const result = await log.collectGarbage({
      unreferencedBefore: "2021-01-01T00:00:00.000Z",
    });

    expect(result).toEqual({ scanned: 2, retained: 1, deleted: 1 });
    await expect(artifacts.has(retained)).resolves.toBe(true);
    await expect(artifacts.has(orphan)).resolves.toBe(false);

    const racing = await artifacts.put(Buffer.from("racing", "utf8"));
    await utimes(artifacts.pathFor(racing), old, old);
    const [gc, append] = await Promise.allSettled([
      log.collectGarbage({ unreferencedBefore: "2021-01-01T00:00:00.000Z" }),
      log.append([{ stream: "publish", body: { t: "asset", content: racing } }]),
    ]);
    expect(gc.status).toBe("fulfilled");
    const envelopes = await log.readAll();
    if (append.status === "fulfilled") {
      await expect(artifacts.has(racing)).resolves.toBe(true);
      expect(envelopes).toHaveLength(2);
    } else {
      expect(append.reason).toMatchObject({ code: "artifact-missing" });
      await expect(artifacts.has(racing)).resolves.toBe(false);
      expect(envelopes).toHaveLength(1);
    }
  }, DURABLE_IO_TEST_TIMEOUT_MS);
});

async function corruptFrame(file: string, frameIndex: number): Promise<void> {
  const bytes = await readFile(file);
  let offset = walDataOffset(bytes);
  for (let index = 0; index <= frameIndex; index += 1) {
    const bounds = frameBounds(bytes, offset);
    if (index === frameIndex) {
      bytes[bounds.payloadEnd - 1] =
        bytes[bounds.payloadEnd - 1] === 0x7d ? 0x7b : 0x7d;
      await writeFile(file, bytes);
      return;
    }
    offset = bounds.nextOffset;
  }
  throw new Error("Frame does not exist");
}

function frameBounds(bytes: Buffer, offset: number): {
  payloadEnd: number;
  nextOffset: number;
} {
  const payloadBytes = bytes.readUInt32BE(offset + 8);
  const version = bytes.readUInt16BE(offset + 4);
  const payloadEnd = offset + AUTHORITY_WAL_HEADER_BYTES + payloadBytes;
  return {
    payloadEnd,
    nextOffset:
      payloadEnd + (version === 1 ? 12 : AUTHORITY_WAL_TRAILER_BYTES),
  };
}

function walDataOffset(bytes: Buffer): number {
  return bytes.byteLength >= AUTHORITY_WAL_FILE_HEADER_BYTES &&
    bytes.readUInt32BE(0) === 0x5a584148
    ? AUTHORITY_WAL_FILE_HEADER_BYTES
    : 0;
}

function bufferWalReader(bytes: Buffer) {
  return {
    size: bytes.byteLength,
    read: (offset: number, length: number) =>
      Promise.resolve(bytes.subarray(offset, offset + length)),
  };
}
