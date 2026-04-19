import * as lark from "@larksuiteoapi/node-sdk";
import type { FeishuAdapterConfig } from "./config.js";

export function resolveDomain(domain: FeishuAdapterConfig["domain"]): lark.Domain {
  return domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
}

export function detectReceiveIdType(id: string): "open_id" | "chat_id" {
  if (id.startsWith("oc_")) return "chat_id";
  return "open_id";
}

const RETRYABLE_CODES = new Set([
  99991429, // rate limit
  99991500, // internal server error
  99991504, // gateway timeout
]);

export class FeishuApiError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: number,
    readonly apiMessage: string,
  ) {
    super(`Feishu API error [${code}]: ${apiMessage}`);
    this.name = "FeishuApiError";
    this.retryable = RETRYABLE_CODES.has(code);
  }
}

export class FeishuClient {
  readonly raw: lark.Client;

  constructor(config: FeishuAdapterConfig) {
    this.raw = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: resolveDomain(config.domain),
    });
  }

  async sendCard(
    receiveId: string,
    card: Record<string, unknown>,
    receiveIdType: "open_id" | "chat_id" = "open_id",
  ): Promise<string | undefined> {
    const resp = await this.raw.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });

    if (resp.code !== 0) {
      throw new FeishuApiError(resp.code!, resp.msg ?? "unknown error");
    }

    return resp.data?.message_id;
  }
}
