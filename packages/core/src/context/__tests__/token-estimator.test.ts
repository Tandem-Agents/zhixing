import { describe, expect, it } from "vitest";
import {
  TokenEstimator,
  createTokenEstimator,
  estimateTextTokensRaw,
} from "../token-estimator.js";
import type { Message } from "../../types/messages.js";
import {
  userMessage,
  assistantMessage,
  toolResultMessage,
} from "../../types/messages.js";

// ─── estimateTextTokensRaw ───

describe("estimateTextTokensRaw", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTextTokensRaw("")).toBe(0);
  });

  it("estimates pure ASCII text (chars/4 baseline)", () => {
    const text = "Hello, world!"; // 13 chars
    const tokens = estimateTextTokensRaw(text);
    // 13 × 0.25 = 3.25 → ceil = 4
    expect(tokens).toBe(4);
  });

  it("estimates longer ASCII text", () => {
    const text = "The quick brown fox jumps over the lazy dog"; // 43 chars
    const tokens = estimateTextTokensRaw(text);
    // 43 × 0.25 = 10.75 → ceil = 11
    expect(tokens).toBe(11);
  });

  it("estimates pure CJK text with higher weight", () => {
    const text = "你好世界"; // 4 CJK chars
    const tokens = estimateTextTokensRaw(text);
    // 4 × 1.5 = 6
    expect(tokens).toBe(6);
  });

  it("estimates longer CJK text", () => {
    const text = "知行合一，格物致知"; // 8 CJK chars + 1 punctuation
    const tokens = estimateTextTokensRaw(text);
    // 8 × 1.5 + 1 × 1.5 (fullwidth comma) = 13.5 → ceil = 14
    expect(tokens).toBeGreaterThanOrEqual(12);
    expect(tokens).toBeLessThanOrEqual(15);
  });

  it("estimates mixed CJK and ASCII text", () => {
    const text = "Hello你好World世界"; // 10 ASCII + 4 CJK
    const tokens = estimateTextTokensRaw(text);
    // ASCII: 10 × 0.25 = 2.5
    // CJK: 4 × 1.5 = 6.0
    // Total: 8.5 → ceil = 9
    expect(tokens).toBe(9);
  });

  it("CJK estimate is significantly higher than pure ASCII for same char count", () => {
    const ascii = "abcdefgh"; // 8 chars
    const cjk = "你好世界美丽天空"; // 8 chars
    const asciiTokens = estimateTextTokensRaw(ascii);
    const cjkTokens = estimateTextTokensRaw(cjk);
    // CJK should be ~6x more tokens than ASCII for same char count
    expect(cjkTokens).toBeGreaterThan(asciiTokens * 4);
  });

  it("handles emoji with higher weight", () => {
    const text = "Hello 😀🎉";
    const tokens = estimateTextTokensRaw(text);
    // "Hello " = 6 × 0.25 = 1.5
    // 😀 = 2.0, 🎉 = 2.0
    // Total: 5.5 → ceil = 6
    expect(tokens).toBeGreaterThanOrEqual(5);
    expect(tokens).toBeLessThanOrEqual(7);
  });

  it("handles Japanese hiragana and katakana", () => {
    const text = "こんにちは"; // 5 hiragana
    const tokens = estimateTextTokensRaw(text);
    // 5 × 1.5 = 7.5 → ceil = 8
    expect(tokens).toBe(8);
  });

  it("handles Korean hangul", () => {
    const text = "안녕하세요"; // 5 hangul syllables
    const tokens = estimateTextTokensRaw(text);
    // 5 × 1.5 = 7.5 → ceil = 8
    expect(tokens).toBe(8);
  });

  it("handles code with mixed ASCII and special chars", () => {
    const code = 'const x = "hello";\nconsole.log(x);';
    const tokens = estimateTextTokensRaw(code);
    // All ASCII, 34 chars × 0.25 = 8.5 → ceil = 9
    expect(tokens).toBeGreaterThanOrEqual(8);
    expect(tokens).toBeLessThanOrEqual(10);
  });
});

// ─── TokenEstimator.estimateMessage ───

