/**
 * Scroll region 核心模块——DECSTBM 三区模型的协议层。
 *
 * 三区模型：
 *   ┌──────────────────────┐
 *   │ Scrollback (committed)│ 通过 region 顶滚动自然进入；一旦进入永不 touch
 *   ├──────────────────────┤  ← row 1
 *   │ Scroll Region (DECSTBM)│ 终端原生区域内自滚；底部 \n 触发滚动推到 scrollback
 *   ├──────────────────────┤  ← scrollBottom
 *   │ Chrome (status + input)│ 区域外、不参与 region 滚动；caller 自管字节序列
 *   └──────────────────────┘  ← viewportRows
 *
 * 职责：
 *   - 维护 region / segment / chrome 的精确 viewport 行追踪
 *   - 发射 DECSTBM / cursor positioning / line erase 等 ANSI 控制序列
 *   - 统一收口"region 滚动事件"的状态同步公式（applyScrollEvent）
 *
 * 不做：
 *   - 不解析终端输入（DECSTBM 写出后由终端硬件保证 region 内自滚）
 *   - 不感知 chrome 内容形态（status / input 由 caller 自拼字节并通过协议方法注入）
 *   - 不验证 caller 行宽合约（违反时表现为 segment 位置漂移；由 caller 端测试拦截）
 *
 * 行宽合约（caller 端保证）：
 *   送入 writeScrollLine / appendInline / segment.replace / segment.commit 的字符串
 *   按 \n 切分后每段显示宽度 ≤ columns - 1。违反 → 终端隐式 wrap → 物理行数 >
 *   逻辑行数 → segment 位置漂移、滚动数低估。
 *
 * top-anchored 自然流不变量：
 *   cursor 顺内容下行；regionTailRow ∈ [1, scrollBottom]；当 regionTailRow =
 *   scrollBottom 时下一个 \n 才触发 region 滚动。welcome 在 region 顶、流式内容
 *   紧贴前序内容尾——视觉上无断层。
 */

import { stripAnsi } from "../tui/ansi.js";
import { stringWidth } from "../tui/line-width.js";

const ESC = "\x1b";

/** 字符串中 `\n` 出现次数——比 split('\n').length-1 省一次数组分配 */
function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0a /* '\n' */) n++;
  }
  return n;
}

/** 构造期注入的依赖——viewport 尺寸 + 写出函数 */
export interface ScrollRegionOptions {
  /** 终端 viewport 行数（1-based 上限） */
  readonly viewportRows: number;
  /** 终端 viewport 列数（1-based 上限） */
  readonly viewportCols: number;
  /** stdout 写出函数——测试时注入 mock 捕获字节序列；真实场景 = stdout.write */
  readonly write: (chunk: string) => void;
}

/** 状态快照——测试与调试用，不暴露内部 mutable 引用 */
export interface ScrollRegionState {
  readonly viewportRows: number;
  readonly viewportCols: number;
  readonly chromeHeight: number;
  readonly scrollBottom: number;
  readonly regionTailRow: number;
  readonly regionTailCol: number;
  readonly regionFilledRows: number;
  readonly segmentTopRow: number | null;
  readonly segmentBottomRow: number | null;
  readonly segmentRemainingRows: number | null;
  readonly committedLogicalRows: number;
  readonly attached: boolean;
  readonly suspended: boolean;
  /**
   * 当前 cursor 所在物理行是否已含可见字符（非 \n 非 ANSI）。
   * `false` 表示 cursor 在某行起首尚未写入可见内容（典型态：刚写完 \n）。
   * caller（如 ScreenController.ensureScrollLeadingBlank）用此字段配合
   * trailingBlankRows 决定段间空行是否需要补。
   */
  readonly currentRowHasVisible: boolean;
  /**
   * cursor 上方连续空行数（不含 cursor 所在当前行）。
   * 0 表示上一行有可见内容（无空行隔离）；≥1 表示上方有空行可作段间间距。
   * 与 currentRowHasVisible 联合表达视觉行级 tail 状态——为"段间空行幂等
   * 保证"提供事实依据，避免 caller 误判段间间距而引起 regression。
   */
  readonly trailingBlankRows: number;
}

/**
 * Replaceable segment 句柄——markdown code block / list 双态渲染用。
 *
 * 生命周期：begin → replace × N → commit / close。close 后所有调用 no-op（幂等）。
 * 同一 ScrollRegion 同时只有一个活跃 segment（caller 必须先 commit / close 旧
 * segment 才能 begin 新的）。
 */
export interface SegmentHandle {
  /** 用 newText 替换 segment 当前内容；M' 超过 region 容量时走 partial commit */
  replace(newText: string): void;
  /** 提交最终内容；segment 字段清空，handle 关闭 */
  commit(newText: string): void;
  /** 不写内容直接关闭——segment 字段清空，handle 失活 */
  close(): void;
}

/**
 * Scroll region 协议实现。
 *
 * 典型生命周期：
 *   const region = new ScrollRegion({ viewportRows, viewportCols, write });
 *   region.attachInput(chromeHeight, chromeBytes);  // 启动 + 画 chrome
 *   region.writeScrollLine(welcome);                // 写 welcome
 *   const seg = region.beginReplaceableSegment();   // 流式 segment
 *   seg.replace(streamingDim);                       // 多次 replace
 *   seg.commit(finalHighlighted);                    // 闭合
 *   region.appendInline(chunk);                      // 流式接续
 *   region.detachInput();                            // 退出 chrome 模式
 */
