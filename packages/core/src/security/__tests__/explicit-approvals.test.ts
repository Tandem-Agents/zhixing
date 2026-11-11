import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing-ai/test-utils";
import { DurablePermissionRuleStore, GLOBAL_PERMISSION_BUCKET } from "../durable-permission-rules.js";
import {
  ExplicitApprovalEffects,
  explicitApprovalBucket,
  explicitApprovalRuleId,
  type ExplicitApprovalInput,
} from "../explicit-approvals.js";
import { PermissionStore, toStorageKey } from "../permission-store.js";
import type { PermissionContextId } from "../types.js";

const SCOPE: PermissionContextId = { kind: "workspace", hash: "binding-a", revision: 2 };
const BUCKET = toStorageKey(SCOPE);

function approval(requestId: string, overrides: Partial<ExplicitApprovalInput> = {}): ExplicitApprovalInput {
  return {
    requestId,
    conversationId: "conversation-1",
    assignmentId: "assignment-1",
    contextId: SCOPE,
    decision: {
      kind: "allow-context",
      pattern: { pattern: { tool: "bash", argument: "npm test" }, label: "npm test" },
    },
    decisionDigest: `digest:${requestId}`,
    ...overrides,
  };
}

/** 让该桶下一次原子替换失败：目标文件位置被目录占住。 */
function blockBucketFile(rootDir: string, bucket: string): () => void {
  const file = path.join(rootDir, bucket === GLOBAL_PERMISSION_BUCKET ? "global.json" : `${bucket}.json`);
  const saved = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);
  return () => {
    fs.rmSync(file, { recursive: true, force: true });
    if (saved) fs.writeFileSync(file, saved);
  };
}

describe("显式持久批准三态", () => {
  it("待生效记录不生效；接纳后立即生效并物化，待生效记录随同一次写删除", async () => {
    const rootDir = await createTempDir("explicit-approval");
    const store = new DurablePermissionRuleStore(rootDir);
    const effects = new ExplicitApprovalEffects(store);
    await effects.prepare(approval("request-1"));
    expect(store.context(BUCKET)).toEqual([]);
    expect(store.unacceptedApprovals(BUCKET)).toHaveLength(1);

    const state = await effects.accept("request-1");
    expect(state).toMatchObject({ kind: "effective", materialized: true });
    expect(store.context(BUCKET).map((rule) => rule.id)).toEqual([explicitApprovalRuleId(BUCKET, "request-1")]);
    const file = JSON.parse(fs.readFileSync(path.join(rootDir, `${BUCKET}.json`), "utf8"));
    expect(file.rules).toHaveLength(1);
    expect(file.pending).toBeUndefined();
    // 重开从文件加载同一规则
    expect(new DurablePermissionRuleStore(rootDir).context(BUCKET).map((rule) => rule.id))
      .toEqual([explicitApprovalRuleId(BUCKET, "request-1")]);
  });

  it("待生效记录写失败时上抛且不留下任何生效状态", async () => {
    const parent = await createTempDir("explicit-approval-blocked");
    const rootDir = path.join(parent, "permissions");
    fs.writeFileSync(rootDir, "not a directory");
    const store = new DurablePermissionRuleStore(rootDir);
    const effects = new ExplicitApprovalEffects(store);
    await expect(effects.prepare(approval("request-1"))).rejects.toThrow();
    expect(store.context(BUCKET)).toEqual([]);
    expect(effects.state("request-1")).toBeUndefined();
  });

  it("接纳后物化失败：本次已生效、不上抛，下一次写入补物化", async () => {
    const rootDir = await createTempDir("explicit-approval-materialize");
    const store = new DurablePermissionRuleStore(rootDir);
    const effects = new ExplicitApprovalEffects(store);
    await effects.prepare(approval("request-1"));
    const unblock = blockBucketFile(rootDir, BUCKET);
    await expect(effects.accept("request-1")).resolves.toMatchObject({ kind: "effective", materialized: false });
    expect(store.context(BUCKET)).toHaveLength(1);
    unblock();
    await store.publish(BUCKET, PermissionStore.createRule({
      pattern: { tool: "bash", argument: "ls" },
      decision: "allow",
      scope: "context",
      contextId: SCOPE,
    }));
    const file = JSON.parse(fs.readFileSync(path.join(rootDir, `${BUCKET}.json`), "utf8"));
    expect(file.rules.map((rule: { id: string }) => rule.id)).toContain(explicitApprovalRuleId(BUCKET, "request-1"));
    expect(file.pending).toBeUndefined();
  });

  it("重开后待生效记录先不生效，按耐久决定核对：一致才接纳，不同则删除", async () => {
    const rootDir = await createTempDir("explicit-approval-reopen");
    const first = new ExplicitApprovalEffects(new DurablePermissionRuleStore(rootDir));
    await first.prepare(approval("accepted-request"));
    await first.prepare(approval("rejected-request", {
      decision: { kind: "allow-context", pattern: { pattern: { tool: "bash", argument: "rm *" }, label: "rm" } },
    }));

    const loaded: string[] = [];
    const reopened = new DurablePermissionRuleStore(rootDir, { onPendingLoaded: (bucket) => loaded.push(bucket) });
    const effects = new ExplicitApprovalEffects(reopened);
    expect(reopened.context(BUCKET)).toEqual([]);
    expect(loaded).toEqual([BUCKET]);
    await effects.reconcile(BUCKET, async (entry) =>
      entry.requestId === "accepted-request" ? "accepted" : "rejected");
    expect(reopened.context(BUCKET).map((rule) => rule.pattern.argument)).toEqual(["npm test"]);
    expect(reopened.unacceptedApprovals(BUCKET)).toEqual([]);
    const file = JSON.parse(fs.readFileSync(path.join(rootDir, `${BUCKET}.json`), "utf8"));
    expect(file.pending).toBeUndefined();
  });

  it("决定回到待确认后改为别的范围或别的决定：旧待生效记录被清掉", async () => {
    const rootDir = await createTempDir("explicit-approval-redecide");
    const store = new DurablePermissionRuleStore(rootDir);
    const effects = new ExplicitApprovalEffects(store);
    await effects.prepare(approval("request-1"));
    await effects.prepare(approval("request-1", {
      decision: { kind: "allow-global", pattern: { pattern: { tool: "bash", argument: "npm test" }, label: "npm test" } },
      decisionDigest: "digest:global",
    }));
    expect(store.unacceptedApprovals(BUCKET)).toEqual([]);
    expect(store.unacceptedApprovals(GLOBAL_PERMISSION_BUCKET)).toHaveLength(1);
    await effects.discard("request-1");
    expect(store.unacceptedApprovals(GLOBAL_PERMISSION_BUCKET)).toEqual([]);
    expect(store.global()).toEqual([]);
  });
});

