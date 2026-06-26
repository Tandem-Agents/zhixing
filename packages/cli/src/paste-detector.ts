/**
 * Paste Detector — keypress 层粘贴会话识别。
 *
 * 目标是向上层暴露稳定的领域事件：单键输入走 onSingle，一次完整粘贴走 onPaste。
 * 上层不需要理解 bracketed paste marker、stdin chunk 拆分或 readline 同步 emit 细节。
 *
 * 识别策略：
 *   - bracketed paste marker 存在时，以 paste-start / paste-end 包住的内容为一次完整粘贴
 *   - marker 不存在时，同一 macrotask 内同步出现的多个 keypress 视为一个粘贴片段
 *   - 相邻粘贴片段在极短 idle 窗口内合并，覆盖终端把一次粘贴拆成多个 data chunk 的情况
 *   - 单 keypress 仍在 microtask drain 后立即走 onSingle，不引入可见输入延迟
 *
 * 与 raw mode 组件协作：每个 keypress 消费者用 wrapKeypressHandler 包自己的
 * onKeypress；典型用法：
 *
 *   typeahead-input        → onPaste = finalizePaste（折叠/铺开内容）
 *   SelectOperationRegion  → onPaste = 字符流喂入 input buffer（input mode）/ 丢弃（select mode）
 *   typeahead-panel        → onPaste = 丢弃（panel 不输入文本）
 */

import type * as readline from "node:readline";

const FALLBACK_PASTE_IDLE_MS = 15;

export interface KeypressBatcherOptions {
  /** 单 keypress 时调用（原 keypress handler 逻辑） */
  readonly onSingle: (str: string, key: readline.Key | undefined) => void;
  /** 多 keypress batch 时调用（paste 内容字符串） */
  readonly onPaste: (content: string) => void;
  /** SGR mouse tracking 事件。未提供时仍会吞掉 mouse 序列，避免污染输入区。 */
  readonly onMouse?: (event: KeypressMouseEvent) => void;
}

export interface KeypressBatcherHandle {
  /** 注册到 stdin.on("keypress", handle.handler) */
  readonly handler: (str: string, key: readline.Key | undefined) => void;
  /**
   * 永久禁用本 batcher：flush 单 keypress 残余（避免末尾按键丢失），多 keypress
   * paste 残骸丢弃；此后 handler 调用直接 ignore（不再 dispatch onSingle/onPaste）。
   * caller 在 stdin.off 之后调 release。release 之后不能 reuse——cleanup 终态。
   */
  readonly release: () => void;
}

interface PendingEvent {
  str: string;
  key: readline.Key | undefined;
}

export type MouseButton =
  | "left"
  | "middle"
  | "right"
  | "release"
  | "wheel-up"
  | "wheel-down"
  | "wheel-left"
  | "wheel-right"
  | "unknown";

export interface KeypressMouseEvent {
  readonly protocol: "sgr";
  readonly action: "press" | "release";
  readonly button: MouseButton;
  /** 1-based terminal column. */
  readonly x: number;
  /** 1-based terminal row. */
  readonly y: number;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly rawCode: number;
  readonly raw: string;
}

/**
 * 包装一个 keypress handler，自动按时间窗批量识别 paste 事件。
 *
 * 单一职责：决定完整 paste session 调 onPaste，普通按键调 onSingle。不维护全局状态，
 * caller 自己决定 paste 内容怎么处理。
 */