export class ScrollRegion {
  private viewportRows: number;
  private viewportCols: number;
  private chromeHeight = 0;
  private scrollBottom: number;
  private regionTailRow = 1;
  private regionTailCol = 1;
  private regionFilledRows = 0;
  private segmentTopRow: number | null = null;
  private segmentBottomRow: number | null = null;
  private segmentRemainingRows: number | null = null;
  private committedLogicalRows = 0;
  private attached = false;
  private suspended = false;
  private activeHandle: SegmentHandleImpl | null = null;
  /**
   * 视觉行级 tail state —— 配合 ScreenController.ensureScrollLeadingBlank
   * 实现"段间空行幂等保证"。两字段联合表达"cursor 当前位置与上方空行情况"，
   * 等价于 stripAnsi 后的字节流末尾视觉行状态：
   *   - currentRowHasVisible=true：cursor 在某行中段，行已有可见字符
   *   - currentRowHasVisible=false + trailingBlankRows=0：cursor 在新行起首，上一行有内容（无段间空行）
   *   - currentRowHasVisible=false + trailingBlankRows≥1：cursor 在新行起首，上方至少 1 行空行
   *
   * 初始 trailingBlankRows=1（不是 0）：region 新建时 cursor 在 row 1，没有
   * 实际"上一行"概念；初始为 1 让首次 ensureScrollLeadingBlank no-op，避免
   * 在 region 顶端插无意义空行。
   *
   * 维护点：所有"写 region 内容"的方法在 writeOut 之后调一次 updateLineState
   * 传入实际 emit 的字节流；stripAnsi 后逐字符演化状态机。
   * **不维护点**：pushTopToScrollback（协议级 \n 触发硬件滚动，不代表内容追加）、
   * 各 chromeBytes 写入路径（chrome 区在 region 外）、cursorToSeq / clearLineSeq
   * 等纯 ANSI 控制序列（stripAnsi 自动剥掉，no-op）。
   */
  private currentRowHasVisible = false;
  private trailingBlankRows = 1;
  private readonly writeOut: (chunk: string) => void;

  constructor(opts: ScrollRegionOptions) {
    this.viewportRows = opts.viewportRows;
    this.viewportCols = opts.viewportCols;
    this.scrollBottom = opts.viewportRows;
    this.writeOut = opts.write;
  }

  get state(): ScrollRegionState {
    return {
      viewportRows: this.viewportRows,
      viewportCols: this.viewportCols,
      chromeHeight: this.chromeHeight,
      scrollBottom: this.scrollBottom,
      regionTailRow: this.regionTailRow,
      regionTailCol: this.regionTailCol,
      regionFilledRows: this.regionFilledRows,
      segmentTopRow: this.segmentTopRow,
      segmentBottomRow: this.segmentBottomRow,
      segmentRemainingRows: this.segmentRemainingRows,
      committedLogicalRows: this.committedLogicalRows,
      attached: this.attached,
      suspended: this.suspended,
      currentRowHasVisible: this.currentRowHasVisible,
      trailingBlankRows: this.trailingBlankRows,
    };
  }

  /**
   * 视觉行级 tail state 更新——传入实际 emit 的字节流，stripAnsi 后逐字符演化。
   * 所有"写 region 内容"路径（appendInline / writeScrollLine / replaceSegment /
   * beginReplaceableSegment 的 fresh-line emit）在 writeOut 之后调用一次。
   *
   * 字符级语义：
   *   - `\n`：当前行收口。若 currentRowHasVisible→trailingBlankRows=0；否则
   *     trailingBlankRows++。cursor 进入新行，currentRowHasVisible=false。
   *   - 可见字符：currentRowHasVisible=true（当前行染色为"有内容"）。
   *   - ANSI 控制：stripAnsi 已剥离，不会进入本循环。
   */
  private updateLineState(emittedContent: string): void {
    const visible = stripAnsi(emittedContent);
    for (const ch of visible) {
      if (ch === "\n") {
        if (this.currentRowHasVisible) {
          this.trailingBlankRows = 0;
        } else {
          this.trailingBlankRows++;
        }
        this.currentRowHasVisible = false;
      } else {
        this.currentRowHasVisible = true;
      }
    }
  }

  /**
   * 启动序列——attach input region。
   *
   * chromeHeight：input + status 总高度（caller 自算）；0 = 暂无 chrome（welcome
   * 期）。chromeBytes：chrome 区域字节序列，已包含 cursor positioning + 内容；
   * caller 应保证只走 cursor positioning 切行、永不 emit \n（chrome 在 DECSTBM
   * 区外，\n 会触发整屏滚动破坏 chrome 永驻）。
   *
   * 启动后：DECSTBM 设为 [1, scrollBottom]、cursor 跳 (1, 1) 作为 region 顶起点。
   * 状态字段全归零（regionTailRow=1, regionTailCol=1, regionFilledRows=0,
   * segment* = null, committedLogicalRows=0）。
   */
  attachInput(chromeHeight: number, chromeBytes: string): void {
    if (this.attached) {
      throw new Error("ScrollRegion: attachInput called while already attached");
    }
    if (chromeHeight < 0) {
      throw new Error(`ScrollRegion: chromeHeight must be ≥ 0, got ${chromeHeight}`);
    }
    if (chromeHeight >= this.viewportRows) {
      throw new Error(
        `ScrollRegion: chromeHeight ${chromeHeight} leaves no room for region in viewport ${this.viewportRows}`,
      );
    }
    this.chromeHeight = chromeHeight;
    this.scrollBottom = this.viewportRows - chromeHeight;
    this.resetRegionState();
    this.activeHandle = null;
    this.attached = true;
    this.suspended = false;

    let out = this.decstbmSeq(1, this.scrollBottom);
    out += this.cursorToSeq(1, 1);
    if (chromeHeight > 0 && chromeBytes.length > 0) {
      out += chromeBytes;
      out += this.cursorToSeq(1, 1);
    }
    this.writeOut(out);
  }

