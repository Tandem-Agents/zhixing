/**
 * 标准化按键解码——chunk → KeyEvent[] 的纯函数。
 *
 * stdin raw mode 下，按键到达是字节流。终端用 ANSI 转义序列编码方向键 / Home / End 等：
 *   - 方向键 ↑ → ESC[A    ↓ → ESC[B    → → ESC[C    ← → ESC[D
 *   - Backspace → 0x7F (DEL) 或 0x08 (BS)
 *   - Enter → \r 或 \n
 *   - Esc → 0x1B（孤立 ESC，未跟随 [）
 *   - Ctrl+C → 0x03
 *   - 普通字符 → 字面量
 *
 * 解码器跨 chunk 维护状态（CSI 序列可能被切断在两个 chunk 间）；调用方持有 state 跨调用复用。
 *
 * 边界：未识别的 CSI 序列（如 F1-F12、Page Up/Down）整段吞掉不产生 KeyEvent；
 * 孤立 Esc 后跟随非 [ 字符时，Esc 触发 escape 事件 + 字符正常入流。
 */

import type { KeyEvent } from "../types.js";

export interface KeyDecoderState {
  /** ANSI 序列识别状态机 */
  ansi: "none" | "esc" | "csi";
  /** CSI 内部累积的参数字符（终结后用于识别具体按键） */
  csiBuffer: string;
  /**
   * 上一字符是 CR（\r）——下一字符若是 LF（\n）则吞掉，做 CRLF 行尾归一。
   *
   * 不是为 raw mode Enter 服务（各平台 Enter 都是单个 \r）；而是为**粘贴**：
   * 用户从 Windows 记事本 / CRLF 文本文件粘贴 API Key 时，剪贴板内容含 \r\n
   * 行尾。不归一会让 `sk-xxx\r\n` 产出两个 enter 事件——第一个提交 input 面板，
   * 第二个落到 list 面板触发"进入"，跳错层级。
   */
  lastWasCR: boolean;
}

export function createKeyDecoderState(): KeyDecoderState {
  return { ansi: "none", csiBuffer: "", lastWasCR: false };
}

export interface DecodeResult {
  newState: KeyDecoderState;
  events: KeyEvent[];
}

/**
 * 处理一个字符，返回新状态 + 该字符产生的 KeyEvent 列表（通常 0 或 1 个）。
 *
 * 输入流式处理：caller 用 for-of 字符迭代调用此函数，逐个推进状态。
 */
export function decodeChar(
  ch: string,
  state: KeyDecoderState,
): DecodeResult {
  const code = ch.codePointAt(0)!;

  // ─── CSI 序列内（ESC[...）───
  if (state.ansi === "csi") {
    // 终结字符 0x40-0x7E：结束序列，识别按键
    if (code >= 0x40 && code <= 0x7e) {
      const event = identifyCsi(state.csiBuffer + ch);
      return {
        newState: { ansi: "none", csiBuffer: "", lastWasCR: false },
        events: event ? [event] : [],
      };
    }
    // 合法参数 / 中间字符 0x20-0x3F：累积
    if (code >= 0x20 && code <= 0x3f) {
      return {
        newState: { ansi: "csi", csiBuffer: state.csiBuffer + ch, lastWasCR: false },
        events: [],
      };
    }
    // 异常字符：序列损坏 abort，让字符 pass-through 给后续处理
    const aborted = decodeChar(ch, {
      ansi: "none",
      csiBuffer: "",
      lastWasCR: false,
    });
    return aborted;
  }

  // ─── ESC 之后等待 [ ───
  if (state.ansi === "esc") {
    if (ch === "[") {
      return {
        newState: { ansi: "csi", csiBuffer: "", lastWasCR: false },
        events: [],
      };
    }
    // 孤立 ESC：触发 escape 事件 + 当前字符正常处理（递归用 ansi=none）
    const next = decodeChar(ch, { ansi: "none", csiBuffer: "", lastWasCR: false });
    return {
      newState: next.newState,
      events: [{ type: "escape" }, ...next.events],
    };
  }

  // ─── 顶层（ansi === "none"）───

  // ESC：进入序列等待（保留 lastWasCR 不重置——CR 后立刻按 ESC 不影响 CRLF 标准化）
  if (code === 0x1b) {
    return {
      newState: { ansi: "esc", csiBuffer: "", lastWasCR: false },
      events: [],
    };
  }

  // Ctrl+C
  if (code === 0x03) {
    return { newState: { ...state, lastWasCR: false }, events: [{ type: "ctrl-c" }] };
  }

  // Enter (\r) —— 标记 lastWasCR，让紧随的 \n 被吞
  if (ch === "\r") {
    return {
      newState: { ...state, lastWasCR: true },
      events: [{ type: "enter" }],
    };
  }

  // \n —— 若紧跟 CR 则吞（CRLF 标准化）；否则当独立 Enter
  if (ch === "\n") {
    if (state.lastWasCR) {
      return { newState: { ...state, lastWasCR: false }, events: [] };
    }
    return { newState: { ...state, lastWasCR: false }, events: [{ type: "enter" }] };
  }

  // Backspace（DEL 0x7F 或 BS 0x08）
  if (code === 0x7f || code === 0x08) {
    return {
      newState: { ...state, lastWasCR: false },
      events: [{ type: "backspace" }],
    };
  }

  // 其它控制字符（< 0x20）：忽略
  if (code < 0x20) {
    return { newState: { ...state, lastWasCR: false }, events: [] };
  }

  // 普通字符
  return {
    newState: { ...state, lastWasCR: false },
    events: [{ type: "char", ch }],
  };
}

/**
 * 处理整个 chunk（多字符）：迭代字符 + 累积 events。
 *
 * 工厂函数命名而非类——保持纯函数接口；caller 用同一 state 跨 chunk 调用。
 */
export function decodeChunk(
  chunk: string,
  state: KeyDecoderState,
): DecodeResult {
  let current = state;
  const events: KeyEvent[] = [];
  for (const ch of chunk) {
    const result = decodeChar(ch, current);
    current = result.newState;
    events.push(...result.events);
  }
  return { newState: current, events };
}

// ─── 内部：识别 CSI 序列 ───

/**
 * 已收到完整 CSI 序列（ESC[...终结字符）后识别按键。
 *
 * 仅识别方向键——Home / End / Page Up/Down / F1-F12 等不在编辑器交互范围，吞掉不产生事件。
 */
function identifyCsi(sequence: string): KeyEvent | null {
  // 标准方向键：A=up B=down C=right D=left
  // sequence 不含 ESC[，仅含参数 + 终结字符
  switch (sequence) {
    case "A":
      return { type: "arrow-up" };
    case "B":
      return { type: "arrow-down" };
    case "C":
      return { type: "arrow-right" };
    case "D":
      return { type: "arrow-left" };
    default:
      return null;
  }
}
