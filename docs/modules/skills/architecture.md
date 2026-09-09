# 技能架构

## 核心需求与取舍

技能是可复用的“做某类事的方法”，不是工具本身，也不是用户事实存储。它应沉淀模型无从自知的用户约定、已验证的方法和教训，让用户不必反复教授同一套做法；不把模型本来就会的通用知识堆进技能库。

核心机制是渐进披露：稳定前缀只放廉价索引，模型判断何时需要，再经 `load_skill` 加载正文。方法库可以增长，单个窗口的上下文成本必须受控；不靠硬编码关键词替模型决定适用性。

- 使用标准 `SKILL.md` 与 frontmatter，内容和知行私有状态分离；保留外部技能接入能力。
- 自动索引按 main/work 模式过滤并限量，手动指名不受 top-N 限制；work 当前不细分到各工作场景。
- 用户可以查看、禁用、pin、调整模式及归档技能；内容创作留在对话，结构管理与使用入口分开。
- 外来内容先审查；确凿恶意拒绝，不确定性交用户决定。接入审查不能代替运行期权限和资源边界。
- 系统内置方法与用户资产分责；用户定制不改系统原件，后台自动化不得因资产在本地就取得修改权。

长期自主产生、迭代与治理的需求由[技能自主进化](evolution.md)承载，不能冒充当前已实现能力；[SSP 采纳与集成边界](ssp-adoption.md)单独维护协议关系。本篇不决定未来记忆方案，也不为未知能力预建执行网关。

## 当前责任链

`产品表面 / 工具 → Skill Catalog 领域应用 → Correctness 端口 → 权威提交与制品存储`

| 责任 | 当前归属 |
|---|---|
| 查询、管理、索引投影、加载、保存和接入规则 | `core/skills/catalog-application.ts`；各用例明确分责，不由绑定层重新编排 |
| 用户技能事实与恢复投影 | `AnchorSkillGlobalStateAdapter`；目录 revision、对象 revision、请求去重及变更投影 |
| 运行内读写与内容获取 | assignment skill adapter；接入 GlobalQuery、overlay、staged batch 和 ArtifactStore，不持有第二份业务规则 |
| 管理提交 | management correctness adapter；选择当前权威代次，以 expectedRevision 提交命令，冲突显式失败 |
| 工具与模型循环接入 | Host 注入 load/save/admission 应用，工具只负责参数和产品反馈；Kernel 消费技能投影与工具端口 |
| CLI 管理与唤醒 | `SkillCatalogClient` 的查询、命令、已提交事实投影；不扫描用户磁盘或直接写库 |

旧稿中的“各 runtime / CLI 各建一个 SkillStore，共享磁盘目录”不再是生产架构。应用负责技能语义，正确性层负责授权、提交与恢复，基础设施负责候选文件和不可变内容；这些职责不能重新合成跨层 Store。

## 内容、状态与唯一权威

用户技能目录条目保存 id、name、description、source、mode、pinned、disabled、createdAt、usage、contentRef 及 revision/digest。正文通过不可变 `ArtifactRef` 获取；索引和管理视图都是权威目录的投影，不是新的事实源。

- `own` / `linked` 当前是来源标记：保存产生 own，接入产生 linked；不再表示运行端必须存在同名磁盘分区。
- `skillNameToId` 统一名称到标识的转换：规范空白和非法文件名字符、保留 Unicode。索引、加载与 slash 共用 id，避免中文名或含空格名称断链。
- name/description 与正文保持标准文档形态；mode、pin、禁用、usage 不写进外部文档 frontmatter。
- 更新携带 expectedRevision，重复请求必须与原 mutation 一致；不能把覆盖冲突悄悄当成功。
- `skill-archive` 当前从活动目录移除条目。原“可逆归档”产品要求保留，但现有管理 API 没有恢复命令，不能把权威历史或制品仍在解释为用户已经能恢复。

当前不提供旧目录自动发现机制：把文件放进 `own/`、`linked/` 不是现行入库方式。旧“整包附属文件保留”和“linked 编辑后保留上游副本”要求与当前实现的差异见[创作与接入](authoring-and-admission.md)。

## 索引与窗口生命周期

