/**
 * selectWithInput 组件测试
 *
 * 覆盖 spec §9.2 Step 2 要求的 16 条场景，特别是 #11 和 #12 的"渲染帧"
 * 护栏——这两条测试是阻止 spec §6.4 cursor off-by-one bug 回归的关键。
 *
 * 测试路径：in-process PassThrough 流 + 脚本化键盘事件。
 * 无需 spawn 子进程，不依赖真 TTY。
 */

import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringWidth } from "../line-width.js";
import {
  _getRawModeRefcount,
  _resetRawModeRefcountForTests,
  selectWithInput,
  type SelectOption,
  type SelectResult,
} from "../select-with-input.js";

// ─── 测试辅助 ───

/**
 * 构造 PassThrough 流对 (stdin, stdout) 用作组件输入输出。
 * 模拟非 TTY：raw mode 调用会被 enterRawMode/exitRawMode 跳过。
 */
function makeStreams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  // 显式标记非 TTY（PassThrough 默认 undefined 也不会命中 isTTY 为 true）
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdout as unknown as { isTTY: boolean }).isTTY = false;

  let captured = "";
  stdout.on("data", (chunk: Buffer | string) => {
    captured += chunk.toString("utf8");
  });

  return {
    stdin,
    stdout,
    getCaptured: () => captured,
    clearCaptured: () => {
      captured = "";
    },
  };
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const BACKSPACE = "\x7f";

/**
 * 把一组键顺序写入 stdin。每次 write 后让事件循环转一圈，让组件
 * 处理完当前 keypress 并重绘后再写下一个。
 */
