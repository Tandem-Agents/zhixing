import type { IncomingMessage, ServerResponse } from "node:http";
import type { ExtensionInstance, ExtensionProcess, ExtensionTypeBinding } from "@zhixing/core/extensions/contracts";
import { channelDeclaration, validateChannelCredentials } from "@zhixing/core/channels/extension";
import type { ChannelBindingPolicy, ChannelChallengeAction, DeliveryResult, HttpHandler, InboundMessage } from "@zhixing/core/channels";
import type { ChannelProjection } from "./channel-configuration.js";

export interface ChannelConsumerBinding {
  message(message: InboundMessage, controlOnly?: boolean): Promise<void>;
  challenge(action: ChannelChallengeAction): Promise<void>;
}

/** Malformed external evidence is an unknown effect, never a successful delivery. */
export function channelDeliveryResult(value: unknown): DeliveryResult {
  const result = value as DeliveryResult | null;
  if (!result || typeof result.success !== "boolean" || typeof result.retryable !== "boolean" ||
      (result.messageId !== undefined && typeof result.messageId !== "string") ||
      (result.receiptBytes !== undefined && !(result.receiptBytes instanceof Uint8Array)) ||
      (result.attempted !== undefined && typeof result.attempted !== "boolean") ||
      (result.success && result.attempted === false) ||
      (!result.success && result.attempted === false && !result.retryable)) {
    throw new Error("Invalid Channel delivery evidence");
  }
  return {
    success: result.success, retryable: result.retryable,
    ...(result.messageId !== undefined ? { messageId: result.messageId } : {}),
    ...(result.receiptBytes !== undefined ? { receiptBytes: result.receiptBytes } : {}),
    ...(result.attempted !== undefined ? { attempted: result.attempted } : {}),
    ...(!result.success ? { error: "Channel rejected delivery" } : {}),
  };
}

export function createChannelTypeBinding(options: {
  records?: import("@zhixing/core/logging").LogRecordPort;
  instance: ExtensionInstance;
  consumers: () => ChannelConsumerBinding;
  routes: Map<string, HttpHandler>;
  ready: (capabilities: { challenges: boolean; bindingPolicy?: ChannelBindingPolicy } | undefined) => void;
}): ExtensionTypeBinding {
  const owned = new Map<string, HttpHandler>();
  let closed = false;
  let quiescing = false;
  let call: ExtensionProcess["call"] | undefined;
  return {
    type: "channel", contract: 1,
    bindTransport(transport) { call = transport; },
    validate(manifest, payload) {
      const projection = payload as ChannelProjection;
      if (projection.id !== options.instance.id) throw new Error("Channel instance mismatch");
      validateChannelCredentials(channelDeclaration(manifest), projection.config.credentials);
    },
    async receive({ method, payload, requestId }) {
      if (closed) throw new Error("Channel generation expired");
      if (quiescing && method !== "channel.challenge-action" && method !== "channel.message") throw new Error("Channel generation is handing over");
      if (method === "channel.message") {
        const message = payload as InboundMessage;
        if (!message || message.channelId !== options.instance.id || typeof message.messageId !== "string" || !message.messageId ||
            typeof message.from !== "string" || typeof message.text !== "string" || !["dm", "group", "thread"].includes(message.chatType)) {
          throw new Error("Invalid Channel message identity");
        }
        const refs = [{ kind: "message", id: message.messageId }, ...(requestId ? [{ kind: "extensionRequest", id: requestId }] : [])];
        options.records?.record(() => ({ event: "received", refs, data: { inputChars: message.text.length, chatType: message.chatType } }));
        try {
          await options.consumers().message(message, quiescing);
          options.records?.record({ event: "handled", refs, result: "success" });
        } catch (error) {
          options.records?.record(() => ({ event: "handled", refs, result: "failure", data: { error: error instanceof Error ? error.message : "渠道处理失败" } }));
          throw error;
        }
        return null;
      }
      if (method === "channel.challenge-action") {
        const action = payload as ChannelChallengeAction;
        if (action?.responder?.channelId !== options.instance.id) throw new Error("Invalid challenge source");
        await options.consumers().challenge(action);
        return null;
      }
      if (method === "channel.ready") {
        const ready = payload as { challenges: boolean; bindingPolicy?: ChannelBindingPolicy };
        if (typeof ready?.challenges !== "boolean" || (ready.bindingPolicy && !["per-group", "per-user-in-group"].includes(ready.bindingPolicy.group))) throw new Error("Invalid Channel capabilities");
        const declared = channelDeclaration(options.instance.binding.manifest).bindingPolicy?.group ?? "per-group";
        if ((ready.bindingPolicy?.group ?? "per-group") !== declared) throw new Error("Channel binding policy differs from its admitted declaration");
        options.ready(ready);
        return null;
      }
      if (method === "channel.register-route") {
        const path = (payload as { path?: unknown })?.path;
        if (typeof path !== "string" || !path.startsWith(`/channels/${options.instance.id}/`) || !/^\/channels\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9/_-]+$/.test(path) || options.routes.has(path)) throw new Error("Invalid callback route");
        const handler: HttpHandler = async (request, response) => {
          const req = request as IncomingMessage;
          const res = response as ServerResponse;
          if (closed || !call) { res.writeHead(503); res.end(); return; }
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += Buffer.byteLength(chunk);
            if (size > 1024 * 1024) { res.writeHead(413); res.end(); return; }
            chunks.push(Buffer.from(chunk));
          }
          try {
            const result = await call("channel.http", { path, method: req.method, headers: req.headers, body: Buffer.concat(chunks) }) as { status: number; headers: Record<string, string>; body: Uint8Array };
            if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status > 599 ||
                !result.headers || typeof result.headers !== "object" ||
                Object.values(result.headers).some((value) => typeof value !== "string") ||
                !(result.body instanceof Uint8Array)) throw new Error("Invalid Channel HTTP response");
            res.writeHead(result.status, result.headers); res.end(Buffer.from(result.body));
          } catch { res.writeHead(503); res.end(); }
        };
        options.routes.set(path, handler); owned.set(path, handler);
        return null;
      }
      throw new Error("Unknown Channel callback");
    },
    quiesce() { quiescing = true; },
    close() {
      if (closed) return;
      closed = true;
      call = undefined;
      for (const [path, handler] of owned) if (options.routes.get(path) === handler) options.routes.delete(path);
      owned.clear(); options.ready(undefined);
    },
  };
}
