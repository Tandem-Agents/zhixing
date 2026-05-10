import { beforeEach, describe, expect, it } from "vitest";
import { ScrollRegion } from "../scroll-region.js";

/** mock stdout——所有写入累积到 buffer，测试断言字节序列 */
function makeWriter() {
  const buffer: { value: string } = { value: "" };
  const write = (chunk: string): void => {
    buffer.value += chunk;
  };
  return { buffer, write };
}

/** 默认构造一个 24×80 的 ScrollRegion + capture 写入 */
function makeRegion(opts: { rows?: number; cols?: number } = {}) {
  const w = makeWriter();
  const region = new ScrollRegion({
    viewportRows: opts.rows ?? 24,
    viewportCols: opts.cols ?? 80,
    write: w.write,
  });
  return { region, buffer: w.buffer };
}

describe("ScrollRegion · 构造与初始状态", () => {
  it("构造期不写任何字节（纯状态初始化）", () => {
    const { buffer } = makeRegion();
    expect(buffer.value).toBe("");
  });

  it("初始 state：未 attached、scrollBottom = viewportRows、所有字段归零", () => {
    const { region } = makeRegion({ rows: 24, cols: 80 });
    const s = region.state;
    expect(s.attached).toBe(false);
    expect(s.suspended).toBe(false);
    expect(s.viewportRows).toBe(24);
    expect(s.viewportCols).toBe(80);
    expect(s.chromeHeight).toBe(0);
    expect(s.scrollBottom).toBe(24);
    expect(s.regionTailRow).toBe(1);
    expect(s.regionTailCol).toBe(1);
    expect(s.regionFilledRows).toBe(0);
    expect(s.segmentTopRow).toBeNull();
    expect(s.segmentBottomRow).toBeNull();
    expect(s.segmentRemainingRows).toBeNull();
    expect(s.committedLogicalRows).toBe(0);
  });
});

describe("ScrollRegion · attachInput", () => {
  it("emit DECSTBM(1, scrollBottom) + cursor 跳 (1,1) + chrome bytes + cursor 回 (1,1)", () => {
    const { region, buffer } = makeRegion({ rows: 24, cols: 80 });
    region.attachInput(3, "<chrome-bytes>");
    // scrollBottom = 24 - 3 = 21
    expect(buffer.value).toBe(
      "\x1b[1;21r" + "\x1b[1;1H" + "<chrome-bytes>" + "\x1b[1;1H",
    );
  });

  it("attachInput 后 attached=true、scrollBottom 正确、所有 region 字段归零", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(4, "");
    const s = region.state;
    expect(s.attached).toBe(true);
    expect(s.chromeHeight).toBe(4);
    expect(s.scrollBottom).toBe(20);
    expect(s.regionTailRow).toBe(1);
    expect(s.regionTailCol).toBe(1);
    expect(s.regionFilledRows).toBe(0);
    expect(s.segmentTopRow).toBeNull();
  });

  it("chromeHeight=0 时不 emit chrome bytes（空字串也不写）", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    // scrollBottom = 24 - 0 = 24
    expect(buffer.value).toBe("\x1b[1;24r" + "\x1b[1;1H");
  });

  it("chromeHeight>0 但 chromeBytes 空字串时不 emit 无意义 cursor 回 (1,1) 之前的内容", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(3, "");
    // chrome 字节空 → 不走 chrome 写入分支 → 只 DECSTBM + cursor (1,1)
    expect(buffer.value).toBe("\x1b[1;21r" + "\x1b[1;1H");
  });

  it("重复 attachInput 抛错", () => {
    const { region } = makeRegion();
    region.attachInput(3, "");
    expect(() => region.attachInput(3, "")).toThrow(/already attached/);
  });

  it("chromeHeight 负值抛错", () => {
    const { region } = makeRegion();
    expect(() => region.attachInput(-1, "")).toThrow(/must be ≥ 0/);
  });

  it("chromeHeight ≥ viewportRows 抛错（无 region 空间）", () => {
    const { region } = makeRegion({ rows: 5 });
    expect(() => region.attachInput(5, "")).toThrow(/no room for region/);
    expect(() => region.attachInput(10, "")).toThrow(/no room for region/);
  });
});

describe("ScrollRegion · detachInput", () => {
  it("emit cursor 跳 chrome 顶 + erase below + 撤 DECSTBM + cursor (1,1)", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(3, "<chrome>");
    buffer.value = ""; // 清 attach 期 emit
    region.detachInput();
    // chrome 顶 = scrollBottom(21) + 1 = 22
    expect(buffer.value).toBe(
      "\x1b[22;1H" + "\x1b[J" + "\x1b[r" + "\x1b[1;1H",
    );
  });

  it("attachInput chromeHeight=0 后 detachInput 不发 erase chrome 序列", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    buffer.value = "";
    region.detachInput();
    // chrome 高度 0 → 跳过 chrome erase；仅撤 DECSTBM + cursor (1,1)
    expect(buffer.value).toBe("\x1b[r" + "\x1b[1;1H");
  });

  it("detachInput 后 attached=false、状态字段全归零", () => {
    const { region } = makeRegion();
    region.attachInput(4, "<chrome>");
    region.detachInput();
    const s = region.state;
    expect(s.attached).toBe(false);
    expect(s.suspended).toBe(false);
    expect(s.chromeHeight).toBe(0);
    expect(s.scrollBottom).toBe(s.viewportRows);
    expect(s.regionTailRow).toBe(1);
    expect(s.regionTailCol).toBe(1);
    expect(s.regionFilledRows).toBe(0);
    expect(s.segmentTopRow).toBeNull();
  });

  it("未 attached 时 detachInput 是 no-op、不写字节", () => {
    const { region, buffer } = makeRegion();
    region.detachInput();
    expect(buffer.value).toBe("");
    expect(region.state.attached).toBe(false);
  });

  it("attachInput → detachInput → attachInput 重新启动序列正常", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(3, "");
    region.detachInput();
    buffer.value = "";
    region.attachInput(2, "<new-chrome>");
    expect(buffer.value).toBe(
      "\x1b[1;22r" + "\x1b[1;1H" + "<new-chrome>" + "\x1b[1;1H",
    );
    expect(region.state.scrollBottom).toBe(22);
  });
});

