# 技能创作与接入

本篇负责对话内创建、打磨与外部接入；目录、索引、加载、管理及权威边界见[技能架构](architecture.md)。

## 产品思想

创建技能是需要用户持续参与的创作：看草稿、纠正、再看。把它委派出去会隔着转述，切到专门编辑屏会打断语境；因此起草与打磨留在当前对话，保存护栏由程序承担。能力以内置方法交给模型，不把创作固化成页面状态机。

形态是“按需加载的方法 + 必要的落地工具”。起草没有专用工具、额外结构化草稿调用或独立 JSON 草稿；草稿是对话内容，多轮版本占用上下文是这一形态的明确代价，小改只展示变化、窗口压缩沿原机制处理。

知情不等于增加确认步骤：提炼来源随草稿一起说明，用户可以直接纠正，不另做一次概括调用并要求点头后才起草。明确接受放在保存这个真实副作用之前，不能用多一屏、多一句安抚代替清楚的草稿与可介入的过程。

不设 `/skill-new`、`/skill-add` 专门入口；使用仍可 `/<id>` 唤醒，结构管理仍在 `/skills`。创建需要开放式表达和反复打磨，指名使用需要快捷、确定的入口，两者不必采用同一种交互形态。

## 对话创作的硬边界

- 只在用户明确要求，或刚验证走通一套值得复用的方法时提议；只提议、不自动保存，被拒后不反复打扰。
- 起草前简要说明提炼的是哪件事，让用户能及时纠正；正文只留特定约定、教训和已验证方法，description 说明“何时使用”。
- 草稿在原对话里展示与修改，保存前必须取得明确接受；修改已有技能先确认目标，同样不能静默覆盖。
- 判断与方法由模型承担；脱敏、格式、来源和提交一致性由程序保证。接入审查不能交给刚读过外来内容的主模型自行裁决。
- 反馈必须与真实结果一致：仅发生脱敏时报告计数；未正式提交不能说已入库，不承诺后台自主学习或必然自动命中。

## 保存、写回基准与包物化

`skill_save → SkillCatalogSaveApplicationService → SkillPackageArchive v1 / content artifact + assignment stage → 父运行提交`

工具接收 name、description、body（或随附多文件纯文本包成员）、可选 mode 与 visibility 等字段，并支持 `expectedRevision` 与 `writeTemplate`（`expectedVersion`）双阶段写回基准（在提交确认卡前与落盘提交时均校验）防盲写；更新已有技能却未携带一致写回基准时显式拒绝，只改正文/元数据时省略 `resources` 会完整保留既有附属成员，避免模型基于过期快照或半量草稿静默破坏原有包。领域应用统一执行：

1. 对名称、描述、正文及 `SkillPackageArchive v1` 纯文本成员（`≤ 64` 成员、`≤ 2 MiB`，拒绝路径越界与非纯文本载荷）脱敏并校验，使用统一 name-to-id；`skill_materialize` 负责在已授权工作区目录安全物化 `system:` 或 `user:` 包内纯文本模板且受工作区读写与 `/trust` `deny` 规则约束。
2. 读取权威条目与本 assignment overlay，按同名 upsert 决定 create/update，核对 `expectedRevision` / `expectedVersion` 写回基准版本；重放时排除本操作及其后的 overlay，避免把首次创建误判为另一次更新。
3. 生成标准 frontmatter、不可变 `contentRef` 及多文件 `packageRef`；以稳定 tool operation id 暂存 mutation（`"skill-create-v2"` / `"skill-update-v2"` 等 v2 变更记录），更新携 `expectedRevision` / `expectedVersion`。
4. 返回 created/updated、id、修订摘要与脱敏计数。工具明确反馈“本轮成功完成后入库”，不是直接写用户目录。

保存后的来源为 own；pin 等未改状态随更新保留，disabled 清除。旧需求要求更新时保留原 mode、模式变更由管理器表达；当前保存会把工具解析后的 mode 写入更新，省略 mode 也可能按当前场景改模式，必须承认此差异，不能宣称原模式必然保持。

