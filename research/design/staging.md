# Staging — 架构设计与审核平台

> 介于 [`active-problem.md`](active-problem.md) 工作台与 [`specifications/`](specifications/) 设计权威之间的中转平台。承载**需求已明确、架构待设计与审核**的内容 —— 设计审核通过后进入实施。一次只承载一个 staging topic;实施完成后"当前 staging"区整段清空,等下次启用换 topic。

## 原则

本文档的维护规则。**原则稳定**;下方"当前 staging"区随 topic 生灭整段重写。

- **定位**:本文件承载"需求已明确、架构待设计与审核"的内容。与 [`active-problem.md`](active-problem.md) 区别 —— active-problem 是"产品方向对齐工作台"(要跟用户**对齐需求**,讨论"做什么、不做什么"),staging 是"架构设计与审核平台"(需求已明确,**设计与审核架构**,讨论"怎么做")。需求未明确不放本文件,回 active-problem 对齐
- **工作流是设计 → 审核 → 实施**:架构设计需要至少一轮顶级架构师视角审查通过后才进入实施。审查中发现的真问题在本文件迭代修复,**不是上来就执行**
- **单 topic 承载**:一次只一个 staging topic,与 active-problem 的"一次只一个问题"纪律同构。多个 staging 并存 → 拆到 `drafts/` 或独立 spec,不堆本文
- **顶部原则段**:本文档自身维护规则,永久稳定
- **内容区结构**:每个 staging topic 必须按"明确需求 → 架构设计"两段式组织
  - **明确需求**:**严格保留用户原话精确表达的产品决策**,不擅自扩展、不引入未确认的次要事实、不写"哪些不在范围"等推断内容。任何对此段的修改都必须经过产品方向重新对齐(走 active-problem 流程,而非直接改本段)
  - **架构设计**:实施层面的具体方案(目标 / 层次 / trade-offs / 清单 / 验收)。**本段是审查与迭代的主战场**,所有 grep 验证、调用链梳理、边界判断、范围确认都在本段做,审查发现的真问题在此段精确修复,直到审查通过才动手实施
- **重启规则**:上一个 staging 沉淀完毕,下一个启用前**整段重写**"当前 staging"——不要在旧内容上叠加
- **绝不留模糊问题**:已明确才放本文件,有疑问回 active-problem 重新对齐
- **绝不长期残留**:实施完成立即清理(整段清空回模板态),staging 不是"已完成内容博物馆",归档去 problems / specifications

---

## 当前 staging:REPL 输入与命令体验三项小改

### 明确需求

1. **中文顿号 "、" 在输入行首位按命令唤醒符 `/` 处理**:输入行首位字符是 "、" 时(中文输入法下 `/` 键位对应字符),按 `/` 路径处理 —— 显示层保留用户实际输入的 "、" 字符,但解析层(typeahead 命令列表弹出 / 命令名匹配 / 回车提交执行)完全当作 `/` 处理。理由:中文输入法切换误打 "、" 后删除再重打效率低,而首位字符是 "、" 明显不是有效用户输入内容,可直接当 `/` 解析。仅首位字符触发,后续字符的 "、" 不替换语义(命令参数中的 "、" 保留原义)
2. **`/clear` 执行后 UI 重置为刚进入交互模式时的初始态**:现状执行后仅在历史对话末尾追加一行提示,历史仍占满屏。期望:执行后**清屏 + 重渲染刚进入交互模式时的初始区域(advisories + welcome chrome)**,然后追加一行轻量提示。提示文案由设计阶段确认。数据层(messages / transcript compact / view layer reset)行为不变
3. **`/workscene` 命令重命名为 `/work`**:`/workscene` 字面太长,且作为带二级指令(`<scene id/name>`)的命令,二级指令前必须输完整一级名才能继续,typeahead 直接选会触发无参数交互,所以必须手动输完整。缩短到 `/work`,无 legacy alias 直接换(参照 `/switch → /resume` 改名手法,全仓代码 + 测试 + spec/README 字面同步)

