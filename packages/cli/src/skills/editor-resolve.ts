/**
 * 外部编辑器解析 + 无闪拉起 —— AI 编辑屏的"逃生口":用户想用自己的 GUI 编辑器改草稿时,
 * 把草稿文件交给它打开。**纯确定性、不放 AI**(选哪个编辑器、怎么拉起没有任何判断空间)。
 *
 * 解析是优先级链(高→低):用户显式配置 → $VISUAL → $EDITOR → git core.editor →
 * 在 PATH 上探测已知编辑器 → OS 兜底。探测与 spawn 都注入,故解析链可纯逻辑单测、不碰真
 * 进程。命中 OS 兜底时 caller 应提示用户固定设一个,避免每次落到记事本 / vi。
 *
 * 不等编辑器关闭(不加 `--wait`):拉起即返回,GUI 在自己窗口里改,AI 编辑屏的 alt-screen
 * 不受影响;用户改完回屏,下一次交互按 mtime 比对一次性重读 —— 比持续 watch / 双向同步
 * 轻且稳。无闪靠 `windowsHide`(等价 .NET CreateNoWindow):`.cmd` / `.bat` 包装(如
 * `code.cmd`)直接拉会闪一个临时控制台,无窗口启动 + detached 规避。
 */

import { spawn } from "node:child_process";

/** 解析输入(全部注入,可测)。空串视为未设置。 */
export interface EditorResolveEnv {
  /** 用户显式配置的技能编辑器(类 git `core.editor`);最高优先。 */
  configured?: string;
  /** `$VISUAL`。 */
  visual?: string;
  /** `$EDITOR`。 */
  editor?: string;
  /** `git config core.editor` 的值(由 caller 取,注入)。 */
  gitEditor?: string;
  platform: NodeJS.Platform;
  /** 在 PATH 上探测命令是否存在 → 可执行路径或 null(注入,可 mock;实参走 which / where)。 */
  probe: (command: string) => string | null;
}

export interface ResolvedEditor {
  /** spawn 的程序(命令名或已探测到的绝对路径)。 */
  command: string;
  /** 固定参数(不含待打开的文件路径)。 */
  baseArgs: string[];
  source: "configured" | "visual" | "editor" | "git" | "probe" | "os-default";
}

/** 按偏好顺序探测的已知编辑器 —— GUI 优先(逃生口的本意是"用我顺手的编辑器")。 */
const KNOWN_EDITORS = ["code", "cursor", "subl", "idea", "zed", "nvim", "vim"];

/** 把配置串(可能带参数,如 `code --wait`)切成命令 + 参数。路径含空格的需用户自行不留空格 / 用包装名。 */
function parseCommand(
  value: string,
  source: ResolvedEditor["source"],
): ResolvedEditor {
  const parts = value.trim().split(/\s+/);
  return { command: parts[0] ?? value.trim(), baseArgs: parts.slice(1), source };
}

/** OS 兜底:都没命中时按平台给一个一定能用的编辑器。 */
function osDefault(platform: NodeJS.Platform): ResolvedEditor {
  if (platform === "win32") {
    return { command: "notepad", baseArgs: [], source: "os-default" };
  }
  if (platform === "darwin") {
    // `open -t` 用系统默认文本编辑器打开,不依赖具体安装。
    return { command: "open", baseArgs: ["-t"], source: "os-default" };
  }
  return { command: "nano", baseArgs: [], source: "os-default" };
}

/** 解析出该用哪个编辑器。总返回一个结果(最差落到 OS 兜底)。 */
export function resolveEditor(env: EditorResolveEnv): ResolvedEditor {
  const explicit: Array<[string | undefined, ResolvedEditor["source"]]> = [
    [env.configured, "configured"],
    [env.visual, "visual"],
    [env.editor, "editor"],
    [env.gitEditor, "git"],
  ];
  for (const [value, source] of explicit) {
    if (value && value.trim()) return parseCommand(value, source);
  }
  for (const name of KNOWN_EDITORS) {
    const found = env.probe(name);
    if (found) return { command: found, baseArgs: [], source: "probe" };
  }
  return osDefault(env.platform);
}

/** spawn 抽象 —— 注入以便单测断言调用、不拉真编辑器。 */
export type EditorSpawn = (command: string, args: string[]) => void;

const defaultSpawn: EditorSpawn = (command, args) => {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    // 无窗口启动:.cmd / .bat 包装直接拉会闪控制台,等价 .NET CreateNoWindow。
    windowsHide: true,
  });
  // 不阻塞、不等关闭 —— 回屏靠 mtime 比对重读,而非等子进程退出。
  child.unref();
};

/** 用解析到的编辑器打开文件(拉起即返回)。 */
export function openInEditor(
  file: string,
  resolved: ResolvedEditor,
  spawnFn: EditorSpawn = defaultSpawn,
): void {
  spawnFn(resolved.command, [...resolved.baseArgs, file]);
}
