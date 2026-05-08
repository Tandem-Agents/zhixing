/**
 * 屏幕协调器——cli 交互模式下所有写到屏幕的逻辑必须经此协调。
 *
 * 三区屏幕模型：
 *   ┌────────────────────────────────┐
 *   │  Scrollback（已固化）          │   历史 scroll，不可重画
 *   ├────────────────────────────────┤   ← frame 起点（cursor up 上限）
 *   │  Tail Buffer                   │   未固化的 scroll 行——每次 paint 重画
 *   ├────────────────────────────────┤
 *   │  Status Bar (0..N 行)          │   动态状态条
 *   ├────────────────────────────────┤
 *   │  Input Region                  │   持久输入区
 *   └────────────────────────────────┘
 *
 * **Frame Buffer 渲染契约（核心）**：
 *   每次更新 = 全帧差分覆盖：cursor up 到 frame 起点 + \r + 逐行 \x1b[2K + 新内容。
 *   tailBuffer + chrome 作为单一"frame"重画——chunk 接续靠 tailBuffer 末尾行内追加，
 *   chrome 永驻显示在 frame 末尾，整个序列单次 stdout.write 给 TTY。
 *
 *   这取代了"exclusive 擦 chrome 让 chunk 直写"的旧设计——旧设计让 chrome 在流式期间
 *   消失（用户期望 chrome 永驻）。新设计让 chunk 在 tailBuffer 末尾行内累积，chrome
 *   每次 paint 重画在 tailBuffer 之后——视觉上 chrome 始终跟随 scroll 末尾，永驻。
 *
 * **行固化（freeze）—— viewport 硬约束**：
 *   frame buffer 总行数永远 ≤ 终端 viewport 行数 - 安全 margin。append / status / input
 *   变化后立即检查，超出立即固化最早的 tailBuffer 行（cursor up + write + \n 主动推入
 *   永久 scrollback），保证 paintFrame 的 cursor up 永远在 viewport 内，不触发滚动。
 *
 *   反例（fix 前）：MAX_TAIL_LINES = 50 是绝对值，超大多数终端可视行数（24-40），frame
 *   超 viewport 时 cursor up 被截断 + paint 末尾 \n 触发滚动 → 上一帧内容部分推入
 *   scrollback → 下一帧重复 → scrollback 累积重复副本。
 *
 * **使用约定**：
 *   - cli REPL 模式启动一个 ScreenController，持续到 REPL 结束
 *   - 写到 stdout 的所有 caller 必须经此协调，禁止直接 process.stdout.write
 *   - 输入区状态变化通过 requestInputRepaint 触发重画
 *   - 状态条更新通过 setStatusBar
 *   - 接口语义：
 *     - withScrollWrite —— 流式接续（如 LLM chunk），直接追加到 tailBuffer 末尾行
 *     - writeScrollLine —— 独立段（如完成态卡片 / 异步通知），保证起新行避免与流式段粘连
 *
 * **Alt UI 嵌入协议（chrome 末尾让位）**：
 *   confirmation panel 等短小 modal alt UI 需要独占 stdout 实时响应键盘
 *   （selectWithInput 直写 stdout + raw mode keypress 设计），与 ScreenController
 *   的 chrome paint 共享 stdout 会互相覆盖。
 *
 *   嵌入协议：alt UI 进入前 caller 调 `screen.suspend()` 让位 chrome 末尾区域（同步
 *   擦 status + input + 清 tailBuffer 内部状态 + 暂存后续 paint 任务 + 通知订阅者
 *   暂停周期行为），alt UI 退出后调 `screen.resume()` 恢复（flush 暂存任务 + 在
 *   alt UI 之后重画 status + input）。
 *
 *   关键视觉契约：suspend 是 **chrome 末尾让位**，不是全屏接管——tailBuffer 视觉
 *   （welcome / 用户消息 / AI 回复历史）保留在 alt UI 上方屏幕；alt UI 在原
 *   status + input 位置 inline 起手；alt UI 关闭后 chrome 重画在 alt UI 之后。
 *   长对话时新 chrome 触底 cursor `\n` 自然滚动早期内容到 scrollback——与 Claude
 *   Code 等成熟 cli modal 行为一致。
 *
 *   suspend / resume 必须成对，不可重入（alt UI 不嵌套）。disposed 后调用抛错。
 *   onSuspendChange 让 status-bar 等订阅者协同暂停/恢复 ticker。
 *
 *   suspend 与 detachInput 语义区分：
 *     - suspend：chrome 末尾让位（tailBuffer 状态清空保视觉不重画，statusLines /
 *       input 引用保留供 resume 重画）
 *     - detachInput：彻底离开（清所有状态 + 擦整 frame，对应 input controller
 *       dispose 路径）
 *
 *   已知 alt UI 接入：confirmation panel（cli REPL 工具调用确认）。
 *   全屏 alt UI（config-editor）走 alt-screen ANSI 模式自治，与 suspend 协议正交
 *   ——可叠加 suspend 让 ScreenController 在 alt-screen 期间不 paint chrome。
 */

