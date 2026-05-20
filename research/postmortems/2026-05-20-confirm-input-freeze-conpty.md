# 2026-05-20 · Confirmation 面板退出后输入冻结 —— Windows ConPTY raw-mode 翻转引发的 keypress 静默死锁

## 问题现象

zhixing 在 Windows 终端下，confirm 面板（无论用户按 allow / deny / Ctrl+C 取消）退出后回到主输入区，输入框对**所有按键完全无响应**——typing 没字符回显、Ctrl+C 不能中断、`Esc` 没反应、`/` 调命令也无效。只能强关终端窗口才能退出 zhixing 进程。

特征：

- 触发不分用户选择：allow / Ctrl+C / deny 任一路径退出面板后都复现
- turn 1（直接对话，LLM 没调工具→没面板）：输入正常
- turn 2（LLM 调工具→面板→面板退出）：输入冻死
- Node.js 视角看 stdin 全部正常：`isRaw=true`、`isPaused()=false`、`_readableState.flowing=true`、`listenerCount("keypress")=2`、`listenerCount("data")=2`
- 但 stdin 实际**不再 emit keypress 事件**，所有按下的键被底层吞掉

## 失败诊断轨迹

### 第 1 轮：纯代码 trace 找 listener 关系

用户报告 bug，描述场景：confirm 面板 Ctrl+C 后输入冻结。AI 立刻进入「这是 listener 引用关系问题」的假设，反复 trace：

- `stdinOwnership` 的 snapshot+remove → restore 链
- `rawModeController` 的 refcount 进退
- `typeahead.batcher` 的 OLD / NEW 引用切换
- `wrapKeypressHandler` 的 `released` 标志在不同闭包间的传递

trace 走了多层，自我得出"输入应该工作"的结论——但用户报告"还是不行"。

→ 失误：bug 现象（按键完全无响应、Ctrl+C 也死）在 Node Readable / EventEmitter 模型下找不到对应原因，AI 应该**早一步切换诊断维度到 host 层**，而不是反复 trace 代码逻辑。

### 第 2 轮：建可观测性 + 用户提供关键信号

用户主动补充信号：**「allow 路径也复现」**——直接把根因范围从「Ctrl+C 取消的特殊路径」收窄到「panel 退出共同路径」。同时用户说"`Ctrl+C 都没反应`"，提示了 stdin 全死、而不是仅特定 key 路径出问题。

按 postmortems 2026-05-07 / 2026-05-14 沉淀的方法论，AI 这时切换到「建立可观测性」：

- 扩展 `keypress-dump.ts` 加 `recordStdinSnapshot` 函数（记 isRaw / keypressListenerCount / dataListenerCount）
- 在 typeahead.suspend / resume / handleKeypress 入口、keyboard.attach / detach 各节点插 dump 调用
- 用户开 `--log` 复现一次

第 1 份日志：dump 文件在 `keyboard.detach.after-release` 之后**完全空白**，没有任何 typeahead.handleKeypress.entry。结合用户后续按 Ctrl+C 也无效→只能硬关终端，得出"末尾若干事件可能被 createWriteStream 内部 buffer 吞了"的假设。

→ 切换到 `appendFileSync` 同步写盘，重新复现。

### 第 3 轮：同步写盘后日志确认 stdin 真死

第 2 份日志：`appendFileSync` 改造让强关终端也保留全部记录。日志末尾停在 `keyboard.detach.after-release`，**之后用户敲键 / Ctrl+C 仍然零事件**。

但 stdin 的所有可观测字段都"健康"：

```
[+38550ms] keyboard.detach.after-release
  isRaw: true
  keypressListenerCount: 2
  dataListenerCount: 2
```

「listener 数对、raw 模式开、`off` 是 no-op 但 `release` 添了 1 个 → 2 个 listener 合理（B_NEW + B_orig）」——但 typing 不 emit 任何 keypress。AI 卡住。

→ 失误：到这一步 AI 仍在「我代码哪里漏了」的视角。应该早一步意识到「Node 自报健康但事件不来」=**底层 host 层异常**，不是应用代码 bug。

### 第 4 轮：加内部状态字段 + 周期轮询

继续扩观测面：

- `recordStdinSnapshot` 增加 `_readableState.flowing` 与 `isPaused()`——Node Readable 内部流动状态
- 加 500ms 周期 `stdin.periodic-poll`（unref 不阻塞退出）——bug 发生后用户不敲键的静默期也能持续 snapshot

第 3 份日志：从 `keyboard.detach.after-release` 之后整 32 秒、约 60 条周期 poll，**每条都报 `flowing=true / isPaused=false / 全部 listener 数对 / isRaw=true`**。诊断到此明确无误：

> **Node.js Readable stream 自报完全健康，但底层不再 emit keypress 事件。**