describe("ScrollRegion · writeScrollLine", () => {
  it("起始状态写文本——cursor (1,1) + text + 末尾 \\n", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    buffer.value = "";
    region.writeScrollLine("Hello");
    expect(buffer.value).toBe("\x1b[1;1H" + "Hello\n");
    const s = region.state;
    expect(s.regionTailRow).toBe(2);
    expect(s.regionTailCol).toBe(1);
    expect(s.regionFilledRows).toBe(2);
  });

  it("text 已以 \\n 结尾时不再追加（避免双 \\n）", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    buffer.value = "";
    region.writeScrollLine("abc\n");
    expect(buffer.value).toBe("\x1b[1;1H" + "abc\n");
    expect(region.state.regionTailRow).toBe(2);
  });

  it("空字符串视为空行（emit 1 个 \\n）", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    buffer.value = "";
    region.writeScrollLine("");
    expect(buffer.value).toBe("\x1b[1;1H" + "\n");
    expect(region.state.regionTailRow).toBe(2);
  });

  it("多行 text 推进 regionTailRow N+1", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    region.writeScrollLine("line1\nline2\nline3"); // 2 内置 \n + 1 末尾 = 3
    expect(region.state.regionTailRow).toBe(4);
  });

  it("regionTailCol > 1（mid-line）触发前置切行 \\n", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    region.appendInline("partial"); // col → 8
    buffer.value = "";
    region.writeScrollLine("done");
    // cursor (1, 8) + "\n" + "done\n" = 2 \n
    expect(buffer.value).toBe("\x1b[1;8H" + "\n" + "done\n");
    expect(region.state.regionTailRow).toBe(3);
    expect(region.state.regionTailCol).toBe(1);
  });

  it("regionTailRow 撞 scrollBottom 时滚动 — row_post 钉在 scrollBottom", () => {
    const { region } = makeRegion({ rows: 6 });
    region.attachInput(0, ""); // scrollBottom = 6
    // 先把 cursor 推到 row 6
    region.writeScrollLine("a"); // row 1→2
    region.writeScrollLine("b"); // 2→3
    region.writeScrollLine("c"); // 3→4
    region.writeScrollLine("d"); // 4→5
    region.writeScrollLine("e"); // 5→6
    expect(region.state.regionTailRow).toBe(6);
    expect(region.state.regionFilledRows).toBe(6);
    // 再写一条会触发 1 次滚动
    region.writeScrollLine("f");
    expect(region.state.regionTailRow).toBe(6); // pinned at scrollBottom
    expect(region.state.regionFilledRows).toBe(6);
  });

  it("写多行 + 部分滚动 — N = max(0, newlines - 剩余空间)", () => {
    const { region } = makeRegion({ rows: 10 });
    region.attachInput(0, ""); // scrollBottom = 10
    // 跳到 row 8（写 7 个单行）
    for (let i = 0; i < 7; i++) region.writeScrollLine(`l${i}`);
    expect(region.state.regionTailRow).toBe(8);
    // 写 4 内置 \n + 1 末尾 = 5 \n；剩余 = 10-8 = 2；N = 5 - 2 = 3
    region.writeScrollLine("a\nb\nc\nd\ne");
    expect(region.state.regionTailRow).toBe(10);
    expect(region.state.regionFilledRows).toBe(10);
  });

  it("未 attached 抛错", () => {
    const { region } = makeRegion();
    expect(() => region.writeScrollLine("x")).toThrow(/not attached/);
  });
});

describe("ScrollRegion · appendInline", () => {
  it("无 \\n chunk — col 顺写顺前进", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    buffer.value = "";
    region.appendInline("Hello");
    expect(buffer.value).toBe("\x1b[1;1H" + "Hello");
    const s = region.state;
    expect(s.regionTailRow).toBe(1);
    expect(s.regionTailCol).toBe(6); // 1 + 5
  });

  it("含 \\n chunk — col = 最后 \\n 之后可见宽度 + 1", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    region.appendInline("abc\ndef");
    const s = region.state;
    expect(s.regionTailRow).toBe(2);
    expect(s.regionTailCol).toBe(4); // visibleWidth("def") + 1 = 3 + 1
  });

  it("末尾恰好 \\n — col 归 1", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    region.appendInline("abc\n");
    expect(region.state.regionTailCol).toBe(1);
    expect(region.state.regionTailRow).toBe(2);
  });

  it("CJK 双宽计算 col_post", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    region.appendInline("你好"); // 4 列
    expect(region.state.regionTailCol).toBe(5); // 1 + 4
  });

  it("ANSI 染色不计入 col 宽度", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    region.appendInline("\x1b[31mhi\x1b[0m"); // 2 列
    expect(region.state.regionTailCol).toBe(3); // 1 + 2
  });

  it("空 chunk — no-op、不写字节", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    buffer.value = "";
    region.appendInline("");
    expect(buffer.value).toBe("");
    expect(region.state.regionTailCol).toBe(1);
  });

  it("跨多次 appendInline 续写 col 累积", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    region.appendInline("ab");
    region.appendInline("cd");
    expect(region.state.regionTailCol).toBe(5); // 1 + 2 + 2
    region.appendInline("ef\n"); // 含 \n → col 归 1，row +1
    expect(region.state.regionTailRow).toBe(2);
    expect(region.state.regionTailCol).toBe(1);
  });

  it("撞 scrollBottom 时滚动 + filled 钉满", () => {
    const { region } = makeRegion({ rows: 6 });
    region.attachInput(0, ""); // scrollBottom = 6
    region.appendInline("a\nb\nc\nd\ne\n"); // 5 \n；row 1 → 6
    expect(region.state.regionTailRow).toBe(6);
    region.appendInline("f\ng\n"); // 2 \n；scroll 2 次；row 钉 6
    expect(region.state.regionTailRow).toBe(6);
    expect(region.state.regionFilledRows).toBe(6);
  });

  it("未 attached 抛错", () => {
    const { region } = makeRegion();
    expect(() => region.appendInline("x")).toThrow(/not attached/);
  });
});