describe("撤销终结优先于物化", () => {
  it("撤销已提交而删除失败→重开：旧规则不生效，同 id 重放与重新接纳都被拒", async () => {
    const rootDir = await createTempDir("explicit-approval-revoke");
    const store = new DurablePermissionRuleStore(rootDir);
    const effects = new ExplicitApprovalEffects(store);
    await effects.prepare(approval("request-1"));
    await effects.accept("request-1");
    const ruleId = explicitApprovalRuleId(BUCKET, "request-1");
    const unblock = blockBucketFile(rootDir, BUCKET);
    // 终结写入成功、范围文件删除失败：照常返回已撤销
    await expect(store.revoke(ruleId)).resolves.toBe(true);
    expect(store.context(BUCKET)).toEqual([]);
    unblock();
    // 恢复的范围文件仍带旧规则（删除没落地）
    expect(JSON.parse(fs.readFileSync(path.join(rootDir, `${BUCKET}.json`), "utf8")).rules).toHaveLength(1);

    const reopened = new DurablePermissionRuleStore(rootDir);
    expect(reopened.context(BUCKET)).toEqual([]);
    const replay = PermissionStore.createRule({
      pattern: { tool: "bash", argument: "npm test" },
      decision: "allow",
      scope: "context",
      contextId: SCOPE,
    });
    await expect(reopened.publish(BUCKET, { ...replay, id: ruleId })).resolves.toBe("revoked");
    const reopenedEffects = new ExplicitApprovalEffects(reopened);
    await expect(reopenedEffects.prepare(approval("request-1"))).rejects.toThrow(/revoked/u);
    expect(reopened.context(BUCKET)).toEqual([]);
  });

  it("已接纳尚未物化的批准被撤销后，重开核对再接纳也不生效", async () => {
    const rootDir = await createTempDir("explicit-approval-revoke-pending");
    const store = new DurablePermissionRuleStore(rootDir);
    const effects = new ExplicitApprovalEffects(store);
    await effects.prepare(approval("request-1"));
    const unblock = blockBucketFile(rootDir, BUCKET);
    await effects.accept("request-1");
    await expect(store.revoke(explicitApprovalRuleId(BUCKET, "request-1"))).resolves.toBe(true);
    unblock();

    const reopened = new DurablePermissionRuleStore(rootDir);
    const reopenedEffects = new ExplicitApprovalEffects(reopened);
    await reopenedEffects.reconcile(BUCKET, async () => "accepted");
    expect(reopened.context(BUCKET)).toEqual([]);
  });

  it("同 id 同内容幂等，同 id 异内容拒绝", async () => {
    const store = new DurablePermissionRuleStore(await createTempDir("explicit-approval-idempotent"));
    const rule = PermissionStore.createRule({
      pattern: { tool: "bash", argument: "npm test" },
      decision: "allow",
      scope: "global",
    });
    await expect(store.publish(GLOBAL_PERMISSION_BUCKET, rule)).resolves.toBe("published");
    await expect(store.publish(GLOBAL_PERMISSION_BUCKET, { ...rule, createdAt: rule.createdAt + 1 })).resolves.toBe("exists");
    await expect(store.publish(GLOBAL_PERMISSION_BUCKET, { ...rule, pattern: { tool: "bash", argument: "rm *" } }))
      .rejects.toThrow(/different content/u);
    expect(store.global()).toHaveLength(1);
  });

  it("全局批准落在全局桶，对任何范围生效", async () => {
    const store = new DurablePermissionRuleStore(await createTempDir("explicit-approval-global"));
    const effects = new ExplicitApprovalEffects(store);
    const input = approval("request-g", {
      decision: { kind: "allow-global", pattern: { pattern: { tool: "bash", argument: "git status" }, label: "git status" } },
    });
    expect(explicitApprovalBucket(input.contextId, input.decision.kind)).toBe(GLOBAL_PERMISSION_BUCKET);
    await effects.prepare(input);
    await effects.accept("request-g");
    const permissions = new PermissionStore({ durable: store });
    expect(permissions.list({ kind: "main" }).map((rule) => rule.scope)).toEqual(["global"]);
  });
});
