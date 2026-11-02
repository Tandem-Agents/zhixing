/**
 * 显式持久批准（始终允许：本范围 / 全局）的效果：在决定生命周期上分三态落地。
 *
 * 1. 赢得仲裁、尚无耐久决定：`prepare` 写待生效记录（不生效）。写失败上抛，调用方让
 *    决定回到待确认，用户可重试或改为仅本次。
 * 2. 耐久决定已提交：`accept` 接纳并立即生效，物化失败不上抛（决定已固定），由同一
 *    范围文件的下一次写入补做。
 * 3. 已物化：规则在范围文件里，待生效记录随同一次原子写删除。
 *
 * 规则 id 由（范围桶、请求 id）确定派生，同一请求的重放得到同一规则；撤销终结后不再
 * 写回。重开时待生效记录先不生效，宿主按耐久决定摘要核对后才接纳（`reconcile`）。
 */

import { createHash } from "node:crypto";
import type { SuggestedPattern } from "../confirmation/types.js";
import {
  GLOBAL_PERMISSION_BUCKET,
  type DurablePermissionRuleStore,
  type PendingPermissionApproval,
} from "./durable-permission-rules.js";
import { toStorageKey } from "./permission-store.js";
import type { PermissionContextId, PermissionRule } from "./types.js";

export interface ExplicitApprovalDecision {
  readonly kind: "allow-context" | "allow-global";
  readonly pattern: SuggestedPattern;
}

export interface ExplicitApprovalInput {
  readonly requestId: string;
  readonly conversationId?: string;
  readonly assignmentId?: string;
  /** 本次运行的授权范围（确认请求所带，来自运行时绑定）。 */
  readonly contextId: PermissionContextId;
  readonly decision: ExplicitApprovalDecision;
  /** 与执行端耐久交互结果同一算法的决定摘要。 */
  readonly decisionDigest: string;
}

export type ExplicitApprovalState =
  | { readonly kind: "effective"; readonly rule: PermissionRule; readonly materialized: boolean }
  | { readonly kind: "revoked" };

/** 重开核对：按耐久决定判断一条待生效记录。 */
export type ExplicitApprovalVerdict = "accepted" | "rejected" | "unknown";

const MAX_TRACKED_REQUESTS = 512;

export class ExplicitApprovalEffects {
  readonly #store: DurablePermissionRuleStore;
  readonly #now: () => number;
  /** 请求 id → 所在桶（跨范围清理旧决定用）与最近状态。只保留最近的有限条。 */
  readonly #requests = new Map<string, { bucket: string; state?: ExplicitApprovalState }>();

