/**
 * 屏幕协调器——cli 交互模式下所有写到屏幕的逻辑必须经此协调。
 *
 * 三区屏幕模型（DECSTBM-based，main buffer 模式）：
 *   ┌──────────────────────────┐
 *   │ Scrollback               │ region 顶部滚动自然进入；用户可向上滚回看历史
 *   ├──────────────────────────┤  ← row 1
 *   │ Scroll Region (DECSTBM)  │ 终端原生区域内自滚
 *   │  ─ welcome / 用户消息    │
 *   │  ─ AI 流式输出           │
 *   │  ─ Replaceable segment   │
 *   ├──────────────────────────┤  ← scrollBottom
 *   │ Chrome (status + input)  │ 区域外、不参与 region 滚动
 *   └──────────────────────────┘  ← viewportRows
 *
 * 启动协议（pre-attach 缓冲 + 首次 attach 清 scrollback + 清屏 + flush）：
 *   - 构造期不立即启动 ScrollRegion——shell prompt 之上的历史保留显示
 *   - caller 早期 cliWriter.line(welcome) / setStatusBar 调用累积在 ScreenController
 *     内部缓冲——pre-attach 期间不直写 stdout，避免覆盖 shell history
 *   - typeahead-input.start() 触发 attachInput 时：emit `\x1b[3J\x1b[2J\x1b[1;1H`
 *     （清 scrollback + 清 viewport + cursor 顶）+ DECSTBM 启动 + emit chrome
 *     字节 + 一次性写出缓冲内容 + 定位 input cursor。viewport 与 scrollback **完全
 *     干净**，zhixing 拿到一张白纸开始 session（详见 ANSI_FIRSTATTACH_SEQUENCE
 *     常量 docstring "为什么清 scrollback" 段）
 *   - 之后所有写入实时转发 ScrollRegion，chrome 永驻语义由 DECSTBM 原生保证；
 *     被 DECSTBM 滚出 region 顶的内容自然进 scrollback，用户运行时可向上滚回看
 *
 * 退出协议（dispose 三态）：
 *   - ① attached=true → ScrollRegion 仍持有 region。shutdown 内 emit 完整退出
 *      序列（撤 DECSTBM + \x1b[2J 整屏清 + cursor 顶）+ 重置内部状态字段。
 *   - ② attached=false && everAttached=true → 已被 detachInput 撤过 DECSTBM 但
 *      仅清 chromeHeight 行（不整屏清），viewport 顶 region 内容仍残留 →
 *      ScreenController 层补整屏清。这是 ctrl+c 路径常见情况：inputController.stop()
 *      触发 detachInput 后，dispose 接力补整屏清让 shell 拿到干净 viewport。
 *   - ③ everAttached=false → 从未接管屏幕（pre-attach 误调 dispose），不写任何字节
 *      保护 shell 原状。
 *
 * 异常路径（uncaught exception / SIGTERM）由 `process.on("exit")` 钩子兜底
 * （见 repl.ts），Node.js exit 事件除 SIGKILL 外都会触发。
 *
 * ─── 设计取舍：main buffer 模式 vs alt screen 模式 ───
 *
 * 业界两派：
 *   - main buffer 派：Claude Code classic（默认）/ Aider / Open Interpreter / **zhixing**
 *   - alt screen 派：OpenCode (Bubble Tea) / Codex CLI (Ratatui) / vim / htop / lazygit
 *
 * zhixing 选 main buffer 派的理由：
 *   - **滚看历史是高频刚需**：用户在长对话中需要向上滚动看早期对话内容，
 *     alt screen 模式下 region 滚出去内容直接消失（alt buffer 不支持 scrollback），
 *     用户每天都受影响 —— 远比"退出干净"重要
 *   - tmux/screen copy mode 能选 zhixing 历史（远程 SSH 开发场景刚需）
 *   - DECSTBM 钉 chrome 在 viewport 底，每帧 chrome 写入只覆盖 chromeHeight 行，
 *     不会每帧把 chrome 推进 scrollback（Claude Code classic #11260 的痛点 zhixing 没有）
 *   - config-editor 等 caller 自管的 alt screen 切换不冲突（zhixing 主体在 main buffer）
 *
 * 已知 trade-off：
 *   - **退出后 scrollback 残留本次 zhixing 内容**：用户 ctrl+c 退出后向上滚仍能
 *     看到本次 session 的对话历史 + chrome 边框（绝大多数桌面 / SSH 用户都接受
 *     —— 看历史比退出干净更重要）
 *   - 不像 vim / htop 那样"完全恢复 shell 启动前状态"
 *   - 下次 zhixing 启动时 ANSI_FIRSTATTACH_SEQUENCE 的 `\x1b[3J` 清掉 scrollback，
 *     **包括用户启动前 shell 跑过命令的视觉残留**（cd / ls / git 等命令输出）。
 *     这是为了让进入 zhixing 后向上滚只看到本次 session 内容、不被 shell 噪音
 *     干扰；PSReadLine / bash readline 维护的命令历史功能（按 ↑ 调出）不受影响
 *
 * 何时需要切换到 alt screen 模式：
 *   - zhixing 重写为"声明式重画"模型并实现内部 viewport scroll（vim 那种 Ctrl-b/Ctrl-f
 *     的内部滚动）—— 此时滚看历史能力由 zhixing 自己实现，不依赖 terminal scrollback
 *   - 用户群转向"轻交互快速退出"场景为主（不再需要长对话回看）
 *
 * 切换步骤（如果未来要切到 alt screen）：
 *   1. `firstAttach` 内 `ANSI_FIRSTATTACH_SEQUENCE` 改为 `"\x1b[?1049h\x1b[1;1H"`
 *      （alt buffer 进入后无 scrollback 概念，`\x1b[3J` 失效，干脆不要）
 *   2. `dispose` 三态内的 `ANSI_DISPOSE_SEQUENCE` emit 改为 `"\x1b[?1049l"`
 *   3. `ScrollRegion.shutdown` 改为仅 emit `"\x1b[r"`（撤 DECSTBM，main buffer
 *      恢复由 ScreenController 层 `\x1b[?1049l` 完成）
 *   4. 必须先实现 zhixing 内部 viewport scroll 机制，否则用户无法滚看历史
 *   5. 测试断言对应调整
 *
 * ─── 硬件光标可见性 SoT（单源真相） ───
 *
 *   chrome 模式下硬件光标**永久隐藏**——输入光标由 InputController.computeRender
 *   通过 input-layout.ts 在 cursorRow 上画 reverse SGR 视觉光标承担。这是消除
 *   "输出区底行光标 + 输入光标随 LLM 输出 chunk 闪烁"双现象的根本架构。
 *
 *   生命周期 emit 点（ScreenController 唯一管理处，其他位置不得直接发 \x1b[?25l/h）：
 *     - firstAttach 末尾 emit hideCursor —— chrome 模式建立
 *     - detachInput 内 emit showCursor —— chrome 模式终止，shell 接管
 *     - resume 末尾 emit hideCursor —— modal 退出后重新断言 chrome 不变量
 *     - dispose 内 emit showCursor —— 进程退出前最终恢复
 *
 *   modal alt UI（config-editor 等 alt-screen 独占屏组件）仍可自由 emit hideCursor /
 *   showCursor 作为局部装饰——它们在 suspend/resume 之间运行，resume 兜底重隐藏，
 *   不产生协议冲突。
 *
 *   repaintInputCursor 仍 emit cursor 定位序列（\x1b[r;cH），目的是维护 logical
 *   cursor position 不变量供 screen reader / accessibility 工具追踪；在硬件光标
 *   隐藏状态下视觉无副作用。
 *
 * ─── 行宽硬合约（caller 端保证） ───
 *
 *   送入 writeScrollLine / withScrollWrite / segment.replace / segment.commit 的字符串
 *   按 \n 切分后每段显示宽度 ≤ columns - 1。违反 → 终端隐式 wrap → 物理行数 >
 *   逻辑行数 → segment 位置漂移、滚动数低估。block-renderer / TextStream / wrapAnsiLine
 *   已在 caller 端落地此合约。
 *
 * ─── Alt UI 嵌入协议（chrome 末尾让位） ───
 *
 *   confirmation panel 等 modal alt UI 通过 suspend / resume 进入；suspend 撤
 *   DECSTBM + 擦 chrome 让 alt UI 在 chrome 区直写 stdout；alt UI 退出 caller
 *   调 resume 重设 DECSTBM + 重画 chrome。alt-screen 切换（config-editor）由
 *   caller 自管，与 suspend 协议正交 —— main buffer 模式下 caller 自管 alt screen
 *   不影响 zhixing 主体视图（main buffer 不动）。
 *
 * ─── 串行化语义（保留 enqueue 队列） ───
 *
 *   所有写入路径（attachInput / setStatusBar / writeScrollLine / withScrollWrite /
 *   segment 操作）入队 FIFO 执行；suspend 期间任务暂存等 resume 后 flush。这
 *   保证视觉操作的原子性（避免与异步 spinner / scheduler notify 交错）。
 */

