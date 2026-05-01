/**
 * 引导交互的终端实现——基于 raw mode + 自写字符状态机。
 *
 * 设计选择（vs readline + _writeToOutput hijack）：
 *   - 仅依赖 setRawMode（公开 API），不依赖 readline 内部未文档化钩子
 *   - silent / 非 silent 共用同一 read loop，区别仅在是否 echo 用户字符
 *   - 双层状态机外部化为纯函数，集成层 onData 仅做 stream wiring
 *
 * 双层状态机：
 *   1. processAnsiSequenceChar（sequence-level）—— 识别 ANSI 转义序列
 *      （方向键 / Home / F1-12 等），整段吞掉避免序列字符污染输入
 *   2. processInputChar（char-level）—— 字符级判定 buffer 累积 / 提交 / 取消
 *
 * 行编辑能力：
 *   - 字符输入：累积到 buffer
 *   - Backspace（DEL 0x7F / BS 0x08）：删 buffer 末尾一个 codePoint
 *   - Enter（\r 或 \n）：提交（trim 后空字符串视为 cancel）
 *   - Ctrl+C（0x03）：cancel
 *   - Ctrl+D（0x04）空 buffer：cancel
 *   - 方向键 / Home / End / F1-F12 等 ANSI 序列：整段吞掉，不污染 buffer
 *   - 其它控制字符（< 0x20）：忽略
 *
 * 不实现：光标移动、history、tab completion——wizard 简单输入用不到。
 */

import type { MissingField } from "@zhixing/providers";
import { buildIntroLines } from "./prompts.js";
import type {
  BootstrapAskAnswer,
  BootstrapAskRequest,
  BootstrapInteraction,
} from "./types.js";

// ─── ANSI 序列状态机（纯函数，可单元测试） ───

/**
 * ANSI 序列识别状态：
 *   - none：未在序列中（普通字符流）
 *   - esc：刚收到 ESC（0x1B），等待下一字符判定是否进入 CSI
 *   - csi：CSI 序列内（ESC[...），吞所有字符直到终结字符（0x40-0x7E）
 *
 * 仅识别 CSI（ESC[...）——覆盖方向键 / Home / End / Page Up/Down / F1-F12 等
 * 大多数终端控制序列。OSC（ESC]）、DCS（ESCP）等罕见 sequence 不主动识别——
 * 落到 esc 状态后下一字符若非 [ 则丢弃 ESC + 字符 pass-through，最坏情况
 * 是一个孤立 ESC 被丢，不影响数据正确性。
 */
export type AnsiSequenceState = "none" | "esc" | "csi";

export interface AnsiSequenceAction {
  /** 状态机推进后的新状态 */
  newState: AnsiSequenceState;
  /** 是否将当前字符转交下层处理（false = 序列吞掉） */
  passThrough: boolean;
}

/**
 * ANSI 序列状态机：决定字符是否被序列吞掉。
 *
 * 转移规则：
 *   none + ESC          → esc，吞 ESC
 *   none + 其它          → none，pass-through
 *   esc  + '['          → csi，吞 [
 *   esc  + 其它          → none，pass-through（孤立 ESC 已丢，当前字符正常处理）
 *   csi  + 终结字符      → none，吞终结字符（0x40-0x7E：@A-Z[\]^_`a-z{|}~）
 *   csi  + 参数/中间字符 → csi，吞字符（0x20-0x3F：参数 0-9 / ; / 标点等）
 *   csi  + 异常字符      → none，pass-through（< 0x20 控制字符或 0x7F+ 不属于 CSI
 *                         合法字符；按 ANSI 规范应 abort sequence。这保证用户逃生口
 *                         （Ctrl+C / Enter / Backspace）永不被吞——粘贴未完成的
 *                         CSI 序列后用户仍能正常取消或提交）
 */