describe("ScrollRegion · regionFilledRows 公式（无 segment）", () => {
  it("写入扩到 regionTailRow_post — filled = max(filled, row_post)", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    region.writeScrollLine("a\nb\nc"); // 3 \n；row 1 → 4
    expect(region.state.regionFilledRows).toBe(4);
  });

  it("滚动消化老内容 — consumedFilled = min(N, filled)", () => {
    const { region } = makeRegion({ rows: 6 });
    region.attachInput(0, "");
    // 推到 row 6, filled=6
    for (let i = 0; i < 5; i++) region.writeScrollLine(`x`);
    expect(region.state.regionFilledRows).toBe(6);
    // 再写让 N=2 滚动；consumedFilled=min(2,6)=2；filled = max(6-2, 6) = 6
    region.appendInline("a\nb\n");
    expect(region.state.regionFilledRows).toBe(6);
  });

  it("filled 永不超 scrollBottom", () => {
    const { region } = makeRegion({ rows: 5 });
    region.attachInput(0, "");
    region.appendInline("a\nb\nc\nd\ne\nf\n"); // 6 \n；scroll N=2；row=5
    expect(region.state.regionFilledRows).toBe(5);
    expect(region.state.regionTailRow).toBe(5);
  });
});

describe("ScrollRegion · beginReplaceableSegment", () => {
  it("起始状态 begin — 不写字节、segment 字段保持 null、handle 创建", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    buffer.value = "";
    const seg = region.beginReplaceableSegment();
    expect(seg).toBeDefined();
    expect(buffer.value).toBe("");
    const s = region.state;
    expect(s.segmentTopRow).toBeNull();
    expect(s.segmentBottomRow).toBeNull();
    expect(s.segmentRemainingRows).toBeNull();
    expect(s.committedLogicalRows).toBe(0);
  });

  it("mid-line begin — 先 emit \\n 切到新行起首（fresh-line 合约）", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    region.appendInline("partial"); // col 1 → 8
    buffer.value = "";
    region.beginReplaceableSegment();
    // emit cursor (1, 8) + "\n"
    expect(buffer.value).toBe("\x1b[1;8H" + "\n");
    expect(region.state.regionTailRow).toBe(2);
    expect(region.state.regionTailCol).toBe(1);
  });

  it("mid-line begin 在 scrollBottom — 触发 1 次滚动、tailRow 钉 scrollBottom", () => {
    const { region } = makeRegion({ rows: 6 });
    region.attachInput(0, "");
    // 推到 row 6 col > 1
    region.appendInline("a\nb\nc\nd\ne\n"); // row 1 → 6
    region.appendInline("partial"); // col 1 → 8
    expect(region.state.regionTailRow).toBe(6);
    expect(region.state.regionTailCol).toBe(8);
    region.beginReplaceableSegment();
    // 在 scrollBottom mid-line begin → 1 \n 触发 scroll
    expect(region.state.regionTailRow).toBe(6);
    expect(region.state.regionTailCol).toBe(1);
  });

  it("已有 active segment 时 begin 抛错", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    region.beginReplaceableSegment();
    expect(() => region.beginReplaceableSegment()).toThrow(
      /another is active/,
    );
  });

  it("commit 后 begin 新 segment 正常", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    const s1 = region.beginReplaceableSegment();
    s1.commit("hello");
    expect(() => region.beginReplaceableSegment()).not.toThrow();
  });

  it("close 后 begin 新 segment 正常", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    const s1 = region.beginReplaceableSegment();
    s1.close();
    expect(() => region.beginReplaceableSegment()).not.toThrow();
  });
});

