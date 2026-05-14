/**
 * PanelRenderer —— 原地重绘的光标不变量
 *
 * spec §6.4 的核心工程知识：TUI 面板在同一块屏幕区域反复重绘时，**每次
 * render() 结束时光标必须停在 `(startRow + N, col 0)`**（N = 本次渲染行数）。
 * 下次 rerender() 依赖这个位置 —— 先一次性上移 N 行回到 startRow，再逐行
 * 覆盖。这个约束看似琐碎，但实地调试里第一版原型**8 个自动化场景全绿却在
 * 真实 Windows Terminal 里每次按一次方向键就堆一行头部边框**。根因是"擦
 * 除 N 行"写成了"移动 N-1 次"的 off-by-one。
 *
 * 三个致命陷阱（均在本实现中规避）：
 *   1. `\n` vs `\r\n`：分隔符永远写 `\r\n`，不要赌 LF 在 raw mode 下会不会
 *      把 cursor 重置到列 0。iTerm2 / tmux 某些场景会坑你。
 *   2. 擦除 off-by-one：清 N 行必须上移 N 次（不是 N-1）。用"一次到位上移
 *      + 从头逐行覆盖"的两步模式，**永远不要**用"边清边移"的循环。
 *   3. clear() 的终止位置：清空后光标必须落在 startRow（不是 startRow+N），
 *      让后续 render() 仍然能从 startRow 开始覆盖而不是在旧面板下面追加。
 *
 * 这个模块只负责"给我一组行、保证无副作用地在原地重绘"这一条语义 ——
 * 它不关心行的内容、颜色、截断 —— 这些是调用方的职责（比如 TypeaheadPanel
 * 用 `clampLine` 截断，用 theme 上色）。
 *
 * 单独的 kernel 让 consumer 复用：
 *   - TypeaheadPanel（常驻组件，trigger 消失时调 clear() 无痕撤销）
 *
 * 一次性 modal 类组件（曾用此 kernel 的 SelectWithInput）已迁移到 chrome inline
 * 形态（SelectOperationRegion 通过 ScreenController.attachInput），不再直写 stdout，
 * 故不需 PanelRenderer。TypeaheadPanel 仍走直写路径（panel 在 input 区上方浮起）。
 */

import { ANSI } from "../ansi.js";

export interface PanelRenderer {
  /**
   * 原地重绘。把给定行写到 stdout，内部维护"上次渲染的高度"用于下次重绘。
   *
   * 不变量（后置条件）：光标位于 `(startRow + lines.length, col 0)`。
   */
  render(lines: readonly string[]): void;

  /**
   * 擦除上次渲染。光标落在 `(startRow, col 0)`，下次 render() 可从此处开始。
   *
   * 如果从未 render 过（lastRenderHeight === 0）则什么都不做。
   */
  clear(): void;

  /** 当前维护的渲染高度；测试和诊断用。 */
  readonly lastRenderHeight: number;
}

export function createPanelRenderer(
  stdout: NodeJS.WriteStream,
): PanelRenderer {
  let lastHeight = 0;

  return {
    render(lines: readonly string[]): void {
      // 前置条件：cursor 在 (startRow + lastHeight, col 0)
      // 或首次渲染时 cursor 在任意"startRow"位置（调用方决定）

      // 整帧包裹同步输出 ANSI——避免 TTY 分段刷新让 cursor 在 moveUp / clearLine
      // 之间短暂出现在中间状态，造成视觉闪烁（任何用 PanelRenderer 的 TUI 组件
      // 按键 rerender 时受益）
      stdout.write(ANSI.syncBegin);

      if (lastHeight > 0) {
        // 关键：一次性上移 lastHeight 行（不是 lastHeight - 1，见陷阱 2）
        stdout.write(ANSI.moveUp(lastHeight));
        stdout.write(ANSI.col0); // 防御式回列 0
      }

      for (const line of lines) {
        stdout.write(ANSI.col0); // 防御式回列 0
        stdout.write(ANSI.clearLine); // 清整行
        stdout.write(line); // 写新内容
        stdout.write("\r\n"); // 下一行，列 0（陷阱 1：必须 \r\n）
      }

      lastHeight = lines.length;
      stdout.write(ANSI.syncEnd);
      // 后置条件：cursor 回到 (startRow + lastHeight, col 0) ✓
    },

    clear(): void {
      if (lastHeight === 0) return;

      // 前置条件：cursor 在 (startRow + lastHeight, col 0)
      // 策略：上移到 startRow，然后用 \x1b[J 清除到屏幕末尾。
      // 这比"逐行 clearLine + moveDown + 再 moveUp N-1"简单、不容易写错。
      stdout.write(ANSI.syncBegin);
      stdout.write(ANSI.moveUp(lastHeight));
      stdout.write(ANSI.col0);
      stdout.write(ANSI.clearBelow); // 清光标到屏幕末尾的所有内容
      stdout.write(ANSI.syncEnd);

      lastHeight = 0;
      // 后置条件：cursor 在 (startRow, col 0)，下方屏幕区域已清空 ✓
    },

    get lastRenderHeight(): number {
      return lastHeight;
    },
  };
}
