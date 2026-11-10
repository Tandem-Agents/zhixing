/**
 * 规则命中在规则权威侧的累计：待计数记录（准备）→ 接纳（计数与删除同一次原子写）。
 * 覆盖重放、写失败、重开、撤销与并发命中，确保不漏、不重、不复活。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import {
  DurablePermissionRuleStore,
  GLOBAL_PERMISSION_BUCKET,
  type PendingRuleHit,
} from "../durable-permission-rules.js";
import type { PermissionRule } from "../types.js";

const RULE: PermissionRule = {
  id: "rule-fetch",
  pattern: { tool: "web_fetch", argument: "*" },
  decision: "allow",
  scope: "global",
  createdAt: 1,
  lastMatchedAt: 0,
  matchCount: 0,
};

function hit(n: number, overrides: Partial<PendingRuleHit> = {}): PendingRuleHit {
  return {
    id: `assignment-1/trust-rule-hit:${n}`,
    ruleId: RULE.id,
    at: 1000 + n,
    digest: `sha256:hit-${n}`,
    assignmentId: "assignment-1",
    conversationId: "conversation-1",
    ...overrides,
  };
}

function globalFile(rootDir: string): { rules: PermissionRule[]; hits?: unknown[] } {
  return JSON.parse(fs.readFileSync(path.join(rootDir, "global.json"), "utf8"));
}

/** 让该桶下一次原子替换失败：目标文件位置被目录占住。 */
function blockGlobalFile(rootDir: string): () => void {
  const file = path.join(rootDir, "global.json");
  const saved = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);
  return () => {
    fs.rmSync(file, { recursive: true, force: true });
    fs.writeFileSync(file, saved);
  };
}

async function storeWithRule(): Promise<{ rootDir: string; store: DurablePermissionRuleStore }> {
  const rootDir = await createTempDir("rule-hits");
  const store = new DurablePermissionRuleStore(rootDir);
  await store.addGlobalRule({ ...RULE });
  return { rootDir, store };
}

const count = (store: DurablePermissionRuleStore) => store.global().find((rule) => rule.id === RULE.id)?.matchCount;

/** 按记录本身认领（id 与内容摘要，带批次时含批次）。 */
const claim = (entry: PendingRuleHit) => ({
  id: entry.id,
  digest: entry.digest,
  ...(entry.batchDigest ? { batchDigest: entry.batchDigest } : {}),
});