export function processAnsiSequenceChar(
  ch: string,
  state: AnsiSequenceState,
): AnsiSequenceAction {
  const code = ch.codePointAt(0)!;

  if (state === "csi") {
    // 终结字符 0x40-0x7E：完成序列
    if (code >= 0x40 && code <= 0x7e) {
      return { newState: "none", passThrough: false };
    }
    // 合法参数 / 中间字符 0x20-0x3F：继续吞，sequence 仍在进行
    if (code >= 0x20 && code <= 0x3f) {
      return { newState: "csi", passThrough: false };
    }
    // 异常字符（控制字符 < 0x20 或 0x7F+）：序列损坏 abort，
    // 字符 pass-through 给 char-level 状态机正常处理
    return { newState: "none", passThrough: true };
  }

  if (state === "esc") {
    if (ch === "[") {
      return { newState: "csi", passThrough: false };
    }
    // 孤立 ESC：丢弃 ESC，让当前字符正常 pass-through
    return { newState: "none", passThrough: true };
  }

  // state === "none"
  if (code === 0x1b) {
    return { newState: "esc", passThrough: false };
  }
  return { newState: "none", passThrough: true };
}

// ─── 字符状态机（纯函数，可单元测试） ───

/**
 * 处理单字符的结果——caller 据此更新 buffer 与（可选）echo 到 stdout。
 *
 * 状态机外部化：read loop 只做 stream wiring 与 echo 写入；判定逻辑全在
 * processInputChar 内，便于单元测试覆盖所有字符路径。
 */
export type CharAction =
  | { kind: "continue"; buffer: string; echo: string }
  | { kind: "submit"; value: string }
  | { kind: "cancel" };

/**
 * 处理一个字符，返回新 buffer 状态与可选 echo。
 *
 * 纯函数：不读不写 IO；echo 字段告诉 caller 该输出什么（silent=true 时 echo 总为空）。
 *
 * silent 区分仅影响 echo：buffer 状态推进（含 Backspace 删除）总是发生，
 * 让 silent 模式下用户的删除操作仍生效——只是看不到反馈。
 */
export function processInputChar(
  ch: string,
  buffer: string,
  silent: boolean,
): CharAction {
  const code = ch.codePointAt(0)!;

  // Enter 提交（trim 后空字符串视为 cancel——用户主动空回车取消）
  if (ch === "\r" || ch === "\n") {
    const value = buffer.trim();
    return value ? { kind: "submit", value } : { kind: "cancel" };
  }

  // Ctrl+C
  if (code === 0x03) return { kind: "cancel" };

  // Ctrl+D 在空 buffer 视为 cancel；非空 buffer 时忽略
  if (code === 0x04) {
    if (buffer.length === 0) return { kind: "cancel" };
    return { kind: "continue", buffer, echo: "" };
  }

  // Backspace（DEL 0x7F 或 BS 0x08）
  if (code === 0x7f || code === 0x08) {
    if (buffer.length === 0) {
      return { kind: "continue", buffer, echo: "" };
    }
    // codePoint-aware：用 Array.from 按 codePoint 切，删除最后一个完整字符
    const chars = Array.from(buffer);
    chars.pop();
    return {
      kind: "continue",
      buffer: chars.join(""),
      echo: silent ? "" : "\b \b",
    };
  }

  // 其它 ASCII 控制字符（< 0x20）：忽略
  if (code < 0x20) {
    return { kind: "continue", buffer, echo: "" };
  }

  // 普通字符：累积 + echo
  return {
    kind: "continue",
    buffer: buffer + ch,
    echo: silent ? "" : ch,
  };
}

// ─── 终端集成层 ───

export class TerminalBootstrapInteraction implements BootstrapInteraction {
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WritableStream;
  private originalRawMode: boolean | null = null;
  private closed = false;

  constructor(
    options: {
      stdin?: NodeJS.ReadStream;
      stdout?: NodeJS.WritableStream;
    } = {},
  ) {
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
  }