import {
  ANSI_CARRIAGE_RETURN,
  ANSI_ERASE_DOWN,
  ANSI_ERASE_LINE,
  ansiCursorDown,
  ansiCursorUp,
  eraseRegion,
  moveCursorWithinRegion,
} from "./region-painter.js";

export interface InputRegion {
  /**
   * 渲染当前输入区为字符串数组（逐行，不含末尾 \n）。
   * 包含完整 chrome（边框 + 内 padding）、buffer 文本、可选 panel 行。
   */
  renderLines(): readonly string[];

  /**
   * 光标在 renderLines() 数组中的位置——row 0-based 行偏移，col 0-based 显示列。
   * caller 不需要写 ANSI 移动光标，由 ScreenController 内部移动。
   */
  cursorPosition(): { row: number; col: number };
}

/**
 * 可替换尾段——begin 后流式期反复 replace 整段、commit 时一次替换 + 关闭。
 *
 * 用例：LLM 流式 code block 的双态渲染——流式期 dim 字面占位、闭合时整段
 * 替换为语法高亮版。begin 必与 commit/close 配对调用，单一活跃 segment（不
 * 可嵌套）。
 *
 * 长 block 视觉契约：流式期 segment 行数 + status + input 超 viewport 时由
 * ScreenController 自动从 segment 头部固化推 scrollback——已固化的部分保留
 * 流式期 dim 字面（不再受 replace/commit 影响）；commit/replace 仅替换 segment
 * 当前持有的尾部行。已知行为：极长 block 在用户回滚 scrollback 时呈"上 dim
 * 字面 + 下高亮"撕裂——viewport 内体验最优、frame 健康优先于回滚视觉一致。
 */
export interface ReplaceableSegmentHandle {
  /**
   * 替换 segment 当前持有的内容为 newText——流式期反复调用，不关闭 segment。
   *
   * 行为：newText 按 \n 切；segment 已被固化推 scrollback 的起首行不动
   * （segmentFrozenLineCount 记录已固化数）；tailBuffer 中 segment 持有的范围
   * 替换为 newText 切行去掉起首已固化数的剩余部分。close/commit 后调用 no-op。
   */
  replace(newText: string): void;

  /**
   * 用 newText 替换当前内容并关闭 segment——闭合一次性切换（流式期 dim →
   * 闭合期 highlight 即此调用）。等同 replace(newText) + close()。关闭后
   * handle 失效，后续 replace/commit/close 都 no-op。
   */
  commit(newText: string): void;

  /**
   * 关闭 segment 不替换内容——保留当前内容转 immutable。退化路径（如不触发
   * 流式渲染时直接关闭，留下 segment 期间已 append 的内容作历史）。
   */
  close(): void;
}

