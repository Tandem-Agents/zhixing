/**
 * cli 写屏统一接口——所有"在屏幕上输出文字"的代码必须经此协调，避免直接
 * console.log / process.stdout.write 推走 chrome（持久 input 区 + 状态条）。
 *
 * 双实现：
 *   - createScreenWriter(screen)：经 ScreenController 协调（cli REPL 持久 chrome 模式）
 *   - createStdoutWriter(stdout)：直接 stdout（runOnce / 非交互 / 测试模式，无 chrome）
 *
 * 设计契约：
 *   - line：独立段，自动补 \n——welcome / slash 命令 / 错误 / 工具卡片等"段落级"内容
 *   - appendInline：流式追加，不补 \n——LLM 流式 chunk 在 ScreenController 的 tailBuffer
 *     末尾行内接续，多次调用拼接同段
 *   - notify：独立段语义同 line——区别在调用语境表达"任意时刻可能触发"（scheduler /
 *     watchdog 等异步事件），让代码意图清晰
 *
 * 使用约束（强制）：
 *   - cli 模块禁止直接 console.log / process.stdout.write—— no-direct-console.test.ts 拦截
 *   - 所有渲染函数（render*）必须接受 CliWriter，由 caller 注入对应实现
 *   - 长生命周期 caller（如 OutputRenderer / RuntimeSession）持有 CliWriter 引用，
 *     不重复构建
 */

import type {
  ReplaceableSegmentHandle,
  ScreenController,
} from "./screen-controller.js";

export interface CliWriter {
  /**
   * 写一段独立内容——一次调用 = 一段独立屏幕落地。
   *
   * 协议：
   *   - text 是"独立段"语义——底层确保末尾 \n 落地（即使 text 不以 \n 结尾）
   *   - 多次 line 之间天然换行——每次 line 是独立段
   *   - 空字符串："" 表示空行（写一个 \n）；适合段间间隔
   *
   * 不要用 line 做流式 chunk 接续！流式接续用 appendInline——line 强制补 \n 会
   * 让 chunk 间被分行。
   */
  line(text: string): void;

  /**
   * 流式追加——不补 \n，多次调用在同一行接续。
   *
   * 协议：
   *   - text 直接追加到 frame 的 scroll 末尾行；如 text 含 \n，按 \n 切分自然换行
   *   - 多次 appendInline 之间在末尾行内接续（chunk 拼接同段）
   *   - 适合 LLM 流式 token / 工具卡片头部等"接续输出"场景
   *
   * 与 line 互斥：appendInline 末尾**不**补 \n，下次 appendInline 接续；下次 line
   * 调用会自动补 \n 让该段独立落地。
   */
  appendInline(text: string): void;

  /**
   * 异步通知——独立段语义，等同 line。区别在 caller 用此 API 表达"任意时刻可能
   * 触发的事件"（scheduler 任务完成、外部 signal、watchdog 警告等），让代码意图
   * 与同步路径的 line 区分开。
   */
  notify(text: string): void;

  /**
   * 可选——开启可替换尾段（流式期 replace、闭合时 commit、退化 close）。
   *
   * 仅 cli REPL 持久 chrome 模式（ScreenWriter）实现：转发 ScreenController 的
   * beginReplaceableSegment，让 caller 实现"流式期占位 + 闭合时整段切换"语义
   * （markdown code block 双态：流式 dim 字面 → 闭合 syntax highlight）。
   *
   * StdoutWriter 不实现此方法（直写无 chrome、无替换语义）——caller 通过
   * `writer.beginReplaceableSegment?.()` 检测：返回 undefined 时退化为 hold 路径
   * （等闭合再一次性 line 写出整段）。
   */
  beginReplaceableSegment?(): ReplaceableSegmentHandle;
}

interface ScreenWriterOptions {
  readonly screen: ScreenController;
}

/**
 * 经 ScreenController 协调的 CliWriter——cli REPL 持久 chrome 模式。
 *
 * line / notify 都走 screen.writeScrollLine（独立段语义，保证起新行避免与流式 chunk 粘连）；
 * appendInline 走 screen.withScrollWrite（流式接续语义，多次调用在 tailBuffer 末尾行追加）；
 * beginReplaceableSegment 转发到 ScreenController 的可替换尾段能力（双态渲染）。
 */
export function createScreenWriter(options: ScreenWriterOptions): CliWriter {
  const { screen } = options;
  return {
    line(text) {
      screen.writeScrollLine(text);
    },
    appendInline(text) {
      if (text.length === 0) return;
      screen.withScrollWrite((write) => write(text));
    },
    // notify 与 line 语义等同（双 writer 实现皆然）——空字符串都是"空行"
    // 而非 no-op，避免互换 writer 实现时行为漂移
    notify(text) {
      screen.writeScrollLine(text);
    },
    beginReplaceableSegment() {
      return screen.beginReplaceableSegment();
    },
  };
}

interface StdoutWriterOptions {
  readonly stdout?: NodeJS.WriteStream;
}

/**
 * 直接 stdout 的 CliWriter——runOnce / 非交互 / 测试模式（无 chrome）。
 *
 * 与 ScreenWriter 行为对称：
 *   - line / notify：独立段——确保末尾 \n
 *   - appendInline：流式追加——不补 \n
 */
export function createStdoutWriter(
  options: StdoutWriterOptions = {},
): CliWriter {
  const stdout = options.stdout ?? process.stdout;

  const writeLine = (text: string): void => {
    if (text.length === 0) {
      stdout.write("\n");
      return;
    }
    stdout.write(text);
    if (!text.endsWith("\n")) {
      stdout.write("\n");
    }
  };

  return {
    line: writeLine,
    appendInline(text) {
      if (text.length === 0) return;
      stdout.write(text);
    },
    notify: writeLine,
  };
}
