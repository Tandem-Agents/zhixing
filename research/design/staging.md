# Staging — 架构设计与审核平台

> 承载**需求已明确、架构待设计与审核**的内容 —— 设计审核通过后进入实施。一次只承载一个 staging topic;实施完成后"当前 staging"区整段清空,等下次启用换 topic。

## 原则

本文档的维护规则。**原则稳定**;下方"当前 staging"区随 topic 生灭整段重写。

- **定位**:本文件承载"需求已明确、架构待设计与审核"的内容，讨论"怎么做"；需求未明确时先与用户对齐。
- **工作流是设计 → 审核 → 实施**:架构设计需要至少一轮顶级架构师视角审查通过后才进入实施。审查中发现的真问题在本文件迭代修复,**不是上来就执行**
- **单 topic 承载**:一次只一个 staging topic。多个 staging 并存 → 拆到 `drafts/` 或独立 spec,不堆本文
- **顶部原则段**:本文档自身维护规则,永久稳定
- **内容区结构**:每个 staging topic 必须按"明确需求 → 架构设计"两段式组织
  - **明确需求**:**严格保留用户原话精确表达的产品决策**,不擅自扩展、不引入未确认的次要事实、不写"哪些不在范围"等推断内容。任何对此段的修改都必须经过产品方向重新对齐，而非直接改本段。
  - **架构设计**:实施层面的具体方案(目标 / 层次 / trade-offs / 清单 / 验收)。**本段是审查与迭代的主战场**,所有 grep 验证、调用链梳理、边界判断、范围确认都在本段做,审查发现的真问题在此段精确修复,直到审查通过才动手实施
- **重启规则**:上一个 staging 沉淀完毕,下一个启用前**整段重写**"当前 staging"——不要在旧内容上叠加
- **绝不留模糊问题**:已明确才放本文件,有疑问先重新对齐
- **绝不长期残留**:实施完成立即清理(整段清空回模板态),staging 不是"已完成内容博物馆",归档去 problems / specifications

---

## 当前 staging