保存前明确同意是方法与工具描述的要求，运行期仍走通用安全管线；不是应用持有一份独立的“用户已同意”证明。不得将 prompt 要求写成程序能够无条件识别用户真实授权。副作用确认策略不因改为对话入口而绕过。

内容处理与提交由领域应用和正确性端口承担；保存不立即刷新当前窗口的稳定前缀。对话正文在任一产品表面复用，是否可写仍取决于该运行具备的工具、权限与 artifact-backed assignment。

## 外部接入：三向独立审查与授权分离

`skill_admit → 候选包快照 → 静态信号 + 独立 AI 裁判 → 拒绝 / 等待确认 / 暂存接入 → 父运行提交`

当前源仅支持用户指定的本地文件或目录；工具顶层 `path` 声明为显式文件读取边界（`filePathArgumentKeys`），另声明 app-state 写边界。新增来源不能用模糊的嵌套参数掩盖其网络或文件权限，但 URL / 仓库获取不属于当前能力。

候选获取和文件清理由宿主 adapter 负责，领域只持不透明 candidateId、多文件纯文本包快照与全包摘要。需明确区分两层限额：底层归档与同步格式 `SkillPackageArchive v1` 允许 `≤ 64` 成员、单成员 `≤ 512 KiB`、整包 `≤ 2 MiB`；而外部本地路径接入审查（`skill_admit` / `stageLocalSkillPackage`）执行更严的安全预算——**单成员 `≤ 64 KiB`、整包可读 UTF-8 文本合计 `≤ 128 KiB`**（超限在调用裁判模型前即硬拒绝）。系统强制**三向独立授权与可辨别裁判绑定**（`reviewerAuthorized`、`callerReceiptContentAuthorized` 与 `publishAuthorized` 三权分离）：

1. 候选树拒绝符号链接/junction、`.git` 目录、含 NUL 字节的二进制及非普通文件；高置信度秘密或违规结构在静态扫描阶段即硬阻断（**零次 `AdmissionLlm` 调用**），不消耗模型额度或泄露候选正文。
2. 非硬阻断候选将全包可读成员（`SKILL.md` 及全部附属纯文本成员，连同目录树摘要）送入独立 `AdmissionLlm` 裁判（要求具备可辨别的独立裁判身份与 `reviewerAuthorized`），主模型自身不得自行裁决接入安全性；调用失败或输出无法解析时均 fail-safe 降级为 `needs-confirm` 或拒绝。
3. 当 `callerReceiptContentAuthorized !== true` 时，对外仅返回中性脱敏回执，**零回显**候选正文、成员文件名或风险摘录（防止回执通道旁路读出受拒文件）；仅 `admissionToken` 本身永远不授权发布——即使审为 `safe` 或 `needs-confirm`，也必须依赖独立的 `publishAuthorized` 拥有者明确确认（或 `/trust` 规则授权与用户确认互相独立、互不替代）。

| 裁决 | 当前处理 |
|---|---|
| safe | 在 `publishAuthorized` 成立前提下将已审多文件纯文本包（`contentRef` + `packageRef`）暂存为 `"skill-admit-v2"`，清候选；正式入库仍等父提交 |
| escalate | 拒绝并清候选，不发 token，不提供强制放行参数；无 `callerReceiptContentAuthorized` 时仅输出中性脱敏回执 |
| needs-confirm | 保留候选并返回带独立签名边界的 `admissionToken`、威胁等级与理由；取得真实拥有者确认及 `publishAuthorized` 后重调，仍按未授权策略脱敏回执字段 |

确认重调只使用 token 指定的候选，不重新读取原路径；检查 token 未过期、候选摘要与拥有者绑定未变，再暂存同一份内容。token 绑定 candidateId、digest、mode、理由、威胁和过期时间，存于 admission 应用实例内，不能跨实例恢复。初始 TTL 为十分钟；失效或内容变化必须重新审查，不静默放行。

