# 2026-05-14 · Confirmation 面板输入消失 —— dist 滞后 + 跨 host 模式协议漂移

## 问题现象

zhixing 的「权限请求」面板从 alt-screen 切到 chrome inline 后，用户选择「拒绝并说明原因」按 Enter 进入 input 模式，按字符**输入完全不显示**。同一个组件的 alt-screen 旧版本下输入"suanle"成功——切到 inline 路径就废了。

特征：

- ↑↓ Enter 等控制键正常工作（panel 状态正确切换）
- 字符键完全无响应（buffer 不更新、屏幕不变）
- AI 多次"修复"用户均反馈"还是不行"
- 一次"修复"后突然恢复，但 AI 不清楚是哪一次改动让它恢复

## 失败诊断轨迹

### 第 1 轮：误把 dist 滞后当作"修复无效"

AI 改了源码（去掉 `if (key)` 检查）后跑了测试 + tsc。让用户重启 zhixing 测试。**没 build**。

用户测试报"还是不行"。AI 又改了源码（onPaste 接受字符流）。再让用户测。

`packages/cli/dist/index.js` 时间戳：`19:24`。AI 源码修改：`19:34` 之后。**用户两次测试都跑的是 19:24 的旧 build**。

直到 AI 偶然 `ls -la dist/index.js` 看时间戳——才意识到所有"修复"用户从未真正测过。

→ AI 失误：cli 工具的 `dist` 是 build 产物，源码修改不会自动 reflect 到用户运行的版本。AI 默认认为"改了 .ts 就等于改了运行行为"，但**这只对 dev-tsx 模式成立，对 build-dist 模式（zhixing 的发布形态）不成立**。

### 第 2 轮：多 hypothesis 盲打 vs 早建观测

AI 在不知道字符在路径上哪里丢的情况下，提了多个 hypothesis 并依次修复，每次都让用户验证：

1. hypothesis A：`if (key) handleKeypress(str, key)` 拦截了 `key=undefined` 字符（IME 中文场景）
   - 改：去掉 `if (key)` 检查
   - 结果：用户报"还是不行"

2. hypothesis B：`onPaste: () => {}` no-op 把被 paste-detector 误识为 paste 的字符丢了
   - 改：onPaste 在 input mode 下接受字符流
   - 结果：用户报"恢复了"

→ AI 实际修对了，但**两次 hypothesis 中只有第二次是真根因**。第一次纯是猜，没实证。如果第一次就建观测（如本 postmortem 沉淀的 `--log` keypress dump 通道），1 次复现就能定位字符走了 onPaste 而非 onSingle，直接精修。

→ **更严重的元问题**：第一轮的"dist 未 build"让 hypothesis A 的有效性根本无法验证——AI 误以为 A 无效是因为 hypothesis 错，实际可能是 build 没 reflect。**hypothesis 验证回路被工程纪律污染**。

### 第 3 轮：根因不在我看的代码

修复有效后，AI 反向追根因。表面看是 `SelectOperationRegion.onPaste = no-op` 丢字符，深层是：

`selectWithInput`（旧 alt-screen 路径）在 stdout 上**同步直写** + PanelRenderer 原地重画——没有 ScreenController 任务队列。paste-detector 的 `queueMicrotask(flush)` 在每个字符的独立 macrotask 内 flush，batch=1 → onSingle。所以**同样的 onPaste no-op 在 alt-screen 模式下不暴露**。

`SelectOperationRegion`（新 chrome inline 路径）通过 `ScreenController.attachInput → refreshChrome` 走任务队列。chrome 重画涉及 emit cursor positioning + chromeBytes 同步写 stdout，**抢占 microtask**。readline 在 raw mode + Windows ConPTY 下的多 byte / ANSI 后续 byte 推送在这种 microtask 拥塞下被 paste-detector batch ≥ 2 识别为 paste → onPaste no-op 丢字符。

**相同代码在不同 host 模式下行为漂移**——这是 emergent timing 问题，单看 `SelectOperationRegion.ts` 的代码逻辑找不出 bug。

### 第 4 轮：抄邻居模仿 vs 理解协议本意

`SelectOperationRegion` 的 `onPaste: () => {}` 是从 `selectWithInput` 抄来的（"select 不支持 paste"）。但同一个 `wrapKeypressHandler` 协议下，`typeahead-input` 的 `onPaste` 实现是 `finalizePaste(content)`——**接受 paste 作为内容**。

同接口在多 client 实现不同：
- `typeahead-input.onPaste`：接受字符（finalizePaste）
- `selectWithInput.onPaste`：丢弃（no-op）

新 client（`SelectOperationRegion`）抄哪个？AI 选了 `selectWithInput` 的 no-op——因为"select 同源更像"。但 `selectWithInput` 是 alt-screen 直写模式，不会触发 chrome 队列调度问题；新 client 在 chrome inline 模式下继承了这个 no-op = 隐式契约漂移。