import {
  ScrollRegion,
  type SegmentHandle,
} from "./scroll-region.js";
import type { TerminalCapability } from "./terminal-capability.js";
import { ANSI, clampLine, layout, tone } from "../tui/index.js";

export interface InputRegion {
  /**
   * 渲染当前输入区为字符串数组（逐行，不含末尾 \n）。
   * 包含完整 chrome（边框 + 内 padding）、buffer 文本、可选 panel 行。
   */
  renderLines(): readonly string[];

  /**
   * 光标在 renderLines() 数组中的位置——row 0-based 行偏移，col 0-based 显示列。
   * caller 不需要写 ANSI 移动光标，由 ScreenController 内部移动。
   */
  cursorPosition(): { row: number; col: number };
}

/**
 * 可替换尾段——begin 后流式期反复 replace 整段、commit 时一次替换 + 关闭。
 *
 * 用例：LLM 流式 code block / list 的双态渲染——流式期 dim 字面占位、闭合时
 * 整段替换为语法高亮版。begin 必与 commit/close 配对调用，单一活跃 segment
 * （不可嵌套）。
 *
 * 长 block 视觉契约：流式期 segment 行数超 region 容量时由 ScrollRegion 自然
 * 触发 partial commit——已 partial 推进 scrollback 的部分保留流式期 dim 字面，
 * commit/replace 仅替换 segment 当前持有的尾部行。已知行为：极长 block 在
 * 用户回滚 scrollback 时呈"上 dim 字面 + 下高亮"撕裂——viewport 内体验最优。
 */
export interface ReplaceableSegmentHandle {
  /**
   * 替换 segment 当前持有的内容为 newText——流式期反复调用，不关闭 segment。
   *
   * 行宽合约：newText 按 \n 切分后每段 ≤ columns - 1（caller 负责）。
   * close/commit 后调用 no-op。
   */
  replace(newText: string): void;

  /**
   * 用 newText 替换当前内容并关闭 segment——闭合一次性切换（流式期 dim →
   * 闭合期 highlight 即此调用）。等同 replace(newText) + close()。关闭后
   * handle 失效，后续 replace/commit/close 都 no-op。
   */
  commit(newText: string): void;

  /**
   * 关闭 segment 不替换内容——保留当前内容转 immutable。退化路径（如不触发
   * 流式渲染时直接关闭，留下 segment 期间已 append 的内容作历史）。
   */
  close(): void;
}

export interface ScreenController {
  /** 注册唯一活跃输入区。重复 attach 会替换旧的并立刻重画。 */
  attachInput(region: InputRegion): void;
  /** 卸载输入区——擦除状态条 + 输入区屏幕痕迹，状态条状态也清空。 */
  detachInput(): void;
  /** 设置状态条内容；null / 空数组 = 隐藏状态条。 */
  setStatusBar(lines: readonly string[] | null): void;
  /**
   * 设置/移除状态行尾部一个独立段 —— 多 source 协议。
   *
   * 协议：
   *   - 每个 source（task / context / 未来扩展）用稳定的 id 独占一段，
   *     多个段按**首次注册顺序**保序拼接，段之间由 chrome 绘制 `│` 分隔符。
   *   - 同 id 重复 set 是更新（位置不变），不会重新进入末尾。
   *   - text=null / 空字符串 → 移除该 id 的段；其他段不受影响。
   *
   * 渲染规则（chrome 协议）：
   *   - statusLines 非空 + 任一 tail 段非空 → 段集合拼到第一行末尾
   *   - statusLines 空 + 任一 tail 段非空 → 段集合独立成行（加 contentPrefix 与全局对齐）
   *   - 所有 tail 段为空 → 不渲染 tail
   *
   * 行末超长由 chrome 行宽 clamp 自然截断。
   *
   * 已知 id 集合：见 `screen/status-tail-ids.ts` 的 `STATUS_TAIL_IDS` 注册表
   * （单一命名权威 —— 调用方必须引用常量，禁止直接写字符串字面量）。
   */
  setStatusTail(id: string, text: string | null): void;
  /**
   * 写到滚动区——caller 通过 fn 接收的 write 函数追加内容。
   *
   * 内容直接写入 region 末尾（流式 chunk 接续语义）；多次 withScrollWrite 调用
   * 按顺序追加。chunk 末尾不带 \n 时下次写入接续到末尾行；带 \n 时末尾换行后
   * 下次写入新起一行。
   */
  withScrollWrite(fn: (write: (chunk: string) => void) => void): void;
  /**
   * 写入一段独立内容——保证起新行起手。
   *
   * 与 withScrollWrite 区别：后者是流式接续语义（chunk 直接追加到 region 末），
   * 本方法是独立段语义——若 cursor 当前在行接续中（非新行起首），先补 \n 切到
   * 新行再写 text，确保异步段（slash 命令输出 / 完成态卡片 / scheduler 通知 /
   * retry 警告等）不会与正在进行的流式 chunk 粘连成同一行。
   *
   * text 自动确保末尾 \n 落地；空字符串等价"写一空行"。
   */
  writeScrollLine(text: string): void;
  /** 触发输入区重画——用于按键后 buffer / panel 变化通知屏幕刷新。 */
  requestInputRepaint(): void;