export interface ScreenController {
  /** 注册唯一活跃输入区。重复 attach 会替换旧的并立刻重画。 */
  attachInput(region: InputRegion): void;
  /** 卸载输入区——擦除状态条 + 输入区屏幕痕迹，状态条状态也清空。 */
  detachInput(): void;
  /** 设置状态条内容；null / 空数组 = 隐藏状态条。 */
  setStatusBar(lines: readonly string[] | null): void;
  /**
   * 写到滚动区——caller 通过 fn 接收的 write 函数追加内容。
   *
   * 内容累积到 tailBuffer 末尾（chunk 接续在末尾行内追加），整个 frame（tailBuffer +
   * chrome）做行级差分 paint——chrome 永驻显示，chunk 接续无擦不闪烁。
   *
   * 多次 withScrollWrite 调用：内容按顺序累积到 tailBuffer，chunk 末尾不带 \n 时下次
   * 写入接续到末尾行；带 \n 时末尾换行后下次写入新起一行。
   */
  withScrollWrite(fn: (write: (chunk: string) => void) => void): void;
  /**
   * 写入一段独立内容——保证起新行起手。
   *
   * 与 withScrollWrite 区别：后者是流式接续语义（chunk 直接追加到 tailBuffer 末尾行），
   * 本方法是独立段语义——若 tailBuffer 当前在行接续中（最后一行未以 \n 结尾），
   * 先补 \n 切到新行再写 text，确保异步段（slash 命令输出 / 完成态卡片 / scheduler
   * 通知 / retry 警告等）不会与正在进行的流式 chunk 粘连成同一行。
   *
   * text 自动确保末尾 \n 落地；空字符串等价"写一空行"。
   */
  writeScrollLine(text: string): void;
  /** 触发输入区重画——用于按键后 buffer / panel 变化通知屏幕刷新。 */
  requestInputRepaint(): void;

  /**
   * 开启可替换尾段——流式期反复 replace、闭合时 commit。
   *
   * 同步返回 handle；内部 begin task enqueue 到队列，按 cli writer 现有的
   * 异步任务序列与 replace/commit/close 顺序执行。单一活跃 segment 约束：
   * 当前已有活跃 segment 时再 begin 抛错（caller bug，不可嵌套）。
   *
   * disposed 状态调用抛错；suspended 期间也允许 begin（task 暂存到 resume
   * 后执行），但实际 LLM 流式与 alt UI 不并发——约定 segment 仅在 LLM 流式
   * 期间存活，suspend 期间不会有活跃 segment。
   */
  beginReplaceableSegment(): ReplaceableSegmentHandle;

  /**
   * 暂停 chrome 协调——confirmation panel 等 modal alt UI 进入前调用，让位 chrome
   * 末尾区域（status + input）让 alt UI 在原 status + input 位置 inline 起手，
   * tailBuffer 视觉（welcome / 用户消息 / AI 回复历史）保留在 alt UI 上方屏幕。
   *
   * 行为：
   *   1. 同步写出 ANSI 序列：cursor up 到 frame 起点 → cursor down 跨过 tailBuffer
   *      → erase 到屏幕底——仅擦 chrome 末尾（status + input），tailBuffer 物理
   *      显示保留
   *   2. 清空 tailBuffer 内部状态（屏幕已显示，resume 时不重画避免重复）；
   *      statusLines / input 引用保留供 resume 重画
   *   3. 设 suspended 标志，所有后续 enqueue 任务暂存在队列（flush 不消费），
   *      状态字段通过 enqueue 任务依次修改但不触发 paintFrame
   *   4. 广播 suspended=true 让 onSuspendChange 订阅者（如 status-bar）暂停自身
   *      周期行为（避免无效 setStatusBar 累积）
   *
   * 视觉契约：长对话时 alt UI + 新 chrome 触底由 cursor `\n` 自然滚动早期 tailBuffer
   * 内容到 scrollback——与 Claude Code 等成熟 cli modal 行为一致。
   *
   * 必须与 resume() 成对调用。重复 suspend 抛错（不可重入——alt UI 不嵌套）。
   * disposed 后调用抛错。
   *
   * 仅 cli REPL chrome 模式需要——serve daemon / runOnce 等无 chrome 场景不需要
   * alt UI 嵌入协议；全屏 alt UI（config-editor）走 alt-screen ANSI 模式自治，与
   * 本协议正交（可叠加 suspend 让 chrome 在 alt-screen 期间不 paint）。
   */
  suspend(): void;

  /**
   * 恢复 chrome 协调——alt UI 退出后调用，让 chrome 在 alt UI 之后重画。
   *
   * 行为：
   *   1. 清 suspended 标志并广播 suspended=false 让订阅者恢复
   *   2. enqueue 一次 paintFrame 兜底——同时触发 flush 消费暂存队列；期间累积的
   *      setStatusBar / withScrollWrite / writeScrollLine 任务依次执行（每个内部
   *      paintFrame），最后兜底 paintFrame 确保 chrome 状态正确显示
   *
   * 视觉效果：cursor 在 alt UI 关闭后的新行起手 paint——chrome 重画在 alt UI 之后；
   * tailBuffer 状态在 suspend 时已清空，resume 不重画屏幕上方已显示的历史内容。
   *
   * 必须 suspend 之后调用——未 suspend 调 resume 抛错。disposed 后调用抛错。
   */
  resume(): void;