  /**
   * 卸载 chrome、撤 DECSTBM、清状态。
   *
   * 用于 cli 退出 chrome 模式（runOnce 完成 / shutdown 路径）。idempotent：未
   * attached 时 no-op，避免 caller 重复调用。
   *
   * 协议：
   *   1. cursor 跳 chrome 顶（= scrollBottom + 1）+ erase 到屏幕底擦 chrome 显示
   *   2. 撤 DECSTBM（恢复全屏 scroll region）
   *   3. cursor 落 (1, 1)，清状态字段
   */
  detachInput(): void {
    if (!this.attached) return;

    let out = "";
    if (this.chromeHeight > 0) {
      out += this.cursorToSeq(this.scrollBottom + 1, 1);
      out += this.clearScreenBelowSeq();
    }
    out += this.decstbmResetSeq();
    out += this.cursorToSeq(1, 1);
    this.writeOut(out);

    this.chromeHeight = 0;
    this.scrollBottom = this.viewportRows;
    this.resetRegionState();
    this.activeHandle = null;
    this.attached = false;
    this.suspended = false;
  }

  /**
   * 写一段独立内容——独立段语义（`cliWriter.line` / `notify` 路径）。
   *
   * 协议：
   *   - 若 regionTailCol > 1（cursor mid-line），先 emit 一个 \n 切到新行起首
   *   - 写 text，若不以 \n 结尾自动补 1 个；空字符串视为空行（emit 1 个 \n）
   *   - 滚动数 N 由"总写入 \n 数"超过"region 末剩余空间"决定
   *   - 写入末态：cursor 在新行起首（regionTailCol = 1）
   *
   * 行宽合约：text 按 \n 切分后每段显示宽度必须 ≤ columns - 1（caller 负责）。
   */
  writeScrollLine(text: string): void {
    this.requireWritable();

    const ensured = text.length === 0
      ? "\n"
      : text.endsWith("\n")
      ? text
      : text + "\n";
    const cut = this.regionTailCol > 1 ? "\n" : "";
    const writeStr = cut + ensured;

    const newlines = countNewlines(writeStr);
    const N = Math.max(0, newlines - (this.scrollBottom - this.regionTailRow));
    const regionTailRow_post = Math.min(
      this.scrollBottom,
      this.regionTailRow + newlines - N,
    );

    let out = this.cursorToSeq(this.regionTailRow, this.regionTailCol);
    out += writeStr;
    this.writeOut(out);

    this.regionTailCol = 1;
    this.applyScrollEvent(N, regionTailRow_post);
    this.updateLineState(writeStr);
  }

  /**
   * 流式 chunk 接续——LLM token 流 / TextStream paragraph 等"接续输出"路径。
   *
   * 协议：
   *   - 不前置切行——caller 期望 chunk 顺当前 cursor 续写
   *   - 写 chunk 原样（含其内的 \n）
   *   - 滚动数 N 同 writeScrollLine
   *   - 写入末态：
   *     · chunk 含 \n → regionTailCol = 最后 \n 之后部分的可见宽度 + 1
   *     · chunk 无 \n → regionTailCol += chunk 可见宽度（顺写顺前进）
   *
   * 行宽合约：chunk 按 \n 切分后每段（含此前累积未换行内容）显示宽度 ≤ columns - 1
   * （caller 负责；TextStream / wrapAnsiLine 已落地）。
   */
  appendInline(chunk: string): void {
    this.requireWritable();
    if (chunk.length === 0) return;

    const newlines = countNewlines(chunk);
    const N = Math.max(0, newlines - (this.scrollBottom - this.regionTailRow));
    const regionTailRow_post = Math.min(
      this.scrollBottom,
      this.regionTailRow + newlines - N,
    );

    let out = this.cursorToSeq(this.regionTailRow, this.regionTailCol);
    out += chunk;
    this.writeOut(out);

    const lastNlIdx = chunk.lastIndexOf("\n");
    if (lastNlIdx === -1) {
      this.regionTailCol += stringWidth(chunk);
    } else {
      this.regionTailCol = stringWidth(chunk.slice(lastNlIdx + 1)) + 1;
    }
    this.applyScrollEvent(N, regionTailRow_post);
    this.updateLineState(chunk);
  }

