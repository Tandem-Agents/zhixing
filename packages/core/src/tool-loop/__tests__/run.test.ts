/**
 * 轻量工具循环测试 —— 全程注入 mock（complete / 工具 / onProgress），无真网、无真 LLM、
 * 无定时器。覆盖六类路径：done / 护栏自愈 / exhausted / 解析容错 / 工具错误回灌 / 框架级错误，
 * 外加 abort 与进度。
 */

import { describe, expect, it, vi } from "vitest";
import { runToolLoop } from "../run.js";
import type { ToolLoopDeps, ToolLoopSpec, ToolLoopTool } from "../types.js";

const SCHEMA = { type: "object" as const };

function makeTool(name: string, run: ToolLoopTool["run"]): ToolLoopTool {
  return { name, description: `${name} 工具`, inputSchema: SCHEMA, run };
}

/** 按序返回脚本化决策；用尽后兜底一个 final，避免误入死循环。 */
function scripted(...responses: string[]): ToolLoopDeps["complete"] {
  let i = 0;
  return vi.fn(async () => responses[i++] ?? '{"final":"_exhausted_fallback_"}');
}

function spec(
  tools: ToolLoopTool[],
  maxRounds = 5,
  parseFinal: ToolLoopSpec<unknown>["parseFinal"] = (payload) => ({ ok: true, result: payload }),
): ToolLoopSpec<unknown> {
  return { goal: "测试任务", tools, maxRounds, parseFinal };
}

describe("runToolLoop", () => {
  it("调工具拿真实结果 → final → done（携带轮数）", async () => {
    const search = vi.fn(async () => ["pkgA", "pkgB"]);
    const complete = scripted(
      '{"call":{"tool":"search","input":{"q":"x"}}}',
      '{"final":{"picked":"pkgA"}}',
    );
    const r = await runToolLoop(spec([makeTool("search", search)]), { complete });
    expect(search).toHaveBeenCalledOnce();
    expect(r.kind).toBe("done");
    if (r.kind === "done") {
      expect(r.result).toEqual({ picked: "pkgA" });
      expect(r.rounds).toBe(2);
    }
  });

  it("parseFinal reject 回灌 → LLM 修正后 done（护栏自愈）", async () => {
    const complete = scripted('{"final":"bad"}', '{"final":"good"}');
    let calls = 0;
    const parseFinal = (p: unknown) => {
      calls++;
      return p === "good"
        ? { ok: true as const, result: p }
        : { ok: false as const, reason: "不符合要求" };
    };
    const r = await runToolLoop(spec([], 5, parseFinal), { complete });
    expect(calls).toBe(2);
    expect(r.kind).toBe("done");
  });

  it("恒调工具不收尾 → exhausted（轮数到顶）", async () => {
    const search = vi.fn(async () => ["x"]);
    const complete = vi.fn(async () => '{"call":{"tool":"search","input":{}}}');
    const r = await runToolLoop(spec([makeTool("search", search)], 3), { complete });
    expect(r.kind).toBe("exhausted");
    if (r.kind === "exhausted") expect(r.rounds).toBe(3);
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("容忍代码围栏 / 噪声；不可解析 → 回灌纠错后继续", async () => {
    const complete = scripted(
      "抱歉我先想想（无 JSON）",
      "```json\n{\"final\":\"ok\"}\n```",
    );
    const r = await runToolLoop(spec([]), { complete });
    expect(r.kind).toBe("done");
    if (r.kind === "done") expect(r.rounds).toBe(2);
  });

  it("工具 run 抛错 → 回灌、不终止，LLM 据此收尾", async () => {
    const search = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const complete = scripted(
      '{"call":{"tool":"search","input":{}}}',
      '{"final":"despite-error"}',
    );
    const r = await runToolLoop(spec([makeTool("search", search)]), { complete });
    expect(search).toHaveBeenCalledOnce();
    expect(r.kind).toBe("done");
  });

  it("调用不存在的工具 → 回灌可用工具名、不终止", async () => {
    const complete = scripted('{"call":{"tool":"nope","input":{}}}', '{"final":"ok"}');
    const r = await runToolLoop(spec([makeTool("search", async () => [])]), { complete });
    expect(r.kind).toBe("done");
  });

  it("complete（LLM 调用）抛错 → error（框架级失败）", async () => {
    const complete = vi.fn(async () => {
      throw new Error("model down");
    });
    const r = await runToolLoop(spec([]), { complete });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.reason).toContain("model down");
  });

  it("已 abort → error(aborted)，不调 complete", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const complete = vi.fn(async () => '{"final":"x"}');
    const r = await runToolLoop(spec([]), { complete }, ctrl.signal);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.reason).toBe("aborted");
    expect(complete).not.toHaveBeenCalled();
  });

  it("onProgress 报 deciding/calling 事件；回调抛错被吞、不影响结果", async () => {
    const events: string[] = [];
    const onProgress = vi.fn((p: { round: number; phase: string; tool?: string }) => {
      events.push(`${p.round}:${p.phase}${p.tool ? `:${p.tool}` : ""}`);
      throw new Error("ui boom"); // 进度回调抛错不应坏主循环
    });
    const complete = scripted(
      '{"call":{"tool":"search","input":{"q":"a"}}}',
      '{"final":"ok"}',
    );
    const r = await runToolLoop(spec([makeTool("search", async () => ["x"])]), {
      complete,
      onProgress,
    });
    expect(r.kind).toBe("done");
    expect(events).toEqual(["1:deciding", "1:calling:search", "2:deciding"]);
  });
});