### 架构设计

三项需求互相**正交无依赖**,可串行设计串行实现。共同纪律:**语义边界单点拦截 + 单一事实源 + 纯函数可测 + 零架构债**(不引入兼容/降级/双轨)。

#### R1 — 首位 `、` → `/` 别名规范化

**事实**:命令解析有四个语义边界硬编码 `/` —— ① `CommandProvider.matchTrigger` 调 `findTriggerToken(triggerChar: "/")`;② `InputController.submit()`(typeahead-input.ts:831)的 `text.startsWith("/")` 分支;③ `CommandDispatcher.dispatch()`(command-dispatcher.ts:105)的 `trimmed.startsWith("/")` 保险检查;④ `runLegacyCommand`(repl.ts:1860)的 `trimmed.startsWith("/")`——legacy 终端(无 chrome 能力时,`useTypeahead=false`)走 `rl.question` 接收 input 后直接调本路径,**完全不经** InputController。①②③ 共属 chrome 路径(经 `InputController.submit()`),④ 是与之互斥的 legacy 路径。`InputBuffer.toTriggerContext()` 喂 broker;`InputController.submit()` 取 rawDraft 同时驱动 echo(显示)和 dispatch(语义)——显示路径与语义路径在 `submit()` 这一点天然分叉(rawDraft 给 echo、normalized text 给 dispatcher)。legacy 路径无 echo 层,本就**没有"显示/解析分叉"可言**——`rl.question` 由 readline 自己写屏,用户输什么终端显什么。

**目标**:产品规则"`、` 首位等价于 `/`(仅首位、仅触发字符位置)"封装成独立模块,**显示层零感知**(保留 `、`),**语义层全部经规范化**(下游硬编码 `/` 不动)。

**方案**——新增 `packages/cli/src/runtime/leading-slash-alias.ts` 纯函数模块:

```ts
// 当前约束:SLASH_ALIASES 仅支持单字符 alias。扩展多字符 alias 须同时
// 重算 syncBroker override 后 ctx.cursor(draft 字符长度变化,cursor 需重映射),
// 否则 cursor 与 draft 字符索引脱节。
export const SLASH_ALIASES: readonly string[] = ["、"];
export function normalizeLeadingSlashAlias(input: string): string {
  for (const alias of SLASH_ALIASES) {
    if (input.startsWith(alias)) return "/" + input.slice(alias.length);
  }
  return input;
}
```

chrome 路径两处 callsite 均在 `typeahead-input.ts`:
1. `syncBroker()`:取 `buffer.toTriggerContext(runtime)` 后,把 `ctx.draft` override 为 `normalizeLeadingSlashAlias(ctx.draft)` 再喂 broker → typeahead 候选列表 / ghost text 看到 `/help`
2. `submit()`:`text = normalizeLeadingSlashAlias(expanded.trim())` 再走原 `text.startsWith("/")` 分支 → rawDraft 给 echo 显示 `、help`,text 给 dispatcher 走 `/help`

legacy 路径(repl.ts:1920-1934)**不接入 normalize** —— legacy 无 echo 分叉,`rl.question` 由 readline 自己写屏:若把 `trimmed` 也 normalize,屏幕已显示 `、help` 但执行 `/help`,显示与解析仍不一致(与 chrome 路径"echo 显 `、` + 执行 `/`"的视觉契约**根本无法对齐**,因为 readline 那行字已经写在 scrollback 里无法回改);若不 normalize,行为等于"legacy 模式不支持 alias",语义清晰。chrome 是主流路径(Windows ConPTY / Win Terminal / iTerm / 主流 Linux 终端均触发 `capability.ok=true`),legacy 仅古老 / 探测失败终端兜底,产品上可接受。

