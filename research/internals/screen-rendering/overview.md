# 屏幕渲染 (Screen Rendering)

> 知行 CLI 怎么画屏:两种屏模式、各自能力边界、alt-screen 的硬约束、踩过的滚动根因。做屏幕相关需求前先读这里。

## 承载

- `screen/screen-controller.ts` — 主 REPL 屏协调器:DECSTBM 三区、suspend/resume、resize、dispose
- `screen/scroll-region.ts` — DECSTBM 三区模型协议层:滚动区 emit、chrome 永驻
- `tui/render.ts` — Renderer:ANSI 原语、alt-screen 进出、`writeFrame` 满屏整帧
- `tui/viewport.ts` — `composeViewport`:alt-screen 全屏分区合成(固定顶 + 滚动中 + 固定底)
- alt-screen 自管屏:config-editor(`config-editor/runner.ts`)、skill editor(`skills/editor-screen.ts`)、技能管理器(`skills/manager-screen.ts`)

## 核心模型:渲染范式 + 两种屏

屏幕方案有两个正交维度:缓冲区(main buffer 走终端 scrollback / alt-screen 独占屏)、渲染范式(命令式流式 emit / 声明式状态树)。

知行的范式是**命令式 ANSI 流式 emit、不维护应用层 UI 状态**:内容直接 emit 进终端,靠 DECSTBM 实现 chrome 永驻、靠终端原生 scrollback 留历史。对照的另一类是**声明式状态树**(应用层持有完整 UI 状态、每帧从状态重画整屏)。两维度正交,渲染范式才是关键:知行的能力边界主要由「有没有状态层」决定(见「当前局限」),与缓冲区无关。

知行内部有两种屏:

**① main buffer + DECSTBM 三区模型**(home / 主 REPL):

```
Scrollback             ← region 顶滚出的内容进终端原生回卷,用户滚轮看历史
──────────── row 1
Scroll Region          ← DECSTBM [1, scrollBottom],终端原生区内自滚(welcome / 对话 / 流式)
──────────── scrollBottom
Chrome(status+input)   ← 区外、不滚、永驻屏底
──────────── viewportRows
```

启动发 `\x1b[2J\x1b[3J\x1b[1;1H`(清屏 + 清回卷 + cursor 顶),退出发 `\x1b[r\x1b[2J\x1b[1;1H`(撤滚动区 + 清屏,**保留**本次回卷历史)。

**② alt-screen 独占屏**(config-editor / skill editor 等全屏 modal):

`\x1b[?1049h` 切 alt buffer,终端**原子保管** main buffer(含 home 已绘历史);全屏独占渲染;`\x1b[?1049l` 原子恢复。两种进法:

- **suspend/resume**(如 confirmation panel):由 ScreenController 托管进退,main buffer 不动 —— 这是消除「DECSTBM clear 擦掉 home 历史」bug 的根本手段
- **自管**(config-editor / skill editor / 技能管理器):caller 自己进退 + 自管光标,返回后调 `reassertCursorHidden()` 重申隐藏

其中 skill editor 用 `composeViewport` 做分区布局(固定顶/底 + 滚动中)、`writeFrame` 满屏整帧写(末尾不带 `\n`、不触发滚动);`composeViewport` 是为分区布局新增的原语,config-editor / 技能管理器等更早的 alt-screen 屏未用它、各自渲染。

## 能力边界矩阵(知行当前实现)

下表反映知行**当前实现**、不是范式固有优劣 —— 末行那些 ❌ 在声明式状态树范式里大多能靠状态层补上(代价见「当前局限」)。

| 能力 | main buffer(home) | alt-screen 屏 |
|---|---|---|
| 滚看历史(终端原生回卷) | ✅ | ❌ alt buffer 无 scrollback |
| 隔离 home 已绘历史 | ❌ 与 home 共享一屏 | ✅ 终端原子保管,退出原样恢复 |
| 固定屏底 chrome | ✅ DECSTBM | ✅ 应用自绘 |
| 屏内滚动 | ✅ 终端原生 | ❌ 终端层(滚轮信号)+ 应用层(自持内容)两轴都缺 |
| 已绘历史重绘 / 接管 / resize 重排 | ❌ 无状态层 | ❌ 无状态层 |

## 当前局限(无状态层的代价)

知行不维护已绘内容的状态、内容 emit 进终端就撒手,带来三个硬限制 —— 做屏幕需求必须先知道:

- **已绘历史不可接管 / 重绘**:滚进 scrollback 的内容归终端管,应用无法再读、改、搬,也无法重新画回来
- **resize 不能重排历史**:只能整屏重建当前 region 那点内容;已滚进 scrollback 的历史交终端 reflow、会乱
- **alt-screen 屏内滚动做不了**:它要两轴 —— 应用自持内容按偏移重画(应用层,知行无状态层)+ 滚动输入信号(终端层,详见「约束与雷区」);两轴独立、知行都缺。补状态层也不解决滚轮信号在 alt buffer 拿不到的终端层问题

