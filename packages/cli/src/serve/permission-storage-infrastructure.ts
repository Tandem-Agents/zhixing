import { createHash } from "node:crypto";
import path from "node:path";
import type { TrustSedimentFact, TrustSedimentMirrorEntry } from "@zhixing/core/contracts";
import { parseConversationId } from "@zhixing/core/conversation";
import { canonicalize } from "@zhixing/core/protocol";
import {
  bindPermissionRuleExecutionSource,
  createPermissionStoreTrustAdministrationRepository,
  DurablePermissionRuleStore,
  ExplicitApprovalEffects,
  explicitApprovalBucket,
  PermissionStore,
  toPermissionContext,
  trustSedimentRuleId,
  type ExplicitApprovalVerdict,
  type PendingPermissionApproval,
  type PermissionContextId,
  type PermissionRule,
} from "@zhixing/core/security";
import type {
  ExecutionTrustScopeInput,
  TrustAdministrationExecutionApplication,
  TrustAdministrationExecutionRepository,
  TrustAdministrationRepository,
  TrustAdministrationRepositoryRule,
  TrustSedimentSubmission,
} from "@zhixing/core/trust-administration";
import {
  jobRunTrustScopeInput,
  resolveExecutionTrustScope,
  TrustAdministrationExecutionApplicationService,
  trustSedimentIsConsistent,
} from "@zhixing/core/trust-administration";
import type { ConversationTrustSedimentPort } from "@zhixing/owner-kernel/conversation-assignment";
import type { JobTrustSedimentPort } from "@zhixing/owner-kernel/job-assignment";
import type {
  KernelSecurityApprovalResult,
  KernelSecurityExecution,
  KernelSecurityExecutionFactory,
} from "@zhixing/orchestrator/runtime";

export interface RuntimeSecurityExecutionBindOptions {
  /**
   * 本运行的答复路径是否支持显式持久批准。job 的确认只有仅本次/拒绝，传 false；
   * 不传时取宿主能力（锚点宿主支持，执行端角色宿主不支持）。
   */
  readonly persistentApprovals?: boolean;
}

export interface RuntimeSecurityExecutionInfrastructure {
  /** 按本次运行的已认证范围事实绑定；范围只经 resolveExecutionTrustScope 推导。 */
  bind(
    scope: ExecutionTrustScopeInput,
    options?: RuntimeSecurityExecutionBindOptions,
  ): KernelSecurityExecutionFactory;
}

/** 重开后核对显式批准的待生效记录：按耐久决定判断是否已接纳。 */
export type ExplicitApprovalVerifier = (
  entry: PendingPermissionApproval,
) => Promise<ExplicitApprovalVerdict>;

export interface PermissionStorageInfrastructure {
  /** 管理面；与各运行时共享同一个持久规则所有者，撤销后各运行时立即可见。 */
  readonly management: TrustAdministrationRepository;
  /** Product-context binder for runtime-scoped Security execution. */
  readonly runtime: RuntimeSecurityExecutionInfrastructure;
  /** 显式持久批准的效果所有者；只在规则权威所在的锚点宿主存在。 */
  readonly explicitApprovals?: ExplicitApprovalEffects;
  /** 宿主装配好耐久决定的查询后注入；此前加载到的待生效记录在注入时核对。 */
  bindExplicitApprovalVerifier(verify: ExplicitApprovalVerifier): void;
  /**
   * 执行端运行时的沉淀经这些来源记入当前耐久指派（对话或 job）的台账，随镜像回到 owner；
   * 不在任何来源的指派绑定里时返回 undefined。
   */
  addTrustSedimentRecorder(recorder: TrustSedimentRecorder): void;
  /** owner 接纳对话镜像里的沉淀；只在规则权威所在的锚点宿主存在。 */
  readonly trustSediments?: ConversationTrustSedimentPort;
  /** owner 接纳 job 镜像里的沉淀；只在规则权威所在的锚点宿主存在。 */
  readonly jobTrustSediments?: JobTrustSedimentPort;
  /**
   * 没有 owner 侧运行时的派发（job）冻结快照：与运行时派发同一组合（PermissionStore.snapshot）
   * ——会话池（这里不存在运行时，即空）＋该范围持久（工作区按修订过滤）＋全局＋本次工具集合
   * 贡献的内置规则；冲突在执行端冻结匹配里按共同规则裁决（用户规则先于内置）。
   */
  executionRulesFor(
    scope: ExecutionTrustScopeInput,
    builtinRuleSets?: readonly { readonly namespace: string; readonly rules: readonly PermissionRule[] }[],
  ): readonly PermissionRule[];
}