export function wrapKeypressHandler(
  options: KeypressBatcherOptions,
): KeypressBatcherHandle {
  let batch: PendingEvent[] = [];
  let scheduled = false;
  let released = false;
  let bracketedPasteContent: string[] | null = null;
  let fallbackPasteContent = "";
  let fallbackPasteTimer: ReturnType<typeof setTimeout> | undefined;
  let sgrMouseBuffer: string | null = null;

  function flush(): void {
    scheduled = false;
    if (released) {
      batch = [];
      return;
    }
    const events = batch;
    batch = [];
    if (events.length === 0) return;
    if (events.length >= 2) {
      appendFallbackPaste(events.map(eventToContent).join(""));
      return;
    }
    flushFallbackPaste();
    const single = events[0]!;
    options.onSingle(single.str, single.key);
  }

  function eventToContent(e: PendingEvent): string {
    const name = e.key?.name;
    if (name === "return" || name === "enter") return "\n";
    return e.str;
  }

  function isPasteStart(key: readline.Key | undefined): boolean {
    return key?.name === "paste-start";
  }

  function isPasteEnd(key: readline.Key | undefined): boolean {
    return key?.name === "paste-end";
  }

  function isSgrMouseStart(key: readline.Key | undefined): boolean {
    const code = (key as { code?: string } | undefined)?.code;
    return key?.sequence === "\x1b[<" || code === "[<";
  }

  function eventRawText(e: PendingEvent): string {
    return e.str ?? e.key?.sequence ?? "";
  }

  function appendSgrMouse(event: PendingEvent): boolean {
    if (sgrMouseBuffer === null) return false;
    const raw = eventRawText(event);
    if (raw.length === 0) return true;

    for (const ch of raw) {
      if (!/[0-9;Mm]/.test(ch)) {
        sgrMouseBuffer = null;
        return true;
      }
      sgrMouseBuffer += ch;
      if (ch === "M" || ch === "m") {
        const parsed = parseSgrMouse(sgrMouseBuffer);
        sgrMouseBuffer = null;
        if (parsed) options.onMouse?.(parsed);
        return true;
      }
      if (sgrMouseBuffer.length > 64) {
        sgrMouseBuffer = null;
        return true;
      }
    }
    return true;
  }

  function appendFallbackPaste(content: string): void {
    if (content.length === 0) return;
    fallbackPasteContent += content;
    scheduleFallbackPasteFlush();
  }

  function scheduleFallbackPasteFlush(): void {
    clearFallbackPasteTimer();
    fallbackPasteTimer = setTimeout(
      flushFallbackPaste,
      FALLBACK_PASTE_IDLE_MS,
    );
  }

  function clearFallbackPasteTimer(): void {
    if (fallbackPasteTimer === undefined) return;
    clearTimeout(fallbackPasteTimer);
    fallbackPasteTimer = undefined;
  }

  function flushFallbackPaste(): void {
    clearFallbackPasteTimer();
    if (fallbackPasteContent.length === 0) return;
    const content = fallbackPasteContent;
    fallbackPasteContent = "";
    if (!released) {
      options.onPaste(content);
    }
  }

  function flushBracketedPaste(): void {
    const content = bracketedPasteContent?.join("") ?? "";
    bracketedPasteContent = null;
    if (content.length > 0) {
      options.onPaste(content);
    }
  }

  const handler = (
    str: string,
    key: readline.Key | undefined,
  ): void => {
    if (released) return;
    const event = { str: str ?? "", key };

    if (isPasteStart(key)) {
      flush();
      flushFallbackPaste();
      if (bracketedPasteContent !== null) {
        flushBracketedPaste();
      }
      bracketedPasteContent = [];
      return;
    }

    if (isPasteEnd(key)) {
      flush();
      if (bracketedPasteContent !== null) {
        flushBracketedPaste();
      }
      return;
    }

    if (bracketedPasteContent !== null) {
      bracketedPasteContent.push(eventToContent(event));
      return;
    }

    if (appendSgrMouse(event)) return;

    if (isSgrMouseStart(key)) {
      flush();
      flushFallbackPaste();
      sgrMouseBuffer = "";
      return;
    }

    batch.push(event);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  };

  return {
    handler,
    release: () => {
      if (released) return;
      released = true;
      clearFallbackPasteTimer();
      fallbackPasteContent = "";
      bracketedPasteContent = null;
      sgrMouseBuffer = null;
      // 残余 flush：单 keypress 转 onSingle 避免末尾按键丢失；多 keypress paste
      // 残骸在 release 时丢弃（cleanup 阶段已 detach，paste 内容无意义）
      const events = batch;
      batch = [];
      if (events.length === 1) {
        const single = events[0]!;
        try {
          options.onSingle(single.str, single.key);
        } catch {
          // ignore：cleanup 时调原 handler 的异常不传播
        }
      }
    },
  };
}

function parseSgrMouse(raw: string): KeypressMouseEvent | null {
  const m = raw.match(/^(\d+);(\d+);(\d+)([Mm])$/);
  if (!m) return null;
  const rawCode = Number(m[1]);
  const x = Number(m[2]);
  const y = Number(m[3]);
  if (!Number.isFinite(rawCode) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  const wheel = (rawCode & 64) !== 0;
  const low = rawCode & 3;
  let button: MouseButton = "unknown";
  if (wheel) {
    button =
      low === 0
        ? "wheel-up"
        : low === 1
          ? "wheel-down"
          : low === 2
            ? "wheel-left"
            : "wheel-right";
  } else if (m[4] === "m") {
    button = low === 3 ? "release" : low === 0 ? "left" : low === 1 ? "middle" : "right";
  } else {
    button =
      low === 0 ? "left" : low === 1 ? "middle" : low === 2 ? "right" : "release";
  }

  return {
    protocol: "sgr",
    action: m[4] === "m" ? "release" : "press",
    button,
    x,
    y,
    shift: (rawCode & 4) !== 0,
    meta: (rawCode & 8) !== 0,
    ctrl: (rawCode & 16) !== 0,
    rawCode,
    raw: `\x1b[<${raw}`,
  };
}
