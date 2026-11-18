import { describe, expect, it } from "vitest";
import { TurnContextInjector } from "../context/turn-context.js";
import {
  coalesceUserMaterialTextBlocks,
  createTextFileMaterial,
  isTextFileMaterial,
  replaceFirstText,
  extractFirstText,
} from "./messages.js";
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

  it("文件材料文本 part 在消息转换与还原中无损保留 material，且同源清洗控制字符与代理对截断", () => {
    const clean = createTextFileMaterial(
      `a\u0000b\u0085c\u009bd\u2028e\u2029[f]g\ud800`,
      0,
    );
    expect(clean).toEqual({
      kind: "file",
      name: "a b c d e f g\ufffd",
      byteSize: 0,
    });
    expect(isTextFileMaterial(clean)).toBe(true);

    // 255 个 ASCII + 1 个 2-code-unit 代理对（共 257 > 256）：不得切出孤立高代理项
    const surrogateEdge = createTextFileMaterial(`${"x".repeat(255)}🦞tail`, 128);
    expect(surrogateEdge.name).toBe("x".repeat(255));
    expect(isTextFileMaterial(surrogateEdge)).toBe(true);
    expect(createTextFileMaterial(" \r\n\u0085\u2028[] ", 5).name).toBe("unnamed");

    for (const badName of [
      "",
      "line\nbreak",
      "nel\u0085char",
      "c1\u0090ctrl",
      "ls\u2028sep",
      "ps\u2029sep",
      "bad[bracket]",
      `lone\ud800high`,
      "a".repeat(257),
    ]) {
      expect(isTextFileMaterial({ kind: "file", name: badName, byteSize: 1 })).toBe(false);
    }

    const input = {
      parts: [
        { type: "text" as const, text: "前缀 " },
        {
          type: "text" as const,
          text: '<file path="E:/repo/empty.txt">\n\n</file>',
          material: createTextFileMaterial("empty.txt", 0),
        },
        { type: "text" as const, text: " 后缀" },
      ],
    };
    expect(isNonEmptyUserTurnInput(input)).toBe(true);
    expect(
      isUserTurnInput({
        parts: [{ type: "text", text: "", material: { kind: "file", name: "a.txt", byteSize: 0 } }],
      }),
    ).toBe(false);

    const msg = userMessageFromTurnInput(input);
    expect(msg.content).toEqual(input.parts);
    expect(userTurnInputFromMessages([msg])).toEqual(input);
    expect(extractUserTurnInputText(input)).toBe(
      '前缀 <file path="E:/repo/empty.txt">\n\n</file> 后缀',
    );
    expect(coalesceUserMaterialTextBlocks(msg.content)).toEqual([
      {
        type: "text",
        text: '前缀 <file path="E:/repo/empty.txt">\n\n</file> 后缀',
      },
    ]);

    // replaceFirstText / TurnContextInjector.inject 在文件位于中间、开头及图片之后时，出站折叠结果均与改前单块完全一致
    const ctxMgr = new TurnContextInjector().register({
      name: "env",
      shouldInject: () => true,
      render: () => ({ title: "Env", body: "cwd: E:/repo" }),
    });
    const fXml = '<file path="E:/repo/a.txt">\nalpha\n</file>';
    const mat = createTextFileMaterial("a.txt", 5);
    const img = { type: "base64" as const, mediaType: "image/png", data: "AAAA" };
    for (const [splitContent, legacyContent] of [
      [
        [{ type: "text" as const, text: "前缀 " }, { type: "text" as const, text: fXml, material: mat }, { type: "text" as const, text: " 后缀" }],
        [{ type: "text" as const, text: `前缀 ${fXml} 后缀` }],
      ],
      [
        [{ type: "text" as const, text: fXml, material: mat }, { type: "text" as const, text: " 后缀" }],
        [{ type: "text" as const, text: `${fXml} 后缀` }],
      ],
      [
        [{ type: "image" as const, source: img }, { type: "text" as const, text: fXml, material: mat }, { type: "text" as const, text: " 后缀" }],
        [{ type: "image" as const, source: img }, { type: "text" as const, text: `${fXml} 后缀` }],
      ],
    ] as const) {
      const injectedSplit = ctxMgr.inject([{ role: "user", content: [...splitContent] }])[0]!;
      const injectedLegacy = ctxMgr.inject([{ role: "user", content: [...legacyContent] }])[0]!;
      expect(coalesceUserMaterialTextBlocks(injectedSplit.content)).toEqual(injectedLegacy.content);
      const manualSplit = replaceFirstText({ role: "user", content: [...splitContent] }, `CTX\n\n${extractFirstText({ role: "user", content: [...splitContent] })}`);
      const manualLegacy = replaceFirstText({ role: "user", content: [...legacyContent] }, `CTX\n\n${extractFirstText({ role: "user", content: [...legacyContent] })}`);
      expect(coalesceUserMaterialTextBlocks(manualSplit.content)).toEqual(manualLegacy.content);
    }
  });
});