这是「可观测字段全对，但实际行为异常」——经典的 host 层（OS / 终端驱动 / Node TTY 底层实现）问题，**不在应用代码可达层**。

### 第 5 轮：识别 raw mode 翻转模式 → 命中根因

回看 confirm 面板时序：

```
1. typeahead.suspend → rawModeLease.release    refcount 1→0  setRawMode(false)
2. region.run → rawModeLease.acquire           refcount 0→1  setRawMode(true)
3. region.finish → rawModeLease.release        refcount 1→0  setRawMode(false)
4. typeahead.resume → rawModeLease.acquire     refcount 0→1  setRawMode(true)
```

——一次 confirm 面板触发 4 次 `setRawMode` 翻转，refcount 经过 `1→0→1→0→1`。Turn 1（无面板）下 refcount 始终 1、零翻转、零问题；turn 2 下走翻转轨迹、触发问题。

**Windows ConPTY 在快速 `setRawMode(false)→setRawMode(true)` 翻转时**让 keypress 字节流静默断开 —— 所有 Node 可观测字段不反映这个故障。

修复策略：让 `rawModeController` refcount 在 confirm 面板期间走 `1→2→1` 而非 `1→0→1→0→1` —— typeahead.suspend 只摘 keypress 订阅层（batcher、broker session），**保留 rawModeLease 与 stdinOwnership**；typeahead.resume 反之只装回订阅层。

修复后第 4 份日志：`typeahead.suspend.exit` 的 `isRaw=true`（之前是 false）、面板期间 polling `count=2`、面板退出后 keyboard.detach.after-release 之后用户敲 backspace **立即触发** `typeahead.handleKeypress.entry` 连续事件。根因 + 修复 + 验证一气贯通。

## 用户成本量化

- 用户复现次数：**4 次**（每次需重启 zhixing + 按完整流程触发）
- AI 占用对话轮次：从 bug 报告到根因定位 + 修复约 8 轮
- 用户主动提供的关键信号：「allow 路径也复现」「Ctrl+C 也死」——两条都把诊断范围明显收窄

**理论最低成本路径**：
- AI 第一时间识别"按键完全无响应 + Ctrl+C 也死" = host 层问题，立刻建观测 + 周期 poll
- 第 1 次复现就得到完整时间线 → 定位 ConPTY raw-mode 翻转 → 1 轮修复

**实际成本路径**：
- 第 1 轮纯 code trace 浪费时间
- 第 2 轮观测但同步写盘没立刻加（postmortem 2026-05-14 已经踩过 WriteStream buffering 坑，AI 没立即引用），用户多复现一次才发现日志末尾被 buffer 吞
- 第 3 轮加 flowing/isPaused + 周期 poll，又一次复现才拿到决定性证据
- 第 4 轮才识别 raw mode 翻转模式做修复

## AI 的认知失败分析

### 失败 1：「自报健康但行为异常」的识别延迟

诊断时序里有个清晰的转折点：第 3 份日志显示「Node 所有字段都说健康，但 stdin 不 emit」。这种信号在系统排错里有明确含义——**可观测层与实际行为脱钩**，问题在更底层（OS / 驱动 / 框架内部）而非应用代码。

AI 在此之前已经花两轮 trace 应用代码、写新观测点，但**没有从"健康字段+异常行为"这个组合直接跳到「host 层异常」结论**。下次遇到「指标全绿但功能挂」该立刻识别为 host 层信号，不再尝试在应用代码里找原因。

### 失败 2：跨 postmortem 知识没立刻调用

postmortem 2026-05-14 明文记录了两条直接相关的经验：

1. **WriteStream buffer 在 force-close 时丢末尾几条** → 诊断 cli 工具时一开始就要用同步写盘
2. **同代码在不同 host 模式下 emergent 行为漂移** → 跨模式（这里是 turn 1 无面板 vs turn 2 有面板）行为不同时优先看 host 环境差异

AI 知道这两条 postmortem 但**没在诊断第 1 轮就引用**：第一份日志才用 createWriteStream（结果被 buffer 吞了）、第 2-3 轮才意识到这是跨模式 host 问题。

→ 已有 postmortem 在硬盘上但 AI 没"读 + 应用"，等于没沉淀。下次每次开新诊断都该把 postmortems README 列表过一遍，把可能相关的几条挑出来作为诊断检查清单。

### 失败 3：refcount 共享资源设计预见性不足

`rawModeController` 用 refcount 管 shared raw mode，设计本身是对的——多 consumer 并发持有时不互相踩脚。但**没设计"sequential handoff"路径下避免 refcount 归零**——典型场景是 A 释放后 B 立刻 acquire，理论上是 `1→0→1`，应用代码视角是无害的（终态 raw mode 还是 on），但底层 host 不喜欢这种翻转。

