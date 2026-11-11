import type { EnvironmentRequirement } from "@zhixing-ai/core/contracts";
import { parseConversationId } from "@zhixing-ai/core/conversation";
import type {
  ConversationSecurityPermissionRule,
  ConversationSecurityProjectionPort,
  ConversationSecurityResult,
} from "@zhixing-ai/core/conversation/application";
import type { TrustRuleSnapshot } from "@zhixing-ai/core/security";
import { resolveExecutionTrustScope } from "@zhixing-ai/core/trust-administration";
import type { ConversationManager } from "@zhixing-ai/owner-kernel/conversation-manager";

/** 对话当前正在执行的运行：指派的已验签清单环境与冻结权限快照摘要。 */
export type ActiveRunSecurityFacts = (conversationId: string) => Promise<
  | {
      readonly runId: string;
      readonly environment: EnvironmentRequirement;
      readonly permissionSnapshotDigest: string;
    }
  | undefined
>;

/**
 * Anchor Correctness adapter; Conversation owns query/error/result semantics.
 *
 * 有正在执行的运行时，按该运行指派的已验签清单推导实际授权范围（与派发同源），规则取
 * 它冻结的权限快照；否则标为对话默认概览。只读已登记的活跃指派，不追踪运行历史。
 */
export function createAnchorConversationSecurityProjectionPort(input: Readonly<{
  conversations: ConversationManager;
  exists(conversationId: string): Promise<boolean>;
  activeRun?: ActiveRunSecurityFacts;
  permissionSnapshotFor?: (digest: string) => Promise<TrustRuleSnapshot | undefined>;
}>): ConversationSecurityProjectionPort {
  return Object.freeze({
    inspectSecurityExisting: async (conversationId: string) => {
      const inspected = await input.conversations.inspectSecurityExisting(
        conversationId,
        () => input.exists(conversationId),
      );
      if (inspected.status !== "done") return inspected;
      const scope = await runScope(conversationId, input).catch(() => undefined);
      return {
        ...inspected,
        snapshot: { ...inspected.snapshot, scope: scope ?? { kind: "default" as const } },
      };
    },
  });
}

async function runScope(
  conversationId: string,
  input: Readonly<{
    activeRun?: ActiveRunSecurityFacts;
    permissionSnapshotFor?: (digest: string) => Promise<TrustRuleSnapshot | undefined>;
  }>,
): Promise<ConversationSecurityResult["scope"]> {
  const facts = await input.activeRun?.(conversationId);
  if (!facts) return undefined;
  const snapshot = await input.permissionSnapshotFor?.(facts.permissionSnapshotDigest);
  if (!snapshot) return undefined;
  const { scope: conversationScope } = parseConversationId(conversationId);
  const workspace = facts.environment.workspace;
  const context = resolveExecutionTrustScope({
    ...(conversationScope.kind === "workscene" ? { sceneId: conversationScope.sceneId } : {}),
    ...(workspace ? { workspace } : {}),
  });
  return {
    kind: "run",
    runId: facts.runId,
    contextId: context.kind === "workspace" ? { kind: "workspace", hash: context.hash } : context,
    permissionRules: snapshot.rules.map(toSecurityRule),
  };
}

function toSecurityRule(rule: TrustRuleSnapshot["rules"][number]): ConversationSecurityPermissionRule {
  const contextId = rule.contextId;
  return {
    id: rule.id,
    pattern: { tool: rule.pattern.tool, argument: rule.pattern.argument },
    decision: rule.decision,
    scope: rule.scope,
    createdAt: rule.createdAt,
    // 冻结快照只带规则本身，不带运行中的匹配计数
    lastMatchedAt: 0,
    matchCount: 0,
    ...(contextId
      ? { contextId: contextId.kind === "workspace" ? { kind: "workspace" as const, hash: contextId.hash } : contextId }
      : {}),
    ...(rule.contributors ? { contributors: rule.contributors.map((entry) => ({ ...entry })) } : {}),
  };
}
