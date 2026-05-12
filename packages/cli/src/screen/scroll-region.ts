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
    };
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
   * 暂停 region 模式——alt UI（confirmation panel 等）进入前调用。
   *
   * 设计协议:让 alt UI 在 DECSTBM 保护的 region 内渲染,chrome 区完全不受影响
   *   - DECSTBM 不撤,继续生效(region 范围 1 到 scrollBottom)
   *   - cursor 跳到 region 顶 (1, 1) 作为 alt UI 起手行
   *   - 逐行清 region(去 region 内既有内容,留出干净空间给 alt UI)
   *   - alt UI 的 \r\n 推进受 DECSTBM 限制:在 region 内触发 region 滚动
   *     (顶行进 scrollback,新行加底),cursor 永远不越 region 底界 → chrome 不受推
   *   - alt UI 高度可任意:超 region 高度时旧内容自然滚到 scrollback,可回看
   *
   * 与 alt-screen 1049 切换的对比:本协议纯 VT100 ANSI(DECSTBM + cursor + 逐行清),
   * 跨终端兼容性最优(Windows ConPTY / 各 Linux 终端 / macOS 都支持);alt-screen 1049
   * 在 ConPTY 等部分实现不可靠(EXIT 可能未完整恢复 main-screen)。
   *
   * caller 契约:suspend 期间不持有活跃 segment(LLM 流式与 typeahead-input /
   * panel 不并发);活跃 handle 失活。
   */
  suspend(): void {
    if (!this.attached) {
      throw new Error("ScrollRegion: cannot suspend when not attached");
    }
    if (this.suspended) return;

    let out = this.clearRegionSeq();
    out += this.cursorToSeq(1, 1);
    this.writeOut(out);

    this.resetRegionState();
    this.activeHandle = null;
    this.suspended = true;
  }

  /**
   * 恢复 region 模式——alt UI 退出后调用。
   *
   * 设计协议:清掉 alt UI 留在 region 的痕迹 + 重画 chrome 反映最新状态
   *   - 逐行清 region(擦掉 alt UI 在 region 内的渲染结果)
   *   - 根据 caller 传入的 chromeHeight 重设 DECSTBM(可能因 suspend 期间暂存任务
   *     消费导致 chrome 高度变化)
   *   - 写 chromeBytes 重画 chrome
   *   - cursor 跳 (1, 1) 作为 region 顶起点,与 attachInput 同协议
   *
   * caller 在 resume 前可能经历 viewport resize,因此 chromeHeight 是显式输入
   * 而非 ScrollRegion 假设不变。
   */
  resume(chromeHeight: number, chromeBytes: string): void {
    if (!this.attached) {
      throw new Error("ScrollRegion: cannot resume when not attached");
    }
    if (!this.suspended) {
      throw new Error("ScrollRegion: cannot resume when not suspended");
    }
    if (chromeHeight < 0) {
      throw new Error(
        `ScrollRegion: chromeHeight must be ≥ 0, got ${chromeHeight}`,
      );
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
    this.suspended = false;

    let out = this.clearRegionSeq();
    out += this.decstbmSeq(1, this.scrollBottom);
    if (chromeHeight > 0 && chromeBytes.length > 0) {
      out += chromeBytes;
    }
    out += this.cursorToSeq(1, 1);
    this.writeOut(out);
  }

  /**
   * 逐行清 region 范围(1 到 scrollBottom)—— 与 setChromeHeight 缩小路径同手法。
   *
   * 不用 `\x1b[1J`(清屏顶到 cursor)是因为该序列在 chrome 高度边界的清除范围
   * 跨终端实现差异较大;逐行清是确定性手法,代价是 N 次序列写但 region 不大,
   * 实测每帧 < 1ms。
   */
  private clearRegionSeq(): string {
    let out = "";
    for (let row = 1; row <= this.scrollBottom; row++) {
      out += this.cursorToSeq(row, 1);
      out += this.clearLineSeq();
    }
    return out;
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
    let out = this.decstbmResetSeq();
    out += this.cursorToSeq(this.viewportRows, 1);
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