describe("规则命中累计", () => {
  it("准备后未接纳不计入；接纳后计入并在同一次写里删除待计数记录", async () => {
    const { rootDir, store } = await storeWithRule();
    await store.prepareHits(GLOBAL_PERMISSION_BUCKET, [hit(1)]);
    expect(count(store)).toBe(0);
    expect(store.unacceptedHits(GLOBAL_PERMISSION_BUCKET).map((entry) => entry.id)).toEqual([hit(1).id]);
    expect(globalFile(rootDir).hits).toHaveLength(1);

    expect(await store.acceptHits(GLOBAL_PERMISSION_BUCKET, [claim(hit(1))])).toBe(1);
    expect(count(store)).toBe(1);
    expect(store.global()[0]!.lastMatchedAt).toBe(1001);
    const file = globalFile(rootDir);
    expect(file.rules[0]!.matchCount).toBe(1);
    expect(file.hits).toBeUndefined();
  });

  it("同 ID 同内容准备幂等；同 ID 异内容拒绝", async () => {
    const { store } = await storeWithRule();
    await store.prepareHits(GLOBAL_PERMISSION_BUCKET, [hit(1)]);
    await store.prepareHits(GLOBAL_PERMISSION_BUCKET, [hit(1)]);
    expect(store.unacceptedHits(GLOBAL_PERMISSION_BUCKET)).toHaveLength(1);
    await expect(store.prepareHits(GLOBAL_PERMISSION_BUCKET, [hit(1, { digest: "sha256:other" })]))
      .rejects.toThrow(/different content/);
    await expect(store.prepareHits(GLOBAL_PERMISSION_BUCKET, [hit(1, { ruleId: "rule-other" })]))
      .rejects.toThrow(/different content/);
  });

  it("同一命中随新批次重发：记下最新批次摘要，供重开核对", async () => {
    const { store } = await storeWithRule();
    await store.prepareHits(GLOBAL_PERMISSION_BUCKET, [hit(1, { batchDigest: "sha256:batch-a" })]);
    await store.prepareHits(GLOBAL_PERMISSION_BUCKET, [hit(1, { batchDigest: "sha256:batch-b" })]);
    expect(store.unacceptedHits(GLOBAL_PERMISSION_BUCKET).map((entry) => entry.batchDigest)).toEqual(["sha256:batch-b"]);
  });

  it("重复接纳（回执丢失后的重放）不重复计数", async () => {
    const { store } = await storeWithRule();
    await store.prepareHits(GLOBAL_PERMISSION_BUCKET, [hit(1)]);
    expect(await store.acceptHits(GLOBAL_PERMISSION_BUCKET, [claim(hit(1))])).toBe(1);
    expect(await store.acceptHits(GLOBAL_PERMISSION_BUCKET, [claim(hit(1))])).toBe(0);
    expect(count(store)).toBe(1);
  });

  it("接纳写失败：内存已计入，下一次写入物化；不重复计数", async () => {
    const { rootDir, store } = await storeWithRule();
    await store.prepareHits(GLOBAL_PERMISSION_BUCKET, [hit(1), hit(2)]);
    const restore = blockGlobalFile(rootDir);
    expect(await store.acceptHits(GLOBAL_PERMISSION_BUCKET, [claim(hit(1))])).toBe(1);
    expect(count(store)).toBe(1);
    restore();
    expect(await store.acceptHits(GLOBAL_PERMISSION_BUCKET, [claim(hit(2))])).toBe(1);
    expect(count(store)).toBe(2);
    const file = globalFile(rootDir);
    expect(file.rules[0]!.matchCount).toBe(2);
    expect(file.hits).toBeUndefined();
  });

  it("重开：未接纳的待计数记录重新加载、交宿主核对；接纳一次", async () => {
    const { rootDir, store } = await storeWithRule();
    await store.prepareHits(GLOBAL_PERMISSION_BUCKET, [hit(1)]);
    const loaded: string[] = [];
    const reopened = new DurablePermissionRuleStore(rootDir, {
      onPendingLoaded: (bucket) => { loaded.push(bucket); },
    });
    expect(count(reopened)).toBe(0);
    expect(loaded).toEqual([GLOBAL_PERMISSION_BUCKET]);
    expect(reopened.unacceptedHits(GLOBAL_PERMISSION_BUCKET)).toEqual([hit(1)]);
    expect(await reopened.acceptHits(GLOBAL_PERMISSION_BUCKET, [claim(hit(1))])).toBe(1);
    expect(count(reopened)).toBe(1);
    // 写失败后重开：内存接纳丢失，记录仍在，按核对补做
    const { rootDir: other, store: failing } = await storeWithRule();
    await failing.prepareHits(GLOBAL_PERMISSION_BUCKET, [hit(1)]);
    const restore = blockGlobalFile(other);
    await failing.acceptHits(GLOBAL_PERMISSION_BUCKET, [claim(hit(1))]);
    restore();
    const after = new DurablePermissionRuleStore(other);
    expect(count(after)).toBe(0);
    expect(after.unacceptedHits(GLOBAL_PERMISSION_BUCKET)).toHaveLength(1);
  });

  it("撤销后：准备不写、迟到的接纳只丢记录，规则不复活", async () => {
    const { rootDir, store } = await storeWithRule();
    await store.prepareHits(GLOBAL_PERMISSION_BUCKET, [hit(1)]);
    expect(await store.revoke(RULE.id)).toBe(true);
    expect(await store.acceptHits(GLOBAL_PERMISSION_BUCKET, [claim(hit(1))])).toBe(0);
    await store.prepareHits(GLOBAL_PERMISSION_BUCKET, [hit(2)]);
    expect(store.global()).toEqual([]);
    expect(store.unacceptedHits(GLOBAL_PERMISSION_BUCKET)).toEqual([]);
    const file = globalFile(rootDir);
    expect(file.rules).toEqual([]);
    expect(file.hits).toBeUndefined();
  });

  it("未知规则的命中不写记录、不创建规则", async () => {
    const { store } = await storeWithRule();
    await store.prepareHits(GLOBAL_PERMISSION_BUCKET, [hit(1, { ruleId: "rule-missing" })]);
    expect(store.unacceptedHits(GLOBAL_PERMISSION_BUCKET)).toEqual([]);
    expect(store.global().map((rule) => rule.id)).toEqual([RULE.id]);
  });

  it("同一规则的两次真实命中都计入；并发接纳串行累计", async () => {
    const { rootDir, store } = await storeWithRule();
    await store.prepareHits(GLOBAL_PERMISSION_BUCKET, [hit(1)]);
    const other = hit(2, { assignmentId: "assignment-2", id: "assignment-2/trust-rule-hit:1" });
    await store.prepareHits(GLOBAL_PERMISSION_BUCKET, [other]);
    const accepted = await Promise.all([
      store.acceptHits(GLOBAL_PERMISSION_BUCKET, [claim(hit(1))]),
      store.acceptHits(GLOBAL_PERMISSION_BUCKET, [claim(other)]),
    ]);
    expect(accepted).toEqual([1, 1]);
    expect(count(store)).toBe(2);
    expect(globalFile(rootDir).rules[0]!.matchCount).toBe(2);
  });

  it("清理确定不会接纳的记录；已接纳的不受影响", async () => {
    const { store } = await storeWithRule();
    await store.prepareHits(GLOBAL_PERMISSION_BUCKET, [hit(1), hit(2)]);
    await store.acceptHits(GLOBAL_PERMISSION_BUCKET, [claim(hit(1))]);
    await store.discardHits(GLOBAL_PERMISSION_BUCKET, [claim(hit(1)), claim(hit(2))]);
    expect(store.unacceptedHits(GLOBAL_PERMISSION_BUCKET)).toEqual([]);
    expect(count(store)).toBe(1);
  });

  it("没有耐久回程时规则权威直接记账：计入存在且未撤销的规则", async () => {
    const { rootDir, store } = await storeWithRule();
    expect(await store.recordHits(GLOBAL_PERMISSION_BUCKET, [
      { ruleId: RULE.id, at: 5 },
      { ruleId: RULE.id, at: 9 },
      { ruleId: "rule-missing", at: 7 },
    ])).toBe(2);
    expect(count(store)).toBe(2);
    expect(globalFile(rootDir).rules[0]).toMatchObject({ matchCount: 2, lastMatchedAt: 9 });
  });

  it("直接记账首次写盘失败：上报错误、不计入；故障解除后正常记一次，重开保持", async () => {
    const { rootDir, store } = await storeWithRule();
    const restore = blockGlobalFile(rootDir);
    await expect(store.recordHits(GLOBAL_PERMISSION_BUCKET, [{ ruleId: RULE.id, at: 5 }])).rejects.toThrow();
    expect(count(store)).toBe(0);
    restore();
    expect(await store.recordHits(GLOBAL_PERMISSION_BUCKET, [{ ruleId: RULE.id, at: 6 }])).toBe(1);
    expect(count(store)).toBe(1);
    expect(count(new DurablePermissionRuleStore(rootDir))).toBe(1);
  });

  it("只认领本批的记录：另一批次的接纳与清理都碰不到它", async () => {
    const { store } = await storeWithRule();
    const committed = hit(1, { batchDigest: "sha256:batch-a" });
    await store.prepareHits(GLOBAL_PERMISSION_BUCKET, [committed]);
    // 被拒绝的另一批次声称同一命中：清理与接纳都不能动 A 的恢复记录
    await store.discardHits(GLOBAL_PERMISSION_BUCKET, [{ ...claim(committed), batchDigest: "sha256:batch-b" }]);
    expect(await store.acceptHits(GLOBAL_PERMISSION_BUCKET, [{ ...claim(committed), batchDigest: "sha256:batch-b" }])).toBe(0);
    // 内容不同的认领同样无效
    expect(await store.acceptHits(GLOBAL_PERMISSION_BUCKET, [{ ...claim(committed), digest: "sha256:other" }])).toBe(0);
    expect(store.unacceptedHits(GLOBAL_PERMISSION_BUCKET)).toEqual([committed]);
    // 本批重放接纳一次
    expect(await store.acceptHits(GLOBAL_PERMISSION_BUCKET, [claim(committed)])).toBe(1);
    expect(count(store)).toBe(1);
  });
});
