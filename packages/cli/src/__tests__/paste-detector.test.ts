import { describe, expect, it, vi } from "vitest";
import { wrapKeypressHandler } from "../paste-detector.js";

function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const KEY = (name: string) => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
  sequence: name,
});

describe("wrapKeypressHandler — 单 keypress 路径", () => {
  it("单字符敲键走 onSingle，不触发 onPaste", async () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { handler } = wrapKeypressHandler({ onSingle, onPaste });

    handler("a", KEY("a"));
    await tick();

    expect(onSingle).toHaveBeenCalledTimes(1);
    expect(onSingle).toHaveBeenCalledWith("a", KEY("a"));
    expect(onPaste).not.toHaveBeenCalled();
  });

  it("两次异步 emit 之间 microtask drain → 各自走 onSingle", async () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { handler } = wrapKeypressHandler({ onSingle, onPaste });

    handler("a", KEY("a"));
    await tick(); // microtask drain → 第一个 batch flush
    handler("b", KEY("b"));
    await tick();

    expect(onSingle).toHaveBeenCalledTimes(2);
    expect(onPaste).not.toHaveBeenCalled();
  });

  it("return key（用户按 Enter）走 onSingle", async () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { handler } = wrapKeypressHandler({ onSingle, onPaste });

    handler("\r", KEY("return"));
    await tick();

    expect(onSingle).toHaveBeenCalledWith("\r", KEY("return"));
    expect(onPaste).not.toHaveBeenCalled();
  });
});

describe("wrapKeypressHandler — paste 路径（同步多 keypress）", () => {
  it("同步连续多次 keypress 走 onPaste，content 是字符拼接", async () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { handler } = wrapKeypressHandler({ onSingle, onPaste });

    // 模拟 readline 同步 emit 多次 keypress（粘贴）
    handler("a", KEY("a"));
    handler("b", KEY("b"));
    handler("c", KEY("c"));
    await tick();

    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onPaste).toHaveBeenCalledWith("abc");
    expect(onSingle).not.toHaveBeenCalled();
  });

  it("paste 含 \\n 字符正确包含在 content 内（return key str 字段空）", async () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { handler } = wrapKeypressHandler({ onSingle, onPaste });

    // 模拟 readline 实际行为：return key 的 str 是空字符串而非 \n
    handler("l", KEY("l"));
    handler("i", KEY("i"));
    handler("", KEY("return"));
    handler("n", KEY("n"));
    handler("e", KEY("e"));
    await tick();

    expect(onPaste).toHaveBeenCalledWith("li\nne");
    expect(onSingle).not.toHaveBeenCalled();
  });

  it("paste 含 enter key 也转 \\n", async () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { handler } = wrapKeypressHandler({ onSingle, onPaste });

    handler("a", KEY("a"));
    handler("", KEY("enter"));
    handler("b", KEY("b"));
    await tick();

    expect(onPaste).toHaveBeenCalledWith("a\nb");
  });

  it("paste 多行内容里的 \\r\\n 序列还原为 \\n", async () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { handler } = wrapKeypressHandler({ onSingle, onPaste });

    handler("1", KEY("1"));
    handler("", { ...KEY("return"), sequence: "\r" });
    handler("2", KEY("2"));
    handler("", { ...KEY("return"), sequence: "\r" });
    handler("3", KEY("3"));
    await tick();

    expect(onPaste).toHaveBeenCalledWith("1\n2\n3");
  });

  it("paste 含 ESC sequence keypress（str 为空）正确处理", async () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { handler } = wrapKeypressHandler({ onSingle, onPaste });

    // ESC sequence keypress 通常 str 为空字符串
    handler("a", KEY("a"));
    handler("", { name: undefined, sequence: "\x1b[200~" } as never);
    handler("b", KEY("b"));
    await tick();

    expect(onPaste).toHaveBeenCalledWith("ab");
  });

  it("两次独立 paste（中间 microtask drain）各自触发 onPaste", async () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { handler } = wrapKeypressHandler({ onSingle, onPaste });

    handler("a", KEY("a"));
    handler("b", KEY("b"));
    await tick();
    handler("c", KEY("c"));
    handler("d", KEY("d"));
    await tick();

    expect(onPaste).toHaveBeenCalledTimes(2);
    expect(onPaste.mock.calls[0]![0]).toBe("ab");
    expect(onPaste.mock.calls[1]![0]).toBe("cd");
  });

  it("CJK 字符 paste 正确拼接", async () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { handler } = wrapKeypressHandler({ onSingle, onPaste });

    handler("你", KEY("你"));
    handler("好", KEY("好"));
    await tick();

    expect(onPaste).toHaveBeenCalledWith("你好");
  });
});

describe("wrapKeypressHandler — release 行为", () => {
  it("release 清理 pending timer + flush 单 keypress 残余", () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { handler, release } = wrapKeypressHandler({ onSingle, onPaste });

    handler("a", KEY("a"));
    // 立即 release，未达 timer
    release();

    expect(onSingle).toHaveBeenCalledWith("a", KEY("a"));
    expect(onPaste).not.toHaveBeenCalled();
  });

  it("release 时 batch ≥ 2（pending paste）丢弃，不调 onPaste", () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { handler, release } = wrapKeypressHandler({ onSingle, onPaste });

    handler("a", KEY("a"));
    handler("b", KEY("b"));
    release();

    expect(onSingle).not.toHaveBeenCalled();
    expect(onPaste).not.toHaveBeenCalled();
  });

  it("release 后 handler 调用被 ignore（cleanup 终态）", async () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { handler, release } = wrapKeypressHandler({ onSingle, onPaste });

    release();
    handler("x", KEY("x"));
    await tick();

    expect(onSingle).not.toHaveBeenCalled();
    expect(onPaste).not.toHaveBeenCalled();
  });

  it("release 幂等", () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { release } = wrapKeypressHandler({ onSingle, onPaste });

    release();
    expect(() => release()).not.toThrow();
  });
});

describe("wrapKeypressHandler — 边界场景", () => {
  it("空字符串 keypress（仅 key 无 str）正确处理", async () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { handler } = wrapKeypressHandler({ onSingle, onPaste });

    handler("", KEY("up"));
    await tick();

    expect(onSingle).toHaveBeenCalledWith("", KEY("up"));
  });

  it("undefined str 转空字符串", async () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { handler } = wrapKeypressHandler({ onSingle, onPaste });

    handler(undefined as unknown as string, KEY("a"));
    await tick();

    expect(onSingle).toHaveBeenCalledWith("", KEY("a"));
  });

  it("paste batch 中包含 undefined str 不破坏拼接", async () => {
    const onSingle = vi.fn();
    const onPaste = vi.fn();
    const { handler } = wrapKeypressHandler({ onSingle, onPaste });

    handler("a", KEY("a"));
    handler(undefined as unknown as string, KEY("up"));
    handler("b", KEY("b"));
    await tick();

    expect(onPaste).toHaveBeenCalledWith("ab");
  });
});