export type TrustSedimentRecorder = (sediment: TrustSedimentFact) => Promise<
  { readonly assignmentId: string; readonly requestId: string; readonly mirrored: boolean } | undefined
>;

/** 沉淀待生效记录在桶里的请求身份（与显式批准的确认请求 id 不冲突）。 */
export function trustSedimentPendingId(assignmentId: string, sedimentId: string): string {
  return `${assignmentId}/${sedimentId}`;
}

/**
 * The single Host infrastructure owner for the P04 permission file mechanism.
 *
 * 持久规则只有一个所有者（本基础设施内的 DurablePermissionRuleStore），全部运行时与
 * 管理面的 PermissionStore 共享它；会话规则仍随各自 AgentRuntime 的 PermissionStore
 * 实例存亡。显式持久批准只在锚点宿主（规则权威）提供；执行端角色宿主的运行不出现
 * "始终允许"，端口收到也拒绝。
 */
export function createPermissionStorageInfrastructure(input: Readonly<{
  zhixingHome: string;
  /** 本宿主是否是持久规则的权威（锚点宿主）。 */
  persistentApprovals?: boolean;
}>): PermissionStorageInfrastructure {
  const hostPersistentApprovals = input.persistentApprovals === true;
  let verifier: ExplicitApprovalVerifier | undefined;
  const awaitingVerification = new Set<string>();
  let effects: ExplicitApprovalEffects | undefined;
  const reconcile = (bucket: string) => {
    if (!effects) return;
    if (!verifier) {
      awaitingVerification.add(bucket);
      return;
    }
    void effects.reconcile(bucket, verifier).catch(() => undefined);
  };
  const durable = new DurablePermissionRuleStore(
    path.join(input.zhixingHome, "permissions"),
    // 加载在同步读取里发生：核对排到之后异步进行，待生效记录在核对前不生效
    { onPendingLoaded: (bucket) => queueMicrotask(() => reconcile(bucket)) },
  );
  effects = hostPersistentApprovals ? new ExplicitApprovalEffects(durable) : undefined;
  const management: TrustAdministrationRepository = Object.freeze({
    ...createPermissionStoreTrustAdministrationRepository(() => new PermissionStore({ durable })),
    // 管理面按页列范围：按存储键排序取页，只加载该页的范围文件
    async listScopes(input: { readonly after?: string; readonly limit: number }) {
      const keys = (await durable.bucketKeys()).filter((key) => input.after === undefined || key > input.after);
      const scopes: { cursor: string; context: TrustAdministrationRepositoryRule["contextId"] & object; rules: TrustAdministrationRepositoryRule[] }[] = [];
      let examined = 0;
      for (const key of keys) {
        examined += 1;
        const rules = durable.context(key);
        const contextId = rules.find((rule) => rule.contextId)?.contextId;
        if (contextId) {
          scopes.push({
            cursor: key,
            // 分组按范围身份（工作区不带修订：一个绑定的全部修订在同一组）
            context: contextId.kind === "workspace" ? { kind: "workspace", hash: contextId.hash } : { ...contextId },
            rules: rules.map(toRepositoryRule),
          });
        }
        if (scopes.length >= input.limit) break;
      }
      const next = examined < keys.length ? keys[examined - 1] : undefined;
      return { scopes, ...(next ? { next } : {}) };
    },
  });
  // 每个来源只在自己的耐久指派绑定里返回结果（对话、job 互斥），按序取第一个
  const recorders: TrustSedimentRecorder[] = [];
  const recorder: TrustSedimentRecorder = async (sediment) => {
    for (const source of recorders) {
      const recorded = await source(sediment);
      if (recorded) return recorded;
    }
    return undefined;
  };
  const trustSediments = hostPersistentApprovals ? createTrustSedimentAcceptance(durable) : undefined;
  const runtime: RuntimeSecurityExecutionInfrastructure = Object.freeze({
    bind(scopeInput: ExecutionTrustScopeInput, options: RuntimeSecurityExecutionBindOptions = {}) {
      const scope = resolveExecutionTrustScope(scopeInput);
      const persistentApprovals = hostPersistentApprovals && options.persistentApprovals !== false;
      return Object.freeze({
        create(request: Parameters<KernelSecurityExecutionFactory["create"]>[0]) {
          const store = new PermissionStore({
            durable,
            extractArgument: request.extractArgument,
          });
          for (const contribution of request.builtinRuleSets) {
            store.registerBuiltinRules(
              contribution.namespace,
              [...contribution.rules],
            );
          }
          const repository = createPermissionStoreTrustAdministrationRepository(
            () => store,
          );
          const contextId = toPermissionContext(scope);
          const bucket = explicitApprovalBucket(contextId, "allow-context");
          const application = new TrustAdministrationExecutionApplicationService({
            repository,
            context: scope,
            workspacePath: request.workspacePath,
            // 没有耐久对话回程的运行（定时任务、job）只在规则权威宿主上直接沉淀
            directSediments: hostPersistentApprovals,
            sediments: Object.freeze({
              async submit(sediment: TrustSedimentSubmission) {
                const recorded = await recorder(toTrustSedimentFact(sediment));
                if (!recorded) return Object.freeze({ kind: "unavailable" as const });
                if (!recorded.mirrored) return Object.freeze({ kind: "submitted" as const });
                // 镜像回执即 owner 已接纳；规则在本机所有者里时给出（远程执行端看不到，只报已提交）
                const ruleId = trustSedimentRuleId(bucket, recorded.assignmentId, recorded.requestId);
                const rule = durable.context(bucket).find((entry) => entry.id === ruleId);
                return rule
                  ? Object.freeze({ kind: "accepted" as const, rule: toRepositoryRule(rule) })
                  : Object.freeze({ kind: "submitted" as const });
              },
            }),
          });
          return createKernelSecurityExecution({
            application,
            store,
            repository,
            explicitApprovals: persistentApprovals ? effects : undefined,
            trustContext: scope.kind === "scene"
              ? Object.freeze({ kind: "scene" as const, sceneId: scope.sceneId })
              : request.workspacePath !== null
                ? Object.freeze({
                    kind: "workspace" as const,
                    dir: request.workspacePath,
                  })
                : Object.freeze({ kind: "global" as const }),
          });
        },
      });
    },
  });

  return Object.freeze({
    management,
    runtime,
    ...(effects ? { explicitApprovals: effects } : {}),
    ...(trustSediments
      ? { trustSediments: trustSediments.conversation, jobTrustSediments: trustSediments.job }
      : {}),
    bindExplicitApprovalVerifier(verify: ExplicitApprovalVerifier) {
      verifier = verify;
      const buckets = [...awaitingVerification];
      awaitingVerification.clear();
      for (const bucket of buckets) reconcile(bucket);
    },
    addTrustSedimentRecorder(source: TrustSedimentRecorder) {
      if (recorders.includes(source)) throw new Error("Trust sediment recorder is already added");
      recorders.push(source);
    },
    executionRulesFor(
      scope: ExecutionTrustScopeInput,
      builtinRuleSets: Parameters<PermissionStorageInfrastructure["executionRulesFor"]>[1] = [],
    ) {
      const contextId = toPermissionContext(resolveExecutionTrustScope(scope));
      const store = new PermissionStore({ durable });
      for (const contribution of builtinRuleSets) {
        store.registerBuiltinRules(contribution.namespace, [...contribution.rules]);
      }
      return Object.freeze(store.snapshot(contextId).map(freezeStoredRule));
    },
  });
}