  constructor(store: DurablePermissionRuleStore, options: { readonly now?: () => number } = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => Date.now());
  }

  /** 状态一：写待生效记录。同一请求先前在别的桶里的未接纳记录一并清掉。 */
  async prepare(input: ExplicitApprovalInput): Promise<void> {
    const bucket = explicitApprovalBucket(input.contextId, input.decision.kind);
    const previous = this.#requests.get(input.requestId);
    if (previous && previous.bucket !== bucket) {
      await this.#store.discardPending(previous.bucket, input.requestId);
    }
    const rule = explicitApprovalRule(bucket, input, this.#now());
    const entry: PendingPermissionApproval = {
      requestId: input.requestId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
      decisionDigest: input.decisionDigest,
      rule,
    };
    await this.#store.preparePending(bucket, entry);
    this.#track(input.requestId, { bucket });
  }

  /** 状态二→三：耐久决定已提交后接纳。不上抛。 */
  async accept(requestId: string): Promise<ExplicitApprovalState | undefined> {
    const tracked = this.#requests.get(requestId);
    if (!tracked) return undefined;
    const pending = this.#store.unacceptedApprovals(tracked.bucket)
      .find((entry) => entry.requestId === requestId);
    let outcome: Awaited<ReturnType<DurablePermissionRuleStore["acceptPending"]>>;
    try {
      outcome = await this.#store.acceptPending(tracked.bucket, requestId);
    } catch {
      outcome = "missing";
    }
    const state = outcome === "revoked"
      ? { kind: "revoked" as const }
      : outcome === "missing" || !pending
        ? this.#effectiveState(tracked.bucket, requestId)
        : { kind: "effective" as const, rule: pending.rule, materialized: outcome === "materialized" };
    if (state) this.#track(requestId, { bucket: tracked.bucket, state });
    return state;
  }

  /** 决定改为别的、取消或过期：清掉该请求未接纳的待生效记录。失败不影响决定本身。 */
  async discard(requestId: string): Promise<void> {
    const tracked = this.#requests.get(requestId);
    if (!tracked || tracked.state) return;
    await this.#store.discardPending(tracked.bucket, requestId).catch(() => undefined);
    this.#requests.delete(requestId);
  }

  /** 运行时批准端口读取本请求的结果。 */
  state(requestId: string): ExplicitApprovalState | undefined {
    return this.#requests.get(requestId)?.state;
  }

  /**
   * 没有耐久决定生命周期的运行（决定即时生效）：确认解析本身就是接纳，直接发布
   * 同一确定 id 的规则。写失败上抛。
   */
  async publishDirect(input: Omit<ExplicitApprovalInput, "decisionDigest">): Promise<ExplicitApprovalState> {
    const bucket = explicitApprovalBucket(input.contextId, input.decision.kind);
    const rule = explicitApprovalRule(bucket, input, this.#now());
    const outcome = await this.#store.publish(bucket, rule);
    const state: ExplicitApprovalState = outcome === "revoked"
      ? { kind: "revoked" }
      : { kind: "effective", rule: this.#store.context(bucket).find((entry) => entry.id === rule.id) ?? rule, materialized: true };
    this.#track(input.requestId, { bucket, state });
    return state;
  }

  /**
   * 重开后核对某桶里尚未接纳的待生效记录：耐久决定一致才接纳；决定不同、取消或
   * 过期则删除；暂时查不到的保留（不生效），等下次加载或该请求的决定再处理。
   */
  async reconcile(
    bucket: string,
    verify: (entry: PendingPermissionApproval) => Promise<ExplicitApprovalVerdict>,
  ): Promise<void> {
    for (const entry of this.#store.unacceptedApprovals(bucket)) {
      let verdict: ExplicitApprovalVerdict;
      try {
        verdict = await verify(entry);
      } catch {
        verdict = "unknown";
      }
      if (verdict === "accepted") {
        this.#track(entry.requestId, { bucket });
        await this.accept(entry.requestId);
      } else if (verdict === "rejected") {
        await this.#store.discardPending(bucket, entry.requestId).catch(() => undefined);
      }
    }
  }

  #effectiveState(bucket: string, requestId: string): ExplicitApprovalState | undefined {
    const ruleId = explicitApprovalRuleId(bucket, requestId);
    if (this.#store.isRevoked(ruleId)) return { kind: "revoked" };
    const rule = (bucket === GLOBAL_PERMISSION_BUCKET ? this.#store.global() : this.#store.context(bucket))
      .find((entry) => entry.id === ruleId);
    return rule ? { kind: "effective", rule, materialized: true } : undefined;
  }

  #track(requestId: string, value: { bucket: string; state?: ExplicitApprovalState }): void {
    this.#requests.delete(requestId);
    this.#requests.set(requestId, value);
    if (this.#requests.size > MAX_TRACKED_REQUESTS) {
      this.#requests.delete(this.#requests.keys().next().value!);
    }
  }
}

export function explicitApprovalBucket(
  contextId: PermissionContextId,
  kind: ExplicitApprovalDecision["kind"],
): string {
  return kind === "allow-global" ? GLOBAL_PERMISSION_BUCKET : toStorageKey(contextId);
}

/** 沉淀规则的确定身份：同一范围桶里、同一指派的同一条沉淀只对应一条规则。 */
export function trustSedimentRuleId(bucket: string, assignmentId: string, sedimentId: string): string {
  return `sediment-${createHash("sha256").update(`${bucket}\u0000${assignmentId}\u0000${sedimentId}`).digest("hex").slice(0, 32)}`;
}

/** 显式批准规则的确定身份：同一范围桶里的同一请求只对应一条规则。 */
export function explicitApprovalRuleId(bucket: string, requestId: string): string {
  return `explicit-${createHash("sha256").update(`${bucket}\u0000${requestId}`).digest("hex").slice(0, 32)}`;
}

function explicitApprovalRule(
  bucket: string,
  input: Omit<ExplicitApprovalInput, "decisionDigest">,
  now: number,
): PermissionRule {
  const contextBound = input.decision.kind === "allow-context";
  return {
    id: explicitApprovalRuleId(bucket, input.requestId),
    pattern: { tool: input.decision.pattern.pattern.tool, argument: input.decision.pattern.pattern.argument },
    decision: "allow",
    scope: contextBound ? "context" : "global",
    createdAt: now,
    lastMatchedAt: 0,
    matchCount: 0,
    ...(contextBound ? { contextId: { ...input.contextId } } : {}),
    contributors: [{ origin: "user", timestamp: now }],
  };
}