  async printIntro(args: {
    configPath: string;
    credentialsPath: string;
    missing: MissingField[];
  }): Promise<void> {
    const lines = buildIntroLines({
      configPath: args.configPath,
      credentialsPath: args.credentialsPath,
    });
    for (const line of lines) {
      this.stdout.write(line + "\n");
    }
  }

  async askField(request: BootstrapAskRequest): Promise<BootstrapAskAnswer> {
    this.stdout.write("\n");
    this.stdout.write(`需要：${request.field.humanLabel}\n`);
    this.stdout.write(`  ${request.schemaExample}\n`);
    this.stdout.write("> ");

    return await this.readLine(request.silent);
  }

  async printSummary(args: {
    written: { config: boolean; credentials: boolean };
    nextStepHint: string;
  }): Promise<void> {
    this.stdout.write("\n");
    this.stdout.write("──────────────────────────────────────────────\n");
    this.stdout.write("  首次配置完成\n");
    this.stdout.write("──────────────────────────────────────────────\n");
    if (args.written.config) {
      this.stdout.write("  ✓ 公开配置已写入\n");
    }
    if (args.written.credentials) {
      this.stdout.write("  ✓ 凭证已写入\n");
    }
    if (!args.written.config && !args.written.credentials) {
      this.stdout.write("  必要字段已齐全，无需写入\n");
    }
    this.stdout.write("\n");
    this.stdout.write(`  ${args.nextStepHint}\n`);
    this.stdout.write("\n");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.restoreRawMode();
  }

  /**
   * 单行字符级输入。
   *
   * 完成路径（提交 / 取消 / Ctrl+C）统一走 cleanup：detach listener +
   * 退出 raw mode + 补打印 \n 让 cursor 下行。
   *
   * 非 TTY 兜底：直接返回 cancel 并补 \n——caller 在调用前应已检查 isTTY，
   * 这里 defensive 防止环境异常时挂死。
   */
  private readLine(silent: boolean): Promise<BootstrapAskAnswer> {
    if (!this.stdin.isTTY || typeof this.stdin.setRawMode !== "function") {
      this.stdout.write("\n");
      return Promise.resolve({ kind: "cancel" });
    }

    this.enterRawMode();

    return new Promise<BootstrapAskAnswer>((resolve) => {
      let buf = "";
      let ansiState: AnsiSequenceState = "none";
      let settled = false;

      const cleanup = (answer: BootstrapAskAnswer): void => {
        if (settled) return;
        settled = true;
        this.stdin.off("data", onData);
        this.exitRawMode();
        this.stdout.write("\n");
        resolve(answer);
      };

      const onData = (chunk: string): void => {
        for (const ch of chunk) {
          // Layer 1: ANSI 序列吞字符（方向键等不污染 buffer）
          const ansi = processAnsiSequenceChar(ch, ansiState);
          ansiState = ansi.newState;
          if (!ansi.passThrough) continue;

          // Layer 2: 字符级状态机决定 buffer / submit / cancel
          const action = processInputChar(ch, buf, silent);
          if (action.kind === "submit") {
            cleanup({ kind: "value", value: action.value });
            return;
          }
          if (action.kind === "cancel") {
            cleanup({ kind: "cancel" });
            return;
          }
          buf = action.buffer;
          if (action.echo) this.stdout.write(action.echo);
        }
      };

      this.stdin.on("data", onData);
    });
  }

  private enterRawMode(): void {
    if (this.originalRawMode === null) {
      this.originalRawMode = this.stdin.isRaw ?? false;
    }
    this.stdin.setRawMode!(true);
    this.stdin.resume();
    this.stdin.setEncoding("utf-8");
  }

  private exitRawMode(): void {
    if (this.originalRawMode !== null && this.stdin.setRawMode) {
      this.stdin.setRawMode(this.originalRawMode);
      this.originalRawMode = null;
    }
    this.stdin.pause();
  }

  private restoreRawMode(): void {
    if (this.originalRawMode !== null && this.stdin.setRawMode) {
      this.stdin.setRawMode(this.originalRawMode);
      this.originalRawMode = null;
    }
  }
}
