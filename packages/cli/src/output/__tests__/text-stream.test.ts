import { describe, expect, it } from "vitest";
import { TextStream } from "../text-stream.js";
import { ANCHOR_AI_DONE } from "../speaker-state.js";
import { stripAnsi } from "../../tui/ansi.js";

interface Capture {
  buffer: string;
}

function makeStream(cols = 80): { stream: TextStream; out: Capture } {
  const out: Capture = { buffer: "" };
  const stream = new TextStream({
    write: (chunk) => {
      out.buffer += chunk;
    },
    columns: cols,
  });
  return { stream, out };
}

describe("TextStream 起首", () => {
  it("第一次 feed 自动插入 `  ◆ ` 锚 + 1 空格", () => {
    const { stream, out } = makeStream();
    stream.feed("hello");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} hello`);
  });

  it("空 chunk 不触发起首", () => {
    const { stream, out } = makeStream();
    stream.feed("");
    expect(out.buffer).toBe("");
  });

  it("流式多次 feed 锚只插一次", () => {
    const { stream, out } = makeStream();
    stream.feed("hello ");
    stream.feed("world");
    const anchorMatches = out.buffer.match(/◆/g) ?? [];
    expect(anchorMatches.length).toBe(1);
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} hello world`);
  });
});

describe("TextStream 硬换行", () => {
  it("\\n 触发硬换行 + hanging 4 缩进", () => {
    const { stream, out } = makeStream();
    stream.feed("line1\nline2");
    expect(stripAnsi(out.buffer)).toBe(
      `  ${ANCHOR_AI_DONE} line1\n    line2`,
    );
  });

  it("连续多个 \\n 各自触发 hanging", () => {
    const { stream, out } = makeStream();
    stream.feed("a\nb\nc");
    expect(stripAnsi(out.buffer)).toBe(
      `  ${ANCHOR_AI_DONE} a\n    b\n    c`,
    );
  });

  it("\\n 跨多次 feed 仍正确换行", () => {
    const { stream, out } = makeStream();
    stream.feed("a\n");
    stream.feed("b");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} a\n    b`);
  });

  it("\\n\\n 双换行 = 段落分隔——中间是真空行（无 hanging 4 空格）", () => {
    const { stream, out } = makeStream();
    stream.feed("段一\n\n段二");
    expect(stripAnsi(out.buffer)).toBe(
      `  ${ANCHOR_AI_DONE} 段一\n\n    段二`,
    );
  });

  it("\\n\\n 跨 feed 段落分隔仍正确（不补 hanging 到空段）", () => {
    const { stream, out } = makeStream();
    stream.feed("段一\n");
    stream.feed("\n段二");
    expect(stripAnsi(out.buffer)).toBe(
      `  ${ANCHOR_AI_DONE} 段一\n\n    段二`,
    );
  });

  it("末尾 \\n 后下次 feed 起首补 hanging（同段续行）", () => {
    const { stream, out } = makeStream();
    stream.feed("段一\n");
    stream.feed("续行");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 段一\n    续行`);
  });

  it("起首 \\n 不创建空 ◆ 行——跳过到第一个可见字符位置写锚", () => {
    const { stream, out } = makeStream();
    stream.feed("\n你好");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 你好`);
  });

  it("起首多个 \\n + 空格全部跳过——锚紧跟第一个可见字符", () => {
    const { stream, out } = makeStream();
    stream.feed("\n\n  你好");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 你好`);
  });

  it("第一次 feed 全是 0 宽字符不输出——等下次 feed 有可见字符再起手", () => {
    const { stream, out } = makeStream();
    stream.feed("\n");
    expect(out.buffer).toBe("");
    stream.feed("你好");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 你好`);
  });

  it("起首之后再 feed 含 \\n 不跳过——保留段内换行结构", () => {
    const { stream, out } = makeStream();
    stream.feed("第一行");
    stream.feed("\n第二行");
    expect(stripAnsi(out.buffer)).toBe(
      `  ${ANCHOR_AI_DONE} 第一行\n    第二行`,
    );
  });

  // 起首跳过覆盖所有不可见字符 + 空白：\s + \p{Cc}（C0/C1 含 DEL）+ \p{Cf}（格式控制）。
  // 参数化覆盖各类代表性字符——证明 LLM 输出任何不可见起首都不让 ◆ 行视觉空。
  // 实证：MiniMax 等模型偶尔以 DEL 起首；其它模型可能用 BOM/ZWJ/LRM 等。
  it.each([
    // \p{Cc} 控制字符
    { name: "DEL (U+007F) —— 实证 LLM 偶发起首字符", char: "" },
    { name: "BS (U+0008) C0 控制", char: "" },
    { name: "C1 控制 (U+0085) NEL", char: "" },
    // \p{Cf} 格式控制字符
    { name: "ZWS (U+200B)", char: "​" },
    { name: "ZWNJ (U+200C)", char: "‌" },
    { name: "ZWJ (U+200D)", char: "‍" },
    { name: "LRM (U+200E)", char: "‎" },
    { name: "RLM (U+200F)", char: "‏" },
    { name: "PDF (U+202C) bidi 终止", char: "‬" },
    { name: "word joiner (U+2060)", char: "⁠" },
    { name: "BOM (U+FEFF)", char: "﻿" },
    { name: "soft hyphen (U+00AD)", char: "­" },
  ])("起首 $name 跳过——锚紧跟第一个可见字符", ({ char }) => {
    const { stream, out } = makeStream();
    stream.feed(`${char}你好`);
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 你好`);
  });

  it("起首 DEL chunk 单独发送 + 后续 \\n\\n + 实质 chunk —— 实证还原 LLM 多 chunk 序列", () => {
    // 日志实证场景：LLM 三个 chunk 依次发送
    //   chunk 1: "" (DEL 单独)
    //   chunk 2: "\n\n"
    //   chunk 3: "你好"
    // 期望 ◆ 行紧跟"你好"，不应空。多 chunk 之间 hasStarted 仍 false 直到首个
    // 可见字符到达——LEADING_INVISIBLE trim 在每次 not hasStarted 的 feed 都重新执行。
    const { stream, out } = makeStream();
    stream.feed("");
    expect(out.buffer).toBe(""); // 全 trim 不输出
    stream.feed("\n\n");
    expect(out.buffer).toBe(""); // 仍全 trim
    stream.feed("你好");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 你好`);
  });

  it("起首多种 Cf 类 + \\n 混合——全部跳过，◆ 锚紧跟可见字符", () => {
    const { stream, out } = makeStream();
    // BOM + LRM + ZWJ + \n\n —— 各种 Unicode 不可见字符 + 换行混合
    stream.feed("﻿‎‍\n\n我是知行");
    expect(stripAnsi(out.buffer)).toBe(`  ${ANCHOR_AI_DONE} 我是知行`);
  });
});

describe("TextStream 软 wrap", () => {
  it("超 maxLineWidth 时插 \\n + hanging", () => {
    const { stream, out } = makeStream(20);
    stream.feed("a".repeat(50));
    expect(out.buffer).toContain("\n    ");
  });

  it("CJK 字符按 2 列计算 wrap", () => {
    // cols=30 → maxLineWidth = max(30-4, 20) = 26；20 个"你" = 40 列必 wrap
    const { stream, out } = makeStream(30);
    stream.feed("你".repeat(20));
    expect(out.buffer).toContain("\n    ");
  });

  it("窄终端不破——maxLineWidth 至少 20 列保护", () => {
    const { stream, out } = makeStream(5);
    stream.feed("hello world this is a long line");
    expect(out.buffer.length).toBeGreaterThan(0);
  });
});

describe("TextStream end", () => {
  it("已起首时 end 写末尾换行", () => {
    const { stream, out } = makeStream();
    stream.feed("hello");
    stream.end();
    expect(out.buffer.endsWith("\n")).toBe(true);
  });

  it("未起首时 end 不写", () => {
    const { stream, out } = makeStream();
    stream.end();
    expect(out.buffer).toBe("");
  });

  it("end 后再 feed 重新起首插锚", () => {
    const { stream, out } = makeStream();
    stream.feed("first");
    stream.end();
    stream.feed("second");
    const anchorMatches = out.buffer.match(/◆/g) ?? [];
    expect(anchorMatches.length).toBe(2);
  });
});

describe("TextStream ANSI-aware wrap（不被 ANSI 序列撑爆 wrap 边界）", () => {
  it("CSI 染色序列整段透传不计 wrap 宽度——粗体短文字不在锚后立刻 wrap", () => {
    const { stream, out } = makeStream(40);
    // chalk.bold("X") = "\x1b[1mX\x1b[22m"——3+1+4 = 8 字符，可见仅 1 列
    stream.feed("\x1b[1mhello\x1b[22m world");
    // 整段可见宽度 = "hello world" = 11 列，远小于 maxLineWidth - HANGING = 36
    // 不应 wrap；如果把 ANSI 当字符计入会让 wrap 提前断行
    expect(out.buffer).not.toContain("\n    "); // 没 hanging 续行（无 wrap）
    // ANSI 序列保留完整，没被 wrap 切断
    expect(out.buffer).toContain("\x1b[1mhello\x1b[22m");
  });

  it("OSC 8 超链接序列整段透传——url 字符不计 wrap 宽度", () => {
    const { stream, out } = makeStream(30);
    // OSC 8 链接：\x1b]8;;URL\x1b\\TEXT\x1b]8;;\x1b\\
    // url 30+ 字符是不可见的——可见仅 "click" 5 列
    stream.feed(
      "\x1b]8;;https://very-long-url.example.com/path\x1b\\click\x1b]8;;\x1b\\",
    );
    // 不应被 wrap（可见 click 短）；url 也不应让 wrap 提前断行切碎序列
    expect(out.buffer).not.toContain("\n    ");
    // OSC 序列完整保留
    expect(out.buffer).toContain("\x1b]8;;https://very-long-url.example.com/path\x1b\\");
    expect(out.buffer).toContain("\x1b]8;;\x1b\\");
  });

  it("可见字符到 wrap 边界正常 wrap，ANSI 序列不影响 wrap 决策", () => {
    const { stream, out } = makeStream(20);
    // maxLineWidth = max(20-4, 20) = 20，可见字符 25 列必 wrap
    stream.feed("\x1b[1maaaaaaaaaaaaaaaaaaaaaa\x1b[22mbbb");
    // 应 wrap：可见 22 a + 3 b = 25 列 > 20
    expect(out.buffer).toContain("\n    "); // hanging 续行
    // 但 ANSI 染色不被 wrap 切碎
    expect(out.buffer).toContain("\x1b[1m");
    expect(out.buffer).toContain("\x1b[22m");
  });
});

describe("TextStream SGR 跨 wrap 状态保持（hanging prefix 不继承 bg/fg 染色）", () => {
  it("bg 色（codespan）跨 wrap 边界——\\n 前 emit SGR reset、hanging 4 空格不带 bg、续行 re-apply SGR", () => {
    const { stream, out } = makeStream(20);
    // 模拟 codespan：bg + cyan 包 22 字符长 inline code 触 wrap
    // chalk.bgAnsi256(245).cyan 输出形如 \x1b[48;5;245m\x1b[36mTEXT\x1b[39m\x1b[49m
    // 这里直接构造 ANSI：bg 起开 + cyan 起开 + 22 个 'a' + 续 'b' 触 wrap
    stream.feed("\x1b[48;5;245m\x1b[36maaaaaaaaaaaaaaaaaaaaaab\x1b[39m\x1b[49m");
    // 必 wrap（22 a + 1 b = 23 > 20）
    expect(out.buffer).toContain("\n    ");
    // 关键：wrap 处必有 SGR reset \x1b[0m 让 hanging 不继承 bg
    expect(out.buffer).toContain("\x1b[0m\n    ");
    // 续行（hanging 后）必 re-apply 累积的 SGR（bg + cyan）让可见字符仍染色
    expect(out.buffer).toContain("\x1b[0m\n    \x1b[48;5;245m\x1b[36m");
  });

  it("纯文本 wrap 不带 SGR 时不输出无谓的 reset 序列", () => {
    const { stream, out } = makeStream(20);
    stream.feed("a".repeat(50));
    // hanging 续行存在
    expect(out.buffer).toContain("\n    ");
    // 没 SGR 时 wrap 不应 emit reset（避免无意义 ANSI 噪声）
    expect(out.buffer).not.toContain("\x1b[0m");
  });

  it("SGR full reset \\x1b[0m 清空累积——之后 wrap 不 re-apply 已 reset 的 SGR", () => {
    const { stream, out } = makeStream(20);
    // 先开 bg + cyan，闭合 reset，然后写 22 a 触 wrap
    stream.feed("\x1b[48;5;245m\x1b[36mhi\x1b[0m" + "a".repeat(22));
    // wrap 处不应 re-apply 已 reset 的 SGR
    const wrapMarkerIdx = out.buffer.indexOf("\n    ");
    expect(wrapMarkerIdx).toBeGreaterThan(-1);
    const afterHanging = out.buffer.slice(wrapMarkerIdx + 5); // skip "\n    "
    // hanging 之后不应紧跟 bg/cyan 序列
    expect(afterHanging.startsWith("\x1b[48;5;245m")).toBe(false);
    expect(afterHanging.startsWith("\x1b[36m")).toBe(false);
  });

  it("end() 重置 activeSgr——下次 feed 不残留旧 SGR 累积", () => {
    const { stream, out } = makeStream(20);
    // 第一个 turn：开 bg 不 reset，end()
    stream.feed("\x1b[48;5;245maa");
    stream.end();
    out.buffer = ""; // 清 capture 看下次 feed
    // 第二个 turn：纯文本 wrap，不应 re-apply 上 turn 的 bg
    stream.feed("a".repeat(50));
    expect(out.buffer).not.toContain("\x1b[48;5;245m");
  });

  it("feed 主循环硬换行 + activeSgr 非空——hanging 也走 SGR reset + re-apply（与 wrap 对称）", () => {
    const { stream, out } = makeStream(80);
    // 单 chunk 含硬换行 + bg 起手未在换行前 reset：模拟"未平衡 SGR 输入"防御场景
    stream.feed("\x1b[48;5;245mline1\nline2\x1b[49m");
    // 硬换行处必有 SGR reset 让 hanging 不继承 bg
    expect(out.buffer).toContain("\x1b[0m\n    ");
    // hanging 4 空格之后 re-apply bg
    expect(out.buffer).toContain("\x1b[0m\n    \x1b[48;5;245m");
  });

  it("feed 主循环段落分隔（连续 \\n）—— 真空行不带 hanging 也不 emit 无谓 SGR reset", () => {
    const { stream, out } = makeStream(80);
    stream.feed("段一\n\n段二");
    // 段落分隔的真空行：hanging 不应出现在 \n\n 之间（按段落分隔语义保持原契约）
    expect(out.buffer).toContain("\n\n    段二");
    // 段落分隔不需要 SGR reset 噪声（无 active SGR）
    expect(out.buffer).not.toContain("\x1b[0m");
  });

  it("跨 feed needsHangingPrefix 路径 + activeSgr 非空——hanging 走 reset + re-apply", () => {
    const { stream, out } = makeStream(80);
    // 第一次 feed：末尾 \n + 留 activeSgr 含 bg
    stream.feed("\x1b[48;5;245mline1\n");
    out.buffer = "";
    // 第二次 feed：起首走 needsHangingPrefix 路径
    stream.feed("line2");
    // 第二次 feed 输出应含 SGR reset + hanging + re-apply bg
    expect(out.buffer).toContain("\x1b[0m");
    expect(out.buffer).toContain("    ");
    expect(out.buffer).toContain("\x1b[48;5;245m");
    // 顺序：reset 在 hanging 之前
    const resetIdx = out.buffer.indexOf("\x1b[0m");
    const hangingIdx = out.buffer.indexOf("    ");
    expect(resetIdx).toBeLessThan(hangingIdx);
  });
});
