import type { ExtensionInstance, ExtensionOperation } from "@zhixing-ai/core/extensions/contracts";
import type {
  ExtensionContinuationDeliverResult,
  ExtensionContinuationPlan,
} from "@zhixing-ai/core/extensions/onboarding";
import type { ConversationManager } from "@zhixing-ai/owner-kernel/conversation-manager";
import { DurableConversationAdmissionRejectedError } from "@zhixing-ai/owner-kernel/run-turn";
import { isLocalConversationId } from "@zhixing-ai/core/conversation";
import { userTurnInputFromText, type TurnOrigin } from "@zhixing-ai/core";
import type { ConversationCommunicationTransport } from "./conversation-tools.js";
import type { ConversationStatusNotice } from "@zhixing-ai/core/contracts";
import type { ExtensionManagementTransport } from "./extension-tools.js";
import type { LocalConversationOwnerPort } from "./local-conversation-owner.js";

const ACTIVE_RUN_STATES = new Set([
  "queued",
  "dispatched",
  "running",
  "cancel-requested",
  "uncertain",
]);

function stripStaleMessageIdentity(
  origin: TurnOrigin | undefined,
): Omit<TurnOrigin, "messageIdentity"> | undefined {
  if (!origin) return undefined;
  const { messageIdentity: _stale, ...rest } = origin;
  return rest;
}

export function createExtensionStatusObserver(management: ExtensionManagementTransport) {
  return (notice: ConversationStatusNotice): void => {
    if (["committed", "failed", "cancelled", "expired"].includes(notice.state)) {
      void management.invoke({ action: "status" }).catch(() => undefined);
    }
  };
}

export function createExtensionNotificationHandle() {
  let target: ReturnType<typeof createExtensionContinuation> | undefined;
  return {
    notify: (operation: ExtensionOperation) => {
      if (!target) throw new Error("扩展结果入口尚未就绪");
      return target.notify(operation);
    },
    planContinuation: (operation: ExtensionOperation) =>
      target ? target.planContinuation(operation) : Promise.resolve(undefined),
    deliverContinuation: (
      operation: ExtensionOperation,
      binding: { readonly targetConversationId: string; readonly turnId: string },
    ): Promise<ExtensionContinuationDeliverResult> => {
      if (!target) throw new Error("扩展结果入口尚未就绪");
      return target.deliverContinuation(operation, binding);
    },
    preparationClosed: (operation: ExtensionOperation) =>
      target?.preparationClosed(operation) ?? Promise.resolve(false),
    repairSource: (instance: ExtensionInstance) =>
      target?.repairSource(instance) ?? Promise.resolve(undefined),
    bind(value: ReturnType<typeof createExtensionContinuation>) {
      if (target) throw new Error("扩展结果入口不能重复绑定");
      target = value;
    },
  };
}

export function extensionContinuationText(operation: ExtensionOperation, deviceId: string): string {
  const fact = JSON.stringify({
    operationId: operation.id,
    instanceId: operation.instanceId,
    revision: operation.revision,
    phase: operation.phase,
    targetDeviceId: deviceId,
    ...(operation.reason ? { reason: operation.reason } : {}),
  });
  if (operation.phase === "preparing") {
    return `扩展${operation.purpose === "repair" ? "修复" : operation.purpose === "update" ? "更新" : "接入"}已耐久接纳：${fact}\n原请求：${operation.source?.request ?? "准备连接"}\n请加载“外部能力接入”技能并调用 extension(action: "guide") 获取开发契约与当前可用工具说明；${operation.previous || operation.candidate ? "用 extension_source 取得已有源码和构建资料，结合 status 的脱敏故障证据诊断；" : ""}查证来源后准备独立候选，再用 extension_connect 提交。不要再创建请求。${operation.purpose === "repair" ? "只恢复原能力，不换账号、扩权、增功能或清历史；本轮不能完成则说明受阻，不循环创建修复。" : ""}`;
  }
  if (operation.phase === "configuration") {
    return `扩展候选已准备：${fact}\n请告知用户在设备 ${deviceId} 打开 /config 的消息通道，填写 ${operation.instanceId} 的必要凭据、启用并保存，再按面板指令验证。不要在对话中索要凭据；等待期间结束本轮，不轮询。`;
  }
  if (operation.phase === "verifying") {
    return `扩展连接等待收发确认：${fact}\n${operation.previous ? "请在原 APP 回复验证消息；未收到时，" : "请"}在目标设备 /config 消息通道查看验证指令。可从其他知行入口查询或取消当前验证，原任务和历史保留。结束本轮，不轮询。`;
  }
  return `扩展操作结果：${fact}\n原请求：${operation.source?.request ?? "本机配置变更后的连接验证"}\n请如实告知结果。ready 表示本人、双向收发和文本确认已验证；其他状态不能宣告完成。换版受阻不代表原连接失效，以实例状态为准。受阻时说明原因和下一步；查证存在可行替代方式时说明条件并供用户选择，不擅自切换。`;
}

