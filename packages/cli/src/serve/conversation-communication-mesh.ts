import { Buffer } from "node:buffer";
import type { MeshServiceClient } from "@zhixing/mesh";
import type { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import type { RunInputPort } from "@zhixing/core/loop";
import { isProtocolIdentifier, validateMessages } from "@zhixing/core/protocol";
import { validateConversationCommunicationRequest } from "@zhixing/core/conversation/application";
import type { ConversationCommunicationTransport } from "./conversation-tools.js";

const SERVICE = "conversation.communication";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
const decode = (value: Uint8Array) => JSON.parse(Buffer.from(value).toString("utf8"));

export interface ConversationInputAddress {
  readonly conversationId: string;
  readonly runId: string;
  readonly assignmentId: string;
}

/** 经现有已配对设备连接传输；不创建对话间授权或第二份消息队列。 */
export function registerConversationCommunicationMesh(input: {
  readonly registry: MeshServiceRegistry;
  readonly authorizePeer: (deviceId: string) => boolean;
  readonly communication: ConversationCommunicationTransport;
  readonly inputFor?: (
    address: ConversationInputAddress,
    deviceId: string,
  ) => Promise<RunInputPort & { open(): Promise<void> }>;
}) {
  return input.registry.register(SERVICE, {
    access: "write",
    availability: "negotiated-version",
    authorize: (connection) => input.authorizePeer(connection.peer.deviceId),
    handler: async (payload, connection) => {
      try {
        const command = decode(payload);
        if (command?.v !== 1) throw new TypeError("通信协议版本无效");
        let result: unknown;
        if (command.kind === "communication") {
          if (
            Object.keys(command).sort().join(",") !== "kind,request,sourceConversationId,v" ||
            !isProtocolIdentifier(command.sourceConversationId)
          )
            throw new TypeError("通信身份无效");
          result = await input.communication.invoke(
            command.sourceConversationId,
            validateConversationCommunicationRequest(command.request),
          );
        } else if (command.kind === "input") {
          if (
            Object.keys(command).some(
              (key) => !["v", "kind", "address", "action", "boundary"].includes(key),
            ) ||
            !input.inputFor
          )
            throw new TypeError("运行输入不可用");
          const address = command.address as ConversationInputAddress;
          if (
            !address ||
            Object.keys(address).sort().join(",") !== "assignmentId,conversationId,runId" ||
            ![address.conversationId, address.runId, address.assignmentId].every(
              isProtocolIdentifier,
            )
          )
            throw new TypeError("运行输入身份无效");
          const port = await input.inputFor(address, connection.peer.deviceId);
          if (command.action === "receive") {
            if (
              !command.boundary ||
              Object.keys(command.boundary).sort().join(",") !== "boundary,closing" ||
              !Number.isSafeInteger(command.boundary.boundary) ||
              command.boundary.boundary < 1 ||
              typeof command.boundary.closing !== "boolean"
            )
              throw new TypeError("输入边界无效");
            result = await port.receive(command.boundary);
          } else if (command.action === "close") {
            await port.close();
            result = null;
          } else if (command.action === "open") {
            await port.open();
            result = null;
          } else throw new TypeError("运行输入动作无效");
        } else throw new TypeError("通信操作无效");
        return encode({ v: 1, ok: true, result });
      } catch (error) {
        return encode({
          v: 1,
          ok: false,
          error: error instanceof Error ? error.message : "对话通信失败",
        });
      }
    },
  });
}

export function createMeshConversationCommunication(
  client: () => MeshServiceClient,
): ConversationCommunicationTransport {
  return Object.freeze<ConversationCommunicationTransport>({
    invoke: (sourceConversationId, request) =>
      requestMesh(client(), { v: 1, kind: "communication", sourceConversationId, request }),
  });
}

export async function createMeshRunInput(
  client: () => MeshServiceClient,
  address: ConversationInputAddress,
): Promise<RunInputPort> {
  await requestMesh(client(), { v: 1, kind: "input", address, action: "open" });
  return Object.freeze<RunInputPort>({
    receive: async (boundary) => {
      const result = await requestMesh(client(), {
        v: 1,
        kind: "input",
        address,
        action: "receive",
        boundary,
      });
      return validateMessages(result);
    },
    close: async () => {
      await requestMesh(client(), { v: 1, kind: "input", address, action: "close" });
    },
  });
}

async function requestMesh(client: MeshServiceClient, command: unknown): Promise<unknown> {
  const response = decode(await client.request(SERVICE, encode(command)));
  if (response?.v !== 1 || typeof response.ok !== "boolean") throw new TypeError("通信响应无效");
  if (!response.ok) throw new Error(response.error);
  return response.result;
}