  /**
   * 订阅 suspended 状态变化——返回 unsubscribe。
   *
   * 仅在状态实际翻转时触发回调（false→true 或 true→false）；订阅时不立即触发，
   * 订阅者自行处理初始状态（默认 suspended=false）。
   *
   * 用例：status-bar / 任何持有周期写屏行为的模块订阅此信号，suspended 期间停止
   * 周期任务避免无效计算 + 队列累积。
   */
  onSuspendChange(listener: (suspended: boolean) => void): () => void;

  /** 释放：擦除状态条 + 输入区，detach 输入区，停止接受新写入。 */
  dispose(): void;
}

interface ScreenControllerOptions {
  readonly stdout?: NodeJS.WriteStream;
}

interface QueueTask {
  readonly run: () => void;
}

/**
 * 终端 viewport 兜底——读取 stdout.rows 失败时（CI / pipe / 异常 TTY）的最小可用行数。
 * 24 是经典 VT100 行高，几乎所有现代终端都不低于此值。
 */
const FALLBACK_VIEWPORT_ROWS = 24;
/**
 * frame 高度上限相对 viewport 的安全余量——避免 paint 末尾 \n 在屏幕最后一行触发滚动。
 * viewport 必须 ≥ FRAME_MIN_ROWS 才能正常工作（status + input 自身可能占多行）。
 */
const FRAME_SAFETY_MARGIN = 1;
/** frame 高度下限——viewport 极小时也保留这么多行可用（极端窄终端 fallback） */
const FRAME_MIN_ROWS = 8;

class ScreenControllerImpl implements ScreenController {
  private readonly stdout: NodeJS.WriteStream;
  private input: InputRegion | null = null;
  private statusLines: readonly string[] = [];
  /** 上次"frame 起点"之下到 chrome[0] 之间的 scroll 行——每次 paint 重画 */
  private tailBuffer: string[] = [];
  /** 当前 frame 在屏幕上占用的总行数（max 历史保留——避免 chrome 行数收缩闪烁） */
  private renderedRows = 0;
  /** 当前光标在 frame 内的相对行号（0-based，相对 frame 起点） */
  private cursorRow = 0;
  private readonly queue: QueueTask[] = [];
  private flushing = false;
  private disposed = false;
  /**
   * 暂停 chrome 协调状态——alt UI 嵌入期间为 true，flush 不消费队列让任务暂存。
   * suspend()/resume() 显式切换；不可重入，dispose 强制清。
   */
  private suspended = false;
  /** suspended 状态变化订阅者集合——状态翻转时同步通知 */
  private readonly suspendListeners = new Set<(suspended: boolean) => void>();
  /** 解绑 stdout resize listener 的 closure，dispose 时调用清理 */
  private detachResize: (() => void) | null = null;

  /**
   * 当前活跃 segment 在 tailBuffer 中的起首行索引——null 表示无活跃 segment。
   * 流式期 segment 的行范围 = tailBuffer[segmentStartRow..]。
   */
  private segmentStartRow: number | null = null;
  /**
   * 当前 segment 已被 freezeOverflowToScrollback 推 scrollback 的起首行数——
   * replace/commit 时按此数量从 newText 切行结果起首跳过，避免重复显示。
   */
  private segmentFrozenLineCount = 0;
  /**
   * 同步标志：begin 立刻 set true 让重叠 begin 抛错；handle.close/commit 同步
   * set false 让下次 begin 可立即开启（队列中的 close task 会先执行清状态）。
   */
  private hasActiveSegment = false;

  constructor(options: ScreenControllerOptions = {}) {
    this.stdout = options.stdout ?? process.stdout;
    this.attachResizeListener();
  }