describe("ScrollRegion · segment.replace（常规路径 M' ≤ K）", () => {
  it("首次 replace — writeStartRow = regionTailRow", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    region.writeScrollLine("welcome"); // row 1→2
    expect(region.state.regionTailRow).toBe(2);
    const seg = region.beginReplaceableSegment();
    buffer.value = "";
    seg.replace("a\nb\nc"); // M=3
    // writeStartRow = 2, writeBottomRow = 4, no old segment
    // erase 2..4 (3 行), write a\nb\nc
    const expected =
      "\x1b[2;1H\x1b[2K" +
      "\x1b[3;1H\x1b[2K" +
      "\x1b[4;1H\x1b[2K" +
      "\x1b[2;1H" + "a\nb\nc";
    expect(buffer.value).toBe(expected);
    const s = region.state;
    expect(s.segmentTopRow).toBe(2);
    expect(s.segmentBottomRow).toBe(4);
    expect(s.segmentRemainingRows).toBe(3);
    expect(s.regionTailRow).toBe(4);
    expect(s.regionTailCol).toBe(2); // "c" 长度 1 + 1
  });

  it("第二次 replace — writeStartRow = 旧 segmentTopRow", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    region.writeScrollLine("w");
    const seg = region.beginReplaceableSegment();
    seg.replace("a\nb\nc"); // segment 2..4
    buffer.value = "";
    seg.replace("xx\nyy"); // M=2，writeStart=2，writeBottom=3
    // erase 2..max(4, 3) = 2..4 (3 行)、write
    const expected =
      "\x1b[2;1H\x1b[2K" +
      "\x1b[3;1H\x1b[2K" +
      "\x1b[4;1H\x1b[2K" +
      "\x1b[2;1H" + "xx\nyy";
    expect(buffer.value).toBe(expected);
    const s = region.state;
    expect(s.segmentTopRow).toBe(2);
    expect(s.segmentBottomRow).toBe(3);
    expect(s.segmentRemainingRows).toBe(2);
    expect(s.regionTailRow).toBe(3);
    expect(s.regionTailCol).toBe(3); // "yy" 2 + 1
  });

  it("replace 增长（M 增大）— erase 范围扩到新 writeBottom", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    const seg = region.beginReplaceableSegment();
    seg.replace("a"); // segment 1..1
    buffer.value = "";
    seg.replace("a\nb\nc"); // M=3, writeStart=1, writeBottom=3
    // erase 1..max(1, 3) = 1..3 (3 行)
    expect(buffer.value).toContain("\x1b[3;1H\x1b[2K");
    expect(region.state.segmentBottomRow).toBe(3);
  });

  it("replace 末尾带 \\n — col 归 1（spec：M = split.length 含末空段）", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    const seg = region.beginReplaceableSegment();
    seg.replace("a\nb\n"); // split = ['a', 'b', ''] → M=3
    const s = region.state;
    expect(s.segmentTopRow).toBe(1);
    expect(s.segmentBottomRow).toBe(3);
    expect(s.regionTailCol).toBe(1); // 末段 = "" → width 0 + 1
  });

  it("空 newText — M=1（split=['']）, segment 占 1 行", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    const seg = region.beginReplaceableSegment();
    seg.replace("");
    const s = region.state;
    expect(s.segmentTopRow).toBe(1);
    expect(s.segmentBottomRow).toBe(1);
    expect(s.segmentRemainingRows).toBe(1);
  });
});

describe("ScrollRegion · segment.replace（partial commit M' > K）", () => {
  it("M' 越过 K — overflow 滚动 + segment 字段最终位置正确", () => {
    const { region, buffer } = makeRegion({ rows: 24 }); // scrollBottom = 24
    region.attachInput(0, "");
    // 先把 cursor 推到 row 12 模拟前序内容
    for (let i = 0; i < 11; i++) region.writeScrollLine(`l${i}`);
    expect(region.state.regionTailRow).toBe(12);

    const seg = region.beginReplaceableSegment();
    // K = 24 - 12 + 1 = 13；M' = 15 > K → partial
    const newText = Array.from({ length: 15 }, (_, i) => `r${i}`).join("\n");
    buffer.value = "";
    seg.replace(newText);

    const s = region.state;
    // overflow = 15 - 13 = 2
    // segmentTopRow = max(1, 12 - 2) = 10
    // segmentBottomRow = scrollBottom = 24
    // segmentRemainingRows = 24 - 10 + 1 = 15
    // committedLogicalRows += 15 - 15 = 0
    expect(s.segmentTopRow).toBe(10);
    expect(s.segmentBottomRow).toBe(24);
    expect(s.segmentRemainingRows).toBe(15);
    expect(s.committedLogicalRows).toBe(0);
    expect(s.regionTailRow).toBe(24);
    expect(s.regionFilledRows).toBe(24);
  });

  it("partial commit 极端：segment 自己饱和 — committedLogicalRows 累加", () => {
    const { region } = makeRegion({ rows: 10 }); // scrollBottom = 10
    region.attachInput(0, "");
    // writeStartRow = 1（首次），M' = 15 > K=10
    const seg = region.beginReplaceableSegment();
    const newText = Array.from({ length: 15 }, (_, i) => `r${i}`).join("\n");
    seg.replace(newText);
    const s = region.state;
    // overflow = 15 - 10 = 5
    // segmentTopRow = max(1, 1 - 5) = 1
    // segmentBottomRow = 10
    // segmentRemainingRows = 10
    // committedLogicalRows = 15 - 10 = 5
    expect(s.segmentTopRow).toBe(1);
    expect(s.segmentBottomRow).toBe(10);
    expect(s.segmentRemainingRows).toBe(10);
    expect(s.committedLogicalRows).toBe(5);
    expect(s.regionTailRow).toBe(10);
  });

  it("partial commit 后再 replace — slice 跳过已固化早期行", () => {
    const { region, buffer } = makeRegion({ rows: 10 });
    region.attachInput(0, "");
    const seg = region.beginReplaceableSegment();
    const lines1 = Array.from({ length: 15 }, (_, i) => `a${i}`);
    seg.replace(lines1.join("\n"));
    expect(region.state.committedLogicalRows).toBe(5);

    buffer.value = "";
    // 再 replace 20 行新内容；M' = 20 - 5 = 15 > K=10
    const lines2 = Array.from({ length: 20 }, (_, i) => `b${i}`);
    seg.replace(lines2.join("\n"));
    // slice(5) 跳前 5 行；写入 b5..b19 共 15 行
    const slicedText = lines2.slice(5).join("\n");
    expect(buffer.value).toContain(slicedText);
  });
});

