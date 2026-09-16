import {
  ConversationCommunicationApplicationService,
  dispatchConversationCommunication,
  type ConversationDirectoryApplication,
  type ConversationMessageProjectionPort,
  type ConversationMessageExecutionRequest,
} from "@zhixing/core/conversation/application";
import { projectSessionTurn } from "@zhixing/rpc/session-turn-stream";
import type { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import type { ConversationCommunicationTransport } from "./conversation-tools.js";
import type { LocalConversationOwnerPort } from "./local-conversation-owner.js";
import { createLocalConversationDirectoryApplication } from "./local-conversation-directory-application.js";
import { assertLocalConversationIdForDevice, isLocalConversationId } from "@zhixing/core/conversation";

/** 本机地址是稳定身份，不是永久路由；非本机请求先询问当前 Anchor 的接管事实。 */
export async function routeAddressedConversationCommunication(input: {
  readonly deviceId: string;
  readonly anchorDeviceId: string;
  readonly members: readonly string[];
  readonly local?: { readonly communication: ConversationCommunicationTransport; readonly owner: Pick<LocalConversationOwnerPort, "currentAuthority"> };
  readonly anchor?: { readonly communication: ConversationCommunicationTransport; readonly owns: (id: string) => Promise<boolean> };
  readonly remote: (deviceId: string) => ConversationCommunicationTransport;
}, source: string, request: Exclude<Parameters<ConversationCommunicationTransport["invoke"]>[1], { action: "discover" }>): Promise<unknown> {
  const anchor = () => input.anchor?.communication ?? input.remote(input.anchorDeviceId);
  if (!isLocalConversationId(request.conversationId)) return anchor().invoke(source, request);
  const device = input.members.find(id => {
    try { assertLocalConversationIdForDevice(request.conversationId, id); return true; } catch { return false; }
  });
  if (device === input.deviceId) {
    if (!input.local) throw new Error("目标本机对话不可用");
    const authority = await input.local.owner.currentAuthority(request.conversationId);
    if (authority.state === "frozen" || authority.state === "importing") throw new Error("目标对话正在接管中，请稍后重试");
    return (authority.deviceId === device ? input.local.communication : input.remote(authority.deviceId)).invoke(source, request);
  }
  if (!input.anchor) return anchor().invoke(source, request);
  if (await input.anchor.owns(request.conversationId)) return input.anchor.communication.invoke(source, request);
  if (!device) throw new Error("目标对话的设备不可达");
  return input.remote(device).invoke(source, request);
}

/** 只装配既有准入和执行链；发送方结束后，接收方仍由自己的 Owner 驱动。 */
export function createConversationCommunicationBinding(input: {
  readonly directory: ConversationDirectoryApplication;
  readonly messages: ConversationMessageProjectionPort;
  readonly manager: ConversationManager;
}): ConversationCommunicationTransport {
  const execution = (request: ConversationMessageExecutionRequest) => ({
    execute: async ({ conversationId, turnId }: { conversationId: string; turnId: string }) => {
      const managed = input.manager.getSession(conversationId);
      if (!managed) throw new Error("接收对话运行体不可用");
      try {
        await projectSessionTurn({
          manager: input.manager,
          managed,
          input: request.input,
          turnId,
          runOptions: {
            source: "interactive",
            surfacePrincipal: request.caller.surfacePrincipal,
            turnContext: { turnId, turnOrigin: request.turnOrigin },
          },
          // 与自动准入的运行一致，由正式事件/输出流投影给接收对话，不另发重复 delta。
          notify: () => {},
        });
      } finally {
        input.manager.setBusy(conversationId, false);
      }
    },
    cancelPending: () => {},
  });
  return Object.freeze<ConversationCommunicationTransport>({
    async invoke(sourceConversationId, request) {
      const application = new ConversationCommunicationApplicationService({
        directory: input.directory,
        messages: input.messages,
        execution,
        source: { kind: "conversation", conversationId: sourceConversationId },
        caller: {
          kind: "surface",
          surfacePrincipal: `conversation:${sourceConversationId}`,
          connectionId: `conversation:${sourceConversationId}`,
        },
      });
      return dispatchConversationCommunication(application, request);
    },
  });
}

export function createLocalConversationCommunicationBinding(
  owner: LocalConversationOwnerPort,
): ConversationCommunicationTransport {
  const directory = createLocalConversationDirectoryApplication({ owner, observerCount: () => 0 });
  return Object.freeze<ConversationCommunicationTransport>({
    async invoke(sourceConversationId, request) {
      const caller = {
        kind: "surface" as const,
        surfacePrincipal: `conversation:${sourceConversationId}`,
        connectionId: `conversation:${sourceConversationId}`,
      };
      const application = new ConversationCommunicationApplicationService({
        directory,
        messages: owner.communicationMessages,
        source: { kind: "conversation", conversationId: sourceConversationId },
        caller,
        execution: (request) =>
          owner.createAgentTurnExecution({
            input: request.input,
            turnOrigin: request.turnOrigin,
            surfacePrincipal: caller.surfacePrincipal,
            notify: () => {},
          }).execution,
      });
      return dispatchConversationCommunication(application, request);
    },
  });
}

/** 汇总现有 Owner 的只读目录；部分设备离线时仍返回可用目标并明确不完整。 */
export async function discoverConversations(
  ports: readonly ConversationCommunicationTransport[],
  source: string,
) {
  const results = await Promise.allSettled(
    ports.map((port) => port.invoke(source, { action: "discover" })),
  );
  const entries = new Map<string, unknown>();
  let available = false;
  let partial = results.some((result) => result.status === "rejected");
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const view = result.value as {
      conversations: readonly { conversationId: string }[];
      partial?: boolean;
    };
    if (!Array.isArray(view?.conversations)) throw new Error("对话目录响应无效");
    available = true;
    partial ||= view.partial === true;
    for (const entry of view.conversations) entries.set(entry.conversationId, entry);
  }
  if (!available) throw new Error("对话目录暂不可达");
  return { conversations: [...entries.values()], partial };
}