  /**
   * 监听终端 resize——viewport 变化后旧 cursorRow / renderedRows 不再可靠
   * （cursor up 在新 viewport 下可能被截断），重置 frame 状态让下次 paint 走"首次
   * paint"分支重新画完整 frame。残留旧内容由新 paint 覆盖或滚出，避免重复推送 bug。
   */
  private attachResizeListener(): void {
    const stream = this.stdout as unknown as {
      on?: (event: string, listener: () => void) => void;
      off?: (event: string, listener: () => void) => void;
    };
    if (typeof stream.on !== "function") return;
    const listener = (): void => {
      if (this.disposed) return;
      this.enqueue(() => {
        this.cursorRow = 0;
        this.renderedRows = 0;
        this.paintFrame();
      });
    };
    stream.on("resize", listener);
    this.detachResize = () => {
      stream.off?.("resize", listener);
    };
  }

  attachInput(region: InputRegion): void {
    this.enqueue(() => {
      this.input = region;
      this.paintFrame();
    });
  }

  detachInput(): void {
    this.enqueue(() => {
      // detach 是 chrome 完全消失语义——彻底擦掉 frame，重置所有状态
      if (this.renderedRows > 0) {
        this.stdout.write(eraseRegion(this.cursorRow));
      }
      this.input = null;
      this.statusLines = [];
      this.tailBuffer = [];
      this.renderedRows = 0;
      this.cursorRow = 0;
      this.segmentStartRow = null;
      this.segmentFrozenLineCount = 0;
      this.hasActiveSegment = false;
    });
  }

  setStatusBar(lines: readonly string[] | null): void {
    this.enqueue(() => {
      this.statusLines = lines ?? [];
      this.paintFrame();
    });
  }

  withScrollWrite(fn: (write: (chunk: string) => void) => void): void {
    this.enqueue(() => {
      let collected = "";
      fn((chunk) => {
        collected += chunk;
      });
      if (collected.length === 0) return;
      this.appendToTail(collected);
      this.paintFrame();
    });
  }

  writeScrollLine(text: string): void {
    this.enqueue(() => {
      if (text.length === 0) {
        // 空字符串语义：写一空行
        this.appendToTail("\n");
      } else {
        // 独立段保证：若 tailBuffer 末尾在行接续中（非空字符串），先补 \n 切到新行——
        // 避免与流式 chunk 粘连（典型场景：LLM appendInline 期间 retry warn / scheduler
        // 通知插入 writeScrollLine，没有此保证会让通知拼到 chunk 末尾形成 "chunk text⚠ warn" 同行）
        const lastIndex = this.tailBuffer.length - 1;
        const inMidLine =
          lastIndex >= 0 && this.tailBuffer[lastIndex]!.length > 0;
        if (inMidLine) this.appendToTail("\n");
        const finalText = text.endsWith("\n") ? text : text + "\n";
        this.appendToTail(finalText);
      }
      this.paintFrame();
    });
  }

  requestInputRepaint(): void {
    this.enqueue(() => {
      this.paintFrame();
    });
  }

  beginReplaceableSegment(): ReplaceableSegmentHandle {
    if (this.disposed) {
      throw new Error(
        "ScreenController.beginReplaceableSegment called after dispose",
      );
    }
    if (this.hasActiveSegment) {
      throw new Error(
        "ScreenController has an active segment (single-segment only)",
      );
    }
    this.hasActiveSegment = true;
    this.enqueue(() => {
      // segment 起首必在新行起手——若 tailBuffer 末行非空（接续中）先补 \n 切到新行
      const lastIndex = this.tailBuffer.length - 1;
      const inMidLine =
        lastIndex >= 0 && this.tailBuffer[lastIndex]!.length > 0;
      if (inMidLine) this.appendToTail("\n");
      this.segmentStartRow = this.tailBuffer.length;
      this.segmentFrozenLineCount = 0;
    });
    return this.makeSegmentHandle();
  }

  /**
   * Handle 工厂——闭包 closed 标志让 close/commit 后调用 no-op；同步翻转
   * hasActiveSegment 让重叠 begin 检查在调用 commit/close 后立即放行。
   */
  private makeSegmentHandle(): ReplaceableSegmentHandle {
    let closed = false;
    return {
      replace: (newText: string): void => {
        if (closed) return;
        this.enqueue(() => {
          this.applySegmentContent(newText);
          this.paintFrame();
        });
      },
      commit: (newText: string): void => {
        if (closed) return;
        closed = true;
        this.hasActiveSegment = false;
        this.enqueue(() => {
          this.applySegmentContent(newText);
          this.segmentStartRow = null;
          this.segmentFrozenLineCount = 0;
          this.paintFrame();
        });
      },
      close: (): void => {
        if (closed) return;
        closed = true;
        this.hasActiveSegment = false;
        this.enqueue(() => {
          this.segmentStartRow = null;
          this.segmentFrozenLineCount = 0;
        });
      },
    };
  }