→ **anti-pattern**：照抄邻居的实现而不理解协议本意。`onPaste` 的真实协议是"caller 决定怎么处理同 macrotask 多 keypress 累积"——不是"select 不支持 paste"这个文案声明。当 host 环境（同步 vs 队列调度）让单字符也走 paste 时，no-op 就是 bug。

## 用户成本量化

- 用户复现 bug 次数：**4+ 次**（两次旧 dist 测试 + 至少两次新 dist 验证）
- 用户重启 zhixing 次数：≥ 4 次
- 用户严肃质疑："不行，还是无法输入" / "你定位到了吗?" / "我建议你还是定位到原因吧"
- 用户主动想到的诊断方法：明示要 keypress dump 观测通道（之前 AI 给了 hypothesis 列表但没主动建观测）
- AI 占用对话轮次：从问题出现到真根因定位 ~5 轮

**理论最低成本路径**：
- AI 第一次修复后**立即 build + 时间戳验证 + 通知用户重启** → 1 次复现验证
- AI 第一次未定位时**立即建 keypress 观测通道**（参考 2026-05-07 沉淀的 ZHIXING_RAW_DUMP 模式）→ 用户开 `--log` 复现 → AI 看日志定位 → 1 次精修

**实际成本路径**：
- 工程纪律失败（dist 滞后）耗用户 2 次测试
- 诊断纪律失败（盲改 hypothesis）耗用户 2+ 次测试
- 真正定位发生在**修复偶然命中**之后，不是"先定位再修"

## AI 的认知失败分析

### 失败 1：dist 滞后的盲区——build 产物 vs 源码修改

AI 默认假设"改了源码 = 改了运行行为"。但 zhixing 的 `bin` 指向 `dist/index.js`（tsup build 产物），用户运行的是 build 输出。

修源码 → 跑测试 → 让用户验证：**测试用的是 tsx 直接跑 .ts**，用户用的是 build 的 .js。两个验证回路完全脱节。AI 在测试侧看到"行为变化"，用户在生产侧看到的是"没变化"——AI 把这归因于 hypothesis 错误，实际是工程纪律错位。

`ls -la dist/index.js` 是 cli 工具的"reality check"——AI 在让用户测试**前**应该养成"build → 看时间戳 → 通知用户"的反射，把 build 时间戳作为修改是否真正生效的唯一权威信号。

### 失败 2：跨 host 模式的隐式行为漂移盲区

`SelectOperationRegion` 与 `selectWithInput` 共享 90% 状态机代码（甚至刻意抽离了共享 reducer）。AI 假设"同代码 = 同行为"——但 host 环境（同步直写 vs 任务队列）让相同代码在不同模式下产生 emergent 时序差异。

这种 bug 不能通过 code trace 找到——它**不在代码逻辑里**。需要：
- 意识到"代码相同但模式不同"本身是高风险信号
- 主动质疑"为什么这段代码在新模式下也能 work"，而不是默认它能
- 看 host 环境差异（同步 vs 异步 / 直写 vs 队列 / single vs batch）

### 失败 3：抄邻居 vs 理解协议本意

`wrapKeypressHandler` 的 `onPaste` 协议没明文规定"必须接受字符"还是"必须忽略"——是个 caller-decision 协议。两个既有 caller 各做了不同决定：

| Caller | onPaste 实现 | 隐式契约理解 |
|---|---|---|
| typeahead-input | finalizePaste（接受） | "paste 是合法字符流，我要" |
| selectWithInput | no-op（丢弃） | "select 不支持 paste 操作" |

新 client 抄哪个？正确做法应该是**理解协议本意**：「onPaste 是 paste-detector 把多 keypress 同 macrotask 累积识别为 paste 后调用——caller 是否接受要按自己业务语义决定」。

`SelectOperationRegion` 的 input mode 业务语义是"用户在输入文字"——任何"形如字符流的输入"都该接受，不论 readline 怎么分流。抄 selectWithInput 的 no-op 没理解到这层。

### 失败 4：robust 修复偶然命中 vs 理解为防御性设计

AI 提的 hypothesis B 修复（onPaste 接受字符流）实际上是个**好的 robust 设计**——双路径接受字符，不依赖 readline / paste-detector 分流逻辑的具体行为。

但 AI 当时给的理由是"猜测 paste-detector 误识"——是个 hypothesis，没实证。修对了不等于"hypothesis 正确"。

正确的提案理由应该是：「input mode 业务上要接受所有字符路径——无论 readline / paste-detector 怎么分流，buffer 都应该被填充。这是防御性设计，不依赖底层分流逻辑」。

→ **修复理由的对话价值**：好的 robust 修复理由比"猜中根因"更可持续——根因可能随系统演进失效，防御性原则长期适用。

## 提炼的原则（与已有 postmortems 互补，不重复）

### 原则 1：cli 工具修源码后必 build + 时间戳验证，才让用户测

`dist` 是 build 产物，源码修改不会自动生效。AI 工作流必须：

