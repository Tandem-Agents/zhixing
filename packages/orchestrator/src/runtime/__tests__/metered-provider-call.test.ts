import { describe, expect, it } from "vitest";
import type { ChatRequest, StreamEvent } from "@zhixing-ai/core/types";
import type { ModelCallResourceMeter } from "@zhixing-ai/core/contracts";
import { markRequestUndelivered } from "@zhixing-ai/core/resilience";
import { meteredProviderCall } from "../create-agent-runtime.js";

const REQUEST: ChatRequest = { model: "test-model", messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
const coded = (code: string) => Object.assign(new Error(`connect ${code}`), { code });
const unmarked = (code: string) => Object.assign(new Error("Connection error."), { cause: Object.assign(new TypeError("fetch failed"), { cause: coded(code) }) });
/** 受控传输已证明整次调用都没送达的错误（真实传输的证明见 cli 回环用例） */
const connectionError = (code: string) => { const error = unmarked(code); markRequestUndelivered(error); return error; };

function fixture(call: (request: ChatRequest) => AsyncGenerator<StreamEvent, void, undefined>) {
  const consumed: { usageId: string; tokens: number }[] = [];
  let index = 0;
  const meter: ModelCallResourceMeter = {
    reserve: async ({ callIndex }) => ({ usageId: `usage:${callIndex}` }),
    consume: async (usage) => { consumed.push(usage); },
  };
  const run = async () => {
    const events: StreamEvent[] = [];
    try {
      for await (const event of meteredProviderCall({ call, meter, nextCallIndex: () => ++index, defaultMaxOutputTokens: 100 })(REQUEST)) events.push(event);
    } catch (error) { return { events, error }; }
    return { events };
  };
  return { consumed, run };
}

describe("meteredProviderCall · 失败尝试的预占收束", () => {
  it("拒绝连接、只有适配器在发请求前产出的 message_start：请求未发出，按 0 token 收束本次预占", async () => {
    // 两个真实适配器都在发请求之前先产出 message_start（9840 真机上曾因此一次都没收束）
    const { consumed, run } = fixture(async function* () {
      yield { type: "message_start" };
      yield { type: "error", error: connectionError("ECONNREFUSED") };
    });
    const { events } = await run();
    expect(events.map((event) => event.type)).toEqual(["message_start", "error"]);
    expect(consumed).toEqual([{ usageId: "usage:1", tokens: 0 }]);
  });

  it("一个事件都没有就拒绝连接同样收束", async () => {
    const { consumed, run } = fixture(async function* () { yield { type: "error", error: connectionError("ECONNREFUSED") }; });
    await run();
    expect(consumed).toEqual([{ usageId: "usage:1", tokens: 0 }]);
  });

  it("以异常抛出的未发出失败同样收束", async () => {
    const { consumed, run } = fixture(async function* () { throw connectionError("ENOTFOUND"); });
    const { error } = await run();
    expect((error as Error).message).toBe("Connection error.");
    expect(consumed).toEqual([{ usageId: "usage:1", tokens: 0 }]);
  });

  it("发出后中断（连接重置）不收束：保留预占", async () => {
    const { consumed, run } = fixture(async function* () { yield { type: "error", error: unmarked("ECONNRESET") }; });
    await run();
    expect(consumed).toEqual([]);
  });

  it("没有传输证明的拒连（如首跳已收到请求、跟随跳转后才被拒）不收束", async () => {
    const { consumed, run } = fixture(async function* () {
      yield { type: "message_start" };
      yield { type: "error", error: unmarked("ECONNREFUSED") };
    });
    await run();
    expect(consumed).toEqual([]);
  });

  it("已收到服务端内容后才失败：即使是拒绝连接也不收束", async () => {
    const { consumed, run } = fixture(async function* () {
      yield { type: "message_start" };
      yield { type: "text_delta", text: "partial" };
      yield { type: "error", error: connectionError("ECONNREFUSED") };
    });
    await run();
    expect(consumed).toEqual([]);
  });

  it("收束失败不盖住原始失败", async () => {
    let index = 0;
    const events: StreamEvent[] = [];
    const meter: ModelCallResourceMeter = { reserve: async () => ({ usageId: "u" }), consume: async () => { throw new Error("governor unavailable"); } };
    for await (const event of meteredProviderCall({ call: async function* () { yield { type: "error", error: connectionError("ECONNREFUSED") }; }, meter, nextCallIndex: () => ++index, defaultMaxOutputTokens: 100 })(REQUEST)) events.push(event);
    expect((events.at(-1) as Extract<StreamEvent, { type: "error" }>).error.message).toBe("Connection error.");
  });

  it("成功调用照旧按实际用量收束一次", async () => {
    const { consumed, run } = fixture(async function* () {
      yield { type: "message_start" };
      yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 4 } };
    });
    await run();
    expect(consumed).toEqual([{ usageId: "usage:1", tokens: 7 }]);
  });
});