  /**
   * 段间空行幂等保证——caller 在"新段开始前"调用，确保 scroll 区上方至少 1 行
   * 空行作为段间视觉间距。已有空行（trailingBlankRows ≥ 1）时 no-op；无空行
   * 时补足；cursor 处于行中段时先收口再补。
   *
   * 设计意图：项目内存在隐含契约"每段负责自己段后空行"，但 LLM 输出段（mdStream
   * 的 closeParagraphStream）只 emit 单 `\n`、不加段后空行；导致"LLM → user echo"
   * 之间无视觉间距（典型现象：home 模式输入 /cle 回车后 chrome 上方无空行直接
   * 紧贴 LLM 末尾消息）。本 API 把"段前空行确保"作为 caller 端的幂等工具，
   * 不依赖上一段类型自报，靠 ScrollRegion 的视觉行级 tail state（currentRowHasVisible
   * + trailingBlankRows）作事实源决定补几个 `\n`。
   *
   * 调用方典型场景：用户消息 echo 入口（`echoSubmittedDraft`）。未来若有其他
   * "段入口"（外部 channel 消息推入 scrollback 等）需要相同语义可直接复用。
   *
   * 不动 chrome；不动 segment 状态；不触发 panel 重画。
   */
  ensureScrollLeadingBlank(): void;

  /**
   * 开启可替换尾段——流式期反复 replace、闭合时 commit。
   *
   * 同步返回 handle；内部 begin task enqueue 到队列，按 cli writer 现有的
   * 异步任务序列与 replace/commit/close 顺序执行。单一活跃 segment 约束：
   * 当前已有活跃 segment 时再 begin 抛错（caller bug，不可嵌套）。
   *
   * disposed 状态调用抛错。
   */
  beginReplaceableSegment(): ReplaceableSegmentHandle;

  /**
   * 暂停 chrome 协调——modal alt UI（confirmation panel 等）进入前调用，切到
   * 终端 alternate screen buffer 让 alt UI 独占整屏渲染。
   *
   * 协议：emit `\x1b[?1049h` 切到 alt buffer——终端**原子保存** main buffer 整体
   * （viewport 内容 + scrollback + cursor）。alt UI 在 alt buffer 自由渲染、不
   * 影响 main buffer 的对话历史；resume 时 `\x1b[?1049l` 原子恢复 main buffer。
   *
   * 与"手工 DECSTBM clear + 恢复"协议的对比：alt-screen 由终端保管 main buffer
   * 状态——无 region 可视区内容丢失风险（未自然滚入 scrollback 的对话历史在 alt
   * UI 退出后完整恢复）；DECSTBM clear 路径会 destructive 擦除 region 可视区，
   * 是历史 bug 来源（home 页触发 modal 后历史消失）。
   *
   * 必须与 resume() 成对调用。重复 suspend 抛错（不可重入）。disposed 后
   * 调用抛错。
   */
  suspend(): void;

  /**
   * 恢复 chrome 协调——alt UI 退出后调用。emit `\x1b[?1049l` 切回 main buffer，
   * 终端原子恢复 viewport 内容 / scrollback / cursor / DECSTBM 状态。
   *
   * 防御性 refreshChrome：(1) DECSTBM 跨 alt-screen 是 implementation-defined 是
   * 否随 buffer 保存——re-emit 兜底；(2) suspend 期间累积的 queue 任务可能
   * 改变内部状态（如 setStatusBar），refreshChrome 把最新状态画到（已被终端
   * 恢复的）chrome——idempotent 重画或反映新状态。
   *
   * 必须 suspend 之后调用。disposed 后调用抛错。
   */
  resume(): void;

  /**
   * 订阅 suspended 状态变化——返回 unsubscribe。
   *
   * 仅在状态实际翻转时触发回调；订阅时不立即触发，订阅者自行处理初始状态
   * （默认 suspended=false）。
   *
   * 用例：status-bar / 任何持有周期写屏行为的模块订阅此信号，suspended 期间
   * 停止周期任务避免无效计算 + 队列累积。
   */
  onSuspendChange(listener: (suspended: boolean) => void): () => void;

  /**
   * 设置告别块文本 —— dispose 时在退出清屏序列之后 emit 到 main buffer，
   * 作为 zhixing session 的临别 UI（典型形态：品牌锚 + 对话 ID）。
   *
   * 协议：
   *   - **同步设值不入队**：告别块是"未来 dispose 时读取"的 state，不立即 emit
   *     （chrome 还在显示时 emit 会污染屏幕）；dispose 同步读 + emit
   *   - **多次调用以最后一次为准**：后调用覆盖前调用，与 setStatusBar / setStatusTail
   *     同语义
   *   - **null = 清除**：取消已设置的告别块（如用户取消退出场景）
   *   - **必须在 dispose 之前调**：dispose 后调用无效（disposed flag 短路）
   *   - **caller 渲染好字符串**：与 setStatusBar(lines) / setStatusTail(id, text)
   *     同模式，caller 负责完整渲染（含换行 / ANSI 颜色），ScreenController 只负责
   *     emit 时机；UI 改样式 = 改 caller 渲染函数，本协议层零感知
   *
   * 边界（caller 应处理）：
   *   - 仅在 `everAttached=true` 时实际 emit —— pre-attach 路径 dispose 不写任何
   *     字节（与"保护 shell 原状"原则一致），farewell 也跳过
   *   - 异常退出 / runOnce 单次模式 / serve daemon → caller 不调 setFarewell
   *     即可（默认无告别块）
   */
  setFarewell(text: string | null): void;

  /** 释放：撤 DECSTBM + cursor 回 viewport 底，停止接受新写入。 */
  dispose(): void;
}