  /**
   * 把 newText 应用到当前活跃 segment 持有的范围——按 \n 切 newText、跳过
   * 起首已 freeze 推走的行数（segmentFrozenLineCount）、剩余行替换 tailBuffer
   * 中 segment 当前持有的范围。无活跃 segment 时 no-op（防御已 close 后被 enqueue）。
   */
  private applySegmentContent(newText: string): void {
    if (this.segmentStartRow === null) return;
    const segStart = this.segmentStartRow;
    const newLines = newText.split("\n");
    const replaceLines =
      this.segmentFrozenLineCount > 0
        ? newLines.slice(this.segmentFrozenLineCount)
        : newLines;
    this.tailBuffer.length = segStart;
    for (const line of replaceLines) this.tailBuffer.push(line);
  }

  suspend(): void {
    if (this.disposed) {
      throw new Error("ScreenController.suspend called after dispose");
    }
    if (this.suspended) {
      throw new Error(
        "ScreenController.suspend called while already suspended (alt UI 不嵌套)",
      );
    }
    // 让位策略：保留 tailBuffer 视觉（welcome / 用户消息 / AI 回复历史在屏幕上方
    // 保持显示），仅擦 chrome 末尾（status + input 区）腾出空间让 alt UI 在原 status
    // + input 位置 inline 起手——与 Claude Code 等成熟 cli modal 行为一致。
    //
    // 同时清 tailBuffer 内部状态：屏幕上方已物理显示这些内容，resume 时不再 paint
    // 重画（避免重复显示）。statusLines / input 引用保留供 resume 重画。
    //
    // ANSI 序列：cursor up cursorRow 到 frame 起点 → cursor down tailLines 到 status
    // 起点（frame 内部 tailBuffer 之后的位置）→ 行首 + erase 到屏幕底。
    if (this.renderedRows > 0) {
      const tailLines = this.tailBuffer.length;
      let buf = ansiCursorUp(this.cursorRow);
      if (tailLines > 0) buf += ansiCursorDown(tailLines);
      buf += ANSI_CARRIAGE_RETURN;
      buf += ANSI_ERASE_DOWN;
      this.stdout.write(buf);
    }
    this.tailBuffer = [];
    this.cursorRow = 0;
    this.renderedRows = 0;
    this.segmentStartRow = null;
    this.segmentFrozenLineCount = 0;
    this.hasActiveSegment = false;
    this.suspended = true;
    this.notifySuspendChange(true);
  }

  resume(): void {
    if (this.disposed) {
      throw new Error("ScreenController.resume called after dispose");
    }
    if (!this.suspended) {
      throw new Error(
        "ScreenController.resume called without prior suspend",
      );
    }
    this.suspended = false;
    this.notifySuspendChange(false);
    // 让 chrome 回归——同时触发 flush 消费暂存队列任务。期间累积的 setStatusBar /
    // withScrollWrite / writeScrollLine 依次执行（每个 task 内 paintFrame），最终
    // 的 paintFrame 兜底无副作用（idempotent，基于当前状态画）
    this.enqueue(() => {
      this.paintFrame();
    });
  }

  onSuspendChange(listener: (suspended: boolean) => void): () => void {
    this.suspendListeners.add(listener);
    return () => {
      this.suspendListeners.delete(listener);
    };
  }

