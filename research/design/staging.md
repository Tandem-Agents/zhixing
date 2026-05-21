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

## 当前 staging:transcript schema 历史一致性清理

### 明确需求

1. **来源**:外部架构审查识别的 4 项 transcript schema 历史债务(草稿事实层调研 [drafts/transcript-schema-debt.md](drafts/transcript-schema-debt.md))
2. **目标**:**彻底**消除一致性缺陷,遵循"避免架构债务、追求最优架构"项目原则——不修修补补、不半作妥协
3. **范围**:**仅限审查识别的 4 项**,不擅自扩展产品方向:
   - 债务 1:[conversation-model.md L710](specifications/conversation-model.md#L710) 旧路径残留
   - 债务 2:`TranscriptHeader.projectPath` 死字段
   - 债务 3:`writeHeader` / `readHeader` 生产零调用
   - 债务 4:[session-persistence.md](specifications/session-persistence.md) deprecation 处置不彻底

   架构设计段的事实层 grep 验证可能发现**同款债务在其他 spec 的散落**(同一概念错误在多处重复出现),属于"完整呈现该债务真实边界"而非"扩展产品方向";不同种类的债务(非同款)严格留待独立处置。

### 架构设计

#### 事实层(grep 验证,2026-05-21)

**债务 1 — conversation-model.md §7.1 旧架构描述残留(L710 路径是表象)**

[L710](specifications/conversation-model.md#L710) 当前文本:
> `Conversation 数据持久保留在 ~/.zhixing/projects/<id>/conversations/<convId>/transcript.jsonl`

旧 `projects/<id>/` 路径已被 ADR-CM-016 替代,grep packages 内零命中。但 L710 不是孤立一行——嵌在 §7.1 "形态 A:Standalone CLI(in-process)" 整段生命周期流程图(L670-L711)里,**整段描述与当前实现不符**:

- L688 `ConversationManager.acquire(convId) → 创建 SessionRuntime #1`
- L689 `CliChannel.registerConnection({ id: "cli-pid-12345", ... })`
- L706 `SessionRuntime #1 observers 清空 → 立即进入释放流程`

grep `ConversationManager|SessionRuntime|CliChannel` 在 `packages/cli/src` 的代码符号引用**只命中 `cli/src/serve/`**(cli 充当 server 时)和 `packages/server/`。standalone cli 主入口 [`repl.ts`](../../packages/cli/src/repl.ts) 零代码引用,实际用 `RuntimeSession`([repl.ts:1202](../../packages/cli/src/repl.ts#L1202));`cli/src/runtime/builtin-extra-tools.ts:50` 注释提及 ConversationManager 是描述 `ScheduleTool ↔ Scheduler ↔ runAgentTurn ↔ ConversationManager` 循环依赖,不是代码引用。

**同款债务在其他 spec 散落**(grep `~/.zhixing/projects/` 在 design/specifications/ 下):
- [work-mode.md L121](specifications/work-mode.md#L121) ASCII 目录树 `├── projects/<projectId>/conversations/<id>/  (project scope;现有)` — 写"现有"但 project scope 已被 ADR-CM-016 删除
- [work-mode.md L142](specifications/work-mode.md#L142) `| { kind: "project"; projectId: string; projectPath: string }` — 描述已删除的 ConversationScope variant
- `conversation-scope-flattening.md` 内的 `projects/` 提及是该 spec 自身在描述"已废弃路径"(L16/L40),属合理回溯,不构成债务

**债务 2 — `TranscriptHeader.projectPath` 死字段**

[`transcript/types.ts:24`](../../packages/core/src/transcript/types.ts#L24) `projectPath: string` 字段定义。grep `\bprojectPath\b` 在 `packages/core/src/transcript/` 的实际命中:

| 位置 | 用途 |
|---|---|
| [`types.ts:24`](../../packages/core/src/transcript/types.ts#L24) | 字段定义 |
| [`store.ts:55/75/79`](../../packages/core/src/transcript/store.ts#L55) | 类成员 / 构造参数 / 赋值 |
| [`store.ts:139`](../../packages/core/src/transcript/store.ts#L139) | 写入 header |
| [`__tests__/serializer.test.ts:23/157`](../../packages/core/src/transcript/__tests__/serializer.test.ts) | 测试 fixture |

**生产代码零读取**,纯 write-only。注:`providers/config-loader.ts` / `orchestrator/runtime/project-context.ts` 也命中 `projectPath`,但属其他子系统局部变量,与 transcript header 字段无关。

**文档侧 projectPath 引用**(本字段清理后需同步):
- [conversation-model.md L871](specifications/conversation-model.md#L871) "Header 是不可变的创建快照(conversationId、model、provider、projectPath、createdAt)" — 字段列举
- [conversation-scope-flattening.md L154 / L161 / L192](specifications/conversation-scope-flattening.md) — 三处明确将本字段标记为"本次不动 / 后续独立评估项"。**本次清理即该 spec 预设的'独立评估'落实**,需同步更新这三处描述为"已清理"
- [work-mode.md L142](specifications/work-mode.md#L142) — ConversationScope 描述含 `projectPath`,随债务 1 work-mode 修正一并处理
- [session-persistence.md L137 / L304](specifications/session-persistence.md) — 历史 schema 示例,随债务 4 删正文一并消失

**债务 3 — `writeHeader` / `readHeader` 生产零调用 + dead import**

[`serializer.ts:31`](../../packages/core/src/transcript/serializer.ts#L31) `writeHeader`(mkdir + writeFile)+ [`serializer.ts:142`](../../packages/core/src/transcript/serializer.ts#L142) `readHeader`(读首行解析)。grep 命中:

- `serializer.ts`(自身定义)
- `index.ts`(re-export)
- `__tests__/serializer.test.ts` — 两类用途:**L171-202 `describe("writeHeader / readHeader")` 测试函数本身**(4 个用例:写入后读 / 自动创建父目录 / 文件不存在返 null / 首行非 header 返 null);**L207-258 `describe("appendRecord / loadRecords")` + `describe("countTurns")` 用 writeHeader 作 fixture**(6 处写一个 header 作为前置,然后测其它功能)
- `__tests__/normalize.test.ts:6` `import { writeHeader }` —— grep `writeHeader\s*\(` 在本文件**零调用**,**dead import**

生产路径(`commitTurn` 单原子入口)完全取代了 writeHeader / readHeader。

**注**:`readHeader` 是只读首行(性能),`loadRecords` 是全文件解析,**两者不等价**。删 readHeader 后测试要么用 `fs.readFile + 自解析`,要么用 `loadRecords(...).header`(全文件 IO,测试场景性能可接受)。

**债务 4 — session-persistence.md 处置不彻底,被引用方未真正承接**

[`session-persistence.md`](specifications/session-persistence.md) 顶部 3 段 deprecation 标注完整,但正文 §一-§八(竞品对比 / SHA-256 哈希 / `--continue/--resume/--name/--fork-session` / `SessionStore` 等)仍是过时设计内容(L137/L304 含 `projectPath` 也属此正文残留)。

**归并未真正完成(债务 4 的根因)**:

grep `session-persistence.md` 命中 5 处引用方:

| 引用方 | 行 | 引用形态 | 性质 |
|---|---|---|---|
| `conversation-model.md` | L7 | "(被本文档归并)" | **声明归并** |
| `conversation-model.md` | L513 | "详见 [session-persistence.md](./session-persistence.md) §5(Turn-complete 时追加策略,本文档继承不变)" | **反向引用细节** |
| `conversation-model.md` | L841 | "继承 [session-persistence.md](./session-persistence.md) 的 JSONL 设计" | **反向引用** |
| `conversation-model.md` | L863 | "详见 [session-persistence.md](./session-persistence.md) §2.3。本文档仅修订" | **反向引用细节** |
| `context-architecture.md` | L604 | "见 [session-persistence.md §2.3](./session-persistence.md)" | **anchor 引用** |
| `usage-display.md` | L5 | 关联引用列举 | **see also** |
| `drafts/transcript-retention.md` | L6 | 指 session-persistence.md §2.3 + §4.5 + §5 为"权威 spec" | **archival 引用**(本文件 L3-L9 已自标记"冻结归档") |

conversation-model.md 声称归并,**实际 L513 / L841 / L863 仍反向引用 session-persistence.md 取 JSONL 行格式 / Turn-complete 追加策略等细节**。这是 session-persistence.md 长期残留的根本原因——**归并没做完**,直接删 §一-§八 正文会让 4 个 anchor link(§2.3 / §5)broken。

session-persistence.md 章节结构:§一 竞品 / §二 知行设计(含 §2.3 JSONL 格式)/ §三 CLI 集成 / §四 核心类型(含 §4.5 TranscriptStore 接口)/ §五 写入策略 / §六 文件结构 / §七 实现路线 / §八 ADR-005 修正 / §九 设计原则。被反向引用的 §2.3 / §4.5 / §5 是核心承接对象。

**其他 3 处 deprecated 文档现状(用于对比)**:

| 文档 | 当前 deprecation 形态 | 评估 |
|---|---|---|
| [`context-management-v2-redesign.md L3`](specifications/context-management-v2-redesign.md) | "DEPRECATED + 决策痕迹保留"标注 + 正文承载 v2 设计与 prompt cache 元规则①冲突推演 | 正文承载**决策反思价值**(为何 v2 失败 → v3 出生),无反向引用问题,已最佳实践 |
| [`phase2-complete-agent.md L7-15`](specifications/phase2-complete-agent.md) | "废弃 + **按维度索引**"形态(6 个维度各指向当前权威) | **已做优质维度索引导航**,无反向引用问题,删除反丢价值 |
| [`ADR-005 §决策 6 L88-108`](architecture/decisions/005-cli-architecture.md) | 顶部 deprecation + 维度索引 + 决策主体(13 行) | ADR 标准模式(decision snapshot),无反向引用问题,已最佳实践 |

**结论**:session-persistence.md 与其他 3 处性质不同 ——
- 其他 3 处:**无反向引用,正文是独立决策痕迹**,保留是最佳实践
- session-persistence.md:**正文是被归并的细节**,但归并方(conversation-model.md §九)没真正承接,留正文是"半完成归并"的债务症状

要彻底删 session-persistence.md 正文,前置必须真正完成归并(把 §2.3 / §5 / §4.5 内容本地化到 conversation-model.md §九)。

#### 待决策点(本段是审查迭代主战场)

**决策 1 — 债务 1 范围**(推荐:扩展到 §7.1 整段 + work-mode.md 同款修正)

- A. 仅修 L710 一行路径
- **B. 修 conversation-model.md §7.1 整段对齐 standalone cli 现实(RuntimeSession + auto-resume + REPL 内 /switch /new /name),同步修 work-mode.md L120-L143 目录树 + ConversationScope variant 描述**
- **推荐 B**:L710 是 §7.1 整段过时的表象;只改一行留 §7.1 整段过时债务;work-mode.md L121/L142 是同款债务的另一处散落,放任不修留"为什么这次只改一处"的解释债务。这不是扩展范围,是事实层完整呈现该债务的真实边界

**决策 2 — 债务 2 处置**(推荐:删除字段 + 同步文档)

- A. 删除字段 + 所有引用 + 文档同步
- B. 保留 + 文档化实际用途(需找/补真用例)
- **推荐 A**:[conversation-scope-flattening.md L192](specifications/conversation-scope-flattening.md) 已明确"本字段已被产品定位判定为 dead field,仅因 schema 变更复杂度暂留,应在独立 schema 变更 spec 中清理"——本次即该 spec 预设的清理。无数据迁移代价(旧 transcript 文件 header 多余字段被 normalize 静默忽略)

**决策 3 — 债务 3 处置**(推荐:删除函数 + 测试改写 + 清理 dead import)

- A. 删除 `writeHeader` / `readHeader` 函数 + index re-export + 测试改用直接 fs API 或测试内部 helper + 清理 normalize.test.ts dead import
- B. 保留为公共测试 API
- **推荐 A**:internal-only 项目无外部消费者,公开 API 价值低;函数被 `commitTurn` 单原子入口完全取代,留着诱导未来误用。测试改写不是"等价替换"(readHeader 全文件 IO 性能退化在测试场景无意义)

**决策 4 — 债务 4 处置**(推荐:先完成归并再删正文,两步法;其他 3 处不动)

- A. **两步法**:
  - **前置**:`conversation-model.md §九` 真正承接 `session-persistence.md` 被 active spec 反向引用的细节 —— §2.3 JSONL 行格式 → §9.2 / §5.1 Turn-complete 追加策略(单向数据流设计意图)→ §9.5 **本地化内联**,L513 / L841 / L863 反向引用全部就近迁移,消除归并未完成的根因。**不承接**:§4.5 TranscriptStore 接口 + §5.2/§5.3/§5.4 写入/读取/消息重建实现细节(grep 验证 active spec 无任何反向引用,由代码契约 + ADR-CM-015/017 承载,spec 镜像反成噪音)
  - **后续**:删 `session-persistence.md` §一-§八 正文,留 stub(指向 conversation-model.md 对应章节 + 决策痕迹见 git history)
  - **同步引用方**:`context-architecture.md L604` / `usage-display.md L5` 引用更新到 conversation-model.md 对应章节;`drafts/transcript-retention.md` 自身已 archival(L3-L9 自标"冻结归档"),其中的 anchor 引用退化为墓碑形态可接受,不动
  - **其他 3 处不动**:v2-redesign / phase2 / ADR-005 §决策 6 各自都是已实现的最佳实践(决策反思 / 维度索引 / ADR 标准模式),无反向引用问题
- B. **简化删法**(仅删 session-persistence.md 正文,不做前置承接):省事但留 4 处 anchor link broken + 不消除归并未完成的根因
- C. **一刀切 4 处齐删齐留**:统一形式但毁掉其他 3 处已经做好的决策痕迹/维度索引/ADR 标准模式
- **推荐 A**:B 引入新债务(broken link)且没解决根因;C 引入反向损失。两步法的"前置承接"才是债务 4 的真正解决方案——session-persistence.md 长期残留不是因为"忘了删",而是因为归并方没真正承接细节,半完成的归并把这个文档钉在这里

#### 不在范围(本次不动)

- `Conversation.name` schema 改 nullable(sentinel `name === id` 已沉淀,工作良好)
- `TranscriptHeader.name: string | null` vs `Conversation.name: string` 设计不对称(独立议题,外部审查未识别)
- transcript schema 演进(新增字段 / 新机制)
- workscene 历史对话访问能力(独立议题)
- `ConversationScope` 三态→二态扁平化(已在 commit a2917df 完成)
- 新对话自动命名(已沉淀)
- conversation-model.md §7.2(形态 B,server 客户端模式)— 与当前 server 端实现对齐审查作为独立 scope

#### 实施清单(决策落定后启用,按依赖顺序)

> 以下基于决策 1B / 2A / 3A / 4A 起草。最终清单待用户审查后启用。

1. **决策 2 字段层清理**(无文档依赖,先做):
   - 删 [`transcript/types.ts:24`](../../packages/core/src/transcript/types.ts#L24) `projectPath` 字段
   - 删 [`transcript/store.ts`](../../packages/core/src/transcript/store.ts) L55/75/79/139 字段引用
   - **TranscriptStore 构造签名变更**:从 `(convDir, cwd, options?)` 变为 `(convDir, options?)`。同步以下 8 处 caller 删第二参数:
     - 生产代码 3 处:[`cli/src/repl.ts:1171`](../../packages/cli/src/repl.ts#L1171)(main scope 传 cwd)/ [`cli/src/repl.ts:1429`](../../packages/cli/src/repl.ts#L1429)(workscene 传 scene.workdir)/ [`cli/src/serve/command.ts:177`](../../packages/cli/src/serve/command.ts#L177)(传 workspace)
     - 测试代码 5 处:`store.test.ts:44` / `normalize.test.ts:48` / `lock.test.ts:32` / `compact-all.test.ts:36` / `commit-turn.test.ts:50`
   - 修测试 fixture [`__tests__/serializer.test.ts:23/157`](../../packages/core/src/transcript/__tests__/serializer.test.ts) 中 `HEADER` 字面量删 `projectPath`

2. **决策 3 函数层清理**:
   - 删 [`serializer.ts:31/142`](../../packages/core/src/transcript/serializer.ts) `writeHeader` + `readHeader`
   - 删 [`transcript/index.ts`](../../packages/core/src/transcript/index.ts) re-export
   - **删除** [`__tests__/serializer.test.ts`](../../packages/core/src/transcript/__tests__/serializer.test.ts) L171-202 `describe("writeHeader / readHeader", ...)` 整段(测试函数本身,函数删了测试随之删除)
   - **改写**同文件 L207-258 `describe("appendRecord / loadRecords")` + `describe("countTurns")` 中 writeHeader 作 fixture 的用法 → 直接 fs API 或测试内部 helper
   - 清理 [`__tests__/normalize.test.ts:6`](../../packages/core/src/transcript/__tests__/normalize.test.ts) dead import

3. **决策 1 + 决策 2 文档同步**:
   - [`conversation-model.md §7.1`](specifications/conversation-model.md#L674) (L674-L711) 整段重写对齐 standalone cli 当前实现(RuntimeSession / auto-resume / REPL 内 /switch /new /name),L710 路径修正
   - *(`conversation-model.md L871` 删 `projectPath` 字段列举合并进 item 4a 第 1 条 §9.2 承接重写;避免本 item 局部改后被 item 4a 整段重写覆盖)*
   - [`work-mode.md L120-L143`](specifications/work-mode.md) ASCII 目录树删 project scope 行 + ConversationScope 类型定义删 project variant
   - [`work-mode.md L260`](specifications/work-mode.md#L260) TranscriptStore 接口签名描述从 `TranscriptStore(convDir, workdir)` 更新为 `TranscriptStore(convDir, options?)`(与决策 2 构造签名变更对齐)
   - [`conversation-scope-flattening.md L95`](specifications/conversation-scope-flattening.md#L95) 代码示例更新为 `const store = new TranscriptStore(convDir);` + 删除"(见'不在范围')" 注释(本次清理后该"不在范围"已落实)
   - [`conversation-scope-flattening.md L154 / L161 / L192`](specifications/conversation-scope-flattening.md) 三处"本次不动 / 后续独立评估"描述更新为"已清理"

4. **决策 4 两步法**(实施顺序 4a 承接 → 4b 切引用 → 4c 删正文,过程中无 broken 中间态):

   4a. **前置 — conversation-model.md §九 真正承接 session-persistence.md 细节**(消除归并未完成的根因):
   - [`conversation-model.md §9.2`](specifications/conversation-model.md) **整段重写**(非末尾追加):把 session-persistence.md §2.3 JSONL 行格式细节(Header / Turn / Compact 三种行的字段定义、JSON schema、行级 corruption 隔离语义)本地化内联,L863 "详见 session-persistence.md §2.3" 反向引用消除。**承接 schema 反映决策 2 清理后状态**(Header 字段不含 `projectPath`,§9.2 整段重写过程中现有 L871 `projectPath` 字段列举自然被新内容覆盖消除);**保留 §9.2 现有的修订增量描述**(SessionHeader.sessionId → TranscriptHeader.conversationId、新增 meta.json 拆出可变字段)
   - [`conversation-model.md §9.5`](specifications/conversation-model.md) 整合 session-persistence.md **§5.1** Turn-complete 追加策略(单向数据流设计意图),L513 / L841 反向引用消除。**§5.2/§5.3/§5.4 不承接**(写入/读取/消息重建实现细节由代码契约 + ADR-CM-015/017 承载,与 §4.5 不承接同款原则)
   - 同步 [`conversation-model.md L7`](specifications/conversation-model.md#L7) 引用文案,从"(被本文档归并)"改为"(已被本文档完整归并,保留为决策痕迹归档)"

   4b. **切引用方到新承接位置**(此时 session-persistence.md 仍在,新旧引用并存可用):
   - [`context-architecture.md L604`](specifications/context-architecture.md#L604) 引用更新到 `conversation-model.md §9.2`(Compact 标记行新承接位置)
   - [`usage-display.md L5`](specifications/usage-display.md#L5) 关联引用列表把 `session-persistence.md(会话追踪)` 改为 `conversation-model.md(Conversation / Transcript 持久化)` —— 标签同步精确化,不照搬"会话追踪"(后者是 session-persistence 语义,不准描述 conversation-model)
   - [`drafts/transcript-retention.md`](drafts/transcript-retention.md) 自身已 archival(L3-L9 自标"冻结归档"),anchor 引用退化为墓碑形态可接受,不动

   4c. **删 session-persistence.md 正文**(所有 active 引用已切到新位置,删除瞬间无 broken):§一-§八 整段删除,保留顶部 stub(~15 行:指向 conversation-model.md §九 对应章节 + 维度索引 + 决策痕迹见 git history)

5. **综合验证**:
   - 全包 build 零错误
   - 全包测试零回归
   - grep 验收(见下)

#### 验收(决策定下后启用)

- packages 内 `\bprojectPath\b` 仅命中 `providers/config-loader.ts` / `orchestrator/runtime/project-context.ts` 两处无关局部变量
- packages 内 `writeHeader|readHeader` 零命中
- spec 内 `~/.zhixing/projects/` 仅命中 `conversation-scope-flattening.md` 在描述"已废弃路径"的合理回溯
- spec 内 `ConversationManager|SessionRuntime|CliChannel` 在 standalone cli 流程描述中零命中(`cli/src/runtime/builtin-extra-tools.ts:50` 的注释引用是代码内,不在 spec 验收范围)
- `session-persistence.md` 主体 ≤ 30 行(stub 形态);v2-redesign / phase2 / ADR-005 保持现状
- spec 内 `session-persistence.md#` anchor 引用零命中(`drafts/transcript-retention.md` 自身 archival 内允许墓碑引用,不算)
- `conversation-model.md` 内 "详见 session-persistence.md" / "继承 session-persistence.md" 等反向引用零命中(归并已真正完成)
- 全包测试零回归

---

> 最近一次沉淀:
>
> - **新对话自动命名**(2026-05-21 完成):新对话第一轮 turn 完成后用 light LLM 生成短主题名,落 `conversation.meta.name`。[core/conversation/auto-name.ts](../../packages/core/src/conversation/auto-name.ts) 提供 `InferConversationName` 函数依赖注入 + `maybeAutoNameFirstTurn` 协议(主路径同步 short-circuit / 异步分支二次门控 / 全 catch swallow);cli 装配 inferer 闭包(动态访问 `session.runtime.callText` 跟随 work mode active runtime 切换),commitTurn 成功 + `turnCounter++` 之后 fire-and-forget 触发钩子;Phase 0 顺带修复 work 模式 `worksceneRepo.create({ name: scene.name })` → `create({})` 的"N 次进同 scene 产生 N 个同名对话"bug。沉淀去向:[core/conversation/auto-name.ts](../../packages/core/src/conversation/auto-name.ts) 顶部 docstring 为首位权威(设计原则 / 跨层职责 / 触发协议 / sanitize 规则均在);[conversation-model.md](specifications/conversation-model.md) 后续按需补"自动命名"节(独立 task,不阻塞本 staging)
> - **CLI 启动参数清理**(2026-05-21 完成):彻底删除 `-c, --continue` / `-r, --resume [id]` / `-n, --name <name>` 三个启动参数 + 字段 + 透传 + `interactiveConversationPicker` 函数 + `Conversation` 死 import。架构升级:启动参数纯粹只承载"运行模式 / 环境配置"维度,对话选择维度统一收敛到 REPL 内 `/switch` / `/new` / `/name` + auto-resume。文档:session-persistence.md / phase2-complete-agent.md / ADR-005 决策 6 三处补 DEPRECATED/SUPERSEDED 标注
> - **`/conversations` 与 `/sessions` 冗余命令清理**(2026-05-21 完成):删除 `/conversations` handler + typeahead 注册 + `["sessions"]` 别名;架构升级:`/help` 改读 REPL_COMMAND_META 单源(过滤 hidden 与 typeahead dropdown 一致),消除命令可见性双轨。`/switch` 作为查看+切换对话唯一入口
> - **摘要质量升级**(2026-05-20 完成):主对话压缩(LLMSummarize)模型档位从 light 升级到 main;`compaction-llm.ts` 拆为 `createSummarizeCallLLM` + `createMemoryFlushCallLLM` 两个独立 helper;`MAIN_SESSION_PROMPT` 重写为吸取 opencode 精华的新 7 段(约束与偏好 / 关键决策 / 进度三态)。沉淀去向:
>   - [secondary-llm-capability.md ADR-SLLM-009](specifications/secondary-llm-capability.md) — 角色分流决策权威
>   - [llm-summarization.md](specifications/llm-summarization.md) — 7 段结构 / prompt / 校验同步更新到代码现状
>   - [thinking-control.md](specifications/thinking-control.md) / [work-mode.md](specifications/work-mode.md) / [subagent-execution.md](specifications/subagent-execution.md) — 引用同步