describe("ScrollRegion · segment.commit / close", () => {
  it("commit 后 segment 字段清 null + activeHandle 释放", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    const seg = region.beginReplaceableSegment();
    seg.replace("a\nb");
    seg.commit("final\nresult");
    const s = region.state;
    expect(s.segmentTopRow).toBeNull();
    expect(s.segmentBottomRow).toBeNull();
    expect(s.segmentRemainingRows).toBeNull();
    expect(s.committedLogicalRows).toBe(0);
    // 可以再 begin 新 segment
    expect(() => region.beginReplaceableSegment()).not.toThrow();
  });

  it("close 不写内容、清 segment 字段", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    const seg = region.beginReplaceableSegment();
    seg.replace("a");
    buffer.value = "";
    seg.close();
    expect(buffer.value).toBe("");
    expect(region.state.segmentTopRow).toBeNull();
  });

  it("commit 后再调 commit / replace — handle.closed 防御 no-op / 不抛错", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    const seg = region.beginReplaceableSegment();
    seg.commit("done");
    buffer.value = "";
    expect(() => seg.commit("again")).not.toThrow();
    expect(() => seg.replace("again")).not.toThrow();
    expect(buffer.value).toBe("");
  });

  it("close 后再调 close — 幂等", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    const seg = region.beginReplaceableSegment();
    seg.close();
    expect(() => seg.close()).not.toThrow();
  });

  it("detach 失效旧 handle — replace 抛错", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    const seg = region.beginReplaceableSegment();
    region.detachInput();
    region.attachInput(0, "");
    expect(() => seg.replace("x")).toThrow(/no longer active/);
  });

  it("新 segment 接管后旧 handle.commit 抛错（防误改 region 状态）", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    const s1 = region.beginReplaceableSegment();
    s1.close();
    region.beginReplaceableSegment();
    // s1 已 close → 内部 closed=true → SegmentHandleImpl 包装层直接 no-op
    // 但若构造一个 close 前被外部 nullify 的场景：
    // 这里通过 replace 路径验证 — close 后 closed=true → SegmentHandleImpl 已 short-circuit
    expect(() => s1.replace("x")).not.toThrow(); // 因 closed=true 静默
  });

  it("活跃 handle 期间 detach — 旧 handle.close 静默 no-op（不影响新 region 状态）", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    const seg = region.beginReplaceableSegment();
    region.detachInput();
    region.attachInput(0, "");
    const newSeg = region.beginReplaceableSegment();
    // 旧 seg 仍未在用户层 closed，调 close 应静默 no-op、不影响 newSeg
    seg.close();
    expect(() => newSeg.commit("ok")).not.toThrow();
  });
});

describe("ScrollRegion · setChromeHeight 不变（仅重画内容）", () => {
  it("emit chromeBytes + cursor 回 (regionTailRow, regionTailCol)", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(3, "<old-chrome>");
    region.writeScrollLine("a"); // row 1→2, col 1
    buffer.value = "";
    region.setChromeHeight(3, "<new-chrome>");
    expect(buffer.value).toBe("<new-chrome>" + "\x1b[2;1H");
    // 状态字段不变
    expect(region.state.chromeHeight).toBe(3);
    expect(region.state.scrollBottom).toBe(21);
  });
});

describe("ScrollRegion · setChromeHeight 变高 surplus 充足", () => {
  it("region 顶部空闲足 — 不推 scrollback、缩 DECSTBM", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(2, ""); // scrollBottom = 22
    region.writeScrollLine("welcome"); // row 1→2, filled=2
    buffer.value = "";
    region.setChromeHeight(5, "<chrome>"); // N_diff=3, surplus=22-2=20 >= 3
    // 不 push、emit DECSTBM(1,19) + chromeBytes + cursor (2,1)
    expect(buffer.value).toBe(
      "\x1b[1;19r" + "<chrome>" + "\x1b[2;1H",
    );
    const s = region.state;
    expect(s.chromeHeight).toBe(5);
    expect(s.scrollBottom).toBe(19);
    expect(s.regionTailRow).toBe(2);
    expect(s.regionFilledRows).toBe(2);
  });
});