  /** 同步通知所有 suspend 订阅者状态翻转——监听器异常 swallow 不传播 */
  private notifySuspendChange(suspended: boolean): void {
    for (const listener of this.suspendListeners) {
      try {
        listener(suspended);
      } catch {
        // 监听器异常不影响其它监听器与 ScreenController 自身
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.detachResize?.();
    this.detachResize = null;
    this.queue.push({
      run: () => {
        if (this.renderedRows > 0) {
          this.stdout.write(eraseRegion(this.cursorRow));
        }
        this.input = null;
        this.statusLines = [];
        this.tailBuffer = [];
        this.renderedRows = 0;
        this.cursorRow = 0;
        this.segmentStartRow = null;
        this.segmentFrozenLineCount = 0;
        this.hasActiveSegment = false;
      },
    });
    this.disposed = true;
    // dispose 是特权清理——若处于 suspended 强制清掉让 flush 能消费 cleanup 任务。
    // 暂存队列中的非 cleanup 任务会一并执行（屏幕马上 erase，多 paint 几次无影响）
    this.suspended = false;
    this.flush();
    this.suspendListeners.clear();
  }

  private enqueue(task: () => void): void {
    if (this.disposed) return;
    this.queue.push({ run: task });
    this.flush();
  }

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        // suspended 期间任务暂存不消费——等 resume 时再 flush
        if (this.suspended) break;
        const task = this.queue.shift();
        if (!task) break;
        try {
          task.run();
        } catch {
          // 任务异常不传播——保持后续任务可执行
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 把 content 切分成行追加到 tailBuffer——chunk 接续语义在此实现：
   *
   *   - content = "abc"  → tailBuffer 末尾行追加 "abc"（同行接续）
   *   - content = "\n"   → tailBuffer 追加空行（下次 chunk 在新行起手）
   *   - content = "a\nb" → tailBuffer 末尾行追加 "a"，新增一行 "b"
   *
   * 第一次调用时 tailBuffer 为空——以"空末尾行"起手，让首段直接接续到该行。
   */
  private appendToTail(content: string): void {
    const parts = content.split("\n");
    if (this.tailBuffer.length === 0) {
      this.tailBuffer.push("");
    }
    // 第一段追加到当前末尾行
    this.tailBuffer[this.tailBuffer.length - 1] += parts[0]!;
    // 后续段作为新行
    for (let i = 1; i < parts.length; i++) {
      this.tailBuffer.push(parts[i]!);
    }
  }

  /**
   * 当前终端 viewport 内允许的 frame 最大高度——硬约束。
   *
   * 读 stdout.rows，留 safety margin 避免末尾 \n 触发滚动；不可读时 fallback 到
   * VT100 经典 24 行；极小终端走 FRAME_MIN_ROWS 兜底。
   */
  private getMaxFrameRows(): number {
    const rows = (this.stdout as NodeJS.WriteStream).rows;
    const usable =
      typeof rows === "number" && rows > 0 ? rows : FALLBACK_VIEWPORT_ROWS;
    return Math.max(FRAME_MIN_ROWS, usable - FRAME_SAFETY_MARGIN);
  }

  /**
   * 检查 tailBuffer + statusLines + input 总行数是否超出 viewport 上限——超出则
   * 把最早的若干 tailBuffer 行主动推入永久 scrollback（cursor up + write + \n），
   * 让 frame 永远在 viewport 内可被 paintFrame 安全 cursor up 覆盖。
   *
   * 返回 ANSI prefix string 由 caller 合并到下一次 paintFrame 的 buf，单次 stdout.write
   * 完成 freeze + paint，不在 TTY 间隙暴露中间状态。
   *
   * 物理屏幕语义：
   *   - 旧 frame_start 物理位置：cursor 当前位置 - cursorRow
   *   - cursor up cursorRow → cursor 在旧 frame_start
   *   - write freezeCount 行 + \n —— 这些行原本在同位置（上次 paint 已写过），现在
   *     被同内容覆盖（视觉无变化），但语义上"frame 起点"下移 freezeCount 行
   *   - cursor 现在在第 freezeCount 行 = 新 frame_start
   *   - cursorRow = 0（cursor 已在新 frame 起点）
   *   - renderedRows -= freezeCount（frame 高度缩短）
   *
   * 数据结构：tailBuffer.splice(0, freezeCount) 把固化行移出，下次 paint 不再重画。
   */
  private freezeOverflowToScrollback(): string {
    const inputLines = this.input ? this.input.renderLines().length : 0;
    const totalRows =
      this.tailBuffer.length + this.statusLines.length + inputLines;
    const maxRows = this.getMaxFrameRows();
    if (totalRows <= maxRows) return "";

    const overflow = totalRows - maxRows;
    // 只能固化 tailBuffer 行——status / input 是 frame 永驻区，不固化
    const freezeCount = Math.min(overflow, this.tailBuffer.length);
    if (freezeCount === 0) return "";

    // segment 协调：若 freeze 切到 segment 头部行，更新 segment 状态——
    // 切走的 segment 头部行视为永久固化（流式期 dim 字面保留），后续
    // replace/commit 跳过这些起首行不重新渲染
    if (this.segmentStartRow !== null) {
      const freezeBeforeSegment = Math.min(freezeCount, this.segmentStartRow);
      const freezeFromSegmentHead = freezeCount - freezeBeforeSegment;
      this.segmentFrozenLineCount += freezeFromSegmentHead;
      this.segmentStartRow = Math.max(0, this.segmentStartRow - freezeCount);
    }

    let buf = "";
    if (this.cursorRow > 0) {
      buf += ansiCursorUp(this.cursorRow);
      buf += ANSI_CARRIAGE_RETURN;
    }
    for (let i = 0; i < freezeCount; i++) {
      buf += ANSI_ERASE_LINE + this.tailBuffer[i]! + "\n";
    }

    this.tailBuffer.splice(0, freezeCount);
    this.cursorRow = 0;
    this.renderedRows = Math.max(0, this.renderedRows - freezeCount);
    return buf;
  }

  /**
   * 全帧差分 paint——单次 stdout.write 覆盖整个 frame（tailBuffer + chrome）。
   *
   * 流程：
   *   1. 先 freezeOverflowToScrollback：保证 frame ≤ viewport，超出部分主动推入 scrollback
   *   2. cursor up cursorRow → frame 起点（保证在 viewport 内不被截断）
   *   3. \r → 行首
   *   4. 逐行 \x1b[2K（清整行）+ 内容；行间 \n。保留 max(oldRows, newRows) 占用避免
   *      行数收缩闪烁，多余旧行用 \x1b[2K 清空
   *   5. 移光标到 input cursor 位置
   *
   * 单次 stdout.write 让 TTY 在一帧内处理完整 ANSI 序列——不会被分帧 render 出"擦后写"
   * 的过渡空白。
   */
  private paintFrame(): void {
    const freezePrefix = this.freezeOverflowToScrollback();

    const allLines: string[] = [];
    for (const line of this.tailBuffer) allLines.push(line);
    for (const line of this.statusLines) allLines.push(line);
    const inputStartRow = allLines.length;
    if (this.input) {
      for (const line of this.input.renderLines()) allLines.push(line);
    }

    const oldRows = this.renderedRows;
    const newRows = allLines.length;

    if (oldRows === 0 && newRows === 0) {
      this.cursorRow = 0;
      if (freezePrefix.length > 0) this.stdout.write(freezePrefix);
      return;
    }

    let buf = freezePrefix;
    let writtenRows: number;

    if (oldRows === 0) {
      // 第一次 paint——光标当前在 caller 决定的位置（通常是终端 prompt 之后的新行行首）
      // 直接逐行写新内容，不写 \x1b[2K（避免误擦 caller 已写到光标位置的内容）
      for (let i = 0; i < newRows; i++) {
        buf += allLines[i]!;
        if (i < newRows - 1) buf += "\n";
      }
      writtenRows = newRows;
    } else {
      // 已有 frame：cursor up 到 frame 起点 + 逐行 \x1b[2K + 写新内容
      buf += ansiCursorUp(this.cursorRow);
      buf += ANSI_CARRIAGE_RETURN;

      const totalRows = Math.max(oldRows, newRows);
      for (let i = 0; i < totalRows; i++) {
        buf += ANSI_ERASE_LINE;
        if (i < newRows) buf += allLines[i]!;
        if (i < totalRows - 1) buf += "\n";
      }
      writtenRows = totalRows;
    }

    // 移光标到 input cursor 位置（在 chromeStartRow + statusLines.length + pos.row 行）
    if (this.input && newRows > 0) {
      const pos = this.input.cursorPosition();
      const targetRow = inputStartRow + pos.row;
      buf += moveCursorWithinRegion(writtenRows, targetRow, pos.col);
      this.cursorRow = targetRow;
    } else {
      this.cursorRow = Math.max(0, writtenRows - 1);
    }

    this.renderedRows = writtenRows;
    this.stdout.write(buf);
  }
}

export function createScreenController(
  options: ScreenControllerOptions = {},
): ScreenController {
  return new ScreenControllerImpl(options);
}