> 暂无活跃 topic —— 上一个(普通交互模式输入区底部信息行)已实施完成,详细设计已沉淀至下方「最近一次沉淀」+ [输入区视觉·底部信息行](../../docs/modules/cli/input-visual.md#底部信息行) + `bottom-info/` 各模块 docstring。下个 topic 启用时整段重写本区。

---

> 最近一次沉淀:
>
> - **普通交互模式输入区底部信息行**(2026-05-23 完成):普通模式输入框上抬一行,框正下方留一行始终占位的信息提示行(横向分左 / 右双区、各可多块、左对齐 / 右对齐)。架构 —— **来源无关内容容器**:新建 `packages/cli/src/bottom-info/`(`BottomInfoModel` 左 / 右 `Map<id,content>` + `set` / `snapshot`,按 `BOTTOM_INFO_IDS` 声明序输出;`renderBottomInfoLine` 双区布局纯函数,左对齐 + 右对齐 + 填充 + 超宽右优先左截断,CJK 安全)。**渲染只读 `snapshot()`、永不读 buffer —— 来源无关是容器存在的根本理由(即便当前仅一个来源)**。`InputController` 作为**第一个来源**:`syncBottomInfo()` 在 buffer 内容变化时把 `esc 清空`(buffer 非空、dim)推进容器,接入点在 `syncBroker()` 内 **`broker.updateInput` 之前**(updateInput 同步触发 repaint 读 model,晚于它写会落后一帧)+ `attachKeypressOnly()` 末尾(start / resume 重建 buffer 后防 stale);`stop()` 清自己的块(来源负责自身 block 全生命周期)。渲染落点在 `computeRender` 普通模式(`panelLines.length===0`)追加,面板 / inline 态让位 —— 与普通输入框同生命周期是渲染结构的自然结果,对 chrome 组装 / cursor 公式透明。**最小可扩展内核**:不预建 subscribe / TTL / 优先级(无外部异步来源,YAGNI);未来外部来源持容器引用 `set` + 加 subscribe,`renderBottomInfoLine` 接口不返工。沉淀去向:`bottom-info/` 各模块 docstring 为首位权威 + [输入区视觉·底部信息行](../../docs/modules/cli/input-visual.md#底部信息行);cli 全套 86 文件 1675 测试通过(bottom-info 10 + 接入 6,含 updateInput 顺序守护 / resume 一致 / render 边界)
> - **`/work` 工作场景二级选择面板**：输入交互归入[输入补全](../../docs/modules/cli/input-completion.md)；命令收敛与场景管理已校准归入[工作场景管理](../../docs/modules/workscene/management.md)。旧 callback 直写路径和 archive 不作为现行设计。
> - **`/resume` 对话删除功能**：通用候选删除的能力声明、二次确认与刷新边界已校准归入[输入补全](../../docs/modules/cli/input-completion.md)，旧 `deletable` 单标志与 Provider 物理删除接口已被后续设计替代。删除当前对话后自动新建并衔接、main/work 场景行为属于对话模块，待随该模块核对；旧本地 Repository 删除和 helper 记录不作为当前实现依据。
> - **REPL 输入与命令体验三项小改**(2026-05-21 完成):需求三条 R1 首位 `、`→`/` 别名规范化(中文输入法误打 `、` 直接当 `/` 解析;显示层保留 `、` / 解析层走 `/`)/ R2 `/clear` UI 重置回刚进入交互模式初始态(advisories + welcome chrome + 一行 cleared notice,warnings 经 extraLines 注入避免清屏丢失可观测性)/ R3 `/workscene` → `/work` 改名(16 处字面同步,实施时发现 staging 统计漏了 work-mode.md:64 一处并补改)。新增 [`packages/cli/src/runtime/leading-slash-alias.ts`](../../packages/cli/src/runtime/leading-slash-alias.ts) `SLASH_ALIASES` 单源数组 + 两公开 API:单字符串 `normalizeLeadingSlashAlias(input)` 给 syncBroker(直接 override `ctx.draft`)、双字符串 `normalizeLeadingSlashAliasInExpanded(target, guard)` 给 submit(基于 `rawDraft.trim()` 首位判断、在 `expanded.trim()` 上替换,避免 paste 长内容折叠为 token 后首位恰为 `、` 时被误识别为命令);typeahead-input.ts syncBroker 用 spread + override draft、submit 用 InExpanded 双参数;repl.ts 顶层 startRepl 闭包 `clearScreenToInitial(extraLines?: readonly string[])` 复用 `rebuildAfterResize` + `initialRegionLines` 单源原语,buildSlashCommands 加注入参数,/clear handler 收集 warnings push 到本地数组(去前后 `\n`)、末尾按是否 chrome 分流(chrome 整屏重建 [advisories,"",welcome,"",warnings...,clearedNotice] 单一来源 / legacy 逐行 cliWriter)。沉淀去向:[`leading-slash-alias.ts`](../../packages/cli/src/runtime/leading-slash-alias.ts) 顶部 docstring 为首位权威(单源数组 + 两 API 语义分叉 + 单字符约束 + paste 边界推演);9 包 5193 tests 零回归(基线 +14 单测含 paste 边界 6 case),严格 tsc 全包 exit 0
> - **work 模式对话能力对齐 main**：历史浏览与新建能力的需求已承接至[工作场景架构](../../docs/modules/workscene/architecture.md)。旧的入口分流和本地 Repository 获取策略已被 owner 获取／恢复场景 primary 会话取代；旧 helper 与测试记录不作为现行实现依据。
> - **`/switch` → `/resume` 改名 + 删序号匹配**(2026-05-21 完成):REPL 切换对话命令名从 `/switch` 改为 `/resume`(对齐 Claude Code 用户预期),无 legacy alias 直接换;handler 内删除"按序号选择"匹配段 + 列表渲染去序号编号,保留 ID 精确 + 名称模糊两档解析(有 name fallback id,序号是冗余信号源);全仓代码 + 测试 + 15 个 spec/README/staging 沉淀的 `/switch` 字面同步,grep `/switch` 零命中。架构升级:`argsByName` 字典 key 同步 `switch → resume`(避免 cmd.name 改而 typeahead conversation 选择器查不到的隐性 bug);列表 label fallback 从 `(未命名)` 改为 `chalk.dim(c.id)`,与 typeahead `c.name || c.id` 一致
> - **transcript schema 历史一致性清理**(2026-05-21 完成):4 项审查识别的债务(`conversation-model.md §7.1` 旧架构描述残留 + `TranscriptHeader.projectPath` 死字段 + `writeHeader/readHeader` 生产零调用 + `session-persistence.md` 半完成归并)彻底处置。代码层:删 `projectPath` 字段 + TranscriptStore 构造签名变更 `(convDir, cwd, options?) → (convDir, options?)`(8 处 caller 同步)、删 `writeHeader/readHeader` 函数 + index re-export + 测试两类用途分别处理(测函数本身的 describe 整段删 / fixture 用法改 fs API)、清理 `normalize.test.ts` dead import。文档层:`conversation-model.md §7.1` 重写对齐 standalone cli 现实(RuntimeSession 替代 ConversationManager/SessionRuntime/CliChannel 旧描述)+ §7.3 表格修正 + §9.2 整段重写承接 session-persistence §2.3 JSONL 行格式细节 + §9.5 整合 §5.1 单向数据流意图;同款散落到 work-mode.md 目录树 + ConversationScope variant + TranscriptStore 签名描述、conversation-scope-flattening.md "后续评估项"标记为"已清理";引用方 context-architecture / usage-display 切到 conversation-model;session-persistence.md 删 §一-§八 正文留 18 行 stub(按维度索引指向当前权威)。沉淀去向:[conversation-model.md §九](specifications/conversation-model.md) 单一事实源;9 包 5174 tests 零回归
> - **新对话自动命名**(2026-05-21 完成):新对话第一轮 turn 完成后用 light LLM 生成短主题名,落 `conversation.meta.name`。[core/conversation/auto-name.ts](../../packages/core/src/conversation/auto-name.ts) 提供 `InferConversationName` 函数依赖注入 + `maybeAutoNameFirstTurn` 协议(主路径同步 short-circuit / 异步分支二次门控 / 全 catch swallow);cli 装配 inferer 闭包(动态访问 `session.runtime.callText` 跟随 work mode active runtime 切换),commitTurn 成功 + `turnCounter++` 之后 fire-and-forget 触发钩子;Phase 0 顺带修复 work 模式 `worksceneRepo.create({ name: scene.name })` → `create({})` 的"N 次进同 scene 产生 N 个同名对话"bug。沉淀去向:[core/conversation/auto-name.ts](../../packages/core/src/conversation/auto-name.ts) 顶部 docstring 为首位权威(设计原则 / 跨层职责 / 触发协议 / sanitize 规则均在);[conversation-model.md](specifications/conversation-model.md) 后续按需补"自动命名"节(独立 task,不阻塞本 staging)
> - **CLI 启动参数清理**(2026-05-21 完成):彻底删除 `-c, --continue` / `-r, --resume [id]` / `-n, --name <name>` 三个启动参数 + 字段 + 透传 + `interactiveConversationPicker` 函数 + `Conversation` 死 import。架构升级:启动参数纯粹只承载"运行模式 / 环境配置"维度,对话选择维度统一收敛到 REPL 内 `/resume` / `/new` / `/name` + auto-resume。文档:session-persistence.md / phase2-complete-agent.md / ADR-005 决策 6 三处补 DEPRECATED/SUPERSEDED 标注
> - **`/conversations` 与 `/sessions` 冗余命令清理**(2026-05-21 完成):删除 `/conversations` handler + typeahead 注册 + `["sessions"]` 别名;架构升级:`/help` 改读 REPL_COMMAND_META 单源(过滤 hidden 与 typeahead dropdown 一致),消除命令可见性双轨。`/resume` 作为查看+切换对话唯一入口
> - **摘要质量与角色分流**：按任务质量选择 main/light、独立请求上下文及思考配置的有效设计已承接至[模型角色](../../docs/modules/providers/model-roles.md)与[思考控制](../../docs/modules/providers/thinking-control.md)；摘要本身由[上下文架构](../../docs/modules/context/architecture.md)负责。旧 Memory Flush、helper 接线和七段模板不再作为现行实现依据。