  /**
   * 开启可替换 segment——markdown code block / list 双态渲染入口。
   *
   * 协议：
   *   - 已有活跃 segment 时抛错（caller 必须先 commit / close 旧 segment）
   *   - fresh-line 显式合约：若 regionTailCol > 1（cursor mid-line），先 emit \n
   *     推进到下一行起首；不依赖 caller 之前是否补过 \n
   *   - 清 segment 状态字段、handle.closed = false
   *
   * 返回 SegmentHandle 句柄供 caller 调 replace / commit / close。同一 region
   * 同时只有一个活跃 handle。
   */
  beginReplaceableSegment(): SegmentHandle {
    this.requireWritable();
    if (this.activeHandle !== null) {
      throw new Error(
        "ScrollRegion: cannot begin segment while another is active",
      );
    }

    if (this.regionTailCol > 1) {
      let out = this.cursorToSeq(this.regionTailRow, this.regionTailCol);
      out += "\n";
      this.writeOut(out);
      const N = this.regionTailRow === this.scrollBottom ? 1 : 0;
      const regionTailRow_post =
        N === 0 ? this.regionTailRow + 1 : this.scrollBottom;
      this.regionTailCol = 1;
      this.applyScrollEvent(N, regionTailRow_post);
      this.updateLineState("\n");
    }

    this.clearSegmentState();

    // handle 与 region.activeHandle 的引用相等性是"handle 是否仍代表当前 segment"
    // 的事实源——detachInput / suspend / 新一次 begin 都会 nullify activeHandle，
    // 此时旧 handle 上的 replace / commit 应抛错避免误改 region 状态
    const handle: SegmentHandleImpl = new SegmentHandleImpl({
      replace: (text) => {
        if (this.activeHandle !== handle) {
          throw new Error(
            "ScrollRegion: segment handle is no longer active",
          );
        }
        this.requireWritable();
        this.replaceSegment(text);
      },
      commit: (text) => {
        if (this.activeHandle !== handle) {
          throw new Error(
            "ScrollRegion: segment handle is no longer active",
          );
        }
        this.requireWritable();
        this.replaceSegment(text);
        this.clearSegmentState();
        this.activeHandle = null;
      },
      close: () => {
        // close 是幂等操作——已被外部失效（detach / 新 segment 接管）静默 no-op
        if (this.activeHandle !== handle) return;
        this.clearSegmentState();
        this.activeHandle = null;
      },
    });
    this.activeHandle = handle;
    return handle;
  }

  /**
   * 把 newText 写入 segment 区域——常规路径或 partial commit 路径分流。
   *
   * 数据不变量：newText 必须包含已固化的早期行（M ≥ committedLogicalRows）——
   * caller 累积 streaming 内容时自然满足。违反 → 抛错而非静默腐蚀 segment 字段。
   * M = committedLogicalRows（M_prime = 0）→ idempotent no-op，支持 caller
   * 重复 replace 同一已完全固化内容的合法用法。
   *
   * 行宽合约：newText 按 \n 切分后每段 ≤ columns - 1（caller 负责）；该合约让
   * "M = newText.split('\n').length"恰好等于物理行数，segment 追踪精确无估算。
   */
  private replaceSegment(newText: string): void {
    const M = newText.split("\n").length;
    if (M < this.committedLogicalRows) {
      throw new Error(
        `ScrollRegion: newText has ${M} logical row(s), shorter than already-committed ${this.committedLogicalRows} ` +
          `— caller must include committed rows in newText`,
      );
    }
    const M_prime = M - this.committedLogicalRows;
    if (M_prime === 0) return;

    const writeStartRow = this.segmentTopRow ?? this.regionTailRow;
    const K = this.scrollBottom - writeStartRow + 1;

    if (M_prime > K) {
      this.replaceSegmentPartial(newText, writeStartRow, M_prime, K);
    } else {
      this.replaceSegmentNormal(newText, writeStartRow, M_prime);
    }
  }

  /**
   * 常规路径（M' ≤ K，segment 完全装入 region）：
   *   - erase 范围 = writeStartRow .. max(旧 segmentBottomRow, writeBottomRow)
   *     · 既覆盖旧 segment，又覆盖新 segment 将占用区——避免新 segment 短于
   *       下方既存内容（如 interleave notify）时按字符部分覆盖留视觉碎片
   *   - 跳 (writeStartRow, 1) → 写 newText.slice(committedLogicalRows)
   *   - 无滚动；调用 applyScrollEvent(N=0, writeBottomRow) 同步 filled
   */
  private replaceSegmentNormal(
    newText: string,
    writeStartRow: number,
    M_prime: number,
  ): void {
    const writeBottomRow = writeStartRow + M_prime - 1;
    const eraseEnd = Math.max(this.segmentBottomRow ?? 0, writeBottomRow);

    let out = "";
    for (let r = writeStartRow; r <= eraseEnd; r++) {
      out += this.cursorToSeq(r, 1);
      out += this.clearLineSeq();
    }

    const slicedLines = newText.split("\n").slice(this.committedLogicalRows);
    const slicedText = slicedLines.join("\n");
    out += this.cursorToSeq(writeStartRow, 1);
    out += slicedText;
    this.writeOut(out);

    const lastLine = slicedLines[slicedLines.length - 1] ?? "";

    this.segmentTopRow = writeStartRow;
    this.segmentBottomRow = writeBottomRow;
    this.segmentRemainingRows = M_prime;
    this.regionTailCol = stringWidth(lastLine) + 1;
    this.applyScrollEvent(0, writeBottomRow);
    this.updateLineState(slicedText);
  }