export type ExtensionContinuationLocalOwnerPort = Pick<
  LocalConversationOwnerPort,
  "listConversations" | "createAgentTurnExecution" | "agentTurnAdmission" | "findDurableRunByIngress"
>;

/** Dedicated system continuation port: binds (phase, revision, targetConversationId, turnId) before delivery. */
export function createExtensionContinuation(input: {
  manager: ConversationManager;
  communication?: ConversationCommunicationTransport;
  localOwner?: ExtensionContinuationLocalOwnerPort;
  deviceId: string;
  fallbackConversation?: () => Promise<string | undefined>;
  isReturnAddressReachable?: (origin: TurnOrigin) => Promise<boolean>;
}) {
  const resolveOriginContext = async (operation: ExtensionOperation) => {
    const sourceConversation = operation.source?.conversationId;
    const origin = operation.source?.returnAddress as TurnOrigin | undefined;
    const affectedOrigin = origin?.target?.channelId === operation.instanceId;
    const originReachable = origin ? ((await input.isReturnAddressReachable?.(origin)) ?? true) : true;
    const requiresRepairHandoff = operation.purpose === "repair" && affectedOrigin && !originReachable;
    return { sourceConversation, origin, affectedOrigin, requiresRepairHandoff };
  };

  const deliverToTarget = async (
    targetConversationId: string,
    turnId: string,
    text: string,
    turnOrigin: TurnOrigin,
    emissionTarget?: TurnOrigin["target"],
  ): Promise<
    | { readonly status: "accepted"; readonly continuation: unknown }
    | { readonly status: "terminal-rejected" }
    | { readonly status: "pending-reconcile" }
  > => {
    if (isLocalConversationId(targetConversationId)) {
      const localOwner = input.localOwner;
      if (!localOwner) return { status: "terminal-rejected" };
      const executionHandle = localOwner.createAgentTurnExecution({
        input: userTurnInputFromText(text),
        turnOrigin,
        surfacePrincipal: `conversation:${targetConversationId}`,
        notify: () => {},
      });
      try {
        const admitted = await localOwner.agentTurnAdmission.admit({
          identity: {
            kind: "existing",
            conversationId: targetConversationId,
            exists: async () => (await localOwner.listConversations()).includes(targetConversationId),
          },
          invocation: { kind: "agent" },
          caller: {
            kind: "surface",
            surfacePrincipal: `conversation:${targetConversationId}`,
            connectionId: `extension-continuation:${turnId}`,
          },
          observe: false,
          turnId,
          turnOrigin,
          input: userTurnInputFromText(text),
          execution: executionHandle.execution,
        });
        if (
          admitted.status === "immediate" ||
          admitted.status === "queued" ||
          admitted.status === "replayed"
        ) {
          return {
            status: "accepted",
            continuation: { kind: "turn", turnId, conversationId: targetConversationId },
          };
        }
        return { status: "terminal-rejected" };
      } catch (error) {
        if (error instanceof DurableConversationAdmissionRejectedError) {
          return { status: "terminal-rejected" };
        }
        const existing = await localOwner
          .findDurableRunByIngress?.(targetConversationId, turnId, "interactive")
          .catch(() => undefined);
        if (existing) {
          return {
            status: "accepted",
            continuation: { kind: "turn", turnId, conversationId: targetConversationId },
          };
        }
        return { status: "pending-reconcile" };
      }
    }

    const principal = `conversation:${targetConversationId}`;
    try {
      const accepted = await input.manager.admitDurableTurn({
        conversationId: targetConversationId,
        input: text,
        invocation: { kind: "agent", source: "interactive" },
        surfacePrincipal: principal,
        options: {
          source: "interactive",
          surfacePrincipal: principal,
          turnContext: {
            turnId,
            turnOrigin,
            ...(emissionTarget ? { emissionTarget } : {}),
          },
        },
      });
      if (accepted.shouldEnqueue) accepted.onDeferred?.();
      return {
        status: "accepted",
        continuation: { kind: "turn", turnId, conversationId: targetConversationId },
      };
    } catch (error) {
      if (error instanceof DurableConversationAdmissionRejectedError) {
        return { status: "terminal-rejected" };
      }
      const existing = await input.manager
        .findDurableRunByIngress?.(targetConversationId, turnId, "interactive")
        .catch(() => undefined);
      if (existing) {
        return {
          status: "accepted",
          continuation: { kind: "turn", turnId, conversationId: targetConversationId },
        };
      }
      return { status: "pending-reconcile" };
    }
  };

  const planContinuation = async (
    operation: ExtensionOperation,
  ): Promise<ExtensionContinuationPlan | undefined> => {
    const turnId = `extension:${operation.id}:${operation.revision}`;
    const { sourceConversation, requiresRepairHandoff } = await resolveOriginContext(operation);
    if (requiresRepairHandoff || !sourceConversation) {
      const alternate = await input.fallbackConversation?.();
      if (!alternate || alternate === sourceConversation) return undefined;
      return { targetConversationId: alternate, turnId };
    }
    return { targetConversationId: sourceConversation, turnId };
  };

  const deliverContinuation = async (
    operation: ExtensionOperation,
    binding: { readonly targetConversationId: string; readonly turnId: string },
  ): Promise<ExtensionContinuationDeliverResult> => {
    const text = extensionContinuationText(operation, input.deviceId);
    const { sourceConversation, origin, affectedOrigin, requiresRepairHandoff } =
      await resolveOriginContext(operation);
    const isOriginalTarget =
      Boolean(sourceConversation) &&
      binding.targetConversationId === sourceConversation &&
      !requiresRepairHandoff;
    const identity = {
      id: binding.turnId,
      source: { kind: "system" as const, subsystem: "extension-continuation" as const },
    };
    const cleanOrigin = stripStaleMessageIdentity(origin);
    const turnOrigin: TurnOrigin =
      isOriginalTarget && cleanOrigin
        ? { ...cleanOrigin, messageIdentity: identity }
        : { channel: "system", messageIdentity: identity };
    const emissionTarget = isOriginalTarget ? origin?.target : undefined;

    const result = await deliverToTarget(
      binding.targetConversationId,
      binding.turnId,
      text,
      turnOrigin,
      emissionTarget,
    );
    if (result.status === "accepted") {
      if (affectedOrigin && isOriginalTarget && operation.phase !== "preparing") {
        const alternate = await input.fallbackConversation?.();
        if (alternate && alternate !== sourceConversation) {
          const noticeId = `${binding.turnId}:notice`;
          await deliverToTarget(alternate, noticeId, text, {
            channel: "system",
            messageIdentity: {
              id: noticeId,
              source: { kind: "system", subsystem: "extension-continuation" },
            },
          });
        }
      }
      return { outcome: "accepted", continuation: result.continuation };
    }
    if (result.status === "pending-reconcile") {
      return { outcome: "pending-reconcile" };
    }
    const alternate = await input.fallbackConversation?.();
    const fallbackTarget =
      alternate && alternate !== binding.targetConversationId && alternate !== sourceConversation
        ? { targetConversationId: alternate, turnId: binding.turnId }
        : undefined;
    return {
      outcome: "terminal-rejected",
      ...(fallbackTarget ? { fallbackTarget } : {}),
    };
  };

  return {
    planContinuation,
    deliverContinuation,
    notify: async (operation: ExtensionOperation): Promise<unknown> => {
      const plan = await planContinuation(operation);
      if (!plan) {
        throw new Error("原连接不可达，尚无可用的结果入口");
      }
      const first = await deliverContinuation(operation, plan);
      if (first.outcome === "accepted") return first.continuation;
      if (first.outcome === "terminal-rejected" && first.fallbackTarget) {
        const fallback = await deliverContinuation(operation, first.fallbackTarget);
        if (fallback.outcome === "accepted") return fallback.continuation;
      }
      throw new Error("扩展续接投递尚未完成，等待重试确认");
    },
    repairSource: async (_instance: ExtensionInstance): Promise<ExtensionOperation["source"] | undefined> => {
      const conversationId = await input.fallbackConversation?.();
      return conversationId ? { conversationId, request: "恢复已有连接" } : undefined;
    },
    preparationClosed: async (operation: ExtensionOperation): Promise<boolean> => {
      const continuation = operation.continuation as
        | {
            kind?: string;
            turnId?: string;
            conversationId?: string;
            targetConversationId?: string;
            receipt?: { messageId: string };
          }
        | undefined;
      const conversationId =
        continuation?.conversationId ??
        continuation?.targetConversationId ??
        operation.boundContinuation?.targetConversationId ??
        operation.source?.conversationId;
      if (!conversationId) return false;
      if (continuation?.kind === "message" && continuation.receipt?.messageId && input.communication) {
        const status = (await input.communication.invoke(conversationId, {
          action: "observe",
          conversationId,
          messageId: continuation.receipt.messageId,
        })) as { state?: string } | null;
        return Boolean(status?.state && !ACTIVE_RUN_STATES.has(status.state));
      }
      const turnId = continuation?.turnId ?? operation.boundContinuation?.turnId;
      if (!turnId) return false;
      const run = isLocalConversationId(conversationId)
        ? await input.localOwner?.findDurableRunByIngress?.(conversationId, turnId, "interactive")
        : await input.manager.findDurableRunByIngress(conversationId, turnId, "interactive");
      return Boolean(run && !ACTIVE_RUN_STATES.has(run.state));
    },
  };
}