/**
 * owner 接纳镜像里的沉淀：范围按该指派已认证清单推导（对话再加工作模式；不收执行端自报
 * 范围），只产生 context 规则，模式、阈值与用户贡献引用的交互都核对；校验不过的不写、
 * 不上抛。提交前写待生效，提交后接纳；撤销终结过的规则 id 不再写回。对话与 job 两个来源
 * 只差范围输入与重开核对时查哪本日志。
 */
function createTrustSedimentAcceptance(durable: DurablePermissionRuleStore): {
  readonly conversation: ConversationTrustSedimentPort;
  readonly job: JobTrustSedimentPort;
} {
  const prepared = new Map<string, string>();
  const prepare = async (input: {
    readonly scope: ExecutionTrustScopeInput;
    readonly origin: { readonly conversationId: string } | { readonly taskId: string };
    readonly assignmentId: string;
    readonly entry: TrustSedimentMirrorEntry;
    readonly answered: (requestId: string) => Promise<boolean>;
  }) => {
    const contextId = toPermissionContext(resolveExecutionTrustScope(input.scope));
    const bucket = explicitApprovalBucket(contextId, "allow-context");
    const sediment = input.entry.sediment;
    if (!trustSedimentIsConsistent(sediment)) return;
    for (const contributor of sediment.contributors) {
      if (contributor.origin !== "user") continue;
      if (!contributor.requestId || !(await input.answered(contributor.requestId))) return;
    }
    const now = Date.now();
    const rule: PermissionRule = {
      id: trustSedimentRuleId(bucket, input.assignmentId, input.entry.requestId),
      pattern: { tool: sediment.pattern.tool, argument: sediment.pattern.argument },
      decision: "allow",
      scope: "context",
      createdAt: now,
      lastMatchedAt: 0,
      matchCount: 0,
      contextId: { ...contextId },
      contributors: sediment.contributors.map((entry) => ({ origin: entry.origin, timestamp: entry.timestamp })),
    };
    if (durable.isRevoked(rule.id)) return;
    const pendingId = trustSedimentPendingId(input.assignmentId, input.entry.requestId);
    await durable.preparePending(bucket, {
      requestId: pendingId,
      ...input.origin,
      assignmentId: input.assignmentId,
      decisionDigest: `sha256:${createHash("sha256").update(canonicalize(sediment)).digest("hex")}`,
      rule,
    });
    prepared.set(pendingId, bucket);
  };
  const accept = async (assignmentId: string, entry: TrustSedimentMirrorEntry) => {
    const pendingId = trustSedimentPendingId(assignmentId, entry.requestId);
    const bucket = prepared.get(pendingId);
    // 重启后的重放没有本进程的准备记录：待生效记录由加载时的核对接纳
    if (!bucket) return;
    prepared.delete(pendingId);
    await durable.acceptPending(bucket, pendingId);
  };
  return Object.freeze({
    conversation: Object.freeze({
      async prepare(input: Parameters<ConversationTrustSedimentPort["prepare"]>[0]) {
        const { scope: conversationScope } = parseConversationId(input.conversationId);
        const workspace = input.environment.workspace;
        await prepare({
          scope: {
            ...(conversationScope.kind === "workscene" ? { sceneId: conversationScope.sceneId } : {}),
            ...(workspace ? { workspace } : {}),
          },
          origin: { conversationId: input.conversationId },
          assignmentId: input.assignmentId,
          entry: input.entry,
          answered: input.answered,
        });
      },
      async accept(input: Parameters<ConversationTrustSedimentPort["accept"]>[0]) {
        await accept(input.assignmentId, input.entry);
      },
    }),
    job: Object.freeze({
      async prepare(input: Parameters<JobTrustSedimentPort["prepare"]>[0]) {
        await prepare({
          scope: jobRunTrustScopeInput(input.environment),
          origin: { taskId: input.taskId },
          assignmentId: input.assignmentId,
          entry: input.entry,
          answered: input.answered,
        });
      },
      async accept(input: Parameters<JobTrustSedimentPort["accept"]>[0]) {
        await accept(input.assignmentId, input.entry);
      },
    }),
  });
}