  /**
   * Partial commit 路径（M' > K，新 segment 末尾溢出 scrollBottom）：
   *   - erase 仅旧 segment 范围（不扩展到 writeBottomRow——它已越过 scrollBottom
   *     会误擦 chrome；溢出由滚动天然推走）
   *   - 跳 (writeStartRow, 1) → 写 newText.slice(committedLogicalRows)
   *   - 总写入 \n = M' - 1；overflow = M' - K 行 \n 在 scrollBottom 触发硬件滚动
   *   - segment 字段：top = max(1, writeStartRow - overflow)、bottom = scrollBottom
   *   - committedLogicalRows += (M' - 写后 segmentRemainingRows)
   *
   * 与常规路径的 segment 字段更新职责不同：partial commit 自行精确算出 segment
   * 最终位置，因此调 applyScrollEvent 前先把 segment 字段 nullify、避免公式再次
   * 递减；调用后再设置最终值。
   */
  private replaceSegmentPartial(
    newText: string,
    writeStartRow: number,
    M_prime: number,
    K: number,
  ): void {
    let out = "";
    if (this.segmentTopRow !== null) {
      for (let r = this.segmentTopRow; r <= this.segmentBottomRow!; r++) {
        out += this.cursorToSeq(r, 1);
        out += this.clearLineSeq();
      }
    }

    const slicedLines = newText.split("\n").slice(this.committedLogicalRows);
    const slicedText = slicedLines.join("\n");
    out += this.cursorToSeq(writeStartRow, 1);
    out += slicedText;
    this.writeOut(out);

    const overflow = M_prime - K;
    const lastLine = slicedLines[slicedLines.length - 1] ?? "";

    this.segmentTopRow = null;
    this.segmentBottomRow = null;
    this.segmentRemainingRows = null;
    this.regionTailCol = stringWidth(lastLine) + 1;
    this.applyScrollEvent(overflow, this.scrollBottom);

    this.segmentTopRow = Math.max(1, writeStartRow - overflow);
    this.segmentBottomRow = this.scrollBottom;
    this.segmentRemainingRows =
      this.segmentBottomRow - this.segmentTopRow + 1;
    this.committedLogicalRows += M_prime - this.segmentRemainingRows;
    this.updateLineState(slicedText);
  }

  /**
   * Chrome 高度变化协议——status / input / panel 高度变化的统一入口。
   *
   * 三分支：
   *   - 不变：仅 emit chromeBytes 重画内容、cursor 回 (regionTailRow, regionTailCol)
   *   - 变高（scrollBottom 减小 N_diff）：
   *     · surplusRows = scrollBottom_old - regionFilledRows
   *     · surplusRows ≥ N_diff：region 顶有空闲、不推 scrollback、直接缩 DECSTBM
   *     · surplusRows < N_diff：在 scrollBottom_old emit \n × pushRows 推走顶部内容
   *   - 变矮（scrollBottom 增大 N_diff）：扩 DECSTBM、清原 chrome 顶部 N 行的显示残留
   *
   * chromeBytes：caller 自拼的 chrome 字节序列，已含 cursor positioning + \x1b[2K +
   * 内容；caller 必须保证只走 cursor positioning 切行，永不 emit \n（chrome 在
   * DECSTBM 区外，\n 会触发整屏滚动）。
   *
   * 原子性约束：caller 应在单个 task 内调用本方法，避免与其他写入交错（spec
   * 要求；本类不强制实现，由调度层保证）。
   */
  setChromeHeight(newHeight: number, chromeBytes: string): void {
    this.requireWritable();
    if (newHeight < 0) {
      throw new Error(
        `ScrollRegion: chromeHeight must be ≥ 0, got ${newHeight}`,
      );
    }
    if (newHeight >= this.viewportRows) {
      throw new Error(
        `ScrollRegion: chromeHeight ${newHeight} leaves no room for region in viewport ${this.viewportRows}`,
      );
    }

    const oldHeight = this.chromeHeight;
    const scrollBottom_old = this.scrollBottom;
    const scrollBottom_new = this.viewportRows - newHeight;

    if (newHeight === oldHeight) {
      let out = chromeBytes;
      out += this.cursorToSeq(this.regionTailRow, this.regionTailCol);
      this.writeOut(out);
      return;
    }

    if (newHeight > oldHeight) {
      // chrome 变高
      const N_diff = newHeight - oldHeight;
      const surplusRows = scrollBottom_old - this.regionFilledRows;

      if (surplusRows < N_diff) {
        // pushTopToScrollback 必须在 this.scrollBottom 仍是旧物理边界时调用
        this.pushTopToScrollback(N_diff - surplusRows);
      }

      this.scrollBottom = scrollBottom_new;
      this.chromeHeight = newHeight;
      // clamp top-anchored cursor 到新 region 底——push 之后仍可能未及（surplus
      // 充足路径根本没动）
      if (this.regionTailRow > scrollBottom_new) {
        this.regionTailRow = scrollBottom_new;
      }
      let out = this.decstbmSeq(1, scrollBottom_new);
      if (chromeBytes.length > 0) out += chromeBytes;
      out += this.cursorToSeq(this.regionTailRow, this.regionTailCol);
      this.writeOut(out);
    } else {
      // chrome 变矮——scrollBottom 增大；原 chrome 顶部 N 行变 region 但有显示残留
      const N_diff = oldHeight - newHeight;
      this.scrollBottom = scrollBottom_new;
      this.chromeHeight = newHeight;
      let out = this.decstbmSeq(1, scrollBottom_new);
      for (let r = scrollBottom_old + 1; r <= scrollBottom_old + N_diff; r++) {
        out += this.cursorToSeq(r, 1);
        out += this.clearLineSeq();
      }
      if (chromeBytes.length > 0) out += chromeBytes;
      out += this.cursorToSeq(this.regionTailRow, this.regionTailCol);
      this.writeOut(out);
    }
  }

