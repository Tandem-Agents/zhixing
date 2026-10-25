# 小写盘符工作目录：同一源文件加载两份，构建过滤失效

## 现象

一次集中验证里，三件事同时出错：
- 过滤 terminal-ui 的全量构建，却去构建了 terminal-ui，因缺 bun 失败；
- 此前全部通过的存储用例，在真实刷盘模式下有十余例报“expected XxxError … to be an instance of XxxError”；
- 受影响文件里一批协议运行时用例超时。

代码相对上一次全绿的运行没有相关改动。

## 原因

工具会话把 shell 的工作目录重置成了小写盘符形式（`e:\repo`，而不是 `E:\repo`），之后的 `cd` 没有改变 Windows 记录的盘符大小写。于是：
- pnpm 输出 “No projects matched the filters "e:\repo" in "E:\repo"”，过滤落空，转而执行根包的 build 脚本（`pnpm -r run build`，不带过滤）。
- 测试运行器的模块标识区分大小写。同一个源文件经由 `e:\…` 与 `E:\…` 两种路径各加载一份，错误类有两个身份，`instanceof` 判定失败。同一次运行里的那批协议运行时超时，在修正工作目录后重跑时只剩问题台账里已有的一例，其余都随之消失。

## 诊断要点

- 先看构建日志的第一行异常，不要从测试失败倒推：pnpm 的 “No projects matched the filters” 已经直接指向工作目录。
- “X 不是 X 的实例”而类名相同，优先怀疑模块重复加载（路径大小写、符号链接、两份副本），不要怀疑业务代码。

## 做法

- 昂贵验证（全量构建加重测试）开始前，用一个只打印 `process.cwd()` 的脚本核对盘符，不是预期形式就中止整条链。不要依赖 `pwd`（MSYS 显示的路径与 node 看到的可能不同）。
- 链式验证里，构建失败之后不再继续跑测试：失败构建可能清掉了部分产物，后面的结果都不可用。
- 本机没有 bun：全量构建用 `pnpm release:version:check && pnpm -r --filter '!@zhixing/terminal-ui' --filter '!zhixing' run build`，日志开头应是 “Scope: 17 of 19 workspace projects”。根脚本 `pnpm build` 不带过滤，会去构建 terminal-ui 并报 `spawn bun ENOENT`，与工作目录无关，但现象相同，先看 Scope 行区分。
- 这次失败的运行整体作废、单独归档，不从里面挑“看起来通过”的部分。