function toTrustSedimentFact(sediment: TrustSedimentSubmission): TrustSedimentFact {
  return {
    pattern: { tool: sediment.pattern.tool, argument: sediment.pattern.argument },
    riskLevel: sediment.riskLevel,
    operation: { tool: sediment.operation.tool, arguments: structuredClone({ ...sediment.operation.arguments }) },
    contributors: sediment.contributors.map((entry) => ({
      origin: entry.origin,
      timestamp: entry.timestamp,
      ...(entry.requestId ? { requestId: entry.requestId } : {}),
    })),
  };
}

function toRepositoryRule(rule: PermissionRule): TrustAdministrationRepositoryRule {
  return {
    id: rule.id,
    pattern: { ...rule.pattern },
    decision: rule.decision,
    scope: rule.scope,
    createdAt: rule.createdAt,
    lastMatchedAt: rule.lastMatchedAt,
    matchCount: rule.matchCount,
    ...(rule.contextId ? { contextId: { ...rule.contextId } } : {}),
    ...(rule.contributors ? { contributors: rule.contributors.map((entry) => ({ ...entry })) } : {}),
  };
}

function createKernelSecurityExecution(input: {
  readonly application: TrustAdministrationExecutionApplication;
  readonly store: PermissionStore;
  readonly repository: TrustAdministrationExecutionRepository;
  readonly explicitApprovals: ExplicitApprovalEffects | undefined;
  readonly trustContext: KernelSecurityExecution["trustContext"];
}): KernelSecurityExecution {
  const { application, store, repository, explicitApprovals, trustContext } = input;
  const contextId = Object.freeze(toPermissionContext(application.context));
  const permissionRuleSource = bindPermissionRuleExecutionSource(store, contextId);
  return Object.freeze({
    contextId,
    trustContext,
    permissionRuleSource,
    persistentApprovals: explicitApprovals !== undefined,
    async recordApproval(
      approval: Parameters<KernelSecurityExecution["recordApproval"]>[0],
    ): Promise<KernelSecurityApprovalResult> {
      if (approval.kind === "allow-context" || approval.kind === "allow-global") {
        if (!explicitApprovals) {
          throw new Error("当前运行的答复路径不支持持久授权，未按始终允许处理");
        }
        // 有耐久决定生命周期的运行已在决定接纳时落地；没有的（决定即时生效）在这里直接发布
        const state = explicitApprovals.state(approval.requestId) ??
          await explicitApprovals.publishDirect({
            requestId: approval.requestId,
            contextId,
            decision: { kind: approval.kind, pattern: approval.pattern },
          });
        return state.kind === "effective"
          ? Object.freeze({ kind: "rule-created", rule: freezeStoredRule(state.rule) })
          : Object.freeze({ kind: "recorded" });
      }
      const outcome = await application.recordApproval(approval);
      if (outcome.kind === "recorded") return Object.freeze({ kind: "recorded" });
      return Object.freeze({
        kind: outcome.kind,
        rule: freezePermissionRule(outcome.rule),
      });
    },
    securitySnapshot() {
      const snapshot = application.securitySnapshot();
      return Object.freeze({
        contextId: Object.freeze(toPermissionContext(snapshot.context)),
        workspacePath: snapshot.workspacePath,
        permissionRules: Object.freeze(
          snapshot.userRules.map(freezePermissionRule),
        ),
        confirmations: Object.freeze(
          snapshot.observations.map((entry) => Object.freeze({ ...entry })),
        ),
      });
    },
    executionPermissionRules(scope?: PermissionContextId) {
      // owner 派发按该运行的范围组合（内置＋会话＋该范围持久＋全局）
      const rules = scope
        ? repository.snapshotExecutionRules(scope)
        : application.executionRules();
      return Object.freeze(rules.map(freezePermissionRule));
    },
  });
}

function freezeStoredRule(rule: PermissionRule): PermissionRule {
  const { contextId, contributors, ...base } = rule;
  return Object.freeze({
    ...base,
    pattern: Object.freeze({ ...rule.pattern }),
    ...(contextId ? { contextId: Object.freeze({ ...contextId }) } : {}),
    ...(contributors ? { contributors: contributors.map((entry) => ({ ...entry })) } : {}),
  });
}

function freezePermissionRule(
  rule: TrustAdministrationRepositoryRule,
): PermissionRule {
  const { contextId, contributors, ...base } = rule;
  return Object.freeze({
    ...base,
    pattern: Object.freeze({ ...rule.pattern }),
    ...(contextId
      ? { contextId: Object.freeze(toPermissionContext(contextId)) }
      : {}),
    ...(contributors
      ? {
          contributors: contributors.map((entry) => ({ ...entry })),
        }
      : {}),
  });
}
