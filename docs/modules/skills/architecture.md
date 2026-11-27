# 技能架构

## 核心需求与取舍

技能是可复用的“做某类事的方法”，不是工具本身，也不是用户事实存储。它应沉淀模型无从自知的用户约定、已验证的方法和教训，让用户不必反复教授同一套做法；不把模型本来就会的通用知识堆进技能库。

技能的价值不止是重复执行时保持一致，更在于持续积累做事经验。模型越强，越应减少通用操作步骤，留下特定约定、踩坑原因与经过验证的路径；方法帮助模型判断，不把判断锁死成逐步照抄的流程。

核心机制是渐进披露：稳定前缀只放廉价索引，模型判断何时需要，再经 `skill_read` 加载 `SKILL.md` 正文或按路径与字节范围分页读取技能包附属纯文本资源（显式使用 `system:` / `user:` 限定引用，或按既有作用域解析）。方法库可以增长，单个窗口的上下文成本必须受控；不靠硬编码关键词替模型决定适用性。

- 使用标准 `SKILL.md` 与 frontmatter，多文件纯文本技能包通过 `SkillPackageArchive v1`（`≤ 64` 成员、`≤ 2 MiB`）存储与分发，内容和知行私有状态分离；保留外部技能接入能力。
- 索引可见性（正交 `visibility`）与 `mode`、`disabled` 独立控制：自动索引过滤隐藏项并按 `main`/`work` 模式取用户 top-20，手动指名不受索引可见性与 top-N 限制；`work` 当前不细分到各工作场景。
- 用户可以查看、禁用、pin、调整模式及归档技能；内容创作留在对话，结构管理与使用入口分开。
- 外来内容先审查（三向准入与授权分离）；确凿恶意拒绝，不确定性交用户决定。接入审查不能代替运行期权限和资源边界。
- 系统内置方法与用户资产分责；用户定制不改系统原件，后台自动化不得因资产在本地就取得修改权。

长期自主产生、迭代与治理的需求由[技能自主进化](evolution.md)承载，不能冒充当前已实现能力；[SSP 采纳与集成边界](ssp-adoption.md)单独维护协议关系。本篇不决定未来记忆方案，也不为未知能力预建执行网关。

## 当前责任链

`产品表面 / 工具 → Skill Catalog 领域应用 → Correctness 端口 → 权威提交与制品存储`

| 责任 | 当前归属 |
|---|---|
| 查询、管理、索引投影、加载、保存和接入规则 | `core/skills/catalog-application.ts`；各用例明确分责，不由绑定层重新编排 |
| 用户技能事实与恢复投影 | `AnchorSkillGlobalStateAdapter`；目录 revision、对象 revision、请求去重及变更投影（`skill-catalog-v2` / `skill-get-v2` 与 `v1` 兼容投影） |
| 运行内读写与内容获取 | assignment skill adapter 与跨机 `ExecutionAssetSnapshotV2` 分块缓存（`≤ 256 KiB` 断点续传，兼容 `v1` 执行器回退）；接入 GlobalQuery、overlay、staged batch 和 ArtifactStore |
| 管理提交 | management correctness adapter；选择当前权威代次，以 expectedRevision 提交命令，冲突显式失败 |
| 工具与模型循环接入 | Host 注入 `skill_read`、`skill_save`、`skill_admit` 与 `skill_materialize` 应用绑定；Kernel 消费技能投影与工具端口 |
| CLI 管理与唤醒 | `SkillCatalogClient` 的查询、命令、已提交事实投影；不扫描用户磁盘或直接写库 |

旧稿中的“各 runtime / CLI 各建一个 SkillStore，共享磁盘目录”不再是生产架构。应用负责技能语义，正确性层负责授权、提交与恢复，基础设施负责候选文件和不可变内容（含 `packageRef` 多文件打包与分块传输）；这些职责不能重新合成跨层 Store。

## 内容、状态与唯一权威

用户技能目录条目保存 id、name、description、source、mode、visibility、pinned、disabled、createdAt、usage、`contentRef`、`packageRef`（可选多文件 `SkillPackageArchive v1` 引用）及 revision/digest。正文与包内纯文本附属资源通过不可变 `ArtifactRef` 获取；索引和管理视图都是权威目录的投影，不是新的事实源。