权威目录先按 pinned、新近度、命中次数排序；无 usage 时用 createdAt 参与新近度排序，避免新技能永远没有曝光。领域投影按 mode 与 disabled 过滤，再取用户 top-20；description 渲染最多 200 字符，索引只展示 id 与描述，不泄露宿主路径。

pin 优先参与排名，但仍受 top-20 上限约束，不能承诺超过上限的所有 pinned 都进入索引。使用信号服务排名，不等同于技能有效性的自动评价，也不因此建立淘汰状态机。

索引政策归 Skill 领域；窗口刷新时机归 runtime。Host 的 `createSkillCatalogWindowPromptProjection` 将 assignment GlobalQuery 接到领域投影，Kernel 只接收 revision、segment 与文本，不解释技能条目。新窗口在首次 prompt 消费前取得投影，窗口内稳定前缀保持 byte-equal；技能或 usage 提交不直接重写当前窗口。

新增能力不应另造渐进披露系统：内置“提炼技能”“接入技能”与普通技能同走索引和按需加载。方法以 TS 字符串注册并随代码分发，关联工具只声明需求，具体工具由 Host 绑定。

- builtin 不进用户目录、管理或 slash 列表，也不记用户 usage。
- builtin 按注册的 modes 可见，与用户 top-N 分池，不争用用户条数。
- 用户同 id 条目遮蔽 builtin；禁用用户版本也不会使 builtin 自动重新进入索引。
- 方法能用现有工具完成时不增加专用工具；需要程序护栏时才配套工具。旧稿设想的按数量阈值切换通用网关不是当前实现。

## 加载与提交

`load_skill` 经领域应用读取当前 assignment 的目录与 overlay，用户条目优先于 builtin；用户正文从 contentRef 读取，解析正文后返回。成功用户加载的 usage 以稳定 tool operation id 暂存，builtin 直接返回包内正文且不计 usage。

创建、更新、接入、usage 都通过 assignment staged batch；同一 assignment 可通过 overlay 看到尚未全局提交的内容。正式生效依赖父运行提交及内容依赖校验，失败、取消或未裁决的运行不能凭工具返回就被宣布全局成功。管理命令走独立的权威控制提交，提交成功才产生 `skill-catalog-changed`；表面收到通知后重查，不从通知猜测目录。

缺少 artifact-backed assignment 时，显式降为 builtin-only 读取，用户技能读写失败关闭；不能宣称所有无权威、临时运行都支持完整技能库。

## 使用与管理

`/<id>` 是 agent 类型动态命令，发送给模型后仍经 `load_skill` 使用，不增加命令 handler；与核心命令重名时让核心命令优先。top-N 与模式只限制自动索引，不限制指名加载。

`/skills` 使用现有全屏管理器，浏览含禁用项的目录，提供 pin、禁用、模式调整和归档。它不承载创建编辑屏，也不承担外部接入。技能内容的打磨需要持续对话；管理一组状态则需要稳定列表，两者不是重复入口。

原要求“禁用后不出现在 slash 补全”当前未成立：`SkillCommandSource` 直接消费含禁用项的管理查询，没有再次过滤；禁用目前明确影响自动索引，不能写成彻底禁止加载。此差异不改变原要求。

## 维护依据

- [领域应用与索引政策](../../../packages/core/src/skills/catalog-application.ts)、[权威状态](../../../packages/core/src/skills/global-state-adapter.ts)、[管理正确性适配](../../../packages/core/src/skills/catalog-management-correctness.ts)。
- [assignment 适配](../../../packages/cli/src/runtime/assignment-skill-adapter.ts)、[窗口投影](../../../packages/cli/src/runtime/skill-catalog-window-projection.ts)、[builtin](../../../packages/core/src/skills/builtin.ts)、[索引渲染](../../../packages/core/src/skills/render.ts)。
- [动态命令](../../../packages/cli/src/commands/skill-command-source.ts)、[管理器](../../../packages/cli/src/skills/manager-controller.ts)、[RPC client](../../../packages/rpc/src/skill-catalog-client.ts)。

维护时保护：来源隔离、索引预算与窗口稳定、中文 id、同名遮蔽、管理与加载视图、overlay 可见性、CAS 冲突、重复调用、失败不生效及恢复后目录一致。验证沿领域应用、权威 adapter、assignment adapter 和表面消费者，不以 mock Store 或文件存在代替生产提交证据。
