import { describe, expect, it } from "vitest";
import {
  extractUserTurnInputText,
  isNonEmptyUserTurnInput,
  isUserTurnInput,
  resolveModelInputCapabilities,
  userMessageFromTurnInput,
  userTurnInputFromMessages,
  userTurnInputFromText,
  validateMessagesAgainstInputCapabilities,
} from "./user-input.js";

describe("从运行记录还原原始输入", () => {
  it("只取本次输入的第一条用户消息，文本与图片来源与原输入的消息形态一致，后续追加输入与工具结果不并入", () => {
    const original = {
      parts: [
        { type: "text" as const, text: "整理这张图里的会议记录" },
        { type: "image" as const, source: { type: "base64" as const, mediaType: "image/png", data: "AAAA" }, name: "a.png", mimeType: "image/png", size: 3 },
      ],
    };
    const messages = [
      userMessageFromTurnInput(original),
      { role: "assistant" as const, content: [{ type: "text" as const, text: "好的" }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, toolUseId: "t1", content: "结果" }] },
      userMessageFromTurnInput(userTurnInputFromText("顺便看下周")),
    ];
    const restored = userTurnInputFromMessages(messages);
    expect(userMessageFromTurnInput(restored)).toEqual(userMessageFromTurnInput(original));
    expect(restored.parts).toHaveLength(2);
    expect(JSON.stringify(restored)).not.toContain("顺便看下周");
    expect(userTurnInputFromMessages([messages[2]!, messages[0]!])).toEqual(restored);
  });
});

describe("user turn input", () => {
  it("纯文本输入投影为 user text message", () => {
    expect(userMessageFromTurnInput(userTurnInputFromText("hello"))).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("图片输入投影为 image block，文本顺序保留", () => {
    const msg = userMessageFromTurnInput({
      parts: [
        { type: "text", text: "看这张图：" },
        {
          type: "image",
          source: { type: "base64", mediaType: "image/png", data: "AAA" },
          name: "shot.png",
          mimeType: "image/png",
          size: 3,
        },
      ],
    });

    expect(msg).toEqual({
      role: "user",
      content: [
        { type: "text", text: "看这张图：" },
        {
          type: "image",
          source: { type: "base64", mediaType: "image/png", data: "AAA" },
        },
      ],
    });
  });

  it("提取文本时忽略非文本材料", () => {
    expect(
      extractUserTurnInputText({
        parts: [
          { type: "text", text: "a" },
          {
            type: "image",
            source: { type: "url", url: "https://example.com/a.png" },
          },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("ab");
  });

  it("运行时校验拒绝空输入和非法材料形状", () => {
    expect(isNonEmptyUserTurnInput({ parts: [] })).toBe(false);
    expect(
      isNonEmptyUserTurnInput({ parts: [{ type: "text", text: "" }] }),
    ).toBe(false);
    expect(isUserTurnInput({ parts: [{ type: "image" }] })).toBe(false);
    expect(
      isNonEmptyUserTurnInput({
        parts: [
          {
            type: "image",
            source: { type: "base64", mediaType: "image/png", data: "AAA" },
          },
        ],
      }),
    ).toBe(true);
  });

  it("从模型 catalog 和用户覆盖解析输入能力", () => {
    expect(
      resolveModelInputCapabilities({
        model: "vision",
        providerModels: [{ id: "vision", supportsImages: true }],
      }),
    ).toEqual({ images: true });

    expect(
      resolveModelInputCapabilities({
        model: "custom-vision",
        providerModels: [],
        overrides: { "custom-vision": { images: true } },
      }),
    ).toEqual({ images: true });

    expect(
      resolveModelInputCapabilities({
        model: "unknown",
        providerModels: [],
      }),
    ).toEqual({ images: false });
  });

  it("模型不支持图片时拒绝包含 image block 的消息", () => {
    const error = validateMessagesAgainstInputCapabilities(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "看图" },
            {
              type: "image",
              source: { type: "base64", mediaType: "image/png", data: "AAA" },
            },
          ],
        },
      ],
      { images: false },
    );

    expect(error?.type).toBe("invalid_request");
    expect(error?.message).toContain("不支持图片输入");
  });
});