describe("TokenEstimator.estimateMessage", () => {
  const estimator = createTokenEstimator();

  it("estimates a simple user text message", () => {
    const msg = userMessage("Hello, world!");
    const tokens = estimator.estimateMessage(msg);
    // MESSAGE_OVERHEAD(4) + BLOCK_OVERHEAD(3) + text(4) = 11
    expect(tokens).toBeGreaterThanOrEqual(8);
    expect(tokens).toBeLessThanOrEqual(15);
  });

  it("estimates a CJK user message", () => {
    const msg = userMessage("请读取当前目录下的文件");
    const tokens = estimator.estimateMessage(msg);
    // CJK tokens should be higher than equivalent ASCII
    const asciiMsg = userMessage("Read files in cwd");
    const asciiTokens = estimator.estimateMessage(asciiMsg);
    expect(tokens).toBeGreaterThan(asciiTokens);
  });

  it("estimates an assistant message", () => {
    const msg = assistantMessage("I'll help you with that.");
    const tokens = estimator.estimateMessage(msg);
    expect(tokens).toBeGreaterThan(0);
  });

  it("estimates a message with tool_use block", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool_1",
          name: "read",
          input: { path: "/home/user/project/src/index.ts" },
        },
      ],
    };
    const tokens = estimator.estimateMessage(msg);
    // Should account for JSON structure overhead
    expect(tokens).toBeGreaterThan(10);
  });

  it("estimates a message with tool_result block", () => {
    const msg = toolResultMessage([
      {
        type: "tool_result",
        toolUseId: "tool_1",
        content: "File contents: export const foo = 42;",
      },
    ]);
    const tokens = estimator.estimateMessage(msg);
    expect(tokens).toBeGreaterThan(5);
  });

  it("estimates a message with large tool_result", () => {
    const largeContent = "x".repeat(10000);
    const msg = toolResultMessage([
      {
        type: "tool_result",
        toolUseId: "tool_1",
        content: largeContent,
      },
    ]);
    const tokens = estimator.estimateMessage(msg);
    // 10000 × 0.25 = 2500 tokens + overhead
    expect(tokens).toBeGreaterThan(2400);
    expect(tokens).toBeLessThan(2700);
  });

  it("estimates a message with thinking block", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Let me think about this problem..." },
        { type: "text", text: "Here's my answer." },
      ],
    };
    const tokens = estimator.estimateMessage(msg);
    // Two blocks + message overhead
    expect(tokens).toBeGreaterThan(10);
  });

  it("estimates a message with image block", () => {
    const msg: Message = {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", mediaType: "image/png", data: "..." },
        },
        { type: "text", text: "What is in this image?" },
      ],
    };
    const tokens = estimator.estimateMessage(msg);
    // Image ≈ 1600 tokens + text + overheads
    expect(tokens).toBeGreaterThan(1600);
  });
});

// ─── TokenEstimator.estimateMessages ───

describe("TokenEstimator.estimateMessages", () => {
  const estimator = createTokenEstimator();

  it("returns 0 for empty array", () => {
    expect(estimator.estimateMessages([])).toBe(0);
  });

  it("sums token estimates for multiple messages", () => {
    const messages = [
      userMessage("Hello"),
      assistantMessage("Hi there!"),
      userMessage("How are you?"),
    ];
    const total = estimator.estimateMessages(messages);
    const sum =
      estimator.estimateMessage(messages[0]!) +
      estimator.estimateMessage(messages[1]!) +
      estimator.estimateMessage(messages[2]!);
    expect(total).toBe(sum);
  });

  it("handles a realistic multi-turn conversation", () => {
    const messages: Message[] = [
      userMessage("请帮我读取 package.json 文件"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "好的，我来读取文件。" },
          {
            type: "tool_use",
            id: "t1",
            name: "read",
            input: { path: "package.json" },
          },
        ],
      },
      toolResultMessage([
        {
          type: "tool_result",
          toolUseId: "t1",
          content: '{ "name": "my-project", "version": "1.0.0" }',
        },
      ]),
      assistantMessage(
        "package.json 的内容显示项目名称是 my-project，版本号是 1.0.0。",
      ),
    ];

    const total = estimator.estimateMessages(messages);
    // Should be reasonable for this conversation
    expect(total).toBeGreaterThan(30);
    expect(total).toBeLessThan(200);
  });
});

// ─── TokenEstimator.calibrate ───