设计 refcount 时应该考虑：**handoff 而非 release-then-acquire** —— 让多个 consumer 在重叠期共持，避免 0 transition。本次修复就是把 typeahead 的持有期延长到包住面板期间，让 region 在它之上叠加 refcount，永不归零。

## 提炼的原则（与已有 postmortems 互补）

### 原则 1：「可观测字段全绿但功能挂」= 立刻切 host 层

应用代码视角下你能看到的字段（事件数、状态机标志、引用计数、内部 flag）全部"正常"，但功能就是不工作——这是个**强信号**：问题不在你的代码逻辑里，在底层 host（OS / 终端驱动 / Node TTY / ConPTY / 平台 IO）。

应做的反射动作：

- 立刻停止在应用代码层找原因
- 列出涉及的 host 操作（setRawMode / pipe / readline 内部 / 平台特定 API）
- 优先怀疑这些 host 操作的边界行为（race / 翻转 / 平台差异）
- 不靠"再仔细看代码"——靠**对比同代码在 host 状态不同时的行为差异**

与 2026-05-09 原则 4（代码 trace 多轮无果→切换验证维度）互补：那条说"何时切换"，本条说"切换到哪个维度"。

### 原则 2：诊断开始时先扫一遍 postmortems README 的"应做"清单

每个 postmortem 末尾的"行动转化表"列了具体可应用的反射动作。诊断新 bug 时应该把这些表当**检查清单**走一遍，每一条问"现在的情况符合这个信号吗？"

具体到本次：

- 2026-05-14 行动表第 1 行"用户报'还是不行'且 AI 在让用户测之前没 build" → 不适用（本次每次都 build）
- 2026-05-14 行动表第 2 行"代码从 alt-screen 迁到 chrome inline / 同步迁到异步" → **直接命中**：turn 1 vs turn 2 是不同 host 模式（一个全程 raw on，一个有 raw 翻转）
- 2026-05-14 沉淀的"keypress-dump 同步写盘"→ **应直接套用**，不该重新踩 WriteStream buffer 坑

postmortems 是机制不是装饰。下次每篇都要在诊断开始时被"主动调用"。

### 原则 3：共享资源 refcount 必须显式设计 handoff 路径

refcount 管 shared resource 时，"两个 consumer 顺序持有同一资源" 是**普遍场景**（不只本案 typeahead → selectRegion → typeahead）。如果 refcount 在 handoff 中走 1→0→1，等于底层资源做了一次「释放 → 重新获取」，可能触发 host 层的 reset / race。

设计 shared resource 时应明确：

- **并发持有**：多 consumer 同时持，refcount > 1，handoff 自然走 1→2→1 不归零（本次修复采用）
- **传递所有权**：单 consumer 持有，handoff 时 caller 显式交接（不归零），无 owner = 关闭

不要默认"reference counting 就够了"——还要看 **handoff 是否会让 count 归零**，归零的瞬间底层资源会被"重置"，跨 consumer 的连续性不保证。

## 行动转化

| 信号 | 解读 | 应做 |
|---|---|---|
| 应用代码所有可观测字段都说"健康"但功能挂 | host 层异常（OS / 驱动 / 框架内部 / 平台特定 API） | 立刻停止 trace 应用代码，列出涉及的 host 操作并优先怀疑其边界行为 |
| Bug 在 turn 1 不复现、turn 2（多走一步）复现 | 跨模式 emergent 行为差异，host 层有状态依赖差异 | 列出 turn 1 vs turn 2 的 host 操作差异（setRawMode 调用次数 / 资源 refcount 轨迹 / 同步异步切换），逐差异问"会不会让底层进入 race" |
| 诊断开始 | 之前 postmortem 沉淀的方法论 | 扫一遍 postmortems README 的行动转化表，把命中本次 bug 的信号挑出来作为初始检查清单 |
| 共享资源 refcount 在 handoff 时归零（A 释放→B 获取） | 底层资源做了一次重置 / 重新获取 | 改设计成并发持有（refcount 不归零）或显式所有权转移；不要默认 refcount 够用 |
| 调试通道用 createWriteStream | 进程被强关 / SIGKILL 时 buffer 末尾几条丢 | 用同步 appendFileSync——cli 工具诊断模式应默认同步 |

—

**本案最终修复**：把 `typeahead.suspend` 从「释放三层资源」改成「只释放 keypress 订阅层（batcher + broker session）」，保留 `rawModeLease` 与 `stdinOwnership`。confirm 面板期间 rawModeController refcount 走 `1→2→1` 不归零，永不触发 `setRawMode(false)` → 不触发 Windows ConPTY race。

**理论最低成本路径**：用户报"按键完全无响应+Ctrl+C 也死" → AI 立刻识别 host 层问题 → 1 次复现拿日志看 raw mode 翻转 → 1 轮修复。
**实际成本路径**：4 次用户复现 + 3 次观测面扩展 + 1 轮修复定位。
