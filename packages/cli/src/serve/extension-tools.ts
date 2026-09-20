import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolDefinition } from "@zhixing/core";
import { protocolDigest } from "@zhixing/core/protocol";
import type { ExtensionManagementRequest, ExtensionSnapshot } from "@zhixing/core/extensions/contracts";
import { validateExtensionCandidate } from "@zhixing/core/extensions/candidate";
import { runContextStorage } from "@zhixing/orchestrator/runtime";
import { extensionKitDirectory } from "../runtime/extensions/catalog.js";

export interface ExtensionManagementTransport {
  invoke(request: ExtensionManagementRequest): Promise<{ snapshot: ExtensionSnapshot; targetDeviceId: string }>;
}
export function createExtensionManagementHandle() {
  let target: ExtensionManagementTransport | undefined;
  return {
    port: Object.freeze<ExtensionManagementTransport>({ invoke: request => {
      if (!target) throw new Error("扩展管理尚未就绪");
      return target.invoke(request);
    } }),
    bind(value: ExtensionManagementTransport) { if (target) throw new Error("扩展管理不能重复装配"); target = value; },
  };
}

export function createExtensionTools(transport: ExtensionManagementTransport): ToolDefinition[] {
  return [{
    name: "extension",
    description: "准备外部 APP 接入、查询进度、取消接入或停用连接。先加载“外部能力接入”技能。准备仅接纳需求，不代表已可用；缺少本人操作时使用目标设备 /config 安全入口。",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["guide", "prepare", "status", "cancel", "disable"] },
      instanceId: { type: "string", description: "新连接的稳定标识，或要停用的连接标识" },
      operationId: { type: "string" }, expectedRevision: { type: "integer" },
    }, required: ["action"], additionalProperties: false },
    isReadOnly: false, isParallelSafe: false,
    boundaries: [{ boundaryType: "app-state", access: "write", dynamic: false }],
    async call(input, context) {
      try {
        if (Object.keys(input).some(key => !["action", "instanceId", "operationId", "expectedRevision"].includes(key))) throw new Error("不接受额外参数或自报来源");
        if (input.action === "guide") return { content: JSON.stringify({ directory: extensionKitDirectory(), guide: "authoring.md", validator: "validate.mjs", sdk: "channel-sdk.mjs", schema: "manifest.schema.json" }) };
        const run = runContextStorage.getStore();
        if (!run?.conversationId) throw new Error("需要在可恢复的对话中管理扩展");
        let request: ExtensionManagementRequest;
        if (input.action === "prepare") {
          if (!context.turnId || !context.toolCallId || !context.userIntent || typeof input.instanceId !== "string") throw new Error("准备需要原始请求、稳定调用身份和连接标识");
          request = { action: "prepare", id: `extension-${protocolDigest("ExtensionRequest", 1, { turn: context.turnId, call: context.toolCallId, lineage: run.lineage }).slice("sha256:".length)}`,
            instanceId: input.instanceId, source: { conversationId: run.conversationId, request: context.userIntent,
              // Preserve the wire representation; local optional fields can be
              // undefined, which are not canonical Authority values.
              ...(context.turnOrigin ? { returnAddress: JSON.parse(JSON.stringify(context.turnOrigin)) } : {}) } };
        } else if (input.action === "cancel") {
          if (typeof input.operationId !== "string" || !Number.isSafeInteger(input.expectedRevision)) throw new Error("需要操作标识和当前修订");
          request = { action: "cancel", id: input.operationId, expectedRevision: input.expectedRevision as number };
        } else if (input.action === "disable") {
          if (typeof input.instanceId !== "string") throw new Error("需要连接标识");
          request = { action: "disable", instanceId: input.instanceId };
        } else if (input.action === "status") request = { action: "status" };
        else throw new Error("无效动作");
        return { content: JSON.stringify(await transport.invoke(request)) };
      } catch (error) { return { content: error instanceof Error ? error.message : "扩展管理失败", isError: true }; }
    },
  }, {
    name: "extension_connect",
    description: "提交已校验的固定版本候选包。确认后保存制品并等待安全配置、真实收发验证；不会把已安装当成可用。只接收无凭据的候选，不能覆盖现有连接。",
    inputSchema: { type: "object", properties: {
      operationId: { type: "string" }, expectedRevision: { type: "integer" },
      candidatePath: { type: "string", description: "当前工作目录内的 candidate.json" },
      digest: { type: "string", description: "已检查制品的 SHA-256，确认绑定此摘要" },
    }, required: ["operationId", "expectedRevision", "candidatePath", "digest"], additionalProperties: false },
    isReadOnly: false, isParallelSafe: false, requiresExplicitConfirmation: true,
    permissionArgumentKey: "candidatePath",
    boundaries: [{ boundaryType: "process", access: "execute", dynamic: false }, { boundaryType: "network", access: "write", dynamic: false }],
    async call(input, context) {
      try {
        if (!runContextStorage.getStore()?.conversationId) throw new Error("需要真实对话身份");
        if (Object.keys(input).some(key => !["operationId", "expectedRevision", "candidatePath", "digest"].includes(key)) ||
            typeof input.operationId !== "string" || !Number.isSafeInteger(input.expectedRevision) || typeof input.candidatePath !== "string") throw new Error("候选参数无效");
        const root = await realpath(context.workingDirectory);
        const path = await realpath(resolve(root, input.candidatePath));
        const within = relative(root, path);
        if (isAbsolute(within) || within.startsWith("..") || !within || (await stat(path)).size > 24 * 1024 * 1024) throw new Error("候选须位于当前工作目录且不超过 24 MiB");
        const candidate = validateExtensionCandidate(JSON.parse(await readFile(path, "utf8")));
        if (candidate.manifest.digest !== input.digest) throw new Error("候选已变化，请重新检查并确认");
        context.abortSignal?.throwIfAborted();
        return { content: JSON.stringify(await transport.invoke({ action: "connect", id: input.operationId,
          expectedRevision: input.expectedRevision as number, candidate })) };
      } catch (error) { return { content: error instanceof Error ? error.message : "接入失败", isError: true }; }
    },
  }];
}
