import { describe, expect, it } from "vitest";
import { buildReplyCard, getStatusConfig } from "./cards.js";

describe("getStatusConfig", () => {
  it("returns green for done status", () => {
    const config = getStatusConfig("done");
    expect(config.color).toBe("green");
  });

  it("returns red for error status", () => {
    const config = getStatusConfig("error");
    expect(config.color).toBe("red");
  });

  it("returns grey for queued status", () => {
    expect(getStatusConfig("queued").color).toBe("grey");
  });
});

describe("buildReplyCard", () => {
  it("builds a card with default done status", () => {
    const card = buildReplyCard("Hello");
    expect(card.config).toEqual({ wide_screen_mode: true });

    const header = card.header as Record<string, unknown>;
    expect(header.template).toBe("green");

    const elements = card.elements as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(1);
    expect(elements[0]).toEqual({ tag: "markdown", content: "Hello" });
  });

  it("uses specified status", () => {
    const card = buildReplyCard("Working...", { status: "thinking" });
    const header = card.header as Record<string, unknown>;
    expect(header.template).toBe("blue");
  });

  it("allows custom title override", () => {
    const card = buildReplyCard("text", { title: "Custom Title" });
    const header = card.header as { title: { content: string } };
    expect(header.title.content).toBe("Custom Title");
  });

  it("uses status title when no custom title", () => {
    const card = buildReplyCard("text", { status: "error" });
    const header = card.header as { title: { content: string } };
    expect(header.title.content).toContain("\u51fa\u9519");
  });
});