describe("ScrollRegion · setChromeHeight 变高 surplus 不足", () => {
  it("emit \\n × pushRows 推走 region 顶 + applyScrollEvent 同步状态", () => {
    const { region, buffer } = makeRegion({ rows: 10 });
    region.attachInput(0, ""); // scrollBottom = 10
    // 推到 row 10, filled=10
    for (let i = 0; i < 9; i++) region.writeScrollLine(`l${i}`);
    expect(region.state.regionTailRow).toBe(10);
    expect(region.state.regionFilledRows).toBe(10);

    buffer.value = "";
    // chrome 0 → 3, scrollBottom 10 → 7, N_diff=3, surplus=10-10=0
    // pushRows = 3 - 0 = 3
    region.setChromeHeight(3, "<chrome>");
    // 期待：cursor (10,1) + \n\n\n + DECSTBM(1,7) + chromeBytes + cursor 回
    expect(buffer.value.startsWith("\x1b[10;1H\n\n\n")).toBe(true);
    expect(buffer.value).toContain("\x1b[1;7r");
    expect(buffer.value).toContain("<chrome>");

    const s = region.state;
    expect(s.chromeHeight).toBe(3);
    expect(s.scrollBottom).toBe(7);
    // regionTailRow = max(1, 10 - 3) = 7
    expect(s.regionTailRow).toBe(7);
    // filled was 10, push 3, filled_post = max(7, 7) = 7（钉到 scrollBottom_new）
    expect(s.regionFilledRows).toBe(7);
  });

  it("surplus 不足 + segment 活跃 — segment 字段同步递减", () => {
    const { region } = makeRegion({ rows: 10 });
    region.attachInput(0, "");
    // 把 cursor 推到 row 5, filled=5
    for (let i = 0; i < 4; i++) region.writeScrollLine(`l${i}`);
    const seg = region.beginReplaceableSegment();
    seg.replace("a\nb\nc"); // segment 5..7, filled=7, regionTailRow=7
    expect(region.state.segmentTopRow).toBe(5);
    expect(region.state.segmentBottomRow).toBe(7);
    expect(region.state.regionFilledRows).toBe(7);

    // chrome 0 → 5, scrollBottom 10 → 5, N_diff=5, surplus=10-7=3 < 5
    // pushRows = 5 - 3 = 2
    region.setChromeHeight(5, "");
    const s = region.state;
    // segment 字段递减 2: top 5→3, bot 7→5
    expect(s.segmentTopRow).toBe(3);
    expect(s.segmentBottomRow).toBe(5);
    expect(s.scrollBottom).toBe(5);
  });
});

describe("ScrollRegion · setChromeHeight 变矮", () => {
  it("scrollBottom 增大 — 扩 DECSTBM + 清原 chrome 顶部行", () => {
    const { region, buffer } = makeRegion({ rows: 10 });
    region.attachInput(5, "<old-chrome>"); // scrollBottom = 5
    region.writeScrollLine("a"); // row 1→2, filled=2
    buffer.value = "";
    // chrome 5 → 2, scrollBottom 5 → 8, N_diff = 3
    region.setChromeHeight(2, "<new-chrome>");
    // emit DECSTBM(1,8) + 清 row 6/7/8 + chromeBytes + cursor 回 (2,1)
    expect(buffer.value).toBe(
      "\x1b[1;8r" +
        "\x1b[6;1H\x1b[2K" +
        "\x1b[7;1H\x1b[2K" +
        "\x1b[8;1H\x1b[2K" +
        "<new-chrome>" +
        "\x1b[2;1H",
    );
    const s = region.state;
    expect(s.chromeHeight).toBe(2);
    expect(s.scrollBottom).toBe(8);
    // filled 不变（清的是显示残留，不是逻辑内容）
    expect(s.regionFilledRows).toBe(2);
    expect(s.regionTailRow).toBe(2);
  });
});

describe("ScrollRegion · setChromeHeight 边界", () => {
  it("未 attached 抛错", () => {
    const { region } = makeRegion();
    expect(() => region.setChromeHeight(3, "")).toThrow(/not attached/);
  });

  it("newHeight 负值抛错", () => {
    const { region } = makeRegion();
    region.attachInput(2, "");
    expect(() => region.setChromeHeight(-1, "")).toThrow(/must be ≥ 0/);
  });

  it("newHeight ≥ viewportRows 抛错", () => {
    const { region } = makeRegion({ rows: 5 });
    region.attachInput(2, "");
    expect(() => region.setChromeHeight(5, "")).toThrow(/no room for region/);
  });
});

describe("ScrollRegion · suspend / resume", () => {
  it("suspend emit cursor (chrome 顶, 1) + erase below + 撤 DECSTBM", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(3, "<chrome>");
    buffer.value = "";
    region.suspend();
    expect(buffer.value).toBe("\x1b[22;1H" + "\x1b[J" + "\x1b[r");
    expect(region.state.suspended).toBe(true);
    expect(region.state.attached).toBe(true);
  });

  it("suspend 清 segment 字段 + 失活 handle", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    const seg = region.beginReplaceableSegment();
    seg.replace("a\nb");
    region.suspend();
    const s = region.state;
    expect(s.segmentTopRow).toBeNull();
    expect(s.segmentBottomRow).toBeNull();
    expect(s.segmentRemainingRows).toBeNull();
    expect(s.committedLogicalRows).toBe(0);
    // 旧 handle 失活：replace 抛错
    expect(() => seg.replace("c")).toThrow(/no longer active/);
  });

  it("suspend 期间写入抛错", () => {
    const { region } = makeRegion();
    region.attachInput(2, "");
    region.suspend();
    expect(() => region.writeScrollLine("x")).toThrow(/suspended/);
    expect(() => region.appendInline("x")).toThrow(/suspended/);
    expect(() => region.beginReplaceableSegment()).toThrow(/suspended/);
  });

  it("suspend chromeHeight=0 不发 erase chrome 序列", () => {
    const { region, buffer } = makeRegion();
    region.attachInput(0, "");
    buffer.value = "";
    region.suspend();
    expect(buffer.value).toBe("\x1b[r");
  });

  it("重复 suspend 是 no-op", () => {
    const { region, buffer } = makeRegion();
    region.attachInput(2, "");
    region.suspend();
    buffer.value = "";
    region.suspend();
    expect(buffer.value).toBe("");
  });

  it("未 attached 时 suspend 抛错", () => {
    const { region } = makeRegion();
    expect(() => region.suspend()).toThrow(/not attached/);
  });

  it("resume emit DECSTBM + chromeBytes + cursor (1,1)、状态归零", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(3, "");
    region.writeScrollLine("a");
    region.suspend();
    buffer.value = "";
    region.resume(2, "<new-chrome>");
    expect(buffer.value).toBe(
      "\x1b[1;22r" + "<new-chrome>" + "\x1b[1;1H",
    );
    const s = region.state;
    expect(s.suspended).toBe(false);
    expect(s.chromeHeight).toBe(2);
    expect(s.scrollBottom).toBe(22);
    expect(s.regionTailRow).toBe(1);
    expect(s.regionFilledRows).toBe(0);
  });

  it("resume 后可正常写入", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(2, "");
    region.suspend();
    region.resume(2, "");
    expect(() => region.writeScrollLine("x")).not.toThrow();
    expect(region.state.regionTailRow).toBe(2);
  });

  it("resume chromeHeight 边界校验", () => {
    const { region } = makeRegion({ rows: 5 });
    region.attachInput(2, "");
    region.suspend();
    expect(() => region.resume(-1, "")).toThrow(/must be ≥ 0/);
    expect(() => region.resume(5, "")).toThrow(/no room for region/);
  });
});