async function sendKeys(
  stdin: NodeJS.WritableStream,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    stdin.write(key);
    // 1 tick 给 keypress 事件一次传播机会
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * 直接发射一个合成的 keypress 事件，绕过 Node 的字节级解析器。
 *
 * 为什么需要：脚本化 stdin 写入无法表达"单独按下 Escape"——Node 的
 * readline 解析器会把 `\x1b` 和紧跟其后的字节合并成 meta-modified key 或
 * CSI 序列。真实 TTY 里键盘按键天然有时间间隔所以 bare Escape 能工作，
 * 测试里需要这个 escape-hatch。
 *
 * 其它特殊键（如 F1-F12）在测试中也用此 helper 发射。
 */
async function sendSyntheticKey(
  stdin: NodeJS.ReadableStream,
  key: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string },
): Promise<void> {
  (stdin as unknown as NodeJS.EventEmitter).emit(
    "keypress",
    key.sequence,
    {
      name: key.name,
      ctrl: key.ctrl ?? false,
      meta: key.meta ?? false,
      shift: key.shift ?? false,
      sequence: key.sequence ?? "",
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
}

/** 构造一组标准选项，含一个 simple 和一个 input */
function makeDefaultOptions(): SelectOption[] {
  return [
    { type: "simple", value: "allow-once", label: "允许一次" },
    { type: "simple", value: "allow-session", label: "会话内允许" },
    {
      type: "input",
      value: "allow-with-note",
      label: "允许并补充",
      placeholder: "追加说明",
      allowEmptySubmit: true,
    },
    {
      type: "input",
      value: "deny",
      label: "拒绝",
      placeholder: "告诉 Claude 原因",
      allowEmptySubmit: true,
    },
  ];
}

beforeEach(() => {
  _resetRawModeRefcountForTests();
});

afterEach(() => {
  _resetRawModeRefcountForTests();
});

// ─── 场景 1: 首项 Enter → value ───

describe("selectWithInput — 场景 1-10", () => {
  it("1. 首项 Enter 直接返回 value（默认聚焦第一项）", async () => {
    const { stdin, stdout } = makeStreams();
    const promise = selectWithInput({
      title: "test",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 80,
    });
    await sendKeys(stdin, [ENTER]);
    const result = await promise;
    expect(result).toEqual({ kind: "selected", value: "allow-once" });
  });

  // ─── 场景 2: 多次 down + Enter ───

  it("2. 多次 down + Enter 选中第二项", async () => {
    const { stdin, stdout } = makeStreams();
    const promise = selectWithInput({
      title: "test",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 80,
    });
    await sendKeys(stdin, [DOWN, ENTER]);
    const result = await promise;
    expect(result).toEqual({ kind: "selected", value: "allow-session" });
  });

  // ─── 场景 3: Ctrl+C ───

  it("3. Ctrl+C 任意时刻都取消为 ctrl-c cause", async () => {
    const { stdin, stdout } = makeStreams();
    const promise = selectWithInput({
      title: "test",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 80,
    });
    await sendKeys(stdin, [DOWN, CTRL_C]);
    const result = await promise;
    expect(result).toEqual({ kind: "cancelled", cause: "ctrl-c" });
  });

  // ─── 场景 4: Ctrl+D ───

  it("4. Ctrl+D 任意时刻都取消为 ctrl-d cause", async () => {
    const { stdin, stdout } = makeStreams();
    const promise = selectWithInput({
      title: "test",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 80,
    });
    await sendKeys(stdin, [CTRL_D]);
    const result = await promise;
    expect(result).toEqual({ kind: "cancelled", cause: "ctrl-d" });
  });

  // ─── 场景 5: Enter 进入 input 模式，typing → buffer 累积 ───

  it("5. Enter 进入 input 模式后打字累积到 buffer", async () => {
    const { stdin, stdout } = makeStreams();
    const promise = selectWithInput({
      title: "test",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 80,
    });
    // down×2 到 "允许并补充"
    // Enter 进 input 模式
    // "hi" 输入
    // Enter 提交
    await sendKeys(stdin, [DOWN, DOWN, ENTER, "h", "i", ENTER]);
    const result = await promise;
    expect(result).toEqual({
      kind: "selected",
      value: "allow-with-note",
      note: "hi",
    });
  });

  // ─── 场景 6: Backspace 在 input 模式 ───

  it("6. Backspace 在 input 模式删除最后一字符", async () => {
    const { stdin, stdout } = makeStreams();
    const promise = selectWithInput({
      title: "test",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 80,
    });
    await sendKeys(stdin, [
      DOWN, DOWN, DOWN, // 到 "拒绝"
      ENTER, // 进 input
      "a", "b", "c",
      BACKSPACE, BACKSPACE, // → "a"
      "x", "y", // → "axy"
      ENTER,
    ]);
    const result = await promise;
    expect(result).toEqual({ kind: "selected", value: "deny", note: "axy" });
  });

  // ─── 场景 7: allowEmptySubmit=true → 空提交带 note undefined ───

  it("7. allowEmptySubmit=true 允许空 buffer 提交", async () => {
    const { stdin, stdout } = makeStreams();
    const promise = selectWithInput({
      title: "test",
      options: makeDefaultOptions(), // "allow-with-note" 允许空
      stdin,
      stdout,
      columns: 80,
    });
    await sendKeys(stdin, [DOWN, DOWN, ENTER, ENTER]); // 到"允许并补充"直接空提交
    const result = await promise;
    expect(result).toEqual({
      kind: "selected",
      value: "allow-with-note",
      note: undefined,
    });
  });

  // ─── 场景 8: allowEmptySubmit=false → 空 buffer 按 Enter 无响应 ───

  it("8. allowEmptySubmit=false 空 buffer 按 Enter 不提交，保持 input 模式", async () => {
    const opts: SelectOption[] = [
      {
        type: "input",
        value: "must-have-note",
        label: "必填",
        placeholder: "必须写点什么",
        allowEmptySubmit: false,
      },
    ];
    const { stdin, stdout } = makeStreams();
    const promise = selectWithInput({
      title: "test",
      options: opts,
      stdin,
      stdout,
      columns: 80,
    });
    // 进入 input，直接 Enter（应被吞掉），再打字，Enter 提交
    await sendKeys(stdin, [ENTER, ENTER, "o", "k", ENTER]);
    const result = await promise;
    expect(result).toEqual({
      kind: "selected",
      value: "must-have-note",
      note: "ok",
    });
  });

  // ─── 场景 9: Esc 在 input 模式退回 select 模式 ───

  it("9. Esc 在 input 模式退回 select 模式，buffer 清空", async () => {
    const { stdin, stdout } = makeStreams();
    const promise = selectWithInput({
      title: "test",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 80,
    });
    // 到 "允许并补充" 进 input 打字
    await sendKeys(stdin, [DOWN, DOWN, ENTER, "a", "b", "c"]);
    // Esc 不能通过脚本化字节实现——Node 的 readline 解析器会把 \x1b 和紧跟
    // 其后的字节合并成 meta-key 或 CSI 序列。真实 TTY 的键盘按键天然有时间
    // 间隔所以 bare Escape 能工作；测试里用合成 keypress 事件绕过解析器。
    await sendSyntheticKey(stdin, { name: "escape", sequence: "\x1b" });
    // 退回 select 后上移到 "允许一次" 并选中
    await sendKeys(stdin, [UP, UP, ENTER]);
    const result = await promise;
    expect(result).toEqual({ kind: "selected", value: "allow-once" });
  });

  // ─── 场景 10: UTF-8 中文输入 ───

  it("10. UTF-8 中文输入通过 str 字段写入 buffer", async () => {
    const { stdin, stdout } = makeStreams();
    const promise = selectWithInput({
      title: "test",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 80,
    });
    await sendKeys(stdin, [
      DOWN, DOWN, DOWN, // 到 "拒绝"
      ENTER,
      "不", "要", "用", " ", "r", "m",
      ENTER,
    ]);
    const result = await promise;
    expect(result).toEqual({
      kind: "selected",
      value: "deny",
      note: "不要用 rm",
    });
  });
});

// ─── 场景 11: 渲染帧数恒等式（核心护栏） ───

describe("selectWithInput — 渲染护栏 (spec §6.4)", () => {
  it("11. 渲染次数恒等式：K 次渲染 → K·N 次 clearLine", async () => {
    const { stdin, stdout, getCaptured } = makeStreams();
    const options = makeDefaultOptions();
    const promise = selectWithInput({
      title: "test",
      options,
      stdin,
      stdout,
      columns: 80,
      keyHintBar: "", // 关掉 hint bar 让行数更好算
    });

    // 初始 render + 2 次按键触发 rerender = 3 次总渲染
    await sendKeys(stdin, [DOWN, UP]);
    await sendKeys(stdin, [CTRL_C]); // 结束
    await promise;

    const captured = getCaptured();

    // 面板行数 N：
    //   1 top border
    // + 4 options
    // + 1 bottom border
    //   = 6 lines per frame
    const N = 6;
    const totalFrames = 3; // initial + down + up

    // clearLine 总数 = N * totalFrames
    const clearLineCount = (captured.match(/\x1b\[2K/g) || []).length;
    expect(clearLineCount).toBe(N * totalFrames);

    // `\r\n` 总数 = N * totalFrames （每行结尾都写一次）
    const crlfCount = (captured.match(/\r\n/g) || []).length;
    expect(crlfCount).toBe(N * totalFrames);

    // moveUp 序列 = totalFrames - 1（首次渲染不上移）
    const moveUpCount = (captured.match(/\x1b\[\d+A/g) || []).length;
    expect(moveUpCount).toBe(totalFrames - 1);

    // 每次 moveUp 的参数必须等于 N（即"一次上移 N 行"，不是 N-1）
    const moveUpMatches = Array.from(captured.matchAll(/\x1b\[(\d+)A/g));
    for (const m of moveUpMatches) {
      expect(Number(m[1])).toBe(N);
    }
  });

  // ─── 场景 12: 连续两次同状态 rerender 帧内容相等 ───

  it("12. 同状态下的两次 rerender 产生内容相等的帧", async () => {
    const { stdin, stdout, getCaptured } = makeStreams();
    const promise = selectWithInput({
      title: "test",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 80,
      keyHintBar: "",
    });

    // 触发一个 "无状态变化" 的场景：按一个组件不响应的字符（如 F1 键的
    // 自定义转义码或重复按 up 到顶后再按 up）
    // 用"在顶行再按 up" 的办法——组件 guard 了 selected > 0，按 up 无响应
    // 但按键仍被捕获，不会重绘。所以用更可靠的方式：用下-上-下-上 往返，
    // 第 1 帧和第 3 帧应当相同（both on "allow-session"），第 2 帧和第 4 帧
    // 也应相同（both on "allow-once"）。

    await sendKeys(stdin, [DOWN, UP, DOWN, UP]);
    await sendKeys(stdin, [CTRL_C]);
    await promise;

    const captured = getCaptured();

    // 按 moveUp 切分帧（moveUp 是帧分隔符；首帧无 moveUp）
    const parts = captured.split(/\x1b\[\d+A\r/);
    // parts[0] = 首帧（含 hideCursor 前缀）
    // parts[1..4] = 后续 4 次 rerender 产生的帧
    // 最后一帧后面可能跟着 finish 写入的 showCursor+\n——比较前要剥掉
    expect(parts.length).toBeGreaterThanOrEqual(5);

    // 剥掉帧末尾的 finish 清理序列（showCursor + 任意换行）
    const stripCleanup = (frame: string): string =>
      frame.replace(/\x1b\[\?25h\n*$/, "");

    const frame1 = stripCleanup(parts[1]!);
    const frame2 = stripCleanup(parts[2]!);
    const frame3 = stripCleanup(parts[3]!);
    const frame4 = stripCleanup(parts[4]!);

    // 第 1 次 down 后帧 ≡ 第 3 次 down 后帧（都在 "allow-session"）
    expect(frame1).toBe(frame3);
    // 第 1 次 up 后帧 ≡ 第 2 次 up 后帧（都在 "allow-once"）
    expect(frame2).toBe(frame4);
  });
});

// ─── 场景 13-16 ───

describe("selectWithInput — 场景 13-16", () => {
  // ─── 场景 13: resize 事件触发 rerender ───

  it("13. stdout resize 事件触发 rerender，无堆叠", async () => {
    const { stdin, stdout, getCaptured } = makeStreams();
    // 初始 100 列
    const columnsRef = { value: 100 };
    Object.defineProperty(stdout, "columns", {
      get: () => columnsRef.value,
      configurable: true,
    });
    const promise = selectWithInput({
      title: "resize-test",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      keyHintBar: "",
      // 不传 columns，让组件从 stdout.columns 读取
    });

    // 让组件做完初始渲染
    await new Promise((resolve) => setImmediate(resolve));

    // 触发 resize：改 columns 并 emit resize
    columnsRef.value = 60;
    stdout.emit("resize");
    await new Promise((resolve) => setImmediate(resolve));

    await sendKeys(stdin, [CTRL_C]);
    await promise;

    const captured = getCaptured();

    // 应至少有两次渲染（初始 + resize）→ 至少一次 moveUp
    const moveUpCount = (captured.match(/\x1b\[\d+A/g) || []).length;
    expect(moveUpCount).toBeGreaterThanOrEqual(1);

    // 所有 moveUp 的参数应等于面板行数 6（keyHintBar="" 时）
    const moveUpMatches = Array.from(captured.matchAll(/\x1b\[(\d+)A/g));
    for (const m of moveUpMatches) {
      expect(Number(m[1])).toBe(6);
    }
  });

  // ─── 场景 14: 窄终端回退布局 ───

  it("14. 窄终端（columns < 40）仍能正常渲染不崩溃", async () => {
    const { stdin, stdout, getCaptured } = makeStreams();
    const promise = selectWithInput({
      title: "窄屏测试",
      body: "这是一段相对较长的说明文字",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 30, // 比 minWidth 40 还窄
      keyHintBar: "",
    });
    await sendKeys(stdin, [ENTER]);
    const result = await promise;
    expect(result.kind).toBe("selected");

    // 没有 unclosed rendering artifacts
    const captured = getCaptured();
    expect(captured).toContain("╭");
    expect(captured).toContain("╰");
  });

  // ─── 场景 15: 长 body 被截断 ───

  it("15. 长 body 行被 clampLine 截断到终端宽度内", async () => {
    const { stdin, stdout, getCaptured } = makeStreams();
    const longBody =
      "这是一段极其冗长的说明文字，它会被重复多次以确保超过终端宽度限制".repeat(5);
    const promise = selectWithInput({
      title: "t",
      body: longBody,
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 60,
      keyHintBar: "",
    });
    await sendKeys(stdin, [ENTER]);
    await promise;

    const captured = getCaptured();

    // 按 \r\n 切分捕获的输出成行，去除 ANSI 后检查每行显示宽度
    const rawLines = captured.split("\r\n");
    for (const line of rawLines) {
      // 跳过空行和只含控制码的行
      if (!line.trim()) continue;
      // 面板行的可视宽度应 ≤ columns
      expect(stringWidth(line)).toBeLessThanOrEqual(60);
    }
  });

  // ─── 场景 16: 外部 signal.abort() ───

  it("16. 外部 AbortSignal.abort() 立即取消为 aborted cause", async () => {
    const { stdin, stdout } = makeStreams();
    const controller = new AbortController();
    const promise = selectWithInput({
      title: "test",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 80,
      signal: controller.signal,
    });

    // 让组件做完初始渲染再 abort
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    const result = await promise;
    expect(result).toEqual({ kind: "cancelled", cause: "aborted" });
  });

  // ─── 场景 16b: 调用时 signal 已经 aborted ───

  it("16b. 调用时 signal 已 aborted 立即返回，不渲染", async () => {
    const { stdin, stdout, getCaptured } = makeStreams();
    const controller = new AbortController();
    controller.abort();
    const result = await selectWithInput({
      title: "test",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 80,
      signal: controller.signal,
    });
    expect(result).toEqual({ kind: "cancelled", cause: "aborted" });
    // 没有任何渲染输出
    expect(getCaptured()).toBe("");
  });
});

// ─── 场景 17: stdin 监听器独占护栏 (spec §6.4 陷阱 3) ───

describe("selectWithInput — stdin 独占护栏 (§6.4 陷阱 3)", () => {
  it("17. 已存在的 keypress 监听器在组件运行期间不被触发，结束后恢复", async () => {
    const { stdin, stdout } = makeStreams();

    // 模拟调用方（如 REPL 的 readline.Interface）预挂的 keypress 监听器。
    // Bug 场景：SelectWithInput 没摘这些 listener 就 stdin.resume()，导致
    // 用户在 input 模式打的每个字符被调用方的 listener 也 echo 一次到面板
    // 外的屏幕位置。见 spec §6.4 陷阱 3 的真实复现案例。
    const preExistingReceived: Array<string | undefined> = [];
    const preExistingListener = (str: string | undefined) => {
      preExistingReceived.push(str);
    };
    stdin.on("keypress", preExistingListener);

    const promise = selectWithInput({
      title: "t",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 80,
    });

    // 触发 bug 原发场景：进入 input 模式打字
    await sendKeys(stdin, [
      DOWN, DOWN, // 到 "允许并补充"
      ENTER,      // 进 input
      "h", "i",   // 打字——bug 版本下 preExistingListener 会收到两次
      ENTER,      // 提交
    ]);
    const result = await promise;

    expect(result).toEqual({
      kind: "selected",
      value: "allow-with-note",
      note: "hi",
    });

    // 核心断言：组件生命周期内预挂 listener 一次都没被调用
    expect(preExistingReceived).toEqual([]);

    // 结束后 listener 应被恢复：写一个字符，验证预挂 listener 重新收得到
    stdin.write("z");
    await new Promise((resolve) => setImmediate(resolve));
    expect(preExistingReceived).toEqual(["z"]);

    stdin.removeListener("keypress", preExistingListener);
  });

  it("17b. cancel 路径（Ctrl+C）也正确恢复 listener", async () => {
    const { stdin, stdout } = makeStreams();

    const preExistingReceived: Array<string | undefined> = [];
    const preExistingListener = (str: string | undefined) => {
      preExistingReceived.push(str);
    };
    stdin.on("keypress", preExistingListener);

    const promise = selectWithInput({
      title: "t",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 80,
    });

    await sendKeys(stdin, [CTRL_C]);
    const result = await promise;
    expect(result).toEqual({ kind: "cancelled", cause: "ctrl-c" });

    // Ctrl+C 期间不应收到任何事件
    expect(preExistingReceived).toEqual([]);

    // 结束后恢复
    stdin.write("x");
    await new Promise((resolve) => setImmediate(resolve));
    expect(preExistingReceived).toEqual(["x"]);

    stdin.removeListener("keypress", preExistingListener);
  });
});

// ─── 额外：hotkey 支持 ───

describe("selectWithInput — hotkey 支持", () => {
  it("hotkey 字母直达选项（simple）", async () => {
    const opts: SelectOption[] = [
      { type: "simple", value: "yes", label: "允许", hotkey: "y" },
      { type: "simple", value: "no", label: "拒绝", hotkey: "n" },
    ];
    const { stdin, stdout } = makeStreams();
    const promise = selectWithInput({
      title: "t",
      options: opts,
      stdin,
      stdout,
      columns: 80,
    });
    await sendKeys(stdin, ["n"]);
    const result = await promise;
    expect(result).toEqual({ kind: "selected", value: "no" });
  });
});

// ─── 额外：snapshot 一致性 ───

describe("selectWithInput — 基本结构", () => {
  it("渲染包含 hideCursor / showCursor 对", async () => {
    const { stdin, stdout, getCaptured } = makeStreams();
    const promise = selectWithInput({
      title: "t",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 80,
    });
    await sendKeys(stdin, [ENTER]);
    await promise;
    const captured = getCaptured();
    expect(captured).toContain("\x1b[?25l"); // hideCursor at start
    expect(captured).toContain("\x1b[?25h"); // showCursor at end
  });

  it("空 options 数组 reject", async () => {
    const { stdin, stdout } = makeStreams();
    await expect(
      selectWithInput({
        title: "t",
        options: [],
        stdin,
        stdout,
      }),
    ).rejects.toThrow(/options is empty/);
  });

  it("raw mode refcount 在非 TTY 流上保持 0", async () => {
    _resetRawModeRefcountForTests();
    expect(_getRawModeRefcount()).toBe(0);
    const { stdin, stdout } = makeStreams();
    const promise = selectWithInput({
      title: "t",
      options: makeDefaultOptions(),
      stdin,
      stdout,
      columns: 80,
    });
    // 非 TTY，不计入 refcount
    expect(_getRawModeRefcount()).toBe(0);
    await sendKeys(stdin, [CTRL_C]);
    await promise;
    expect(_getRawModeRefcount()).toBe(0);
  });
});