**Trade-off**:
- 不在 `InputBuffer` 内做 —— 它是底层 widget 状态容器,不该知 REPL 业务别名规则;`InputController` 才是业务层,在它两个语义出口拦截才职责正确
- 不在 `findTriggerToken` 加 alias 参数 —— 那会把"输入法 alias"概念下沉到 `@zhixing/core/typeahead` 通用基础设施污染 core 层;CLI 层产品规则该留在 CLI 层
- 用 readonly 数组而非单字符常量 —— 配置式,日后扩展(其他输入法误打字符)改一行不动函数,也方便单测参数化
- legacy 路径不支持 alias —— 见上方说明,legacy 无显示/解析分叉无法对齐 chrome 路径的视觉契约,且 legacy 受众极少,接受此边界

**实施**:
- 新增 `runtime/leading-slash-alias.ts`(函数 + 别名数组 + 单字符约束注释)
- 新增 `runtime/__tests__/leading-slash-alias.test.ts` 7 case:空串 / 首位 `/` / 首位 `、` / 首位其他字符 / `、、` 仅替首位 / `、 ` 后跟空格 / `text、` 非首位不替
- 改 `typeahead-input.ts`:`syncBroker()` override draft + `submit()` 规范化 text(legacy 路径 `repl.ts:1920-1934` 不动)

**验收**:输入 `、resu` → typeahead 弹 `/resume` 候选;回车 → echo 显示 `、resume`,实际执行 `/resume`;输入 `hello、` 末尾的 `、` 保留原义不触发命令面板。

#### R2 — `/clear` UI 重置到初始态

**事实**:`initialRegionLines()` (repl.ts:1257) 已是 advisories + welcome chrome 的单一来源,延迟求值(每次调用按当时 session 状态生成)。`renderScreen.rebuildAfterResize(buildContent: () => string)` 是"整屏清(`\x1b[2J\x1b[3J\x1b[1;1H` 含 **terminal scrollback** 全清)+ chrome 自适应重画 + region 内容重写"的成熟原语(screen-controller.ts:767,序列与 firstAttach 同源),resize 路径(repl.ts:1789-1795)已是参考样板。`/clear` 数据层逻辑(transcript compactAll + runtime resetConversationState + clearViewLayerState + taskListService.clear)完整正确,**仅 UI 重置缺失**。handler 中 `resetConversationState` / `clearViewLayerState` 两个 try/catch 块会在失败时 `cliWriter.line` 写 yellow 非致命 warning(repl.ts:367-371、380-384)到 scroll region —— 若直接调 rebuildAfterResize 这些 warning 会被一并清掉,**用户失去可观测性**。`renderScreen` 在 legacy 终端(无 chrome 能力)为 null,须有降级路径。

**目标**:`/clear` 数据层零改,UI 层复用现有 `initialRegionLines + rebuildAfterResize` 原语,在 `buildSlashCommands` 边界上**注入一个"清屏到初始态"高阶能力**,handler 不知 renderScreen / initialRegionLines 内部细节。

**方案**——startRepl 顶层(renderScreen + initialRegionLines 闭包内)定义,签名带 `extraLines` 参数承接 handler 收集的 warnings:

```ts
const clearScreenToInitial:
  | ((extraLines?: readonly string[]) => void)
  | undefined = renderScreen
  ? (extraLines) => {
      const clearedNotice = `${layout.contentPrefix}${chalk.dim(
        "⟳ 对话已清空 · 可以从这里开始新一轮",
      )}`;
      renderScreen.rebuildAfterResize(() =>
        [...initialRegionLines(), ...(extraLines ?? []), clearedNotice]
          .map((l) => `${l}\n`)
          .join(""),
      );
    }
  : undefined;
```

`buildSlashCommands` 签名新增参数 `clearScreenToInitial?: (extraLines?: readonly string[]) => void`;`/clear` handler 把现有两个 try/catch 内的 `cliWriter.line(chalk.yellow(...))` 改为 push 到本地 `warnings: string[]`,末尾分流:

