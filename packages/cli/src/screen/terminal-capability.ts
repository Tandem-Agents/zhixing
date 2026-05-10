/**
 * 启动期终端能力检测——一次性 fail-fast 探测，不写任何字节到 stdout。
 *
 * 检测维度：
 *   - `process.stdout.isTTY` 必须为 true（管道 / 重定向 / 测试无 TTY 视为不支持）
 *   - `TERM !== "dumb"`（dumb 终端不支持 ANSI 转义序列）
 *   - Windows: kernel build ≥ 17134（Win10 1803，ConPTY 稳定基线）
 *   - viewport rows / cols：从 stdout 读，不可读时 fallback 到经典 VT100 24×80
 *   - tmux 嵌套：`TMUX` env 存在则标记，调用方用此值做 tmux 路径单独诊断
 *
 * 不做的事：
 *   - 不发 `\x1b[6n` cursor query：需 stdin raw mode 协调，复杂；启动期纯静态
 *     检测够用
 *   - 不写任何字节：保持纯探测语义；fail-fast 提示由 caller 自行 emit
 *   - 不维护 fallback 路径：检测失败 → caller 决策（log 后退出 / 降级到 stdout
 *     writer 模式）
 *
 * 设计契约：
 *   - 返回 Result 对象（ok 分支 + err 分支）而非 throw——caller 可在测试中
 *     注入各种边界场景；便于纯函数式测试
 *   - 全部依赖（stdout / env / platform / osRelease）通过 `DetectionContext`
 *     可注入；默认从 process / os 读
 */

import * as os from "node:os";

/** 终端能力探测结果——成功路径返回的能力描述 */
export interface TerminalCapability {
  /** 终端 viewport 当前行列数；stdout 不可读时为 fallback (24, 80) */
  readonly viewport: {
    readonly rows: number;
    readonly cols: number;
  };
  /** 当前平台——caller 用于平台特定逻辑（如 Windows ConPTY 边缘行为） */
  readonly platform: NodeJS.Platform;
  /** 是否在 tmux 嵌套环境内运行——caller 用于 tmux 特定 bug 诊断路径 */
  readonly tmux: boolean;
}

/** 探测结果——成功 / 失败二选一；失败附 reason 供 caller 决策与日志 */
export type TerminalCapabilityResult =
  | { readonly ok: true; readonly capability: TerminalCapability }
  | { readonly ok: false; readonly reason: string };

/** 探测时可注入的依赖——默认从 process / os 读，测试时可全部 mock */
export interface DetectionContext {
  readonly stdout?: NodeJS.WriteStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** Windows 版本号，形如 "10.0.22631"；测试时可 mock 任意字串 */
  readonly osRelease?: string;
}

/** stdout 不可读时的兜底 viewport——经典 VT100 行高，几乎所有现代终端都不低于此 */
const FALLBACK_ROWS = 24;
const FALLBACK_COLS = 80;

/**
 * Windows 10 1803 (build 17134) ConPTY 稳定基线。
 *
 * 早于此基线的 conhost 对 ANSI 转义序列 / DECSTBM 支持不稳定（部分序列被
 * 当字面字符显示），按 fail-fast 处理。1803+ 已是 2018-04 发布，覆盖目标
 * 用户群之外的 Windows 用户已极少。
 */
const WIN_MIN_BUILD = 17134;

/** Windows kernel 版本字串解析为 build number；非 "10.0.X" 形式返回 null */
function parseWindowsBuild(release: string): number | null {
  const match = release.match(/^10\.0\.(\d+)/);
  if (!match) return null;
  const build = parseInt(match[1]!, 10);
  return Number.isFinite(build) ? build : null;
}

/**
 * 探测当前终端是否满足 zhixing screen 子系统的运行前提。
 *
 * 用例：cli REPL 启动期调用一次；ok 路径取 capability 配置 ScreenController；
 * !ok 路径让 caller log reason 后决定降级或退出。
 */
export function detectTerminalCapability(
  context: DetectionContext = {},
): TerminalCapabilityResult {
  const stdout = context.stdout ?? process.stdout;
  const env = context.env ?? process.env;
  const platform = context.platform ?? process.platform;
  const osRelease = context.osRelease ?? os.release();

  if (!stdout.isTTY) {
    return {
      ok: false,
      reason:
        "stdout 不是 TTY（被管道 / 重定向 / 在非交互环境运行）——screen 子系统需直连终端",
    };
  }

  const term = env.TERM;
  if (term === "dumb") {
    return {
      ok: false,
      reason: "TERM=dumb 表示终端不支持 ANSI 转义序列",
    };
  }

  if (platform === "win32") {
    const build = parseWindowsBuild(osRelease);
    if (build === null) {
      return {
        ok: false,
        reason: `Windows 版本 "${osRelease}" 不可识别——需 Windows 10 build ≥ ${WIN_MIN_BUILD} (1803, ConPTY 稳定基线)`,
      };
    }
    if (build < WIN_MIN_BUILD) {
      return {
        ok: false,
        reason: `Windows build ${build} 早于支持基线 ${WIN_MIN_BUILD} (1803, ConPTY 稳定基线)`,
      };
    }
  }

  const rows =
    typeof stdout.rows === "number" && stdout.rows > 0
      ? stdout.rows
      : FALLBACK_ROWS;
  const cols =
    typeof stdout.columns === "number" && stdout.columns > 0
      ? stdout.columns
      : FALLBACK_COLS;

  return {
    ok: true,
    capability: {
      viewport: { rows, cols },
      platform,
      tmux: env.TMUX !== undefined,
    },
  };
}