interface ScreenControllerOptions {
  /** 终端能力探测结果——caller 在构造前调用 detectTerminalCapability 获得 */
  readonly capability: TerminalCapability;
  /** stdout 注入——测试时可注入 mock；默认 process.stdout */
  readonly stdout?: NodeJS.WriteStream;
}

interface QueueTask {
  readonly run: () => void;
}

/**
 * 启动序列（首次 attach 时 emit）—— 清 viewport + 清 scrollback + cursor 顶。
 *
 * 序列顺序（关键，不能调）：
 *   `\x1b[2J` —— 清 viewport（终端可见区域所有字符）
 *   `\x1b[3J` —— Erase Saved Lines (xterm 扩展) 清整个 terminal scrollback
 *   `\x1b[1;1H` —— cursor 落 (1,1) 让 region 顶 = viewport 顶
 *
 * 为什么 `\x1b[3J` 必须在 `\x1b[2J` 之后：
 *   ConPTY / Windows Terminal 对 `\x1b[2J` 的实现有 quirk —— 清 viewport 时
 *   会**把内容推入 scrollback**（见 microsoft/terminal#5210，与 xterm 标准
 *   "erase but don't scroll" 行为不同）。
 *
 *   若 `\x1b[3J` 在前：先清 scrollback → 然后 `\x1b[2J` 把 viewport 内容
 *   （上次 zhixing 退出前的 farewell + shell prompt 等最后一帧）推入 scrollback
 *   → 结果用户向上滚仍能看到这一帧。
 *
 *   `\x1b[3J` 在后：`\x1b[2J` 推入 scrollback → `\x1b[3J` 把刚推入的也清掉
 *   → scrollback 真正空。
 *
 *   xterm 标准下两种顺序等效（\x1b[2J 不推送），但 Windows ConPTY 下顺序敏感。
 *   按"严格能在两种终端都对"原则选当前顺序。
 *
 * 为什么清 scrollback：
 *   zhixing 主体在 main buffer 渲染（详见模块头 docstring），DECSTBM 滚动会把
 *   region 顶内容自然推入 terminal scrollback。两个场景下用户会看到不希望的内容：
 *     - 启动 zhixing 前 shell 跑过的命令输出残留在 scrollback
 *     - 上次 zhixing session 退出后写过的 chrome / 对话 / farewell 块残留
 *   两类残留对当前 zhixing session 都是噪音 —— 启动时清掉让用户从空 scrollback
 *   开始，进入 zhixing 后向上滚只看到本次 session 的对话历史。
 *
 *   `\x1b[3J` 兼容性：xterm 标准扩展，Windows Terminal / ConPTY (Win10 v1903+) /
 *   PowerShell 7+ / iTerm2 / 主流 Linux 终端都支持；老 VT100 不识别但无害忽略。
 *
 * 副作用：
 *   清 scrollback 同时清掉用户启动 zhixing 之前 shell 的视觉残留（cd / ls / git
 *   等命令的文本输出）。但 PowerShell PSReadLine / bash readline 维护的命令历史
 *   功能（按 ↑ 调出历史命令）**不受影响** —— 那是独立于 viewport scrollback 的
 *   程序级数据。
 */
const ANSI_FIRSTATTACH_SEQUENCE = "\x1b[2J\x1b[3J\x1b[1;1H";

/**
 * 退出清屏序列 —— dispose 时 emit。
 *
 * 撤 DECSTBM + 整屏清 + cursor 回顶，让 shell 接管一个干净的 viewport。
 * 序列顺序：先撤 DECSTBM（否则后续 \x1b[2J / cursor 受 region 限制）→ 整屏清
 * → cursor 回顶（shell prompt 起手位置由 shell 自己决定，cursor 在哪儿不重要，
 * 唯一硬要求是别留任何 zhixing 字节）。
 *
 * 不清 scrollback：本次 zhixing session 写入 scrollback 的内容（被 DECSTBM 滚出
 * 顶部的对话历史）**保留**，用户退出后在 shell 内可向上滚回看本次 session。下次
 * zhixing 启动时由 ANSI_FIRSTATTACH_SEQUENCE 清掉。
 */
const ANSI_DISPOSE_SEQUENCE = "\x1b[r\x1b[2J\x1b[1;1H";

class ScreenControllerImpl implements ScreenController {
  private readonly stdout: NodeJS.WriteStream;
  private readonly capability: TerminalCapability;
  private readonly scrollRegion: ScrollRegion;

  /**
   * 当前 viewport 行列——chrome 字节序列拼装的事实源。
   *
   * 构造期初始化为 capability 值；resize 时同步更新（与 ScrollRegion 自身的
   * viewportRows 在 handleResize 内联更新形成"双向同步对"）。
   *
   * 时序约束：resize 路径必须先更新此字段、再 computeChromeHeight + buildChromeBytes、
   * 最后用同一 chromeHeight 调 ScrollRegion.handleResize——chromeHeight 显式贯穿
   * caller 端推导链，让 ScrollRegion.scrollBottom 与 chromeBytes 起手行用同一推
   * 导式 (viewportRows - chromeHeight)，避免 input.renderLines() 因 columns 变化
   * 触发 reflow 时 chromeHeight 改变而 DECSTBM 边界滞后于新 chrome 起手行。
   */
  private viewportRows: number;
  private viewportCols: number;

  /**
   * status / tail 同行渲染时绘制的分隔符 —— 归 chrome 协议而非任务模块。
   * 任务模块只负责输出纯任务文本；分隔符的存在与否由 chrome 协议在拼接时决定。
   */
  private static readonly STATUS_TAIL_SEPARATOR = `  ${tone.dim("│")}  `;

  private input: InputRegion | null = null;
  /**
   * 是否 attachInput 过 —— ScrollRegion.state.attached 在 detachInput 之后会回到
   * false，但 dispose 路径需要区分"从未接管过屏幕"和"接管过但已 detachInput"两种
   * 状态，前者 dispose 必须不写字节（pre-attach 契约保护 shell 内容），后者必须
   * emit 整屏清（保证 shell 接管干净 viewport）。
   *
   * 此标志在 attachInput 设 true 后**永不回 false**，是 lifecycle 单向闸门。
   */
  private everAttached = false;
  /**
   * 告别块文本 —— 由 caller 通过 setFarewell 设置，dispose 时在退出清屏序列之后
   * emit 到 main buffer。null = 不显示告别块。
   *
   * 同步状态，不进 enqueue 队列 —— 入队会立刻被 flush 写到屏幕扰乱 chrome 渲染。
   * dispose task 内同步读取此 state 决定是否 emit。
   */
  private farewell: string | null = null;
  private statusLines: readonly string[] = [];
  /**
   * 状态行尾部多段集合 —— 按 source id 注册的独立段，JS Map 自带插入顺序保序。
   *
   * 设计：每个独立 source（TaskTail / ContextIndicator / 未来扩展）持有自己的 id，
   * 互不覆盖。chrome 拼接时按 Map iteration 顺序（= 首次注册顺序）拼，让"先注册先
   * 显示"形成稳定的视觉顺序契约，调用方可预期最终位置。
   *
   * 同 id 重新 set 是"更新"（保位）；set 为 null/空 是"移除"（释放位）。
   */
  private statusTails: Map<string, string> = new Map();