```ts
const warnings: string[] = [];
// resetConversationState / clearViewLayerState 失败时 push 到 warnings
// (替代原 cliWriter.line yellow,文案保持不变)
// ...
if (clearScreenToInitial) {
  clearScreenToInitial(warnings);
} else {
  for (const w of warnings) cliWriter.line(w);
  cliWriter.line(chalk.dim(`${layout.contentPrefix}对话历史已清空\n`));
}
```

**提示文案**:`⟳ 对话已清空 · 可以从这里开始新一轮` —— 与 resize notice(`⟳ 已适配新窗口 · 历史对话未丢失……`)风格对齐(同 `⟳` 前缀 + `·` 分隔 + dim),传递"重置完成 + 可以继续"双信号。

**Trade-off**:
- 不让 handler 自己取 renderScreen + initialRegionLines —— buildSlashCommands 参数已 6 项,再各加 2 项扩散无故;把"UI 重置"作为高阶能力注入是单一职责的正解,日后若 `/new` 等也需"清屏到初始态"可直接复用
- 不抹去 `resumedConversationName`(重渲染时仍显示"恢复对话:foo")—— `/clear` 是"清对话内容不改对话身份",resume 来源是"如何来到这个对话"的事实,与"清内容"语义正交,抹去违反纪律
- 不强行让 `/new` 共用 —— `/new` 切换 conversation 身份,UI 重置语义不同(有"已切到新对话"提示流),不预设统一
- 复用 `rebuildAfterResize` 含 `\x1b[3J` 清 terminal scrollback —— 与 `/clear` 数据层 `compactAll` 写 marker 物理压缩磁盘历史的语义一致("清空 + 重新开始"包含滚动历史);不接受 trade-off 反例(保留 scrollback)的理由:scrollback 残留与磁盘已压缩的 transcript 不一致,反成用户认知噪音
- warnings 经 `extraLines` 注入 region 内容而非走 `cliWriter` —— 因 rebuild 会清 scroll region,若 warnings 先写再 rebuild 则丢失;统一收集 → 整屏重建时一并落 region,可观测性零损失

**实施**:
- repl.ts 顶层 startRepl 内(initialRegionLines 之后)闭包定义 `clearScreenToInitial(extraLines?)` 
- `buildSlashCommands` 签名加 `clearScreenToInitial?: (extraLines?: readonly string[]) => void` 参数
- `/clear` handler 改写:两个 try/catch 把 yellow warning push 到本地 `warnings` 数组(文案不变),末尾按是否有 `clearScreenToInitial` 分流(chrome 路径传 warnings 整屏重建 / legacy 路径逐行 cliWriter 写后追加提示)
- 调用 `buildSlashCommands(...)` 处传入 `clearScreenToInitial`
- **换行规范**:`warnings` 数组每个元素是**不含 `\n` 的单行内容**(空行用空字符串 `''` 表示),统一由数组拼接处的 `map(l => l + '\n')` 控制换行——与 `initialRegionLines()` 的同款契约对齐。push 时把原 `cliWriter.line(chalk.yellow('\n  ...\n'))` 文案前后的 `\n` 去掉(原前后 `\n` 是 cliWriter 协议下的"段前/段后空行"惯例,在数组协议里改由 `''` 元素表达),否则会渲染多余空行

**验收**:chrome 终端 `/clear` 后屏幕仅剩 advisories(若有)+ welcome chrome + 一行 cleared notice,数据层 messages 已清空;若 reset 失败 warning 出现在 welcome 与 cleared notice 之间不丢失;legacy 终端 `/clear` 行为不变(逐行写 warning + 提示)。

#### R3 — `/workscene` 重命名为 `/work`

