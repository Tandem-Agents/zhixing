export interface FeishuAdapterConfig {
  appId: string;
  appSecret: string;
  domain?: "feishu" | "lark";
  botOpenId?: string;

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

  return {
    appId,
    appSecret,
    domain: (domain as FeishuAdapterConfig["domain"]) ?? FEISHU_DEFAULTS.domain,
    botOpenId: botOpenId as string | undefined,
    dedupTtlMs: (dedupTtlMs as number) ?? FEISHU_DEFAULTS.dedupTtlMs,
    dedupMaxSize: (dedupMaxSize as number) ?? FEISHU_DEFAULTS.dedupMaxSize,
  };
}