  /**
   * 首次 attach 之前 caller 调用 cliWriter.line / withScrollWrite 累积的内容——
   * attach 时一次性 emit 到 region。pre-attach 期间不直写 stdout 避免覆盖
   * shell history（DECSTBM 启动后 region 顶才会成为屏幕顶）。
   */
  private preAttachContent = "";

  private readonly queue: QueueTask[] = [];
  private flushing = false;
  private disposed = false;

  /**
   * 暂停标志——alt UI 嵌入期间为 true，flush 不消费队列让任务暂存。
   * 与 ScrollRegion.state.suspended 互为镜像（ScrollRegion 在 attached 后才有
   * suspended 状态；ScreenController 始终维护此标志便于 disposed 等场景）。
   */
  private suspendedFlag = false;
  private readonly suspendListeners = new Set<(suspended: boolean) => void>();

  /**
   * 同步翻转标志：begin 同步 set true 让重叠 begin 抛错；handle commit/close 同步
   * set false 让下次 begin 立即放行（实际 ScrollRegion handle 操作仍 enqueue）。
   */
  private hasActiveSegment = false;

  /** 解绑 stdout resize listener——dispose 时调用清理 */
  private detachResize: (() => void) | null = null;

  constructor(options: ScreenControllerOptions) {
    this.capability = options.capability;
    this.stdout = options.stdout ?? process.stdout;
    this.viewportRows = this.capability.viewport.rows;
    this.viewportCols = this.capability.viewport.cols;
    this.scrollRegion = new ScrollRegion({
      viewportRows: this.viewportRows,
      viewportCols: this.viewportCols,
      write: (chunk) => this.stdout.write(chunk),
    });
    this.attachResizeListener();
  }

  attachInput(region: InputRegion): void {
    this.enqueue(() => {
      this.input = region;
      this.everAttached = true; // dispose 路径据此区分 pre-attach 与 detached 两态
      if (!this.scrollRegion.state.attached) {
        this.firstAttach();
      } else {
        this.refreshChrome();
      }
    });
  }

  detachInput(): void {
    this.enqueue(() => {
      const wasAttached = this.scrollRegion.state.attached;
      if (wasAttached) {
        this.scrollRegion.detachInput();
        // 退出 chrome 模式 —— 恢复硬件光标可见性（与 firstAttach 的 hideCursor
        // 严格对偶）。仅在曾接管屏幕时 emit，pre-attach 路径下未 hideCursor →
        // 不 showCursor，与"保护 shell 原状"语义一致。
        this.stdout.write(ANSI.showCursor);
      }
      this.input = null;
      this.statusLines = [];
      this.statusTails.clear();
      this.hasActiveSegment = false;
    });
  }

  setStatusBar(lines: readonly string[] | null): void {
    this.enqueue(() => {
      this.statusLines = lines ?? [];
      if (this.scrollRegion.state.attached) {
        this.refreshChrome();
      }
      // pre-attach 期间仅记录引用；首次 attach 时 build chromeBytes 会读到当前值
    });
  }

  setStatusTail(id: string, text: string | null): void {
    this.enqueue(() => {
      const next = text && text.length > 0 ? text : null;
      const current = this.statusTails.get(id);
      // 幂等：值未变（含双方都不存在的情形）不重画
      if (next === null && current === undefined) return;
      if (next !== null && next === current) return;
      if (next === null) {
        this.statusTails.delete(id);
      } else {
        // 已存在的 id 在 Map 内位置不变（JS Map.set 对已有 key 不改变 iteration 顺序），
        // 新 id 自然追加到末尾 —— 实现"先注册先显示"契约
        this.statusTails.set(id, next);
      }
      if (this.scrollRegion.state.attached) {
        this.refreshChrome();
      }
    });
  }

  withScrollWrite(fn: (write: (chunk: string) => void) => void): void {
    this.enqueue(() => {
      let collected = "";
      fn((chunk) => {
        collected += chunk;
      });
      if (collected.length === 0) return;
      if (this.scrollRegion.state.attached) {
        this.scrollRegion.appendInline(collected);
        this.repaintInputCursor();
      } else {
        this.preAttachContent += collected;
      }
    });
  }

  writeScrollLine(text: string): void {
    this.enqueue(() => {
      if (this.scrollRegion.state.attached) {
        this.scrollRegion.writeScrollLine(text);
        this.repaintInputCursor();
      } else {
        // pre-attach 缓冲：text 自动补末尾 \n；空字符串视为空行
        if (text.length === 0) {
          this.preAttachContent += "\n";
        } else {
          this.preAttachContent += text.endsWith("\n") ? text : text + "\n";
        }
      }
    });
  }

  requestInputRepaint(): void {
    this.enqueue(() => {
      if (this.scrollRegion.state.attached) {
        this.refreshChrome();
      }
    });
  }

  ensureScrollLeadingBlank(): void {
    this.enqueue(() => {
      if (!this.scrollRegion.state.attached) return;
      const { currentRowHasVisible, trailingBlankRows } =
        this.scrollRegion.state;
      // 三态分支决定补几个 \n：
      //   - cursor mid-line（行中段）：需 \n 收口当前行 + \n 加空行 = 2 个
      //   - cursor 在新行起首但上一行有内容：仅补 1 个 \n 加空行
      //   - cursor 在新行起首且上方已有空行：no-op（幂等保证）
      let toEmit = "";
      if (currentRowHasVisible) {
        toEmit = "\n\n";
      } else if (trailingBlankRows < 1) {
        toEmit = "\n";
      }
      if (toEmit.length > 0) {
        this.scrollRegion.appendInline(toEmit);
      }
    });
  }