describe("TokenEstimator.calibrate", () => {
  it("starts with calibration factor 1.0", () => {
    const estimator = createTokenEstimator();
    expect(estimator.calibrationFactor).toBe(1.0);
  });

  it("adjusts factor upward when estimates are too low", () => {
    const estimator = createTokenEstimator();
    // Estimated 100, actual 150 → we were 50% low
    estimator.calibrate(100, 150);
    expect(estimator.calibrationFactor).toBeGreaterThan(1.0);
  });

  it("adjusts factor downward when estimates are too high", () => {
    const estimator = createTokenEstimator();
    // Estimated 100, actual 70 → we were 30% high
    estimator.calibrate(100, 70);
    expect(estimator.calibrationFactor).toBeLessThan(1.0);
  });

  it("converges after multiple calibrations", () => {
    const estimator = createTokenEstimator();
    // Simulate: real ratio is ~1.3 (our estimates are 30% low)
    for (let i = 0; i < 20; i++) {
      estimator.calibrate(100, 130);
    }
    // Should converge to ~1.3
    expect(estimator.calibrationFactor).toBeGreaterThan(1.2);
    expect(estimator.calibrationFactor).toBeLessThan(1.4);
  });

  it("is stable with mixed signals (smoothing)", () => {
    const estimator = createTokenEstimator();
    // Alternating signals shouldn't cause wild swings
    for (let i = 0; i < 10; i++) {
      estimator.calibrate(100, i % 2 === 0 ? 150 : 80);
    }
    // Should be somewhere between 0.8 and 1.5, not at extremes
    expect(estimator.calibrationFactor).toBeGreaterThan(0.8);
    expect(estimator.calibrationFactor).toBeLessThan(1.5);
  });

  it("clamps to safe range", () => {
    const estimator = createTokenEstimator();
    // Extreme underestimate
    estimator.calibrate(1, 10000);
    expect(estimator.calibrationFactor).toBeLessThanOrEqual(3.0);

    // Extreme overestimate
    const estimator2 = createTokenEstimator();
    estimator2.calibrate(10000, 1);
    expect(estimator2.calibrationFactor).toBeGreaterThanOrEqual(0.5);
  });

  it("ignores zero or negative values", () => {
    const estimator = createTokenEstimator();
    estimator.calibrate(0, 100);
    expect(estimator.calibrationFactor).toBe(1.0);
    estimator.calibrate(100, 0);
    expect(estimator.calibrationFactor).toBe(1.0);
    estimator.calibrate(-1, 100);
    expect(estimator.calibrationFactor).toBe(1.0);
  });

  it("affects subsequent estimates", () => {
    const estimator = createTokenEstimator();
    const text = "Hello, world!";

    const before = estimator.estimateText(text);

    // Calibrate upward (our estimates were too low)
    for (let i = 0; i < 10; i++) {
      estimator.calibrate(100, 200);
    }

    const after = estimator.estimateText(text);
    expect(after).toBeGreaterThan(before);
  });
});

// ─── TokenEstimator with initial calibration ───

describe("TokenEstimator initial calibration", () => {
  it("accepts custom initial calibration factor", () => {
    const estimator = createTokenEstimator(1.3);
    expect(estimator.calibrationFactor).toBe(1.3);
  });

  it("clamps initial calibration to safe range", () => {
    const low = createTokenEstimator(0.1);
    expect(low.calibrationFactor).toBe(0.5);

    const high = createTokenEstimator(10.0);
    expect(high.calibrationFactor).toBe(3.0);
  });

  it("produces higher estimates with higher initial calibration", () => {
    const normal = createTokenEstimator(1.0);
    const boosted = createTokenEstimator(1.5);

    const text = "这是一段测试文本";
    expect(boosted.estimateText(text)).toBeGreaterThan(
      normal.estimateText(text),
    );
  });
});

// ─── Real-world accuracy sanity checks ───

describe("real-world accuracy sanity checks", () => {
  const estimator = createTokenEstimator();

  it("English text: estimate within 2x of chars/4 baseline", () => {
    const text =
      "The Anthropic API uses a tokenizer that typically produces about 1 token per 4 characters for English text. This is a reasonable approximation for most use cases.";
    const tokens = estimator.estimateText(text);
    const charsDiv4 = Math.ceil(text.length / 4);
    // Should be close to chars/4 for pure English
    expect(tokens).toBeGreaterThan(charsDiv4 * 0.8);
    expect(tokens).toBeLessThan(charsDiv4 * 1.5);
  });

  it("Chinese text: estimate reflects higher token density", () => {
    const text = "人工智能是计算机科学的一个分支，它企图了解智能的实质。";
    const tokens = estimator.estimateText(text);
    // Chinese: ~1.5 token/char → should be much higher than chars/4
    const charsDiv4 = Math.ceil(text.length / 4);
    expect(tokens).toBeGreaterThan(charsDiv4 * 2);
  });

  it("code snippet: reasonable estimate", () => {
    const code = `
export async function* runAgentLoop(
  params: AgentLoopParams,
): AsyncGenerator<AgentYield, AgentResult> {
  const { model, systemPrompt, abortSignal, eventBus } = params;
  const tools = params.tools ?? [];
  const maxTurns = params.maxTurns ?? 100;
}`.trim();
    const tokens = estimator.estimateText(code);
    // Code is mostly ASCII, ~chars/4
    expect(tokens).toBeGreaterThan(30);
    expect(tokens).toBeLessThan(80);
  });

  it("mixed Chinese+English prompt: balanced estimate", () => {
    const text = "请帮我修改 src/index.ts 文件，将 version 改为 2.0.0";
    const tokens = estimator.estimateText(text);
    // Mix of CJK (high weight) and ASCII (low weight)
    expect(tokens).toBeGreaterThan(15);
    expect(tokens).toBeLessThan(50);
  });
});
