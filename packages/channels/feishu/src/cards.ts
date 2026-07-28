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

export function buildChallengeCard(input: {
  readonly title: string;
  readonly lines: readonly string[];
  readonly token: unknown;
}): Record<string, unknown> {
  const content = input.lines.length > 0
    ? input.lines.join("\n")
    : "需要你的确认。";
  return {
    config: {
      wide_screen_mode: true,
      enable_forward: false,
      update_multi: false,
    },
    header: {
      title: { tag: "plain_text", content: input.title },
      template: "orange",
    },
    elements: [
      { tag: "markdown", content: toCardText(content) },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "允许一次" },
            type: "primary",
            value: {
              v: 1,
              decision: { allowed: true },
              token: input.token,
            },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "拒绝" },
            type: "danger",
            value: {
              v: 1,
              decision: { allowed: false },
              token: input.token,
            },
          },
        ],
      },
    ],
  };
}

function toCardText(value: string): string {
  return value.length > 0 ? value : "需要你的确认。";
}
