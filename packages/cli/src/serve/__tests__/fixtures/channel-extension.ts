import { serveChannelExtension } from "@zhixing/core/channels/extension-worker";
import type { ChannelContext } from "@zhixing/core/channels";

let context: ChannelContext;

serveChannelExtension((id) => ({
  id,
  capabilities: { chatTypes: ["dm"], media: false, edit: false, streaming: false },
  async connect(next: ChannelContext) {
    context = next;
    context.registerHttpRoute(`/channels/${id}/challenge`, async (_req, response) => {
      (response as import("node:http").ServerResponse).end("fixture");
    });
    if (context.config.options?.eager) await context.onMessage({ channelId: id, messageId: "stable-event", from: "user", text: "hello", chatType: "dm" });
  },
  async disconnect() {},
  health: () => "ready",
  async send(_target, content, meta) {
    if (content.text === "held" || content.text === "never") await context.onMessage({ channelId: id, messageId: `started-${content.text}`, from: "user", text: content.text, chatType: "dm" });
    if (content.text === "held") await new Promise((resolve) => setTimeout(resolve, 700));
    if (content.text === "never") await new Promise(() => {});
    if (content.text === "malformed") return { success: "true" } as never;
    return { success: true, retryable: false, messageId: `${meta?.idempotencyKey ?? "reply"}:${id}`,
      ...(meta?.deliveryAttempt ? { receiptBytes: Buffer.from(JSON.stringify(meta.deliveryAttempt)) } : {}),
    };
  },
}));