换来的(有意识的取舍、非失误):白嫖终端原生 scrollback(长对话滚轮回看、tmux / SSH copy-mode 可选历史)、chrome 永驻、省掉自己写整屏渲染引擎。代价就是上面那些没有状态层的局限。详见 `design/problems/screen-render-architecture.md`。

## 约束与雷区

- **alt buffer 无终端原生 scrollback** —— alt-screen 设计为单屏、不积累历史,内容超屏即丢,要回看只能应用自持(xterm 标准行为)
- **alt-screen 内滚动靠两条终端机制,各有硬约束**:
  - **alternate scroll mode(DECSET 1007)**:终端把 alt buffer 里的滚轮转成方向键(↑/↓)发给应用。各终端默认不一 —— Windows Terminal 已默认开(microsoft/terminal#13187 / PR#16535,约 v1.20 起),旧版及部分终端需手动开;且应用收到的是**方向键、不是真滚动事件**,语义受限
  - **SGR 鼠标上报(DECSET 1000/1002/1003 + 1006)**:应用直接收滚轮事件自己解析、更可控;但模式开着时终端持续往 tty 写 escape 序列,应用没及时消费就**泄漏进输入** —— claude-code 实测多发:#50032(跳外部编辑器期间泄漏)、#27995(滚轮误导航 prompt)、#10375(focus 报告泄漏)
  - **Windows legacy conhost 在 alt buffer 根本不把滚轮转发给应用**(openai/codex#12457)—— standalone PowerShell / Git Bash 用的就是 conhost;Windows Terminal 则正确转发。即便应用接了上报,conhost 环境下滚轮也到不了
  - → 结论:alt-screen 屏内滚动没有「开箱即跨平台稳定」的路,可靠基线只有键盘。`composeViewport` 超屏走「截断 + 折叠提示」,**不做真滚**
- **DECSTBM 跨 alt-screen 是否重置 = implementation-defined** —— 知行实测 Windows ConPTY 让它**跨 buffer 继承**(见根因档案)
- **ConPTY 对 ED(`\x1b[2J`)的处理与 xterm 标准有差异**(microsoft/terminal#2832 / PR#5683)—— 故知行清屏避开裸 `2J`、常规用 `\x1b[H\x1b[J`,首屏清回卷用 `\x1b[2J\x1b[3J` 且**顺序敏感**
- **chrome 行宽硬合约** —— 写入滚动区的行按 `\n` 切分后每段显示宽度 ≤ columns − 1,否则终端隐式 wrap → 行数错位、滚动数低估

## 根因档案:DECSTBM 跨 alt-buffer 继承 → skill editor 屏幕错乱

- **现象**:进 skill editor(alt-screen)顶部 chrome 消失、冒多余空行、内容像溢出却无滚动条、书写态鼠标选不中(内容自动上滚)
- **根因**:主 REPL 在 main buffer 设了 DECSTBM `[1, scrollBottom]`;进 alt buffer 时 ConPTY 让该滚动区**跨 buffer 继承**,alt-screen 满屏整帧写到 region 底就触发硬件滚动、把顶部滚出
- **验证**:一次性对照实验(同一帧发 / 不发 `\x1b[r` 对比)—— 不撤时顶行被滚掉、先撤则顶行归位钉死,一正一反坐实;曾误判为满宽行 DECAWM auto-wrap,实测证伪(用后即删,非常驻探针)
- **解法**:`Renderer.enterAlternateScreen()` 进 alt buffer 后立即发 `\x1b[r` 撤销继承的滚动区;**退出不反向 emit** —— ConPTY alt buffer 是 per-buffer 语义,反向会撤掉 main 的滚动区、毁掉主 REPL 的 chrome 永驻
- **关联**:认知失败面见 `postmortems/2026-05-09-screen-render-misdiagnosis.md`;修复在 `tui/render.ts` 的 `enterAlternateScreen` / `writeFrame`

## 关联指针

- 源码:`screen/screen-controller.ts`、`screen/scroll-region.ts`、`tui/render.ts`、`tui/viewport.ts`
- 设计:`design/problems/screen-render-architecture.md`(屏幕架构决策 + 同类项目对比的权威来源,渲染范式定性出处)
- postmortems:2026-05-09(屏幕渲染复读误诊)
- 外部(2026-06 官方核实):DECSET 1007 / SGR 鼠标上报 = xterm ctlseqs;alt scroll 默认开 = microsoft/terminal#13187 + PR#16535;conhost 不转发滚轮 = openai/codex#12457;SGR 泄漏 = claude-code#50032 / #27995 / #10375;ConPTY 2J 差异 = microsoft/terminal#2832 / PR#5683