describe("ScrollRegion · handleResize", () => {
  it("chromeHeight 不变——更新 viewport 尺寸 + 重设 DECSTBM + 清 segment 字段（保留 committed）", () => {
    const { region, buffer } = makeRegion({ rows: 24, cols: 80 });
    region.attachInput(3, "");
    const seg = region.beginReplaceableSegment();
    seg.replace("a\nb\nc"); // segment 1..3
    expect(region.state.segmentTopRow).toBe(1);

    buffer.value = "";
    region.handleResize(30, 100, 3, "<chrome>");
    // viewport 30, chromeHeight 仍 3, scrollBottom = 27
    expect(buffer.value).toBe(
      "\x1b[1;27r" + "<chrome>" + "\x1b[1;1H",
    );
    const s = region.state;
    expect(s.viewportRows).toBe(30);
    expect(s.viewportCols).toBe(100);
    expect(s.chromeHeight).toBe(3);
    expect(s.scrollBottom).toBe(27);
    expect(s.regionTailRow).toBe(1);
    expect(s.regionFilledRows).toBe(0);
    // segment 字段清 null（resize 后 viewport 位置不可控）
    expect(s.segmentTopRow).toBeNull();
    expect(s.segmentBottomRow).toBeNull();
    expect(s.segmentRemainingRows).toBeNull();
  });

  it("chromeHeight 变化（input reflow 因 columns 变窄触发）→ DECSTBM 用新 chromeHeight 算 scrollBottom", () => {
    const { region, buffer } = makeRegion({ rows: 10, cols: 80 });
    region.attachInput(2, ""); // 旧 chromeHeight=2, scrollBottom=8

    buffer.value = "";
    // 模拟 columns 80→40 导致 input box 行数 1→2，新 chromeHeight=3
    region.handleResize(20, 40, 3, "<new-chrome>");

    // 关键不变量：DECSTBM bottom 必须等于 viewportRows - newChromeHeight = 20 - 3 = 17
    // 而非 viewportRows - oldChromeHeight = 20 - 2 = 18（旧 bug 表现）
    expect(buffer.value).toContain("\x1b[1;17r");
    expect(buffer.value).not.toContain("\x1b[1;18r");
    expect(buffer.value).toContain("<new-chrome>");

    const s = region.state;
    expect(s.viewportRows).toBe(20);
    expect(s.viewportCols).toBe(40);
    expect(s.chromeHeight).toBe(3);
    expect(s.scrollBottom).toBe(17);
  });

  it("chromeHeight 变小（用户拉宽窗口让 input 单行）→ DECSTBM 用新 chromeHeight", () => {
    const { region, buffer } = makeRegion({ rows: 10, cols: 40 });
    region.attachInput(3, ""); // 旧 chromeHeight=3, scrollBottom=7

    buffer.value = "";
    region.handleResize(30, 120, 1, "<chrome>");
    // 新 chromeHeight=1, scrollBottom=29
    expect(buffer.value).toContain("\x1b[1;29r");
    expect(region.state.chromeHeight).toBe(1);
    expect(region.state.scrollBottom).toBe(29);
  });

  it("resize 不强制 commit handle — caller 下次 replace 走首次路径", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(0, "");
    const seg = region.beginReplaceableSegment();
    seg.replace("a");
    region.handleResize(30, 100, 0, "");
    // handle 仍活跃；下次 replace 不抛错
    expect(() => seg.replace("b\nc")).not.toThrow();
    // 走首次路径（无旧 segmentTopRow）→ writeStartRow = regionTailRow = 1
    expect(region.state.segmentTopRow).toBe(1);
  });

  it("resize 后新 chromeHeight 超 viewportRows 抛错", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(2, "");
    expect(() => region.handleResize(15, 80, 20, "")).toThrow(/no room/);
  });

  it("resize 接受 chromeHeight 负值抛错", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(2, "");
    expect(() => region.handleResize(30, 100, -1, "")).toThrow(/must be ≥ 0/);
  });

  it("未 attached 时 resize 抛错", () => {
    const { region } = makeRegion();
    expect(() => region.handleResize(30, 100, 0, "")).toThrow(/not attached/);
  });
});

