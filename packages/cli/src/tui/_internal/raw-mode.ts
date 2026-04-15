/**
 * Raw mode 引用计数 —— TTY raw 模式的并发安全 lease 机制
 *
 * 问题背景：当 TUI 里有多个可能并存的 modal（比如 typeahead 面板 + confirmation
 * 弹层），每一个都需要 stdin 处于 raw 模式才能拿到字节级按键事件。如果它们各自
 * 调 `stdin.setRawMode(true/false)`，后离开的那个会意外地把 raw 模式关掉，让
 * 前一个还在等待用户输入的组件彻底失去交互能力。
 *
 * 解法（学习 Claude Code 的 `rawModeEnabledCount`）：用模块级 lease 计数。
 *
 * 语义：
 *   1. 首个 `acquire()`（0→1）：snapshot `stdin.isRaw`，再 `setRawMode(true)`
 *   2. 中间任意次 `acquire()`（n→n+1 where n>0）：只增计数，不碰 stdin
 *   3. 末次 `release()`（1→0）：restore 到最开始 snapshot 的值
 *   4. 非 TTY 流（测试中的 PassThrough）：acquire 返回 no-op lease，不增计数
 *
 * 重要改进 vs 原版：**restore 值在 0→1 转场时 snapshot，不是 per-consumer**。
 * 这样无论 lease 的 release 顺序是否严格 LIFO，最终恢复的都是"首个 acquire
 * 前终端的真实状态"，避免了"B 看到的是 A 设过的 raw=true，B 又用它做 restore
 * 值"这类潜伏 bug。
 *
 * 假设：所有 consumer 都 acquire 同一个 stdin（生产中唯一的 process.stdin）。
 * 若检测到异构 stdin 会忽略后来者的 restore 值 —— 实际不会触发这条路径。
 */

export interface RawModeLease {
  /** 释放本 lease。幂等：重复调用无效果。 */
  release(): void;
}

interface RawModeControllerInternal {
  acquire(stdin: NodeJS.ReadStream): RawModeLease;
  /** 仅供测试：当前活跃 lease 数。 */
  activeLeases(): number;
  /** 仅供测试：重置内部状态，不触碰真实 TTY。 */
  resetForTests(): void;
}

function createRawModeController(): RawModeControllerInternal {
  let leaseCount = 0;
  let originalIsRaw = false;
  let lockedStdin: NodeJS.ReadStream | null = null;

  return {
    acquire(stdin: NodeJS.ReadStream): RawModeLease {
      // 非 TTY：返回 no-op lease，不增计数，不碰 stdin
      if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
        return { release: () => {} };
      }

      if (leaseCount === 0) {
        // 0→1 转场：snapshot 原始状态 + 启用 raw
        originalIsRaw = !!(stdin as unknown as { isRaw?: boolean }).isRaw;
        lockedStdin = stdin;
        stdin.setRawMode(true);
      }
      leaseCount++;

      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          leaseCount--;
          if (leaseCount <= 0) {
            leaseCount = 0;
            // 1→0 转场：恢复到 0→1 时 snapshot 的值
            if (
              lockedStdin &&
              typeof lockedStdin.setRawMode === "function"
            ) {
              lockedStdin.setRawMode(originalIsRaw);
            }
            lockedStdin = null;
            originalIsRaw = false;
          }
        },
      };
    },

    activeLeases(): number {
      return leaseCount;
    },

    resetForTests(): void {
      leaseCount = 0;
      lockedStdin = null;
      originalIsRaw = false;
    },
  };
}

// 模块级单例 —— raw mode 是 fd 级全局状态，控制器也必须全局
export const rawModeController: RawModeControllerInternal =
  createRawModeController();