  private clearSegmentState(): void {
    this.segmentTopRow = null;
    this.segmentBottomRow = null;
    this.segmentRemainingRows = null;
    this.committedLogicalRows = 0;
  }

  /**
   * 把 region 几何 + segment 状态字段全部归零——所有生命周期方法（attach /
   * detach / suspend / resume / handleResize / shutdown）reset 的单一收口，
   * 避免各路径手抄字段列表带来的不一致风险。
   *
   * 不动：
   *   - viewport / chromeHeight / scrollBottom（几何由调用方按场景设值）
   *   - attached / suspended（生命周期标记由调用方自管）
   *   - activeHandle（失活语义由调用方按场景决定——handleResize 须保活让
   *     caller 持有的跨 chunk handle 在下一次 replace 自动恢复）
   */
  private resetRegionState(): void {
    this.regionTailRow = 1;
    this.regionTailCol = 1;
    this.regionFilledRows = 0;
    // 视觉行级 tail state 重置 —— 与 region 几何状态同生命周期：
    // attach/detach/suspend/resume/shutdown/handleResize 全经此重置。
    // 初始 trailingBlankRows=1 让 region 顶端的 ensureScrollLeadingBlank no-op
    // （region 顶等价于"上方无限空"，无需补段间空行）。
    this.currentRowHasVisible = false;
    this.trailingBlankRows = 1;
    this.clearSegmentState();
  }

  /**
   * 主动推 region 顶部 N 行进 scrollback——chrome 变高 surplus 不足场景用。
   *
   * cursor 跳 scrollBottom + emit \n × N 触发 N 次硬件滚动，cursor 留在
   * scrollBottom；之后调用 applyScrollEvent 同步状态字段。
   *
   * 时序约束：必须在 `this.scrollBottom` 仍是**旧物理 region 底**时调用——
   * applyScrollEvent 公式中 filled clamp 用 `this.scrollBottom` 作上界，需要
   * 旧值表达"push 期间的物理边界"。caller 在本 helper 完成后才能更新
   * `this.scrollBottom` 与 emit setDECSTBM。
   */
  private pushTopToScrollback(pushRows: number): void {
    if (pushRows <= 0) return;
    let out = this.cursorToSeq(this.scrollBottom, 1);
    out += "\n".repeat(pushRows);
    this.writeOut(out);
    const regionTailRow_post = Math.max(1, this.regionTailRow - pushRows);
    this.applyScrollEvent(pushRows, regionTailRow_post);
    // **不更新 line state**：协议级 \n 触发硬件滚动，且 caller（setChromeHeight）
    // 在本方法返回后会再次 cursorToSeq 把 cursor 跳到 regionTailRow_post（位于
    // shifted-up content 的边界行），cursor 最终位置是"fresh 空行 + 上方紧邻 content"
    // —— 等价于 push 前的 (false, 0) state，**保持不变即正确**。
    //
    // 早期试过 "trailingBlankRows = max(.., 1)" 的乐观更新——错误：把上方判定为有空行，
    // 导致 echoSubmittedDraft 的 ensureScrollLeadingBlank no-op，从而"LLM 满 region +
    // 用户输入 `/cmd` 触发 panel push + 回车"路径下用户行紧贴 LLM 无空行（实测 bug）。
  }

  /**
   * 任意写入路径完成后统一调用——把"本次写入触发的 N 次滚动"消化到所有 viewport
   * 状态字段。统一收口的工程纪律杜绝"各路径维护 regionFilledRows / segment 字段
   * 不一致"的隐患。
   *
   * 输入：
   *   - N：本次写入触发的滚动数（≥ 0）
   *   - regionTailRow_post：写入完成后的 cursor 行号（写入路径事先算好）
   *
   * 副作用：递减 segment 字段（若活跃 + N>0）、更新 regionFilledRows、写
   * regionTailRow。
   */
  private applyScrollEvent(N: number, regionTailRow_post: number): void {
    if (N > 0 && this.segmentTopRow !== null) {
      this.segmentTopRow -= N;
      this.segmentBottomRow! -= N;
      if (this.segmentBottomRow! < 1) {
        // segment 完全被推进 scrollback——caller 下次 replace 走"首次"路径
        this.committedLogicalRows += this.segmentRemainingRows!;
        this.segmentTopRow = null;
        this.segmentBottomRow = null;
        this.segmentRemainingRows = null;
      } else if (this.segmentTopRow < 1) {
        // 顶被推走但仍持有部分——溢出累入 committedLogicalRows、clamp 到 1
        const overflow = 1 - this.segmentTopRow;
        this.committedLogicalRows += overflow;
        this.segmentTopRow = 1;
        this.segmentRemainingRows = this.segmentBottomRow!;
      }
    }

    // regionFilledRows 统一公式：写入扩到 regionTailRow_post、滚动消化老内容、
    // shrink 场景下方仍有内容时保留旧 filled、最终 clamp 到 scrollBottom
    const consumedFilled = Math.min(N, this.regionFilledRows);
    this.regionFilledRows = Math.min(
      this.scrollBottom,
      Math.max(this.regionFilledRows - consumedFilled, regionTailRow_post),
    );
    this.regionTailRow = regionTailRow_post;
  }

