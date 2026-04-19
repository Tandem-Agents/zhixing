export type CardStatus = "queued" | "thinking" | "tool_call" | "generating" | "done" | "error";

interface StatusConfig {
  title: string;
  color: string;
}

const STATUS_CONFIGS: Record<CardStatus, StatusConfig> = {
  queued: { title: "\u23f3 \u6392\u961f\u4e2d\u2026", color: "grey" },
  thinking: { title: "\ud83e\udd14 \u601d\u8003\u4e2d\u2026", color: "blue" },
  tool_call: { title: "\ud83d\udd27 \u6267\u884c\u4e2d\u2026", color: "blue" },
  generating: { title: "\u270d\ufe0f \u751f\u6210\u4e2d\u2026", color: "blue" },
  done: { title: "\u2705 \u5b8c\u6210", color: "green" },
  error: { title: "\u274c \u51fa\u9519", color: "red" },
};

export function getStatusConfig(status: CardStatus): StatusConfig {
  return STATUS_CONFIGS[status];
}

export interface CardOptions {
  status?: CardStatus;
  title?: string;
}

export function buildReplyCard(
  markdown: string,
  options?: CardOptions,
): Record<string, unknown> {
  const status = options?.status ?? "done";
  const { title, color } = getStatusConfig(status);

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: options?.title ?? title },
      template: color,
    },
    elements: [{ tag: "markdown", content: markdown }],
  };
}
