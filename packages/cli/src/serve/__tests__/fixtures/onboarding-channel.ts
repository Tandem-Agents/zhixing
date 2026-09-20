import { serveChannelExtension } from "@zhixing/core/channels/extension-worker";
import type { ChannelContext } from "@zhixing/core/channels";
import type { IncomingMessage, ServerResponse } from "node:http";

let lastReply = "";
let lastTarget: unknown;
let lastKey: string | undefined;
serveChannelExtension(id => ({
  id, capabilities: { chatTypes: ["dm", "group", "thread"], media: false, edit: false, streaming: false },
  async connect(context: ChannelContext) {
    context.registerHttpRoute(`/channels/${id}/fixture`, async (request, response) => {
      const req = request as IncomingMessage;
      const res = response as ServerResponse;
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part));
      if (req.method === "POST") {
        const message = JSON.parse(Buffer.concat(parts).toString());
        await context.onMessage({ channelId: id, chatType: "dm", ...message });
      }
      res.end(JSON.stringify({ lastReply, lastTarget, lastKey }));
    });
  },
  async disconnect() {},
  health: () => "ready",
  async send(target, content, meta) {
    lastTarget = target;
    lastReply = content.text;
    lastKey = meta?.idempotencyKey;
    return { success: true, retryable: false, messageId: meta?.idempotencyKey ?? "platform-reply" };
  },
}));