每次接入调用清理过期登记并尝试清扫旧候选；成功、拒绝和异常路径清理候选，needs-confirm 保留。部分清理调用是 best-effort，不能承诺任意文件系统故障下零残留；没有额外后台清扫服务。运行提交与候选清理也是不同终态，候选已清不证明技能已提交。

确认 token 只证明“本次发布调用指向此前已审查的候选”，不单独代表 `publishAuthorized` 或真实用户已经同意；知情与明确同意仍需产品确认交互守住。接入审查只判断技能内容，不能替代以后执行该方法时的工具权限、安全裁决或资源治理。

创作与接入的护栏不能互换：创作内容由用户参与打磨，外来内容可能已影响主模型，所以接入裁判必须独立。工具执行前的通用参数确认也无法展示执行中才产生的威胁报告；needs-confirm 接入必须在报告产生后取得同意，并绑定同一候选，避免“确认 A、入库 B”。

## 当前边界

- **多文件包**：标准纯文本技能包与附属资源通过 `SkillPackageArchive v1` 归档格式（底层保存/同步上限：`≤ 64` 成员、单成员 `≤ 512 KiB`、整包 `≤ 2 MiB`）随 `contentRef`/`packageRef` 入库并按需分块同步；外部本地路径接入审查（`skill_admit` / `stageLocalSkillPackage`）另行执行更严的文本审查预算（单成员 `≤ 64 KiB`、整包可读 UTF-8 文本 `≤ 128 KiB`，超限在调用裁判前拒绝）；非纯文本二进制或越限成员拒绝准入。
- **外部原件与定制**：接入正文原样存为不可变制品；后续保存同 id 会把目录条目更新为 own。旧 linked 内容制品不因此被原地改写，但没有旧设计的两份可发现目录、上游同步与显式 fork 管理语义，不能承诺完整 copy-on-write 产品能力。
- **目录边界**：运行期用户正文按授权内容引用读取，不经旧 Store 的路径扫描。候选文件边界与执行技能所调用工具的权限分开负责，不能以“已安全安装”授权任意文件访问。
- **成功反馈**：内置方法与工具返回值统一遵循“当前运行正式提交成功后才全局生效”，不再宣称“写盘即立刻全局可用”；未提交或被取消的运行不会进入权威目录。

## 维护依据

- [领域保存、加载与接入状态机](../../../packages/core/src/skills/catalog-application.ts)（拆分服务：[catalog-load-service.ts](../../../packages/core/src/skills/catalog-load-service.ts)、[catalog-save-service.ts](../../../packages/core/src/skills/catalog-save-service.ts)、[catalog-admission-service.ts](../../../packages/core/src/skills/catalog-admission-service.ts)）、[归档格式](../../../packages/core/src/skills/archive.ts)、[v2 工具绑定](../../../packages/tools-builtin/src/skill-v2.ts)、[安全物化与边界清理](../../../packages/tools-builtin/src/skill-materialize-fs.ts)、[内置方法](../../../packages/core/src/skills/builtin-skills.ts)。
- [工具绑定与结果](../../../packages/tools-builtin/src/skill.ts)、[工具工厂](../../../packages/tools-builtin/src/factories.ts)。
- [候选、制品与 assignment 适配](../../../packages/cli/src/runtime/assignment-skill-adapter.ts)、[独立裁判与获取](../../../packages/core/src/skills/admission.ts)、[权威更新](../../../packages/core/src/skills/global-state-adapter.ts)。

直接验证应覆盖 upsert 与重放、脱敏、来源和状态、无提交不全局生效、三态与 fail-safe、候选调包、过期/跨实例 token、清理失败及生产权限绑定。不能用旧 Store 测试、成功文案或只有模拟 application 的工具测试代替真实提交链。