  beginReplaceableSegment(): ReplaceableSegmentHandle {
    if (this.disposed) {
      throw new Error(
        "ScreenController.beginReplaceableSegment called after dispose",
      );
    }
    // fail-fast：未 attach / 已 suspended 时 ScrollRegion 不接受 segment 操作；
    // 同步抛错暴露 caller 协议违反，避免 begin task 与后续 wrapper 调用陷入
    // silent no-op + hasActiveSegment 状态卡死的双层失败
    if (!this.scrollRegion.state.attached) {
      throw new Error(
        "ScreenController.beginReplaceableSegment requires attachInput first",
      );
    }
    if (this.suspendedFlag) {
      throw new Error(
        "ScreenController.beginReplaceableSegment called while suspended",
      );
    }
    if (this.hasActiveSegment) {
      throw new Error(
        "ScreenController has an active segment (single-segment only)",
      );
    }
    this.hasActiveSegment = true;
    return this.makeSegmentWrapper();
  }

  suspend(): void {
    if (this.disposed) {
      throw new Error("ScreenController.suspend called after dispose");
    }
    if (this.suspendedFlag) {
      throw new Error(
        "ScreenController.suspend called while already suspended (alt UI 不嵌套)",
      );
    }

    // 切到 alternate screen buffer —— 终端原子保存 main buffer 整体（含
    // viewport 内容、scrollback、cursor 位置、DECSTBM 状态由 terminal 自行
    // 决策是否一并保存）。alt UI 在 alt buffer 独立渲染，main buffer 完全
    // 不被触碰——这是消除"region 可视区内容（未自然滚入 scrollback 的活跃
    // 对话历史）被 destructive clear 永久擦除"bug 的根本手段。
    //
    // 显式 `\x1b[1;1H` home cursor —— alt buffer 入口 cursor 位置 implementation-
    // defined（部分终端继承 saved cursor 位置）；显式 home 让 alt UI（如
    // config-editor 用 PanelRenderer 假设 cursor 在 startRow）起手位置确定可预测。
    this.stdout.write(ANSI.enterAltScreen);
    this.stdout.write("\x1b[1;1H");

    // scrollRegion.suspend() 仅切内部 flag——阻塞 suspend 期间任何对 region 的
    // 写入路径（requireWritable check），与 ScreenController.suspendedFlag 保持
    // 状态机镜像。不做任何 destructive emit——内容由终端 alt-screen 原子保管。
    if (this.scrollRegion.state.attached) {
      this.scrollRegion.suspend();
    }
    this.hasActiveSegment = false;
    this.suspendedFlag = true;
    this.notifySuspendChange(true);
  }

  resume(): void {
    if (this.disposed) {
      throw new Error("ScreenController.resume called after dispose");
    }
    if (!this.suspendedFlag) {
      throw new Error(
        "ScreenController.resume called without prior suspend",
      );
    }

    // 切回 main buffer —— 终端原子恢复 main buffer 状态：viewport 内容（含
    // region 内对话历史 + chrome）、scrollback、cursor 位置都回到 suspend 前。
    this.stdout.write(ANSI.exitAltScreen);

    // suspendedFlag 与 ScrollRegion.suspended 同步翻转—— flush 消费暂存任务前
    // 两个状态机必须对齐 unsuspended，否则 ScrollRegion 仍 suspended →
    // requireWritable 抛错 → 暂存写入丢失。
    this.suspendedFlag = false;
    if (
      this.scrollRegion.state.attached &&
      this.scrollRegion.state.suspended
    ) {
      this.scrollRegion.resume();
      // 防御性 refreshChrome：(1) DECSTBM 跨 alt-screen 切换是 implementation-
      // defined 是否保存——refreshChrome 内 setChromeHeight 会 re-emit DECSTBM
      // 序列兜底；(2) suspend 期间累积的暂存任务（setStatusBar / setStatusTails
      // 等）可能改变内部 chrome 状态——refreshChrome 用最新状态重画 chrome 字节
      // （内容不变时是 idempotent，状态变化时反映新状态）。
      this.refreshChrome();
      // 重新断言 chrome 模式不变量：硬件光标隐藏。modal（config-editor 等 alt UI）
      // 可能自己 emit `\x1b[?25h` 显示光标做输入；alt-screen 切回 main buffer
      // 后 main 的 cursor 可见性状态由终端决定（implementation-defined），由本
      // emit 兜底强制隐藏，输入光标继续由 chrome 的 reverse SGR 视觉光标承担。
      this.stdout.write(ANSI.hideCursor);
    }
    this.notifySuspendChange(false);

    // 触发 flush 消费 suspend 期间累积的暂存任务——此刻两个状态机已对齐，
    // ScrollRegion 写入路径全部畅通
    this.flush();
  }

  onSuspendChange(listener: (suspended: boolean) => void): () => void {
    this.suspendListeners.add(listener);
    return () => {
      this.suspendListeners.delete(listener);
    };
  }

