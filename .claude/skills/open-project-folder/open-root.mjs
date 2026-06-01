#!/usr/bin/env node
/**
 * 在系统文件管理器中打开项目根目录 —— 跨平台。
 *
 * 拉起手法借鉴 packages/cli/src/skills/editor-resolve.ts 的 detached + stdio:"ignore" + unref(),
 * 但刻意**不带 windowsHide**:editor-resolve 用它隐藏 .cmd / .bat 包装的临时控制台;这里是直接
 * 拉原生 GUI exe(explorer 等),windowsHide 会把窗口本身一起藏掉(实测确认)。
 *
 * 注意:被沙箱化的命令上下文会拦住 GUI 窗口,本脚本须在禁用沙箱时运行(见 SKILL.md)。
 *
 * 纯确定性、不放 AI:目录与打开器的选择没有判断空间。
 */
import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";

/** 项目根:显式参数 → git 顶层目录 → 当前工作目录,依次回退。 */
function resolveRoot() {
  const explicit = process.argv[2];
  if (explicit?.trim()) return resolve(explicit.trim());
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) return resolve(top); // resolve() 把 git 的正斜杠路径在 win32 归一成反斜杠,免得 explorer 误判
  } catch {
    // 非 git 仓库 / 没装 git —— 退回工作目录。
  }
  return process.cwd();
}

/** 按平台选文件管理器命令。 */
function opener(platform) {
  if (platform === "win32") return "explorer.exe";
  if (platform === "darwin") return "open";
  return "xdg-open";
}

const root = resolveRoot();
const child = spawn(opener(process.platform), [root], {
  detached: true,
  stdio: "ignore",
  // 刻意不带 windowsHide:explorer 是直接拉起的原生 GUI exe,会遵守 windowsHide 传入的
  // SW_HIDE 把文件管理器窗口本身也藏掉(实测确认)。windowsHide 只在隐藏 .cmd / .bat
  // 包装的临时控制台时才有用(见 editor-resolve.ts);这里没有包装、也没有控制台要藏。
});
child.unref(); // 不阻塞:拉起即返回,父进程随即退出
console.log(`已在文件管理器中打开:${root}`);
