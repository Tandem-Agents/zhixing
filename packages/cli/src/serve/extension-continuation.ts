import type { ExtensionInstance, ExtensionOperation } from "@zhixing/core/extensions/contracts";
import type { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { isLocalConversationId } from "@zhixing/core/conversation";
import type { TurnOrigin } from "@zhixing/core";
import type { ConversationCommunicationTransport } from "./conversation-tools.js";
import type { ConversationStatusNotice } from "@zhixing/core/contracts";
import type { ExtensionManagementTransport } from "./extension-tools.js";

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
    notify: (operation: ExtensionOperation) => { if (!target) throw new Error("扩展结果入口尚未就绪"); return target.notify(operation); },
    preparationClosed: (operation: ExtensionOperation) => target?.preparationClosed(operation) ?? Promise.resolve(false),
    repairSource: (instance: ExtensionInstance) => target?.repairSource(instance) ?? Promise.resolve(undefined),
    bind(value: ReturnType<typeof createExtensionContinuation>) { if (target) throw new Error("扩展结果入口不能重复绑定"); target = value; },
  };
}

export function extensionContinuationText(operation: ExtensionOperation, deviceId: string): string {
  const fact = JSON.stringify({ operationId: operation.id, instanceId: operation.instanceId, revision: operation.revision, phase: operation.phase,
    targetDeviceId: deviceId, ...(operation.reason ? { reason: operation.reason } : {}) });
  if (operation.phase === "preparing") return `扩展${operation.purpose === "repair" ? "修复" : operation.purpose === "update" ? "更新" : "接入"}已耐久接纳：${fact}\n原请求：${operation.source.request}\n加载“外部能力接入”技能，读取 extension guide 返回的安装包资料，${operation.previous ? "用 extension_source 取得原版本源码和构建资料，结合 status 的脱敏故障证据诊断；" : ""}查证来源后准备独立候选，再用 extension_connect 提交。不要再创建请求。${operation.purpose === "repair" ? "只恢复原能力，不换账号、扩权、增功能或清历史；本轮不能完成则说明受阻，不循环创建修复。" : ""}`;
  if (operation.phase === "configuration") return `扩展候选已准备：${fact}\n请告知用户在设备 ${deviceId} 打开 /config 的消息通道，填写 ${operation.instanceId} 的必要凭据、启用并保存，再按面板指令验证。不要在对话中索要凭据；等待期间结束本轮，不轮询。`;
  if (operation.phase === "verifying") return `扩展换版等待收发确认：${fact}\n请在原 APP 回复验证消息；未收到时，在目标设备 /config 消息通道查看验证指令。可从其他知行入口查询或取消换版，原任务和历史保留。结束本轮，不轮询。`;
  return `扩展操作结果：${fact}\n原请求：${operation.source.request}\n请如实告知结果。ready 表示本人、双向收发和文本确认已验证；其他状态不能宣告完成。换版受阻不代表原连接失效，以实例状态为准。`;
}

/** Existing Conversation admission owns execution, deduplication and result delivery. */
export function createExtensionContinuation(input: { manager: ConversationManager; communication: ConversationCommunicationTransport; deviceId: string;
  fallbackConversation?: () => Promise<string | undefined> }) {
  return { notify: async (operation: ExtensionOperation): Promise<unknown> => {
    const text = extensionContinuationText(operation, input.deviceId);
    const turnId = `extension:${operation.id}:${operation.revision}`;
    const origin = operation.source.returnAddress as TurnOrigin | undefined;
    const affectedOrigin = origin?.target?.channelId === operation.instanceId;
    const deliver = async (conversationId: string, id: string, original: boolean) => {
      if (isLocalConversationId(conversationId)) {
        const receipt = await input.communication.invoke(conversationId, { action: "send", conversationId, operationId: id, input: text });
        return { kind: "message", receipt, conversationId };
      }
      const principal = `conversation:${conversationId}`;
      const accepted = await input.manager.admitDurableTurn({ conversationId, input: text,
        invocation: { kind: "agent", source: "interactive" }, surfacePrincipal: principal,
        options: { source: "interactive", surfacePrincipal: principal, turnContext: { turnId: id,
          ...(original && origin ? { turnOrigin: origin, ...(origin.target ? { emissionTarget: origin.target } : {}) } : {}) } } });
      if (accepted.shouldEnqueue) accepted.onDeferred?.();
      return { kind: "turn", turnId: id, conversationId };
    };
    let receipt;
    try { receipt = await deliver(operation.source.conversationId, turnId, true); }
    catch (error) {
      const alternate = await input.fallbackConversation?.();
      if (!alternate || alternate === operation.source.conversationId) throw error;
      return deliver(alternate, turnId, false);
    }
    if (affectedOrigin && operation.phase !== "preparing") {
      const alternate = await input.fallbackConversation?.();
      if (alternate && alternate !== operation.source.conversationId) {
        await deliver(alternate, `${turnId}:notice`, false);
      }
    }
    return receipt;
  }, repairSource: async (_instance: ExtensionInstance): Promise<ExtensionOperation["source"] | undefined> => {
    const conversationId = await input.fallbackConversation?.();
    return conversationId ? { conversationId, request: "恢复已有连接" } : undefined;
  }, preparationClosed: async (operation: ExtensionOperation): Promise<boolean> => {
    const continuation = operation.continuation as { kind: string; turnId?: string; conversationId?: string; receipt?: { messageId: string } } | undefined;
    const conversationId = continuation?.conversationId ?? operation.source.conversationId;
    if (continuation?.kind === "message" && continuation.receipt?.messageId) {
      const status = await input.communication.invoke(conversationId, { action: "observe", conversationId,
        messageId: continuation.receipt.messageId }) as { state?: string } | null;
      return Boolean(status?.state && !["queued", "dispatched", "running", "cancel-requested", "uncertain"].includes(status.state));
    }
    if (continuation?.kind !== "turn" || !continuation.turnId) return false;
    const run = await input.manager.findDurableRunByIngress(conversationId, continuation.turnId, "interactive");
    return Boolean(run && !["queued", "dispatched", "running", "cancel-requested", "uncertain"].includes(run.state));
  } };
}
