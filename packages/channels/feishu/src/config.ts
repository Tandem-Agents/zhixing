export interface FeishuAdapterConfig {
  appId: string;
  appSecret: string;
  domain?: "feishu" | "lark";
  botOpenId?: string;
  /**
   * 互动确认(卡片按钮回调)的能力凭据,成对存在。缺失时基础消息能力
   * 照常,互动确认整体停用(degraded)——不因新能力的凭据缺口让既有
   * 消息链路失效。
   */
  interactiveConfirmation?: {
    verificationToken: string;
    encryptKey: string;
  };

  dedupTtlMs?: number;
  dedupMaxSize?: number;
}

export const FEISHU_DEFAULTS = {
  domain: "feishu" as const,
  dedupTtlMs: 86_400_000,
  dedupMaxSize: 2048,
  maxMessageLength: 8000,
};

export function resolveConfig(
  credentials: Record<string, string>,
  options?: Record<string, unknown>,
): FeishuAdapterConfig {
  const appId = credentials["appId"];
  const appSecret = credentials["appSecret"];
  if (!appId || !appSecret) {
    throw new Error("Feishu adapter requires appId and appSecret in credentials");
  }

  const domain = options?.["domain"];
  if (domain !== undefined && domain !== "feishu" && domain !== "lark") {
    throw new Error(`Invalid Feishu domain: "${String(domain)}". Expected "feishu" or "lark".`);
  }

  const dedupTtlMs = options?.["dedupTtlMs"];
  if (dedupTtlMs !== undefined && (typeof dedupTtlMs !== "number" || dedupTtlMs <= 0)) {
    throw new Error(`Invalid dedupTtlMs: ${String(dedupTtlMs)}. Expected a positive number.`);
  }

  const dedupMaxSize = options?.["dedupMaxSize"];
  if (dedupMaxSize !== undefined && (typeof dedupMaxSize !== "number" || dedupMaxSize <= 0)) {
    throw new Error(`Invalid dedupMaxSize: ${String(dedupMaxSize)}. Expected a positive number.`);
  }

  const botOpenId = options?.["botOpenId"];
  if (botOpenId !== undefined && typeof botOpenId !== "string") {
    throw new Error(`Invalid botOpenId: expected a string.`);
  }

  const verificationToken = credentials["verificationToken"];
  const encryptKey = credentials["encryptKey"];
  // 半配置是配置错误而非 degraded:只给其一无法判断意图,必须显式报错;
  // 两者全缺才进入"互动确认停用、基础消息保留"的能力分级。
  if (Boolean(verificationToken) !== Boolean(encryptKey)) {
    throw new Error(
      "Feishu interactive confirmation requires both verificationToken and encryptKey; provide both or neither",
    );
  }

  return {
    appId,
    appSecret,
    domain: (domain as FeishuAdapterConfig["domain"]) ?? FEISHU_DEFAULTS.domain,
    botOpenId: botOpenId as string | undefined,
    ...(verificationToken && encryptKey
      ? { interactiveConfirmation: { verificationToken, encryptKey } }
      : {}),
    dedupTtlMs: (dedupTtlMs as number) ?? FEISHU_DEFAULTS.dedupTtlMs,
    dedupMaxSize: (dedupMaxSize as number) ?? FEISHU_DEFAULTS.dedupMaxSize,
  };
}