  private requireWritable(): void {
    if (!this.attached) {
      throw new Error("ScrollRegion: not attached");
    }
    if (this.suspended) {
      throw new Error("ScrollRegion: cannot write while suspended");
    }
  }

  /**
   * 暂停 region 模式——modal alt UI（confirmation panel 等）进入前调用。
   *
   * 协议（与 ScreenController.suspend() 协同）：纯 flag 切换，**不**做任何 emit。
   * main buffer 内容（含 region 可视区对话历史、cursor 位置、DECSTBM 状态）由
   * ScreenController 在层级上 emit `\x1b[?1049h` 切到 alternate screen buffer 后
   * 由**终端原子保管**。alt UI 在 alt buffer 渲染、main buffer 完全不动；resume
   * 时终端 atomically 还原。
   *
   * 内部状态字段（regionTailRow / regionFilledRows / segmentTopRow 等）天然保留——
   * alt-screen 退出后 cursor / 内容由终端恢复到 suspend 前位置，内部状态与现实
   * 严格匹配。**不**调 `resetRegionState()` 也**不**清 `activeHandle`：
   * - 内容不丢，内部状态无需 reset
   * - contract: suspend 期间不持有活跃 segment（caller 保证；LLM 流式与 modal
   *   不并发），无需主动清 activeHandle
   *
   * 历史协议（DECSTBM clear + 逐行擦）的问题：destructive 操作擦除 region 可视区
   * 内容；未自然滚入 scrollback 的活跃对话历史在 alt UI 退出后无法恢复 ——
   * 这是已修复的 home 页历史丢失 bug 根因。
   */
  suspend(): void {
    if (!this.attached) {
      throw new Error("ScrollRegion: cannot suspend when not attached");
    }
    if (this.suspended) return;
    this.suspended = true;
  }

  /**
   * 恢复 region 模式——alt UI 退出后调用。
   *
   * 协议（与 ScreenController.resume() 协同）：emit 防御性 DECSTBM re-set。
   * main buffer 状态由 ScreenController 在层级上 emit `\x1b[?1049l` 切回后由
   * **终端原子恢复**（含 region 内容 / cursor / scrollback）。DECSTBM 状态跨
   * alt-screen 切换是 implementation-defined 是否随 buffer 保存——defensive
   * re-emit `\x1b[1;{scrollBottom}r` 兜底，让 region 边界回到 (1, scrollBottom)：
   * - 终端已保存 DECSTBM 时此 emit 是 idempotent（设同样值）
   * - 终端未保存（部分 ConPTY 早期版本等）时此 emit 救回 region 不变量
   *
   * chrome 字节重画由 ScreenController 层 refreshChrome 完成（统一收口
   * setChromeHeight → buildChromeBytes），不在本方法职责内。
   */
  resume(): void {
    if (!this.attached) {
      throw new Error("ScrollRegion: cannot resume when not attached");
    }
    if (!this.suspended) {
      throw new Error("ScrollRegion: cannot resume when not suspended");
    }
    this.suspended = false;
    this.writeOut(this.decstbmSeq(1, this.scrollBottom));
  }

  /**
   * 终端 viewport resize 处理——viewport 尺寸 + chrome 高度同步变化的统一入口。
   *
   * 协议参数（与 attachInput / setChromeHeight / resume 协议族对称——chromeHeight
   * 始终是 caller 显式输入而非内部假设不变）：
   *   - viewportRows / viewportCols：新 viewport 几何
   *   - newChromeHeight：新 chrome 高度——caller 在 resize 触发时重算（input.renderLines()
   *     可能因 columns 变化触发 reflow 而行数变化）；ScrollRegion 由此推导 scrollBottom
   *     = viewportRows - newChromeHeight，与 caller 拼 chromeBytes 时用的 scrollBottom
   *     完全一致，避免 DECSTBM 边界与 chrome 起手行错位
   *   - chromeBytes：caller 用上述 scrollBottom 拼好的 chrome 字节序列
   *
   * 行为：
   *   - 重设 DECSTBM 与 scrollBottom（基于 newChromeHeight）
   *   - 重画 chrome
   *   - 保留 active handle 活性（不强制 commit——caller 持有的 handle 在下一次
   *     replace 时按"首次"路径在新 (regionTailRow, regionTailCol) 重起，避免本
   *     turn 内容渲染丢失）
   *   - segment 字段清 null（resize 后终端 reflow，viewport 位置不可控）；
   *     committedLogicalRows 不变（已固化部分仍已固化）
   *   - cursor 跳 (1, 1) 作为新基线
   */
  handleResize(
    viewportRows: number,
    viewportCols: number,
    newChromeHeight: number,
    chromeBytes: string,
  ): void {
    if (!this.attached) {
      throw new Error("ScrollRegion: cannot resize when not attached");
    }
    if (newChromeHeight < 0) {
      throw new Error(
        `ScrollRegion: chromeHeight must be ≥ 0, got ${newChromeHeight}`,
      );
    }
    if (newChromeHeight >= viewportRows) {
      throw new Error(
        `ScrollRegion: chromeHeight ${newChromeHeight} leaves no room for region in viewport ${viewportRows}`,
      );
    }

    this.viewportRows = viewportRows;
    this.viewportCols = viewportCols;
    this.chromeHeight = newChromeHeight;
    this.scrollBottom = viewportRows - newChromeHeight;
    // committedLogicalRows 是 resize 期间唯一保留字段——已固化部分仍已固化、
    // segment.replace 用 slice 跳过；其它 region / segment / handle 状态因终端
    // reflow 后 viewport 位置不可控而失效
    const savedCommitted = this.committedLogicalRows;
    this.resetRegionState();
    this.committedLogicalRows = savedCommitted;

    let out = this.decstbmSeq(1, this.scrollBottom);
    if (newChromeHeight > 0 && chromeBytes.length > 0) {
      out += chromeBytes;
    }
    out += this.cursorToSeq(1, 1);
    this.writeOut(out);
  }

