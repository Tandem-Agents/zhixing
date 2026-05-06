/**
 * Paste Detector — keypress 层 microtask batcher。
 *
 * 把粘贴识别为"同步连续多个 keypress"事件，与单字符敲键自然分离：
 *
 *   - 用户敲键：物理手指最快间隔 ~50ms，每次单 keypress；下一次 keypress 在新的
 *     macrotask 中触发，前一个 batch 已在 microtask drain 时 flush
 *   - 用户粘贴：终端一次 syscall 写入 stdin，readline 同步循环 emit N 个 keypress
 *     全部在同一 macrotask 内累积；microtask drain 时整 batch 一起 flush
 *
 * 算法：
 *   - 任何 keypress 进 pending batch + queueMicrotask(flush)（已 scheduled 跳过）
 *   - 当前 macrotask 结束 → microtask drain → flush
 *   - flush 时 batch ≥ 2 视为 paste（同步多次 = 粘贴）；batch = 1 单 keypress
 *
 * 为什么用 microtask 而非 setTimeout：
 *   - microtask 在当前 macrotask 末同步 drain，不引入可见延迟
 *   - 同步 emit（粘贴）与异步 emit（敲键间隔）自然分离
 *
 * 为什么不用 stdin "data" 字节流：raw mode 下 stdin chunk 大小不可控（部分平台
 * 字节级流），无法可靠基于 chunk size 判断；readline 同步 emit keypress 是更稳定
 * 的粘贴信号。
 *
 * 为什么不用 bracketed paste mode markers 作主路径：跨终端兼容性差（Windows
 * ConPTY / 部分老终端不可靠）。`\x1b[?2004h` 仍启用——抑制终端"多行粘贴警告"
 * 弹窗，但 paste 检测不依赖 markers。
 *
 * 与 raw mode 组件协作：每个 keypress 消费者用 wrapKeypressHandler 包自己的
 * onKeypress；典型用法：
 *
 *   typeahead-input        → onPaste = finalizePaste（折叠/铺开内容）
 *   select-with-input      → onPaste = 丢弃（select 不支持 paste）
 *   typeahead-panel        → onPaste = 丢弃（panel 不输入文本）
 */

import type * as readline from "node:readline";

export interface KeypressBatcherOptions {
  /** 单 keypress 时调用（原 keypress handler 逻辑） */
  readonly onSingle: (str: string, key: readline.Key | undefined) => void;
  /** 多 keypress batch 时调用（paste 内容字符串） */
  readonly onPaste: (content: string) => void;
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

/**
 * 包装一个 keypress handler，自动按时间窗批量识别 paste 事件。
 *
 * 单一职责：决定 batch ≥ 2 时调 onPaste，batch = 1 时调 onSingle。不维护全局状态、
 * 不识别 bracketed paste markers——caller 自己决定 paste 内容怎么处理。
 */
export function wrapKeypressHandler(
  options: KeypressBatcherOptions,
): KeypressBatcherHandle {
  let batch: PendingEvent[] = [];
  let scheduled = false;
  let released = false;

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
      // paste content 拼接：readline 把 `\r` / `\n` / `\r\n` 解析为 return/enter
      // keypress，**str 字段为空字符串**——直接用 e.str 拼接会丢失换行符。从 key
      // 分类还原：return/enter → `\n`；其他用 str（普通字符 keypress）。
      const content = events.map(eventToContent).join("");
      options.onPaste(content);
      return;
    }
    const single = events[0]!;
    options.onSingle(single.str, single.key);
  }

  function eventToContent(e: PendingEvent): string {
    const name = e.key?.name;
    if (name === "return" || name === "enter") return "\n";
    return e.str;
  }

  const handler = (
    str: string,
    key: readline.Key | undefined,
  ): void => {
    if (released) return;
    batch.push({ str: str ?? "", key });
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
