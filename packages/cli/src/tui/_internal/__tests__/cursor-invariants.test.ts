/**
 * cursor-invariants.ts 单元测试
 *
 * 覆盖点（§6.4 两类护栏断言是重点）：
 *   1. 首次 render 不 moveUp（lastHeight=0 时）
 *   2. 后续 render 一次性上移 lastHeight 行（不是 lastHeight-1）
 *   3. 每行结尾是 \r\n（不是 \n），前缀是 \r\x1b[2K
 *   4. render 后 lastRenderHeight 等于行数
 *   5. 连续两次 render 相同 lines 产生相同帧（帧 diff 恒等）
 *   6. 渲染次数恒等式：K 次 render N 行 → K*N 次 clearLine（护栏 #11）
 *   7. clear() 上移 lastHeight 行 + clearBelow + 重置 lastHeight
 *   8. lastHeight=0 时 clear() 是 no-op
 *   9. render 0 行：清零 lastHeight，下次不 moveUp
 *  10. render → clear → render：第二次 render 从 startRow 开始，不叠加
 */

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createPanelRenderer } from "../cursor-invariants.js";

/** 构造一个 stdout PassThrough，收集所有写入的文本 */
function makeStdout() {
  const stream = new PassThrough();
  let captured = "";
  stream.on("data", (chunk: Buffer | string) => {
    captured += chunk.toString("utf8");
  });
  return {
    stdout: stream as unknown as NodeJS.WriteStream,
    getCaptured: () => captured,
    clearCaptured: () => {
      captured = "";
    },
  };
}

