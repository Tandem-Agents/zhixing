/**
 * wrapWithCalibration 单元测试 —— 验证透传契约与校准触发条件。
 *
 * 与 main agent loop 校准条件对账(都跳过 abort / error / 空 usage 样本)。
 */

import { describe, it, expect } from "vitest";
import { wrapWithCalibration } from "../calibration.js";
import type { ITokenEstimator } from "../../types.js";
import type { Message } from "../../../types/messages.js";
import type { StreamEvent, TokenUsage } from "../../../types/llm.js";

// ─── fixtures ───

function makeMessages(text = "hello"): Message[] {
  return [{ role: "user", content: [{ type: "text", text }] }];
}

interface CalibrateCall {
  estimated: number;
  actual: number;
}

function makeEstimator(estimatedReturn = 100): ITokenEstimator & {
  calibrateCalls: CalibrateCall[];
} {
  const calibrateCalls: CalibrateCall[] = [];
  return {
    calibrateCalls,
    estimateText: () => estimatedReturn,
    estimateMessage: () => estimatedReturn,
    estimateMessages: () => estimatedReturn,
    estimateTools: () => 0,
    calibrate(estimated: number, actual: number) {
      calibrateCalls.push({ estimated, actual });
    },
    get calibrationFactor() {
      return 1;
    },
  };
}

async function* streamOf(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e;
}

async function collect(
  stream: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const USAGE_NORMAL: TokenUsage = { inputTokens: 150, outputTokens: 50 };

// ─── 透传契约 ───

describe("wrapWithCalibration · 透传契约", () => {
  it("透传所有 stream events 顺序与上游一致", async () => {
    const events: StreamEvent[] = [
      { type: "message_start" },
      { type: "text_delta", text: "hi" },
      { type: "text_delta", text: " world" },
      { type: "message_end", stopReason: "end_turn", usage: USAGE_NORMAL },
    ];
    const estimator = makeEstimator();

    const collected = await collect(
      wrapWithCalibration(streamOf(events), {
        estimator,
        messages: makeMessages(),
      }),
    );

    expect(collected).toEqual(events);
  });
});

// ─── 校准触发条件 ───

describe("wrapWithCalibration · 校准触发", () => {
  it("成功完成 + 有 usage + inputTokens > 0 → calibrate 被调", async () => {
    const estimator = makeEstimator(120);
    await collect(
      wrapWithCalibration(
        streamOf([
          { type: "message_start" },
          {
            type: "message_end",
            stopReason: "end_turn",
            usage: USAGE_NORMAL,
          },
        ]),
        { estimator, messages: makeMessages() },
      ),
    );

    expect(estimator.calibrateCalls).toEqual([
      { estimated: 120, actual: 150 },
    ]);
  });

  it("无 message_end(stream 提前结束)→ usage 为 null,不 calibrate", async () => {
    const estimator = makeEstimator();
    await collect(
      wrapWithCalibration(
        streamOf([
          { type: "message_start" },
          { type: "text_delta", text: "partial" },
          // 没有 message_end —— 模拟 abort 提前退出
        ]),
        { estimator, messages: makeMessages() },
      ),
    );

    expect(estimator.calibrateCalls).toEqual([]);
  });

  it("usage.inputTokens === 0 → 不 calibrate(样本不可靠)", async () => {
    const estimator = makeEstimator();
    await collect(
      wrapWithCalibration(
        streamOf([
          {
            type: "message_end",
            stopReason: "end_turn",
            usage: { inputTokens: 0, outputTokens: 0 },
          },
        ]),
        { estimator, messages: makeMessages() },
      ),
    );

    expect(estimator.calibrateCalls).toEqual([]);
  });

  it("error event 后即使有 usage → 不 calibrate", async () => {
    const estimator = makeEstimator();
    await collect(
      wrapWithCalibration(
        streamOf([
          { type: "message_start" },
          {
            type: "error",
            error: new Error("provider failed"),
          },
          // 即使后续有 message_end,errored 已设
          {
            type: "message_end",
            stopReason: "end_turn",
            usage: USAGE_NORMAL,
          },
        ]),
        { estimator, messages: makeMessages() },
      ),
    );

    expect(estimator.calibrateCalls).toEqual([]);
  });

  it("上游 stream 抛错 → 错误透传,不 calibrate(generator 中断 finally 后逻辑跳过)", async () => {
    const estimator = makeEstimator();
    const upstream = (async function* (): AsyncIterable<StreamEvent> {
      yield { type: "message_start" };
      throw new Error("upstream boom");
    })();

    await expect(
      collect(
        wrapWithCalibration(upstream, {
          estimator,
          messages: makeMessages(),
        }),
      ),
    ).rejects.toThrow("upstream boom");

    expect(estimator.calibrateCalls).toEqual([]);
  });
});

// ─── messages 透传到 estimateMessages ───

describe("wrapWithCalibration · estimate 输入对账", () => {
  it("estimateMessages 接收 options.messages —— 与 LLM 实际处理的 size 对账", async () => {
    let receivedMessages: readonly Message[] | null = null;
    const estimator: ITokenEstimator = {
      estimateText: () => 0,
      estimateMessage: () => 0,
      estimateMessages: (msgs) => {
        receivedMessages = msgs;
        return 99;
      },
      estimateTools: () => 0,
      calibrate: () => {},
      get calibrationFactor() {
        return 1;
      },
    };
    const expectedMessages = makeMessages("段切换压缩指令");

    await collect(
      wrapWithCalibration(
        streamOf([
          {
            type: "message_end",
            stopReason: "end_turn",
            usage: USAGE_NORMAL,
          },
        ]),
        { estimator, messages: expectedMessages },
      ),
    );

    expect(receivedMessages).toBe(expectedMessages);
  });
});