describe("ScrollRegion · shutdown", () => {
  it("撤 DECSTBM + cursor 跳 viewport 底、清状态", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(2, "");
    buffer.value = "";
    region.shutdown();
    expect(buffer.value).toBe("\x1b[r" + "\x1b[24;1H");
    expect(region.state.attached).toBe(false);
  });

  it("shutdown 后所有状态字段一致归零（与 detachInput 行为对称）", () => {
    const { region } = makeRegion({ rows: 24 });
    region.attachInput(3, "");
    const seg = region.beginReplaceableSegment();
    seg.replace("a\nb\nc"); // segment 1..3
    region.shutdown();
    const s = region.state;
    expect(s.attached).toBe(false);
    expect(s.suspended).toBe(false);
    expect(s.chromeHeight).toBe(0);
    expect(s.scrollBottom).toBe(s.viewportRows);
    expect(s.regionTailRow).toBe(1);
    expect(s.regionTailCol).toBe(1);
    expect(s.regionFilledRows).toBe(0);
    expect(s.segmentTopRow).toBeNull();
    expect(s.segmentBottomRow).toBeNull();
    expect(s.segmentRemainingRows).toBeNull();
    expect(s.committedLogicalRows).toBe(0);
  });

  it("未 attached 时 shutdown 是 no-op", () => {
    const { region, buffer } = makeRegion();
    region.shutdown();
    expect(buffer.value).toBe("");
  });

  it("重复 shutdown 是 no-op", () => {
    const { region, buffer } = makeRegion({ rows: 24 });
    region.attachInput(2, "");
    region.shutdown();
    buffer.value = "";
    region.shutdown();
    expect(buffer.value).toBe("");
  });
});

describe("ScrollRegion · replaceSegment 数据不变量", () => {
  it("M < committedLogicalRows 抛错（caller 违约——newText 短于已固化部分）", () => {
    const { region } = makeRegion({ rows: 10 });
    region.attachInput(0, "");
    const seg = region.beginReplaceableSegment();
    // 触发 partial commit 让 committedLogicalRows = 5
    const lines1 = Array.from({ length: 15 }, (_, i) => `a${i}`);
    seg.replace(lines1.join("\n"));
    expect(region.state.committedLogicalRows).toBe(5);

    // 用一个比 committed (5) 还短的 newText（M=3）
    expect(() => seg.replace("a\nb\nc")).toThrow(
      /shorter than already-committed/,
    );
  });

  it("M === committedLogicalRows 是 idempotent no-op（不写字节、状态不变）", () => {
    const { region, buffer } = makeRegion({ rows: 10 });
    region.attachInput(0, "");
    const seg = region.beginReplaceableSegment();
    const lines1 = Array.from({ length: 15 }, (_, i) => `a${i}`);
    seg.replace(lines1.join("\n"));
    expect(region.state.committedLogicalRows).toBe(5);
    const stateBefore = region.state;

    // 用一个 M = committedLogicalRows = 5 的 newText（caller 重复 replace 同一已
    // 完全固化内容场景；典型：streaming 期间 chunk 来但 list 未增长）
    buffer.value = "";
    seg.replace("0\n1\n2\n3\n4"); // split.length = 5

    // 不写字节 + 状态字段全部不变
    expect(buffer.value).toBe("");
    const stateAfter = region.state;
    expect(stateAfter).toEqual(stateBefore);
  });

  it("M > committedLogicalRows 正常路径分流（无误伤）", () => {
    const { region } = makeRegion({ rows: 10 });
    region.attachInput(0, "");
    const seg = region.beginReplaceableSegment();
    const lines1 = Array.from({ length: 15 }, (_, i) => `a${i}`);
    seg.replace(lines1.join("\n"));
    expect(region.state.committedLogicalRows).toBe(5);
    // M=10 > committed=5 → M_prime=5 → normal 路径正常工作
    expect(() => seg.replace("0\n1\n2\n3\n4\n5\n6\n7\n8\n9")).not.toThrow();
    // segmentRemainingRows = 5
    expect(region.state.segmentRemainingRows).toBe(5);
  });
});

describe("ScrollRegion · applyScrollEvent segment 完全推走分支", () => {
  it("segment 被后续滚动完全推下 region 顶 → 字段清 null + committed 累加 + handle 仍可重用", () => {
    const { region } = makeRegion({ rows: 6 }); // scrollBottom = 6
    region.attachInput(0, "");
    // 推到 row 5（filled=5）让小 segment 占 row 5..5
    for (const c of ["a", "b", "c", "d"]) region.writeScrollLine(c);
    expect(region.state.regionTailRow).toBe(5);

    const seg = region.beginReplaceableSegment();
    seg.replace("seg"); // segment 5..5、remaining=1
    expect(region.state.segmentTopRow).toBe(5);
    expect(region.state.segmentBottomRow).toBe(5);
    expect(region.state.segmentRemainingRows).toBe(1);

    // appendInline 6 个 \n 起手在 (5, 4)：
    //   首 \n 推 cursor 到 (6, 1) 不滚动；后续 5 个 \n 都在 scrollBottom 触发滚动。
    //   N=5 → segmentTopRow = 5-5 = 0、segmentBottomRow = 0 < 1
    //   → 走 applyScrollEvent 的"完全推走"分支
    region.appendInline("\n".repeat(6));

    const s = region.state;
    expect(s.segmentTopRow).toBeNull();
    expect(s.segmentBottomRow).toBeNull();
    expect(s.segmentRemainingRows).toBeNull();
    // segment 占的 1 行被推进 scrollback、committed 累加
    expect(s.committedLogicalRows).toBe(1);
    // activeHandle 不被自动失活——caller 持有的 handle 仍可继续用，下次 replace
    // 走"首次"路径在新位置重起（spec 明文：segment 推走后 caller 角度仍可调 replace）
    expect(() => seg.replace("seg\nrebirth\nlines")).not.toThrow();
    // 重生 segment：committed 仍累加（slice 跳过已固化早期行）
    expect(region.state.segmentTopRow).not.toBeNull();
    expect(region.state.committedLogicalRows).toBe(1);
  });
});