- `own` / `linked` 当前是来源标记：保存产生 own，接入产生 linked；不再表示运行端必须存在同名磁盘分区。
- `skillNameToId` 统一名称到标识的转换：规范空白和非法文件名字符、保留 Unicode。索引、加载与 slash 共用 id，避免中文名或含空格名称断链。
- name/description 与正文保持标准文档形态；mode、pin、禁用、usage 不写进外部文档 frontmatter。
- 更新携带 expectedRevision，重复请求必须与原 mutation 一致；不能把覆盖冲突悄悄当成功。
- `skill-archive` 当前从活动目录移除条目。归档应可逆，但现有管理 API 没有恢复命令，不能把权威历史或制品仍在解释为用户已经能恢复。

当前不提供旧目录自动发现机制：把文件放进 `own/`、`linked/` 不是现行入库方式。旧“整包附属文件保留”和“linked 编辑后保留上游副本”要求与当前实现的差异见[创作与接入](authoring-and-admission.md)。

## 索引与窗口生命周期

权威目录先按 pinned、新近度、命中次数排序；无 usage 时用 createdAt 参与新近度排序，避免新技能永远没有曝光。领域投影按 mode 与 disabled 过滤，再取用户 top-20；description 渲染最多 200 字符，索引只展示 id 与描述，不泄露宿主路径。

pin 优先参与排名，但仍受 top-20 上限约束，不能承诺超过上限的所有 pinned 都进入索引。使用信号服务排名，不等同于技能有效性的自动评价，也不因此建立淘汰状态机。

索引政策归 Skill 领域；窗口刷新时机归 runtime。Host 的 `createSkillCatalogWindowPromptProjection` 将 assignment GlobalQuery 接到领域投影，Kernel 只接收 revision、segment 与文本，不解释技能条目。新窗口在首次 prompt 消费前取得投影，窗口内稳定前缀保持 byte-equal；技能或 usage 提交不直接重写当前窗口。

新增能力不应另造渐进披露系统：内置“提炼技能”“接入技能”“外部能力接入”等方法与普通技能同走索引和按需加载。系统技能以随包注册并支持包内纯文本资源与模板按需物化（`skill_materialize`）的方式分发，关联工具只声明需求，具体工具由 Host 绑定。

- builtin（`system:`）不进用户目录、管理或 slash 列表，也不记用户 usage。
- builtin 按注册的 modes 与正交 visibility 可见，与用户 top-N 分池，不争用用户条数。
- `v2` 索引渲染与解析默认使用带命名空间限定符的条目（`user:<id>` 与 `system:<id>`），全部 `5` 个受保护的 `system:*` 内置技能始终可达、`v2` 索引内互不遮蔽；仅在未带前缀的非限定调用或旧版 `load_skill` 兼容路径中保留用户同名条目优先遮蔽规则。
- 方法能用现有工具完成时不增加专用工具；需要程序护栏时才配套工具。旧稿设想的按数量阈值切换通用网关不是当前实现。

## 加载、离线同步与提交

`skill_read` 经领域应用读取当前 assignment 的目录、`ExecutionAssetSnapshotV2` 本地缓存与 overlay，并支持 `user:`/`system:` 限定读取及包内相对路径区间分页读取；正文与成员资源从 `contentRef`/`packageRef` 读取。跨设备新执行器通过 `reconcile-assets-v2 → ≤ 256 KiB upload-asset-chunk-v2 → commit-assets-v2` 断点续传并核对 100% 制品完整性后才原子发布 `execution-assets-v2.json`（双文件读取按较新 `snapshotRevision` 选版，未完成或撤权中断绝不发布半成品），已发布快照支持执行器离线只读分页浏览；未升级的 `v1` 执行器自动回退 `install-assets` 并对多文件旧写以版本冲突保护。成功用户加载的 usage 以稳定 tool operation id 暂存，builtin 直接返回包内正文且不计 usage。

创建、更新、接入、usage 都通过 assignment staged batch（新写提交使用 `"skill-create-v2"` / `"skill-update-v2"` / `"skill-admit-v2"` / `"skill-set-visibility"` 等 v2 变更记录并随封存闭包分块上传多文件包制品）；同一 assignment 可通过 overlay 看到尚未全局提交的内容。正式生效依赖父运行提交及内容依赖校验，失败、取消或未裁决的运行不能凭工具返回就被宣布全局成功。管理命令走独立的权威控制提交，同样只有提交成功才算生效。