**事实**(全仓 `/workscene` 字面命中,与 `workscene` 标识符 / `workscenes` 复数目录路径严格区分):
- 代码 9 处:repl.ts:254 (legacyKey) / repl.ts:673 (handler key) / repl.ts:683, 721, 748 (usage 文案 + 注释) / session.ts:107, 409, 438 / work-mode-controller.ts:38(均为命令名引用 / docstring 中引用)
- 文档 6 处:packages/cli/README.md:96 / work-mode.md:274, 275, 276, 277, 300
- 共 15 处字面
- `argsByName` 字典无 `workscene` key(子命令是手动 token 解析,非 ArgSchema)—— 无需同步
- `workmode-tools.ts` LLM 工具 description 不引用命令名(`workmode_enter` 等工具描述自身行为) —— 无需同步
- 无 alias、无外部 hooks 引用

**目标**:全仓直接换,无 legacy alias,与 `/switch → /resume` 同款手法。

**方案**——精确同步以下字面:

代码层:
- `REPL_COMMAND_META`:`{ name: "work", description: "工作场景管理（增删改查/归档）", category: "tools", legacyKey: "/work" }`
- `slashCommands` 字典 key:`"/workscene"` → `"/work"`
- handler 内部 usage 文案 `/workscene ...` → `/work ...`(4 处)
- `runtime/session.ts` + `runtime/work-mode-controller.ts` 注释中 `/workscene` → `/work`(4 处)

文档层:
- `packages/cli/README.md` 命令表
- `research/design/specifications/work-mode.md` 命令清单 + 编排描述(6 处)

**不动的**(领域标识符,与命令名解耦):
- 模块路径 `packages/core/src/workscene/`、类型 `WorkScene` / `WorkSceneRegistry`、`ConversationScope.kind: "workscene"`、`workmode_enter` / `workscene_change_approve` 等 LLM 工具名
- **复数目录路径** `<home>/workscenes/<id>/...`(paths.ts / repository.ts / 多份 spec):这是数据持久化目录层级,与单数命令名 `workscene` 是两个独立领域概念,**与本改名完全无关**
- description 文案 `"工作场景管理（增删改查/归档）"`(领域概念词,与命令名独立)

**Trade-off**:
- 不留 `/workscene` alias —— `/switch → /resume` 已确立"无 legacy alias 直接换"纪律;留 alias 让 typeahead 出现双条目混淆,且字符长度的痛点正是要解决的
- 命令名是 `work` 不是 `ws` 或其他 —— 与 `workscene` 同根、与 `workspace` / `work mode` 用户认知一致;3 字母过短易冲突且认知割裂;与 `/exit`、`/me` 等短命令风格一致

**实施**:精确改上述 15 处字面。收尾验收 pattern `/workscene([^s]|$)`(正则尾部断言排除复数路径 `/workscenes` 假阳性;`grep -F "/workscene"` 是字面子串匹配会误命中 `/workscenes/...`,**不能用**);**必须排除 staging.md 自身 + active-problem.md + problems/ 归档 + drafts/ 草稿**(这些区域合理保留旧名作历史/工作台/草稿引用,沉淀进"最近一次沉淀:"区那一行也必然写"`/workscene` → `/work`"作历史描述,验收若不排除则永远不可能零命中)。

**验收**:用 ripgrep 跑 pattern `/workscene([^s]|$)`,排除 `**/staging.md` / `**/active-problem.md` / `**/problems/**` / `**/drafts/**` 后零命中。**pattern 必须用单引号包裹**(bash 与 PowerShell 同款,单引号抑制变量插值,`$` 直传 rg 作行尾断言);若用双引号则 `$` 需写成 `\$`,但 rg regex 里 `\$` 是**字面美元符号**而非行尾断言,会漏掉行尾的 `/workscene`(如 markdown 列表项 `- /workscene`)。跨 shell 通用形:

```
rg -n '/workscene([^s]|$)' --glob '!**/staging.md' --glob '!**/active-problem.md' --glob '!**/problems/**' --glob '!**/drafts/**'
```

行为验收:typeahead 直接选 `/work` 触发工作场景管理列表;`/work add foo` / `/work list` / `/work remove <id>` 全部行为不变。