  setFarewell(text: string | null): void {
    // 同步设值，不入队 —— 详见接口 docstring 与 farewell 字段注释。
    // disposed 后 short-circuit：与 enqueue 路径的 setter（setStatusBar /
    // setStatusTail）行为一致（enqueue 内有同款检查），避免 caller bug 在 dispose
    // 后改 dead state。
    if (this.disposed) return;
    this.farewell = text && text.length > 0 ? text : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.detachResize?.();
    this.detachResize = null;
    // 同步捕获 suspend 状态：dispose 后续会强制 `suspendedFlag = false` 让 flush
    // 消费 cleanup 任务，但 cleanup 任务需要知道"是否曾在 suspend 中"以决定
    // 是否 emit exitAltScreen 防御切回 main buffer。
    const wasSuspendedAtDispose = this.suspendedFlag;
    this.queue.push({
      run: () => {
        // alt buffer 防御退出：若 dispose 时仍处于 suspend 态（如用户在 modal
        // 中 Ctrl+C 终止 session），ScreenController 已被 dispose 入口同步设
        // `suspendedFlag = false`（line below），但终端实际仍在 alt buffer。
        // 必须 emit `\x1b[?1049l` 切回 main buffer，否则 shell 接管时停留在
        // 空 alt buffer，用户视觉错乱（且 shell 输出会被 alt buffer 吞掉）。
        //
        // wasSuspendedAtDispose 由 dispose 入口同步捕获（line 上方），run 闭包
        // 里访问局部值，与 `this.suspendedFlag` 的同步重置（dispose 强制清以让
        // flush 消费 cleanup 任务）不冲突。
        if (wasSuspendedAtDispose) {
          this.stdout.write(ANSI.exitAltScreen);
        }

        // dispose 三态退出协议 —— "shell 接管前最后一次清屏"，与 firstAttach 的
        // `\x1b[2J + cursor(1,1) + 设 DECSTBM` 严格对偶。三态由 attached /
        // everAttached 组合判定：
        //
        //   ① attached=true → ScrollRegion 仍持有 region，shutdown 内 emit 完整
        //      退出序列（撤 DECSTBM + \x1b[2J + cursor）+ 重置内部状态字段。
        //
        //   ② attached=false && everAttached=true → 已被 detachInput 撤过 DECSTBM
        //      但 detachInput 仅清 chromeHeight 行（不整屏清），viewport 顶 region
        //      内容仍残留 → ScreenController 层补整屏清。这是 ctrl+c 路径的常见
        //      情况：inputController.stop() 触发 detachInput 后，dispose 接力补
        //      整屏清让 shell 拿到干净 viewport。
        //
        //   ③ everAttached=false → 从未接管屏幕，**不写任何字节**保护 shell 原状
        //      （pre-attach dispose 误调 / 早期退出路径等场景）。
        //
        // 路径互斥保证无重复 emit：① 走 shutdown（内含整屏清），② 走 ScreenController
        // 层补 emit。
        if (this.scrollRegion.state.attached) {
          this.scrollRegion.shutdown();
        } else if (this.everAttached) {
          this.stdout.write(ANSI_DISPOSE_SEQUENCE);
        }
        // 恢复硬件光标可见性 —— firstAttach 的 hideCursor 对偶。①② 路径均需，
        // ③ pre-attach 路径（everAttached=false）跳过保护 shell 原状。
        // 与 detachInput 的 showCursor 幂等共存（重复 emit 同序列无副作用）。
        if (this.everAttached) {
          this.stdout.write(ANSI.showCursor);
        }
        // 告别块 emit —— 仅在 ①② 路径之后（清屏序列已写完 cursor 在 (1,1)）emit。
        // ③ pre-attach 路径（everAttached=false）跳过，与"保护 shell 原状"原则一致：
        // 从未接管过屏幕的 dispose 不该突然写一段品牌告别块到 shell 之中。
        if (this.everAttached && this.farewell) {
          this.stdout.write(this.farewell);
        }
        this.input = null;
        this.statusLines = [];
        this.statusTails.clear();
        this.preAttachContent = "";
        this.hasActiveSegment = false;
        this.farewell = null;
      },
    });
    this.disposed = true;
    // dispose 是特权清理——若处于 suspended 强制清掉让 flush 消费 cleanup 任务
    this.suspendedFlag = false;
    this.flush();
    this.suspendListeners.clear();
  }

  /** 首次 attach 启动序列：清 scrollback + 清 viewport + DECSTBM + chrome 字节 + flush 缓冲 + cursor 定位 */
  private firstAttach(): void {
    if (this.input === null) return; // 防御：attachInput 必传 region

    // 清 scrollback + 清 viewport + cursor 顶 —— 让 region 顶 = viewport 顶 + 用户
    // 向上滚不会看到 zhixing 启动前 shell 残留或上次 session 残留（见 ANSI_FIRSTATTACH_SEQUENCE
    // 常量 docstring 详解副作用与兼容性）。
    //
    // 紧随其后 emit hideCursor —— chrome 模式下硬件光标永久隐藏（详见模块头
    // "硬件光标可见性 SoT"段）。这是消除"输出区底行光标 + 输入区光标随 chunk 闪烁"
    // 双现象的根本手段：输入光标由 chrome 渲染层用 reverse SGR 画在 body 内，与
    // LLM 流式输出写入完全解耦。
    this.stdout.write(ANSI_FIRSTATTACH_SEQUENCE);
    this.stdout.write(ANSI.hideCursor);

    const chromeHeight = this.computeChromeHeight();
    const chromeBytes = this.buildChromeBytes(chromeHeight);
    this.scrollRegion.attachInput(chromeHeight, chromeBytes);

    // flush pre-attach 缓冲——welcome / advisory 等启动期内容一次性写出
    if (this.preAttachContent.length > 0) {
      this.scrollRegion.appendInline(this.preAttachContent);
      this.preAttachContent = "";
    }

    this.repaintInputCursor();
  }

  /**
   * 按 Map 插入顺序拼接所有 tail 段 —— 多段间复用 STATUS_TAIL_SEPARATOR
   * （与 statusLines[0] ↔ tail 之间使用同一分隔符，视觉一致：A │ B │ C）。
   * 段集合为空 → 返回 null（caller 据此决定是否渲染 tail 区域）。
   */
  private joinStatusTails(): string | null {
    if (this.statusTails.size === 0) return null;
    const segments: string[] = [];
    for (const text of this.statusTails.values()) segments.push(text);
    return segments.join(ScreenControllerImpl.STATUS_TAIL_SEPARATOR);
  }

  /** chrome 协议：高度可能变化时调用——重算 chromeHeight、拼字节、转 ScrollRegion */
  private refreshChrome(): void {
    const chromeHeight = this.computeChromeHeight();
    const chromeBytes = this.buildChromeBytes(chromeHeight);
    this.scrollRegion.setChromeHeight(chromeHeight, chromeBytes);
    this.repaintInputCursor();
  }

  /**
   * status 区高度（不含 input）—— 按双源（statusLines / statusTails 段集合）existence 推导：
   *   - statusLines 非空：保留原行数（tail 段集合拼到第一行末尾，不占新行）
   *   - statusLines 空 + statusTails 非空：1 行（tail 段集合独立成行）
   *   - 两者都空：0 行
   *
   * 单一来源：computeChromeHeight + repaintInputCursor 共用，保证 chrome 边界与
   * input cursor row 用同一推导路径，避免双向不一致。
   */
  private computeStatusHeight(): number {
    if (this.statusLines.length > 0) return this.statusLines.length;
    if (this.statusTails.size > 0) return 1;
    return 0;
  }

  private computeChromeHeight(): number {
    const inputLines = this.input ? this.input.renderLines().length : 0;
    return this.computeStatusHeight() + inputLines;
  }