`skill-catalog-changed` 由目录拥有者 `AnchorSkillGlobalStateAdapter` 统一发出。管理控制提交成功后，或运行中 staged 的创建、更新、接入随父运行提交成功后，适配器读取权威目录，交给宿主级中继比较结构指纹。结构指纹不含使用统计、条目版本和条目摘要，所以只有 usage 变化时不通知；同一批多次变更、重放、恢复和换代都合并到实际最终版本，每个结构变化只通知一次。

staged 的目录记录与父运行写在同一笔提交里。提交事务完成后，owner 经 publisher 和提交协调器把本次实际追加的记录交给目录拥有者观察，所以运行结算时通知已经发出，不必等恢复轮。恢复轮确认物化时还会再观察一次，但被水位去重，只在提交后的观察失败或进程中断时补发。Server 经事件桥把通知投影为 `skill.changed`，发给全部已认证连接；RPC 方法层不再另发。表面收到通知后重查目录，不从通知内容推测目录；连接或重连时会先全量读取一次，所以断线期间错过的通知不需要补发。观察和通知都发生在提交之后，任一环节失败只记诊断，不改变已提交操作的结果。

缺少 artifact-backed assignment 时，显式降为 builtin-only 读取，用户技能读写失败关闭；不能宣称所有无权威、临时运行都支持完整技能库。

## 使用与管理

`/<id>` 是 agent 类型动态命令，发送给模型后仍经 `skill_read` 使用，不增加命令 handler；与核心命令重名时让核心命令优先。top-N、模式与自动索引可见性只限制自动索引，不限制指名加载。

`/skills` 使用现有全屏管理器，浏览含禁用项的目录，提供 pin、禁用、模式调整和归档。它不承载创建编辑屏，也不承担外部接入。技能内容的打磨需要持续对话；管理一组状态则需要稳定列表，两者不是重复入口。

顶层 `disabled: true` 为硬禁用总开关：`skill_read`、`/skills` 唤起的 `/<id>` 与 `skill_materialize` 均以 `skill-disabled` 明确拒绝（受保护 `system:*` 内置技能不接受顶层禁用）。若仅需从模型自动索引隐藏而保留指名加载（`skill_read`）或手动 `/<id>` 唤起，应保持 `disabled: false` 并正交设置 `visibility.modelAutoIndex = false` / `visibility.userSlashCommand`；管理查询始终保留禁用项供管理器浏览与重启用，`SkillCommandSource` 按 `disabled` 与 `visibility.userSlashCommand` 共同投影 slash 可见性。启用后，下一次刷新恢复列出。

## 维护依据

- [领域应用与索引政策](../../../packages/core/src/skills/catalog-application.ts)（拆分服务：[catalog-load-service.ts](../../../packages/core/src/skills/catalog-load-service.ts)、[catalog-save-service.ts](../../../packages/core/src/skills/catalog-save-service.ts)、[catalog-admission-service.ts](../../../packages/core/src/skills/catalog-admission-service.ts)）、[归档格式](../../../packages/core/src/skills/archive.ts)、[v2 工具绑定](../../../packages/tools-builtin/src/skill-v2.ts)、[权威状态](../../../packages/core/src/skills/global-state-adapter.ts)、[管理正确性适配](../../../packages/core/src/skills/catalog-management-correctness.ts)。
- [assignment 适配](../../../packages/cli/src/runtime/assignment-skill-adapter.ts)、[窗口投影](../../../packages/cli/src/runtime/skill-catalog-window-projection.ts)、[v2 缓存](../../../packages/cli/src/serve/execution-asset-cache-v2.ts)、[v2 同步](../../../packages/cli/src/serve/execution-snapshot-v2-sync.ts)、[builtin](../../../packages/core/src/skills/builtin.ts)、[索引渲染](../../../packages/core/src/skills/render.ts)。
- [动态命令](../../../packages/cli/src/commands/skill-command-source.ts)、[管理器](../../../packages/cli/src/skills/manager-controller.ts)、[RPC client](../../../packages/rpc/src/skill-catalog-client.ts)。

维护时保护：来源隔离、索引预算与窗口稳定、中文 id、同名遮蔽、管理与加载视图、overlay 可见性、CAS 冲突、重复调用、失败不生效及恢复后目录一致。验证沿领域应用、权威 adapter、assignment adapter 和表面消费者，不以 mock Store 或文件存在代替生产提交证据。
