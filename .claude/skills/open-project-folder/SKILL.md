---
name: open-project-folder
description: 在系统文件管理器中打开当前项目根目录(Windows 资源管理器 / macOS Finder / Linux 文件管理器)。当用户想"打开项目文件夹 / 在资源管理器里看一下 / reveal in file manager"时使用。
disable-model-invocation: true
argument-hint: [可选:要打开的目录,默认项目根]
---

# 打开项目文件夹

在系统文件管理器中打开项目根目录,供用户用 GUI 浏览文件。手动触发(`/open-project-folder`),不自动调用。

可选参数:指定要打开的目录(留空则打开项目根)。

`$ARGUMENTS`

## 执行

**运行时必须禁用命令沙箱**(Bash / PowerShell 工具设 `dangerouslyDisableSandbox: true`)。沙箱会拦截 GUI 进程,表现为命令打印"已打开"、但窗口根本到不了桌面——实测确认。

运行随技能附带的启动脚本(它自己解析路径、按平台选文件管理器,纯确定性、无需 AI 判断):

```bash
node .claude/skills/open-project-folder/open-root.mjs $ARGUMENTS
```

脚本行为:

- 目录:显式参数 → `git rev-parse --show-toplevel`(项目根)→ 当前工作目录,依次回退
- 打开器:win32 `explorer.exe` / darwin `open` / linux `xdg-open`
- 拉起方式:`detached + stdio:"ignore" + unref()`(借鉴知行 `packages/cli/src/skills/editor-resolve.ts`);**刻意不带 `windowsHide`**——explorer 是直接拉起的原生 GUI exe,windowsHide 会把窗口本身藏掉(这点与 editor-resolve 隐藏 `.cmd` 包装控制台的场景相反)

## 输出要求

- 运行后把脚本打印的"已在文件管理器中打开:<路径>"如实反馈给用户
- 若命令报错(如无图形环境的 Linux、缺少对应打开器),如实说明原因,不要反复重试