#### 总验收

- `pnpm -r typecheck` 严格 tsc 全包 exit 0
- `pnpm -r test` 全包零回归
- R1 normalize 函数单测 7 case 全通
- R2 chrome 终端 `/clear` 后视觉等价于"刚进入交互模式 + 一行 cleared notice";legacy 终端行为不变
- R3 pattern `/workscene([^s]|$)` 在代码 + 当前权威 spec/README 中零命中(staging.md / active-problem.md / problems/ / drafts/ 历史归档区合理保留旧名,不在验收范围)

---

> 最近一次沉淀:
>
> - **work 模式对话能力对齐 main**(2026-05-21 完成):需求三条 R1 `/resume` 解禁 / R2 `/new` 解禁 / R3 进入 scene 按触发源分流(用户 `/enter` 走 auto-resume / LLM `workmode_enter` 工具始终新建)。实施:删 `/resume` 和 `/new` 的 work-mode handler guard 共 8 行(scope 天然分隔由 `state.conv.convRepo` 自动跟随 → handler 零改动复用);新增 [`packages/cli/src/runtime/workscene-conversation.ts`](../../packages/cli/src/runtime/workscene-conversation.ts) 纯函数 helper 模块(三路径 A/B/C 正交:A latest 不存在直 create / B latest 存在 load+get 成功 recovery / C latest 存在加载失败降级 create + warning;`warning` 由 caller 在 try 成功后输出避免双消息困惑);`applyModeSwitch` enter 按 source 分支(LLM 直 create / command 调 helper),`undo` 分支 `loaded === null` 才 push delete(recovery 路径保留用户历史),`wStore.init` 仅 create 路径调用(recovery 不覆盖 transcript),`startMessages` 按"触发源 × 路径"三态组装(LLM `[triggerMsg]` / recovery `loaded.messages` / create `[]`)。顺手清理 baseline:`repl.ts` 死变量 `cwd` 删 + `serve/command.ts` `zhixingHome` 未定义补齐(后者是 `zhixing serve` + `config.messaging` 路径必崩的 production bug)。沉淀去向:helper 顶部 docstring 为首位权威(设计原则 / 三路径 / 触发源分流 / warning 输出协议均在);[work-mode.md](specifications/work-mode.md) 后续按需补"对话获取策略"节(独立 task,不阻塞);全包 5179 测试零回归,严格 tsc 全包 exit 0
> - **`/switch` → `/resume` 改名 + 删序号匹配**(2026-05-21 完成):REPL 切换对话命令名从 `/switch` 改为 `/resume`(对齐 Claude Code 用户预期),无 legacy alias 直接换;handler 内删除"按序号选择"匹配段 + 列表渲染去序号编号,保留 ID 精确 + 名称模糊两档解析(有 name fallback id,序号是冗余信号源);全仓代码 + 测试 + 15 个 spec/README/staging 沉淀的 `/switch` 字面同步,grep `/switch` 零命中。架构升级:`argsByName` 字典 key 同步 `switch → resume`(避免 cmd.name 改而 typeahead conversation 选择器查不到的隐性 bug);列表 label fallback 从 `(未命名)` 改为 `chalk.dim(c.id)`,与 typeahead `c.name || c.id` 一致
> - **transcript schema 历史一致性清理**(2026-05-21 完成):4 项审查识别的债务(`conversation-model.md §7.1` 旧架构描述残留 + `TranscriptHeader.projectPath` 死字段 + `writeHeader/readHeader` 生产零调用 + `session-persistence.md` 半完成归并)彻底处置。代码层:删 `projectPath` 字段 + TranscriptStore 构造签名变更 `(convDir, cwd, options?) → (convDir, options?)`(8 处 caller 同步)、删 `writeHeader/readHeader` 函数 + index re-export + 测试两类用途分别处理(测函数本身的 describe 整段删 / fixture 用法改 fs API)、清理 `normalize.test.ts` dead import。文档层:`conversation-model.md §7.1` 重写对齐 standalone cli 现实(RuntimeSession 替代 ConversationManager/SessionRuntime/CliChannel 旧描述)+ §7.3 表格修正 + §9.2 整段重写承接 session-persistence §2.3 JSONL 行格式细节 + §9.5 整合 §5.1 单向数据流意图;同款散落到 work-mode.md 目录树 + ConversationScope variant + TranscriptStore 签名描述、conversation-scope-flattening.md "后续评估项"标记为"已清理";引用方 context-architecture / usage-display 切到 conversation-model;session-persistence.md 删 §一-§八 正文留 18 行 stub(按维度索引指向当前权威)。沉淀去向:[conversation-model.md §九](specifications/conversation-model.md) 单一事实源;9 包 5174 tests 零回归
> - **新对话自动命名**(2026-05-21 完成):新对话第一轮 turn 完成后用 light LLM 生成短主题名,落 `conversation.meta.name`。[core/conversation/auto-name.ts](../../packages/core/src/conversation/auto-name.ts) 提供 `InferConversationName` 函数依赖注入 + `maybeAutoNameFirstTurn` 协议(主路径同步 short-circuit / 异步分支二次门控 / 全 catch swallow);cli 装配 inferer 闭包(动态访问 `session.runtime.callText` 跟随 work mode active runtime 切换),commitTurn 成功 + `turnCounter++` 之后 fire-and-forget 触发钩子;Phase 0 顺带修复 work 模式 `worksceneRepo.create({ name: scene.name })` → `create({})` 的"N 次进同 scene 产生 N 个同名对话"bug。沉淀去向:[core/conversation/auto-name.ts](../../packages/core/src/conversation/auto-name.ts) 顶部 docstring 为首位权威(设计原则 / 跨层职责 / 触发协议 / sanitize 规则均在);[conversation-model.md](specifications/conversation-model.md) 后续按需补"自动命名"节(独立 task,不阻塞本 staging)
> - **CLI 启动参数清理**(2026-05-21 完成):彻底删除 `-c, --continue` / `-r, --resume [id]` / `-n, --name <name>` 三个启动参数 + 字段 + 透传 + `interactiveConversationPicker` 函数 + `Conversation` 死 import。架构升级:启动参数纯粹只承载"运行模式 / 环境配置"维度,对话选择维度统一收敛到 REPL 内 `/resume` / `/new` / `/name` + auto-resume。文档:session-persistence.md / phase2-complete-agent.md / ADR-005 决策 6 三处补 DEPRECATED/SUPERSEDED 标注
> - **`/conversations` 与 `/sessions` 冗余命令清理**(2026-05-21 完成):删除 `/conversations` handler + typeahead 注册 + `["sessions"]` 别名;架构升级:`/help` 改读 REPL_COMMAND_META 单源(过滤 hidden 与 typeahead dropdown 一致),消除命令可见性双轨。`/resume` 作为查看+切换对话唯一入口
> - **摘要质量升级**(2026-05-20 完成):主对话压缩(LLMSummarize)模型档位从 light 升级到 main;`compaction-llm.ts` 拆为 `createSummarizeCallLLM` + `createMemoryFlushCallLLM` 两个独立 helper;`MAIN_SESSION_PROMPT` 重写为吸取 opencode 精华的新 7 段(约束与偏好 / 关键决策 / 进度三态)。沉淀去向:
>   - [secondary-llm-capability.md ADR-SLLM-009](specifications/secondary-llm-capability.md) — 角色分流决策权威
>   - [llm-summarization.md](specifications/llm-summarization.md) — 7 段结构 / prompt / 校验同步更新到代码现状
>   - [thinking-control.md](specifications/thinking-control.md) / [work-mode.md](specifications/work-mode.md) / [subagent-execution.md](specifications/subagent-execution.md) — 引用同步