  /**
   * 拼装 chrome 字节序列——绝对寻址逐行 cursor positioning + clear line + 内容。
   *
   * 严格不 emit \n（chrome 在 DECSTBM 区外、\n 会触发整屏滚动破坏 chrome 永驻）。
   * 行布局：scrollBottom + 1 起手 → status × N → input × M。
   *
   * scrollBottom 推导：用本类自维护的 `this.viewportRows` 而非 capability——
   * resize 路径先更新 `this.viewportRows` 再调本函数，确保 cursor positioning
   * 行号反映新 viewport，不会把 chrome 写到 region 中部。
   */
  private buildChromeBytes(chromeHeight: number): string {
    if (chromeHeight === 0) return "";
    const scrollBottom = this.viewportRows - chromeHeight;
    const startRow = scrollBottom + 1;
    const lineBudget = this.viewportCols - 1; // chrome 行宽硬合约：防终端隐式 wrap

    const tailJoined = this.joinStatusTails();
    const allLines: string[] = [];
    if (this.statusLines.length > 0) {
      // statusLines 非空：第一行拼 tail 段集合（chrome 协议绘制分隔符），其余 status 行不变
      for (let i = 0; i < this.statusLines.length; i++) {
        let line = this.statusLines[i]!;
        if (i === 0 && tailJoined !== null) {
          line =
            line + ScreenControllerImpl.STATUS_TAIL_SEPARATOR + tailJoined;
        }
        allLines.push(clampLine(line, lineBudget));
      }
    } else if (tailJoined !== null) {
      // statusLines 空 + tail 段集合非空：独立成行，加 contentPrefix 与 cli 全局对齐契约一致
      allLines.push(clampLine(layout.contentPrefix + tailJoined, lineBudget));
    }
    if (this.input) {
      for (const line of this.input.renderLines()) allLines.push(line);
    }

    let bytes = "";
    for (let i = 0; i < allLines.length; i++) {
      const row = startRow + i;
      bytes += `\x1b[${row};1H`; // cursor positioning（绝对）
      bytes += "\x1b[2K"; // clear line
      bytes += allLines[i];
    }
    return bytes;
  }

  /**
   * 把硬件 cursor 移到 input cursor 的逻辑位置 —— chrome 协议方法之后调用。
   *
   * ScrollRegion 协议方法末尾把 cursor 拉回 region 末（top-anchored 不变量）；
   * 这里再 emit 一次让硬件 cursor 跳到 input 内的逻辑位置。
   *
   * **视觉副作用 = 零**：模块头"硬件光标可见性 SoT"段中 chrome 模式硬件光标
   * 永久隐藏，输入光标由 input-layout 的 reverse SGR 视觉光标承担。本函数 emit
   * cursor 定位序列的目的不再是"让用户看到光标"，而是：
   *   - 维护 logical cursor position 不变量供 screen reader / accessibility
   *     工具追踪（部分 AT 工具读硬件 cursor 位置即使其不可见）
   *   - 兜底防御：万一某个上游路径（modal / 异常退出）未走 SoT 让硬件光标暂时
   *     可见，至少 cursor 落在正确位置而非 region 末乱跑
   */
  private repaintInputCursor(): void {
    if (!this.input || !this.scrollRegion.state.attached) return;
    const scrollBottom = this.scrollRegion.state.scrollBottom;
    const pos = this.input.cursorPosition();
    const targetRow = scrollBottom + 1 + this.computeStatusHeight() + pos.row;
    const targetCol = 1 + pos.col;
    this.stdout.write(`\x1b[${targetRow};${targetCol}H`);
  }

  /**
   * Segment wrapper——caller 同步拿 handle 后调用 replace/commit/close 入队。
   *
   * 调用方 beginReplaceableSegment 已 fail-fast 校验 attached + !suspended +
   * !hasActiveSegment，本函数内 begin task 直接转 ScrollRegion 即可。
   * wrapper 闭包持 innerHandle 引用，begin task 完成后填充；replace/commit/close
   * task 入队后保证看到已填充的 innerHandle（FIFO 顺序）。
   */
  private makeSegmentWrapper(): ReplaceableSegmentHandle {
    let closed = false;
    let innerHandle: SegmentHandle | null = null;

    this.enqueue(() => {
      innerHandle = this.scrollRegion.beginReplaceableSegment();
    });

    return {
      replace: (newText: string): void => {
        if (closed) return;
        this.enqueue(() => {
          if (innerHandle !== null) {
            innerHandle.replace(newText);
            this.repaintInputCursor();
          }
        });
      },
      commit: (newText: string): void => {
        if (closed) return;
        closed = true;
        this.hasActiveSegment = false;
        this.enqueue(() => {
          if (innerHandle !== null) {
            innerHandle.commit(newText);
            innerHandle = null;
            this.repaintInputCursor();
          }
        });
      },
      close: (): void => {
        if (closed) return;
        closed = true;
        this.hasActiveSegment = false;
        this.enqueue(() => {
          if (innerHandle !== null) {
            innerHandle.close();
            innerHandle = null;
          }
        });
      },
    };
  }

  /**
   * 监听终端 resize——viewport 变化触发 ScrollRegion.handleResize 重设 DECSTBM
   * + 重画 chrome；segment handle 保持活性让 caller 持有的 handle 在下一次
   * replace 自动恢复（防止本 turn 渲染丢失）。
   */
  private attachResizeListener(): void {
    const stream = this.stdout as unknown as {
      on?: (event: string, listener: () => void) => void;
      off?: (event: string, listener: () => void) => void;
    };
    if (typeof stream.on !== "function") return;
    const listener = (): void => {
      if (this.disposed) return;
      this.enqueue(() => {
        if (!this.scrollRegion.state.attached) return;
        const newRows =
          (this.stdout as NodeJS.WriteStream).rows ?? this.viewportRows;
        const newCols =
          (this.stdout as NodeJS.WriteStream).columns ?? this.viewportCols;
        // chromeHeight 显式贯穿 caller 端推导链——同一值拼 chromeBytes 与传给
        // ScrollRegion.handleResize 推导 scrollBottom，确保 DECSTBM 边界与
        // chrome 起手行用同一公式 (viewportRows - chromeHeight)
        this.viewportRows = newRows;
        this.viewportCols = newCols;
        const chromeHeight = this.computeChromeHeight();
        const chromeBytes = this.buildChromeBytes(chromeHeight);
        this.scrollRegion.handleResize(
          newRows,
          newCols,
          chromeHeight,
          chromeBytes,
        );
        this.repaintInputCursor();
      });
    };
    stream.on("resize", listener);
    this.detachResize = () => {
      stream.off?.("resize", listener);
    };
  }

  /** 同步通知所有 suspend 订阅者状态翻转——监听器异常 swallow 不传播 */
  private notifySuspendChange(suspended: boolean): void {
    for (const listener of this.suspendListeners) {
      try {
        listener(suspended);
      } catch {
        // 监听器异常不影响其它监听器与 ScreenController 自身
      }
    }
  }

  private enqueue(task: () => void): void {
    if (this.disposed) return;
    this.queue.push({ run: task });
    this.flush();
  }

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        // suspended 期间任务暂存不消费——等 resume 时再 flush
        if (this.suspendedFlag) break;
        const task = this.queue.shift();
        if (!task) break;
        try {
          task.run();
        } catch {
          // 任务异常不传播——保持后续任务可执行
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

export function createScreenController(
  options: ScreenControllerOptions,
): ScreenController {
  return new ScreenControllerImpl(options);
}