```
源码修改 → 跑测试（验证逻辑） → pnpm build → ls dist 看时间戳更新 → 通知用户
```

每次让用户重启验证前，AI 应说出 dist 时间戳（如 `dist 已 build 到 21:14`），让"用户测的版本"与"AI 改的版本"显式对齐。

**信号**：用户报"还是不行" → AI 第一反应不该是"再改一个 hypothesis"，而是"我 build 了吗？time stamp 多少？"。错误归因到 hypothesis 之前先排除工程纪律。

类似 2026-05-07 沉淀的"建可观测性"原则，本原则是"建可部署性"——确保 AI 改的能跑到用户那。

### 原则 2：同代码在不同 host 模式下行为可能漂移——主动质疑而非默认

当一段代码从一个 host 模式迁移到另一个（alt-screen → chrome inline / 同步 → 异步 / 直写 → 队列 / single → batched），AI 应该**主动质疑**该代码在新模式下是否仍 work——而不是默认它能。

具体动作：

- 列出新旧模式的 host 环境差异（任务调度、I/O 时机、stdin 流处理...）
- 对每个差异问"如果这个差异在某时序下放大，原代码会怎么样？"
- 写设计文档时显式记录"该代码依赖 host 模式的 X 假设"

代码 trace 找不到这类 bug，因为它不在代码逻辑里——在跨模块协议的 emergent timing。诊断阶段意识到"代码相同但 host 不同"是高风险信号，应优先建立"两个模式下 keypress 路径对比"的观测，而非 trace 单模块代码。

类似 2026-05-09 沉淀的"代码 trace 无果切验证维度"原则，但本原则更前置——在写代码阶段就预判 emergent risk，不等出 bug 才转维度。

### 原则 3：抄邻居前先看协议本意

同协议在多 client 实现不同时（onPaste 接受 vs 拒绝、cwd 显示 vs 隐藏、retry 重试 vs 直接失败...），新 client 不该直接抄某个邻居——必须先问：

- 该协议的**caller 决策点**是什么（接受 paste 还是丢弃，是 caller 业务语义决定）
- 邻居为什么这么决定（一是历史原因，二是该 client 的 host 环境支持这种决定）
- 我的 client 的业务语义+host 环境，决策**应该是**什么

抄邻居的隐性假设是"邻居对我也对"。但邻居可能只在自己 host 下对，迁移到新 host 就漂移。

### 原则 4：好的 robust 修复理由 ≠ "猜中根因"

修复有效不等于 hypothesis 正确。AI 提修复时应分清两种理由：

| 修复理由 | 例子 | 长期价值 |
|---|---|---|
| "我猜根因是 X，所以这样修" | "猜 paste-detector 误识，所以 onPaste 接受字符" | 低（根因可能变，且未实证） |
| "业务语义要求 Y，所以这样修是防御性设计" | "input mode 要接受所有字符路径——无论怎么分流" | 高（业务语义稳定，与底层无关） |

AI 在解释修复时应优先表达"业务语义/防御性原则"层面的理由，把"猜中根因"作为可选补充而非主因。这样修复**理由本身**可持续——根因即使后续变化（譬如未来 readline 升级、ConPTY 行为改变），防御性原则依然适用。

类似 2026-05-09 "最优架构第一原则"，但聚焦在**修复时的理由层级**——架构是设计层面的"最优"，修复理由是诊断层面的"长期可持续"。

## 行动转化

| 信号 | 解读 | 应做的 |
|---|---|---|
| 用户报"还是不行"且 AI 在让用户测之前没 build | dist 滞后，hypothesis 验证回路被工程纪律污染 | 立即 build + 看 dist 时间戳 + 通知用户精确版本 |
| 代码从 alt-screen 迁到 chrome inline / 同步迁到异步 / 直写迁到队列 | host 模式差异可能让相同代码 emergent 行为漂移 | 主动列差异 + 预测时序场景 + 优先双模式对比观测 |
| 同协议在多 client 实现不同 | 隐式契约不清，复制时易漂移 | 不抄邻居，看协议本意 + 自己业务语义决策 |
| AI 提修复理由是"我猜根因是 X" | 未实证猜测，长期不可持续 | 改提"业务语义要求 Y 的防御性设计"层面理由；猜中作为辅助佐证 |

—

**本案最终修复**：
1. `onPaste` 在 input mode 下接受字符流（防御性设计：input mode 业务上要接受所有字符路径，不依赖底层分流逻辑）
2. 长期保留 `--log` flag 启用的 `keypress-dump` 观测通道（与 llm-chunk-dump 共享 flag，统一 cli 工具诊断模式）
3. SelectOperationRegion docstring 标注"InputRegion input mode 字符必须双路径接受"协议级原则

**理论最低成本路径**：用户开 `--log` 复现 1 次 + AI 看日志 + 1 行修复 + 1 次 build。
**实际成本路径**：用户复现 4+ 次 + AI 2 次 build 滞后 + 2 次 hypothesis 盲改 + 真根因定位发生在偶然命中之后。