  /**
   * 异常退出清理——caller 应用层挂 `process.on('exit')` / SIGINT / SIGTERM hook
   * 调用（直接调本方法，或经 ScreenController.dispose 间接触发）。
   *
   * 撤 DECSTBM + cursor 跳 viewport 底，确保 zhixing 退出后 shell 的 \n 行为恢复
   * 正常（不再受 region 限制）。idempotent：重复调用 no-op。
   *
   * 设计取舍：ScrollRegion 是可复用的协议层，不耦合全局 process——caller（应用
   * 启动期）负责把"退出钩子 → shutdown"串起来，让 library 自身保持纯净。
   */
  shutdown(): void {
    if (!this.attached) return;

    // 对称 firstAttach 协议 —— attach 时用 `\x1b[2J + \x1b[1;1H` 整屏清让
    // shell history 进 scrollback、region 顶 = viewport 顶；shutdown 反向撤掉
    // **整个 viewport**（含 region 内对话历史 + chrome 全部）让 shell 接管干净
    // viewport，与启动前视觉状态对称：
    //
    //   firstAttach:    [2J] 整屏清 → cursor (1,1) → 设 DECSTBM
    //   shutdown:       撤 DECSTBM → [2J] 整屏清 → cursor (1,1)
    //
    // 对话历史保留？不需要 —— 已在 conversation 文件里持久化（chat-* JSON），
    // 用户重启 zhixing 即恢复；viewport 内的对话视觉**只是当前 session 的临时
    // 渲染**，不是事实源。退出时不保留与 cli REPL 的"接管 + 归还"语义一致。
    //
    // 但 scrollback 内的对话仍保留（main buffer 模式下被 region 滚出去的内容
    // 已经进了 terminal 自身 scrollback），用户向上滚仍能看到 —— 这是 main
    // buffer 模式选择的核心原因（详见模块头 docstring "设计取舍"段）。
    let out = this.decstbmResetSeq();
    out += this.clearScreenSeq();
    out += this.cursorToSeq(1, 1);
    this.writeOut(out);
    this.chromeHeight = 0;
    this.scrollBottom = this.viewportRows;
    this.resetRegionState();
    this.activeHandle = null;
    this.attached = false;
    this.suspended = false;
  }

  /** DECSTBM 设置滚动区域：CSI top;bottom r */
  private decstbmSeq(top: number, bottom: number): string {
    return `${ESC}[${top};${bottom}r`;
  }

  /** 撤 DECSTBM——恢复全屏 scroll region：CSI r */
  private decstbmResetSeq(): string {
    return `${ESC}[r`;
  }

  /** Cursor positioning（绝对寻址）：CSI row;col H */
  private cursorToSeq(row: number, col: number): string {
    return `${ESC}[${row};${col}H`;
  }

  /** Erase entire line（不动 cursor）：CSI 2 K */
  private clearLineSeq(): string {
    return `${ESC}[2K`;
  }

  /** Erase from cursor to end of screen：CSI J */
  private clearScreenBelowSeq(): string {
    return `${ESC}[J`;
  }

  /** Erase entire screen（不动 cursor，不影响 scrollback）：CSI 2 J */
  private clearScreenSeq(): string {
    return `${ESC}[2J`;
  }
}

/**
 * SegmentHandle 的内部实现——持 closed flag 防止 commit / close 后再次操作；
 * ops 注入由 ScrollRegion 提供 closures 让 handle 不直接接触 region 私有状态。
 */
class SegmentHandleImpl implements SegmentHandle {
  private closed = false;
  constructor(
    private readonly ops: {
      replace: (text: string) => void;
      commit: (text: string) => void;
      close: () => void;
    },
  ) {}

  replace(newText: string): void {
    if (this.closed) return;
    this.ops.replace(newText);
  }

  commit(newText: string): void {
    if (this.closed) return;
    this.ops.commit(newText);
    this.closed = true;
  }

  close(): void {
    if (this.closed) return;
    this.ops.close();
    this.closed = true;
  }
}
