import { describe, expect, it } from "vitest";
import { createStdoutWriter, type CliWriter } from "../cli-writer.js";

class FakeStdout {
  buffer = "";
  isTTY = true;
  columns = 80;
  write(s: string): boolean {
    this.buffer += s;
    return true;
  }
}

describe("StdoutWriter · 直写 stdout（无协调）", () => {
  function makeStdoutWriter(): { writer: CliWriter; out: FakeStdout } {
    const out = new FakeStdout();
    const writer = createStdoutWriter({
      stdout: out as unknown as NodeJS.WriteStream,
    });
    return { writer, out };
  }

  it("line 自动补 \\n 让每段独立落地", () => {
    const { writer, out } = makeStdoutWriter();
    writer.line("hello");
    expect(out.buffer).toBe("hello\n");
  });

  it("line 末尾已是 \\n 不重复补", () => {
    const { writer, out } = makeStdoutWriter();
    writer.line("hello\n");
    expect(out.buffer).toBe("hello\n");
  });

  it("空 line 写一个 \\n（空行）", () => {
    const { writer, out } = makeStdoutWriter();
    writer.line("");
    expect(out.buffer).toBe("\n");
  });

  it("appendInline 不补 \\n——LLM 流式 chunk 接续", () => {
    const { writer, out } = makeStdoutWriter();
    writer.appendInline("你好");
    writer.appendInline("世界");
    expect(out.buffer).toBe("你好世界");
  });

  it("空 appendInline 是 no-op", () => {
    const { writer, out } = makeStdoutWriter();
    writer.appendInline("");
    expect(out.buffer).toBe("");
  });

  it("notify 等同 line（自动补 \\n）", () => {
    const { writer, out } = makeStdoutWriter();
    writer.notify("scheduler done");
    expect(out.buffer).toBe("scheduler done\n");
  });

  it("混合用法：line 段落 + appendInline 流式 + 段间独立", () => {
    const { writer, out } = makeStdoutWriter();
    writer.line("段落 A");
    writer.appendInline("流");
    writer.appendInline("式");
    writer.appendInline("接续");
    writer.line(""); // 强制结束流式段，进入新行
    writer.line("段落 B");
    expect(out.buffer).toBe("段落 A\n流式接续\n段落 B\n");
  });

  describe("ensureSegmentBreak · stdout 模式 no-op（无 chrome 视觉协调职责）", () => {
    // 架构契约：StdoutWriter 用于 pipe / CI / log 场景——消费者关心稳定 stream
    // 格式（ndjson / awk 解析等），不需要也不应当被加入"段间视觉空行"。视觉
    // 间距由 ScreenWriter（chrome 模式）独家负责。

    it("ensureSegmentBreak 不写任何字节——pipe / CI 模式 stream 格式稳定", () => {
      const { writer, out } = makeStdoutWriter();
      writer.line("段 A");
      writer.ensureSegmentBreak();
      writer.line("段 B");
      // 无间距 emit——caller 调 ensureSegmentBreak 在 stdout 模式下静默
      expect(out.buffer).toBe("段 A\n段 B\n");
    });

    it("多次调 ensureSegmentBreak 仍 no-op（幂等成无操作）", () => {
      const { writer, out } = makeStdoutWriter();
      writer.ensureSegmentBreak();
      writer.ensureSegmentBreak();
      writer.ensureSegmentBreak();
      expect(out.buffer).toBe("");
    });

    it("mid-line appendInline 后 ensureSegmentBreak 也 no-op（不主动收口）", () => {
      const { writer, out } = makeStdoutWriter();
      writer.appendInline("接续中");
      writer.ensureSegmentBreak();
      writer.line("新段");
      // 接续中（无 \n） + 新段\n = "接续中新段\n" —— 收口由后续 line 自己保证
      expect(out.buffer).toBe("接续中新段\n");
    });
  });
});