/** 统计某个 substring 出现次数 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

describe("createPanelRenderer — render 语义", () => {
  it("首次 render 不发出 moveUp（lastHeight=0）", () => {
    const { stdout, getCaptured } = makeStdout();
    const panel = createPanelRenderer(stdout);
    panel.render(["line1", "line2", "line3"]);

    const captured = getCaptured();
    // 首次 render 不应包含 \x1b[{N}A（moveUp）
    expect(captured).not.toMatch(/\x1b\[\d+A/);
    // 但应包含 3 个 clearLine
    expect(countOccurrences(captured, "\x1b[2K")).toBe(3);
  });

  it("第二次 render 发出 moveUp(lastHeight)，不是 moveUp(N-1)", () => {
    const { stdout, getCaptured, clearCaptured } = makeStdout();
    const panel = createPanelRenderer(stdout);
    panel.render(["a", "b", "c", "d"]); // lastHeight=4
    clearCaptured();

    panel.render(["e", "f", "g", "d"]);
    const captured = getCaptured();
    // 整帧由同步输出 BSU 包头，紧接 moveUp(lastHeight)；必须是 \x1b[4A 不是 \x1b[3A
    expect(captured).toMatch(/^\x1b\[\?2026h\x1b\[4A/);
    expect(captured).not.toMatch(/^\x1b\[\?2026h\x1b\[3A/);
  });

  it("lastRenderHeight 在 render 后正确更新", () => {
    const { stdout } = makeStdout();
    const panel = createPanelRenderer(stdout);
    expect(panel.lastRenderHeight).toBe(0);
    panel.render(["a", "b"]);
    expect(panel.lastRenderHeight).toBe(2);
    panel.render(["a", "b", "c"]);
    expect(panel.lastRenderHeight).toBe(3);
    panel.render(["x"]);
    expect(panel.lastRenderHeight).toBe(1);
  });

  it("每行前缀 \\r\\x1b[2K + 后缀 \\r\\n（陷阱 1）", () => {
    const { stdout, getCaptured } = makeStdout();
    const panel = createPanelRenderer(stdout);
    panel.render(["hello"]);

    const captured = getCaptured();
    // 必须包含 \r\x1b[2Khello\r\n
    expect(captured).toContain("\r\x1b[2Khello\r\n");
    // 且不含任何裸 \n（除 \r\n 的一部分之外）
    const withoutCrlf = captured.replace(/\r\n/g, "");
    expect(withoutCrlf).not.toContain("\n");
  });

  it("render 空数组：lastHeight 变 0，下次 render 不 moveUp", () => {
    const { stdout, getCaptured, clearCaptured } = makeStdout();
    const panel = createPanelRenderer(stdout);
    panel.render(["a", "b"]);
    clearCaptured();

    panel.render([]);
    expect(panel.lastRenderHeight).toBe(0);
    // 这次 render 应发出 moveUp(2) 回到 startRow，但没有行要写
    const captured = getCaptured();
    expect(captured).toContain("\x1b[2A");

    clearCaptured();
    panel.render(["c"]);
    const captured2 = getCaptured();
    // 因为上次 render([]) 后 lastHeight=0，这次不应 moveUp
    expect(captured2).not.toMatch(/\x1b\[\d+A/);
  });
});

describe("createPanelRenderer — 护栏断言", () => {
  it("护栏 #1：K 次 render N 行 → K*N 次 clearLine（渲染次数恒等式）", () => {
    const { stdout, getCaptured } = makeStdout();
    const panel = createPanelRenderer(stdout);
    const N = 5;
    const K = 8;
    const lines = Array.from({ length: N }, (_, i) => `line${i}`);
    for (let k = 0; k < K; k++) {
      panel.render(lines);
    }
    const captured = getCaptured();
    expect(countOccurrences(captured, "\x1b[2K")).toBe(K * N);
  });

  it("护栏 #2：连续两次 render 相同 lines 产生相同帧（帧 diff 恒等）", () => {
    const { stdout, getCaptured, clearCaptured } = makeStdout();
    const panel = createPanelRenderer(stdout);
    const lines = ["╭─ title ───╮", "│ body     │", "╰──────────╯"];

    // 第一次渲染：产生首帧
    panel.render(lines);
    clearCaptured();

    // 第二次渲染：先 moveUp(3) 再覆盖，去掉 moveUp 前缀后应等于首次 render 的内容
    panel.render(lines);
    const frame2 = getCaptured();
    // 剥掉开头的 BSU + moveUp + col0 序列；BSU 是同步输出包头
    const frame2Stripped = frame2.replace(/^\x1b\[\?2026h\x1b\[\d+A\r/, "");

    // 把 frame2Stripped 应等于一次 render 输出剥掉 BSU 包头后的内容
    // 构造对照：独立 panel 做一次首渲染
    const { stdout: refStdout, getCaptured: refGet } = makeStdout();
    const refPanel = createPanelRenderer(refStdout);
    refPanel.render(lines);
    const frame1 = refGet();
    const frame1Stripped = frame1.replace(/^\x1b\[\?2026h/, "");

    expect(frame2Stripped).toBe(frame1Stripped);
  });
});

describe("createPanelRenderer — clear 语义", () => {
  it("clear() 上移 lastHeight 行 + clearBelow", () => {
    const { stdout, getCaptured, clearCaptured } = makeStdout();
    const panel = createPanelRenderer(stdout);
    panel.render(["a", "b", "c"]);
    clearCaptured();

    panel.clear();
    const captured = getCaptured();
    expect(captured).toContain("\x1b[3A"); // moveUp(3)
    expect(captured).toContain("\x1b[J"); // clearBelow
    expect(panel.lastRenderHeight).toBe(0);
  });

  it("lastHeight=0 时 clear() 是 no-op", () => {
    const { stdout, getCaptured } = makeStdout();
    const panel = createPanelRenderer(stdout);
    panel.clear();
    expect(getCaptured()).toBe("");
    expect(panel.lastRenderHeight).toBe(0);
  });

  it("render → clear → render：第二次 render 从 startRow 开始，不叠加", () => {
    const { stdout, getCaptured, clearCaptured } = makeStdout();
    const panel = createPanelRenderer(stdout);
    panel.render(["old1", "old2"]);
    panel.clear();
    clearCaptured();

    // clear 后 lastHeight=0，此次 render 不应 moveUp
    panel.render(["new1", "new2", "new3"]);
    const captured = getCaptured();
    expect(captured).not.toMatch(/\x1b\[\d+A/);
    // 应包含 3 次 clearLine（每行一次）
    expect(countOccurrences(captured, "\x1b[2K")).toBe(3);
    expect(panel.lastRenderHeight).toBe(3);
  });

  it("clear 之后重复 clear 不产生额外输出", () => {
    const { stdout, getCaptured, clearCaptured } = makeStdout();
    const panel = createPanelRenderer(stdout);
    panel.render(["x"]);
    panel.clear();
    clearCaptured();

    panel.clear();
    panel.clear();
    expect(getCaptured()).toBe("");
  });
});
