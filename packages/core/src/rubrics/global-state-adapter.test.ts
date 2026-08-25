import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { FileArtifactStore, FileAuthorityCommitLog } from "../authority/index.js";
import type { GlobalControlCallContext } from "../contracts/index.js";
import { parseRubricDocument, rubricDocumentId, stringifyRubricDraft } from "./document.js";
import { AnchorRubricGlobalStateAdapter } from "./global-state-adapter.js";

const NOW = "2026-08-03T00:00:00.000Z";
const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;

describe("AnchorRubricGlobalStateAdapter", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("persists immutable rubric content behind a guarded global index", async () => {
    const fixture = await createFixture();
    const first = await rubricWrite(fixture.artifacts, "验收准则", "第一版");
    const rubricId = rubricDocumentId(first.document);
    const saved = await fixture.adapter.mutate(
      { kind: "rubric-save-own", rubric: first.write },
      context("save"),
    );
    expect(saved.revision).toBe(1);
    expect(await fixture.adapter.read(
      { kind: "asset-index", asset: "rubrics" },
      context("read"),
    )).toEqual({
      kind: "asset-index",
      entries: [{ id: rubricId, kind: "rubrics", revision: 1, digest: first.write.content.digest }],
    });

    expect(await fixture.adapter.mutate(
      { kind: "rubric-save-own", rubric: first.write },
      context("save"),
    )).toEqual(saved);
    await expect(fixture.adapter.mutate(
      { kind: "rubric-archive", rubricId, expectedRevision: 1 },
      context("save", 1),
    )).rejects.toThrow("another mutation");

    const restarted = new AnchorRubricGlobalStateAdapter({
      log: fixture.log,
      artifacts: fixture.artifacts,
      anchorEpoch: 1,
      clock: () => NOW,
    });
    const rebuilt = await restarted.read(
      { kind: "asset-index", asset: "rubrics" },
      context("rebuilt"),
    );
    expect(rebuilt).toEqual(await fixture.adapter.read(
      { kind: "asset-index", asset: "rubrics" },
      context("read-again"),
    ));
  });

  it("enforces content identity, revision fences and archive visibility", async () => {
    const fixture = await createFixture();
    const first = await rubricWrite(fixture.artifacts, "验收准则", "第一版");
    const rubricId = rubricDocumentId(first.document);
    await fixture.adapter.mutate(
      { kind: "rubric-save-own", rubric: first.write },
      context("save"),
    );
    const changed = await rubricWrite(fixture.artifacts, "验收准则", "第二版");
    await expect(fixture.adapter.mutate(
      {
        kind: "rubric-update-own",
        rubricId,
        rubric: { ...changed.write, title: "错绑标题" },
        expectedRevision: 1,
      },
      context("wrong-metadata", 1),
    )).rejects.toThrow("metadata");
    expect(await fixture.adapter.mutate(
      {
        kind: "rubric-update-own",
        rubricId,
        rubric: changed.write,
        expectedRevision: 1,
      },
      context("update", 1),
    )).toEqual({ revision: 2 });
    await expect(fixture.adapter.mutate(
      { kind: "rubric-archive", rubricId, expectedRevision: 1 },
      context("stale", 1),
    )).rejects.toThrow("stale");
    await fixture.adapter.mutate(
      { kind: "rubric-archive", rubricId, expectedRevision: 2 },
      context("archive", 2),
    );
    expect(await fixture.adapter.read(
      { kind: "asset-index", asset: "rubrics" },
      context("read"),
    )).toEqual({ kind: "asset-index", entries: [] });
  });

  it("rejects stale authority, unauthorized principals and unsupported global operations", async () => {
    const fixture = await createFixture();
    await expect(fixture.adapter.read(
      { kind: "asset-index", asset: "rubrics" },
      { ...context("stale"), authority: { domain: "global", anchorEpoch: 2 } },
    )).rejects.toThrow("authority fence");
    await expect(fixture.adapter.read(
      { kind: "asset-index", asset: "rubrics" },
      { ...context("principal"), principal: { kind: "usage-reporter", executorId: "e1" } },
    )).rejects.toThrow();
    await expect(fixture.adapter.read(
      { kind: "workscene-list" },
      context("wrong-query"),
    )).rejects.toThrow("only owns Rubric");
  });
});

function context(requestId: string, expectedRevision?: number): GlobalControlCallContext {
  return {
    principal: { kind: "host", component: "rubric-test" },
    requestId,
    deadlineAt: "2026-08-03T01:00:00.000Z",
    authority: { domain: "global", anchorEpoch: 1 },
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
}

async function createFixture() {
  const root = await createTempDir("zhixing-rubric-global-state");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => NOW,
  });
  return {
    artifacts,
    log,
    adapter: new AnchorRubricGlobalStateAdapter({
      log,
      artifacts,
      anchorEpoch: 1,
      clock: () => NOW,
    }),
  };
}

async function rubricWrite(
  artifacts: FileArtifactStore,
  title: string,
  description: string,
) {
  const raw = stringifyRubricDraft({
    title,
    description,
    content: {
      passCriteria: ["任务完成"],
      evidenceRequirements: ["提供结果"],
      failureHandling: [{ scenario: "未完成", reply: "继续处理" }],
    },
  });
  const document = parseRubricDocument(raw);
  const content = await artifacts.put(Buffer.from(raw));
  return {
    document,
    write: { title: document.title, description: document.description, content },
  };
}
