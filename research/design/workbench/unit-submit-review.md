# 单元独立审查工作台

> **维护原则**
>
> - 以独占一行的“审查清单”标题为界：此前为静态区，保存长期稳定的规则；该标题及其后为动态区，保存当前开发单元的独立审查内容。
> - 动态区只固定“当前状态”“来源覆盖”“审查项”“P0/P1 阻断问题列表”“非阻断级问题列表”及其空表。来源分类、审查分区和审查项均须按当前单元重新生成，不得继承上一单元。
> - 历史动态区统一归档到 `research/design/workbench/unit-review-checklists/<module-id>/unit-<N>.gen-<G>.md`，避免跨模块同号单元冲突。
> - 重置步骤：从独占一行的“审查清单”标题起，将当前动态区原样写入同路径的 `.pending` 文件，完整校验单元身份、全部数据行及两类问题列表（包括空表）后原子改名为正式归档；正式归档已存在时，内容一致则复用，不一致则停止。归档完成后，才将当前状态改为下一单元，删除全部来源分类、审查分区和数据行，只保留固定空表，并将进度恢复为 `0%`。
> - 提示词由用户维护；未经用户明确授权，不得新增、删除或修改提示词，规则变化也不得自动同步到提示词。

## 一、定位、范围与质量责任

本工作台用于开发单元完成后的独立审查。审查清单是本单元必做审查动作的有限集合，不是所有可能风险的全集；它同时依据权威架构、单元边界和当前完整交付物生成。在其他交付门禁均已满足的前提下，只有清单覆盖完整且每项通过，才能判定单元可以提交。

审查清单必须从架构目标、单元边界和当前完整交付物推导，覆盖范围包括但不限于全部生产端与消费端、生产装配与拓扑、状态生命周期、异常与恢复、并发、安全、资源上界、非默认配置、边界条件、兼容性、验收条件及其验证证据。模块目录内文档及其声明为规范依据的项目文档必须全部进入来源判定；每份来源逐章判定，适用章内的规范性条款和枚举行还须逐条归入审查项，不适用则写明事实依据。不得只枚举已知适用章节，或以“已有映射”替代映射充分性核查。不得只围绕已知问题、最新改动或容易观察的路径制定；任何未判定来源、章节、条款、枚举行或未纳入清单的功能链和风险面都属于范围缺失。

每个审查项必须限定对象、边界和停止条件，能够在有限成本内独立判定并给出可复核证据；“系统横扫”“全部覆盖”“至少组合”等开放表述必须改写为有限闭包或明确清单。无法判定的适用要求必须拆分或改写，只有事实证明不适用或重复时才能删除。

审查项只描述功能、架构、风险与稳定的通过条件。构建或测试的当次结果、命令状态、任务进度、当前指纹及 Git 工作区或暂存区状态只作流程状态或证据，不得建立为独立功能审查项。

每轮独立审查必须逐项执行完整清单并记录结论。发现问题只登记，不得提前结束；整轮完成后一次性汇总全部真实问题。清单未走完、存在未判定项，或发现交付边界尚未进入清单时，不得给出通过结论。

## 审查清单定稿条件

清单同时满足以下条件即定稿，停止继续补充：

1. 本单元适用的规范性要求与交付物的全部功能链均有承载项；不适用项均有事实依据；没有超出本单元边界的条目。
2. 每个审查项范围有限、可独立判定并能给出可复核证据。
3. 已知失败模式、排除项重开条件和迟发现教训的适用检测动作均有落点。

定稿审查只接受范围遗漏、范围越界或条目不可判定三类问题；仅更换审查视角、假设未知风险、改善措辞或提出非必要增强，不得推动清单继续扩张。三类问题清零后，清单审查结束，不得重复发起。

## 问题等级与通过标准

| 等级    | 含义                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------ |
| P0 阻断 | 导致受支持的核心路径无法正常运行，或造成权限失守、数据丢失、耐久性破坏、不可恢复停摆；提交前必须解决。 |
| P1 严重 | 在明确但受限的场景造成重要功能失败或高风险架构债务；核心路径仍可运行，但提交前必须解决。               |
| P2 一般 | 局部影响健壮性、性能、资源回收或可维护性，不破坏核心正确性、安全性和耐久性。                           |
| P3 轻微 | 仅影响低价值体验、诊断或代码质量，不影响功能正确性。                                                   |

审查项完成且无 P0/P1 时标为通过；发现 P0/P1 时标为有问题并登记。P2/P3 只进入非阻断问题列表，不改变审查项的通过状态。全部审查项完成且 P0/P1 列表为空，即判定独立审查通过。

## 二、独立审查清单提示词

### 2.1 生成独立审查清单

```
完整读取当前单元的架构总纲、可执行规格或执行计划、上下游合同、验收要求及当前完整交付物，确认单元身份、边界和生产装配关系。存在架构总纲时以其为最高依据，审查范围不得偏离或弱化架构设计。

按照本工作台“定位、范围与质量责任”，为当前完整交付物生成独立审查清单并写入动态区。该清单全部通过即表示本单元可以提交，因此必须覆盖整个单元，不能只围绕现有实现、最新改动、默认路径或已知问题；交付物缺少架构要求的实现，也必须形成审查项，不得借现状缩小范围。

先枚举全部规范来源，并逐章判定“适用”或“不适用”；适用章内的规范性条款和枚举行逐条归入审查项，不适用项写明事实依据。再沿当前交付物的完整功能链核对生产端、消费端、共享原语、装配与拓扑、状态生命周期、异常恢复，以及适用的边界条件、非默认场景、并发、安全、资源、兼容性和验收证据，拆成范围有限、可独立判定并能记录证据的审查项。

存在未判定来源、章节、条款、枚举行或功能链，存在范围遗漏、越界、重复、含糊或无法独立判定的条目，或架构不足以确定审查边界时，清单不得定稿；架构空洞必须明确登记，不得用实现假设补齐。本任务只生成并定稿审查清单，不执行审查，不修改实现；完成后立即停止。
```

### 2.2 审查“独立审查清单”

```
审查“独立审查清单”中的审查点，范围是否满足“全部通过就可提交”的要求，坚决不能出现全部通过，但是还有遗漏问题的情况。
同时范围不能超过本单元边界；
满足“审查清单定稿条件”立即停止；
```

### 2.3 执行独立审查

```
完整读取当前单元的权威架构、单元边界、当前完整交付物及已定稿的“独立审查清单”，以清单当前状态确定本轮范围。开始时若仍存在 `[!]`，说明阻断问题尚未完成转存、修复或状态更新，立即停止并报告；否则审查全部 `[ ]` 和 `[~]` 项，直接复用 `[x]` 项，禁止重复审查。

逐项完成本轮应审内容，不得跳项、合并或因发现问题提前结束；只报告基于事实的真实问题，审查期间不得修改实现。每完成一项，立即更新状态、证据和当前进度：存在 P0/P1 时标为 `[!]`；不存在 P0/P1 时标为 `[x]`，P2/P3 不改变该项通过状态。

审查期间不登记问题列表。全部应审项完成后，统一分析本轮发现的问题，将同一根因及其上下游影响合并为一个问题，避免重复登记表象。P0/P1 写入“P0/P1 阻断问题列表”；P2/P3 写入“非阻断级问题列表”，并写明问题、影响、最优解决方案、工作量和评级。全部审查项为 `[x]` 且 P0/P1 为空时，判定独立审查通过。
```

### 2.4 转入问题列表

```
先读取《单元审查与修复工作台》的静态规则。若本单元尚未登记，按其中“单元状态与登记协议”完成登记并更新当前单元指针；随后读取本单元文件中“问题列表”的维护规则、字段与状态约定。

将本轮独立审查登记在《单元独立审查工作台》“P0/P1 阻断问题列表”和“非阻断级问题列表”中的全部问题，转入《单元审查与修复工作台》当前单元正式文件的“问题列表”。写入前，先读取目标“问题列表”的维护规则、字段与状态约定，并严格按其格式登记。

每个根因只保留一行；与已有问题同根时更新原记录，不得重复新增。每行必须写齐事实与证据、根本原因、完整影响面、受影响审查项、最优解决方案与验收条件、状态，并保留问题等级和工作量判断。

最优解决方案必须面向执行者，用最少的文字说清改什么、怎么改、关键边界以及做到什么算完成；不得长篇大论，也不得省略他人直接执行所需的具体步骤。

确认全部问题完整写入后，删除两个独立审查问题列表中的原记录，禁止两处重复维护。不得修改实现；完成转移与一致性核对后立即停止。
```

### 2.5审查问题列表

```
审查一下本单元登记文档的问题列表，挨个核查每一个问题，判断：
1、这个问题是否真正找到了根本原因，还是说只是一个问题表象，如果是表象的话，修复完之后会导致这个问题没有被彻底解决，带来低效率的重复修复工作
2、以"首席产品官 +乔布斯直觉判断这个问题的解决方案是否符合最优架构设计和最优方案的标准？

首次审查时，逐项核查全部问题；审查时，只复审上一轮发现问题且已经修改的条目。已经明确通过且内容、依据与影响面未变化的条目直接复用结论，不得重复审查；

有问题统一告诉我，没有问题直接简要回复；
```

### 2.6

```
```

## 审查清单

### 当前状态

- **当前单元**：第 24 单元 · generation 1
- **架构来源**：分布式运行时总纲与可执行规格；持续在线需求；scheduler、server、统一核心、常驻服务、消息 outbox、确认交互、远程确认、远程中断与内置工具的上下游合同；第 23 单元边界、排除项与迟发现教训
- **交付基线**：`HEAD` 至当前工作区的 68 个单元功能文件（Feishu 6、CLI 27、core 16、executor 4、owner-kernel 10、server 4、规格 1）；两份工作台文件不计入功能交付闭包
- **交付指纹**：待交付物冻结后登记；清单定稿不以当次指纹作为功能审查项
- **目标提交边界**：第 24 单元（S6）中继、渠道确认与最终性整合的生产实现、直接相关测试与规格补充
- **当前任务进度**：100%
- **状态约定**：`[ ]` 未审；`[x]` 已完成且无 P0/P1；`[!]` 存在 P0/P1 阻断问题；`[~]` 输入变化，须重审，证据栏仅保留旧基线事实，不代表当前结论

### 来源覆盖

| 来源                                                                   | 判定     | 归入审查项或不适用依据                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `distributed-runtime-charter.md` 一、二                              | 适用     | 架构目标、需求与产品边界归入 IR24-01、IR24-12～IR24-15、IR24-23。                                                                                                                                                                               |
| `distributed-runtime-charter.md` §1～§4                            | 适用     | 架构结论、角色、包边界、设备网格与安全归入 IR24-01、IR24-02、IR24-14～IR24-16、IR24-21。                                                                                                                                                        |
| `distributed-runtime-charter.md` §5～§8                            | 适用     | 权威、派发、路由和双平面无损流为本单元主体，归入 IR24-03～IR24-18。                                                                                                                                                                             |
| `distributed-runtime-charter.md` §9                                 | 不适用   | 本地域 owner、收编、迁居与备份由第 30 单元及后续单元承载；本单元只验证未提前引入这些能力，归入 IR24-23。                                                                                                                                        |
| `distributed-runtime-charter.md` §10                                | 部分适用 | 凭据不泄漏、角色启停和未启用角色零加载适用，归入 IR24-14、IR24-16；托管服务、迁居、卸载与发布由后续单元承载，归入 IR24-23。                                                                                                                     |
| `distributed-runtime-charter.md` §11～§13                          | 适用     | provisional/committed、异常可见性、故障与安全矩阵，以及不变量 5～7、11～14、16～18 归入 IR24-12～IR24-22；其余不变量仅作既有合同回归，归入 IR24-20。                                                                                            |
| `distributed-runtime-charter.md` §14～§15                          | 部分适用 | S6 及其验收适用，归入 IR24-01、IR24-22；S7～S10 不适用，后续节点不得提前开放，归入 IR24-23。                                                                                                                                                    |
| `specification.md` §1                                               | 适用     | 标识、epoch、时钟、JCS、digest、签名域、符号映射与错误形态归入 IR24-02、IR24-03、IR24-16。                                                                                                                                                      |
| `specification.md` §2                                               | 部分适用 | §2.2 渠道凭证族和 §2.5 生产 mesh 装配适用，归入 IR24-02、IR24-05、IR24-06、IR24-09、IR24-10、IR24-14～IR24-16；§2.1、§2.3、§2.4 仅作既有信任与秘密合同回归，归入 IR24-16、IR24-20。                                                        |
| `specification.md` §3                                               | 部分适用 | 既有权威端口、RunExecutor/RunSubmission guard 与进程内/mesh 同构被本单元消费，归入 IR24-03、IR24-14～IR24-16、IR24-21；不新增第二套端口语义。                                                                                                   |
| `specification.md` §4                                               | 适用     | §4.3 的 stream、challenge、cursor、grant 与状态记录及 §4.4～§4.5 原子提交、保留和回收适用；§4.1～§4.2 作为 spool、journal、ref 的既有物理原语回归，归入 IR24-03、IR24-04、IR24-07、IR24-08、IR24-11、IR24-18～IR24-20。                    |
| `specification.md` §5                                               | 部分适用 | §5.1、§5.5、§5.6 全部适用，§5.2、§5.4 作为既有 assignment/commit 栅栏输入适用，归入 IR24-03～IR24-18；§5.3、§5.7 无新增能力，仅归入 IR24-20 回归。                                                                                       |
| `specification.md` §6                                               | 部分适用 | §6.1、§6.2 全部状态行作为 status/final、取消、过期与 uncertain 的投影输入，归入 IR24-12、IR24-17、IR24-19；§6.2b 不向用户渠道投影，§6.3 与设备状态部分由后续单元承载，归入 IR24-23；§6.4 的 uncertain 开闭输入归入 IR24-12。               |
| `specification.md` §7                                               | 部分适用 | 本单元只消费当前会话/job 的保留与删除事实，归入 IR24-11、IR24-18、IR24-20；转移、检查点备份与本地域 owner 由第 30 单元及后续单元承载，归入 IR24-23。                                                                                            |
| `specification.md` §8～§9                                          | 部分适用 | §8 的 allow-once、渠道入站/外发和状态落点，以及 §9 的当前锚点域 conversation/job 能力适用，归入 IR24-03、IR24-09、IR24-10、IR24-12、IR24-13；本地域 owner、转移和备份能力不适用，归入 IR24-23。                                               |
| `specification.md` §10                                              | 部分适用 | 既有 workload/capacity 治理与本单元 spool 背压、回收上界的交界适用，归入 IR24-18、IR24-20；本单元不重做第 23 单元治理合同。                                                                                                                     |
| `specification.md` §11                                              | 适用     | provisional/committed、离线与失败提示、渠道来源约束归入 IR24-12、IR24-13、IR24-19。                                                                                                                                                             |
| `specification.md` §12                                              | 适用     | 本单元适用的不变量、故障行和安全对抗行逐行归入 IR24-14～IR24-22；结构性验收不得由源码描述或各自 happy path 代替。                                                                                                                               |
| `specification.md` §13                                              | 适用     | 本单元受影响的模块文档与验收来源归入 IR24-20、IR24-22、IR24-24。                                                                                                                                                                                |
| `specification.md` §14                                              | 不适用   | S1 开工顺序已由前置单元完成，本单元不重开；仅由 IR24-20 防止行为回归。                                                                                                                                                                          |
| `specification.md` §15                                              | 部分适用 | 第 24 项及其依赖顺序全部适用，归入 IR24-01～IR24-24；其余执行项只用于确认前置能力已复用、后续能力未提前开放，归入 IR24-20、IR24-23。                                                                                                            |
| `transcript-persistence-and-attention-window-architecture.md` 一～三 | 部分适用 | 既有 RunRecord/SealedBundle 与历史补读边界是 final 合并的输入，归入 IR24-12、IR24-20；window 与 MemoryFlush 的 S7 改造不属本单元，归入 IR24-23。                                                                                                |
| `agent-runtime-lifecycle.md` 一～十四及附录                          | 部分适用 | 权威提交前后写类 hook 的既有时序只作回归，归入 IR24-20；S7 生命周期改造和首个消费者不属本单元，归入 IR24-23。                                                                                                                                   |
| `permission-architecture-evolution.md` 全文                          | 不适用   | TrustRule、PermissionSnapshotLease 与资产化权限已由 S4 承载；本单元的 channel token/grant 走`specification.md` §2.2/§5.6，未修改权限规则或租约。                                                                                            |
| `workscene-management-architecture.md` 全文                          | 不适用   | workscene 与设备域环境绑定由第 25 单元及 S7 后续单元承载，归入 IR24-23。                                                                                                                                                                        |
| `task-advancement-rubric-architecture.md` 全文                       | 不适用   | advancement 取证、裁判和控制接入由 S7 后续单元承载，归入 IR24-23。                                                                                                                                                                              |
| `always-online-and-local-execution-requirements.md` 一～七           | 适用     | 七章共同提供持续在线、就地执行、断线诚实降级及异常可见的产品依据，归入 IR24-05、IR24-12～IR24-15、IR24-18～IR24-20；字段级合同以总纲和规格为准。                                                                                                |
| `s2-security-supply-chain-review.md` 全文                            | 不适用   | 该文只约束`@zhixing/mesh` 的 S2 外部安全依赖；本单元未修改依赖清单、包清单、锁文件或 mesh 包，且未引入外部依赖。                                                                                                                              |
| `scheduler-architecture.md` 一～三、待根治项                         | 部分适用 | 单一调度权威、job owner 与现役 scheduler/delivery 边界归入 IR24-07、IR24-10、IR24-12～IR24-14、IR24-20；CRUD、定时触发产品闭环和技术债专项由第 26 单元承载，归入 IR24-23。                                                                      |
| `unified-core-and-access-surfaces.md` 一～三                         | 适用     | 单一核心、surface 投影、单写者、接入面来源与生命周期归入 IR24-03、IR24-09、IR24-12～IR24-15、IR24-20。                                                                                                                                          |
| `unified-core-and-access-surfaces.md` 四                             | 不适用   | 既有分阶段实施计划已完成，本单元只核对其稳定合同不回归，归入 IR24-20。                                                                                                                                                                          |
| `selection-module-architecture.md` 全文                              | 不适用   | 该文承载`/stop` 多目标选择服务；本单元不修改 SelectionService 或运行控制选择，只复用 ConfirmationBroker 的既有安全边界。                                                                                                                      |
| `server-gateway.md` 一～八、十                                       | 部分适用 | 通道两层接口、入站路由、跨通道确认、飞书回调及 server 安全适用，归入 IR24-09、IR24-13～IR24-16；竞品说明和未采用通道不形成实现义务。                                                                                                            |
| `server-gateway.md` 九、十一～十四                                   | 部分适用 | 生产路线中既有 server/channel 装配、核心类型和文件边界作为回归输入，归入 IR24-14、IR24-20、IR24-21；OpenAI API、历史决策说明和未进入单元的路线不适用。                                                                                          |
| `persistent-service.md` 一～三、五～六、八～九                       | 部分适用 | 统一常驻内核、server/channel 模式、进程收束和事件流适用，归入 IR24-09、IR24-12～IR24-15、IR24-20；竞品背景不形成独立义务。                                                                                                                      |
| `persistent-service.md` 四、七、十～十三                             | 部分适用 | §4.7 现役 DeliveryPipeline 和 scheduler 边界适用，归入 IR24-13、IR24-20；scheduler 产品闭环、daemon、路线图与历史决策不在本单元，归入 IR24-23。                                                                                                |
| `message-outbox.md` 一～三、六、九～十                               | 部分适用 | 因果顺序、turn-slot、失败恢复、测试策略和非目标归入 IR24-08、IR24-12、IR24-13、IR24-17、IR24-19；slot 超时、入口`finally` abandon 等旧收口语义已被 `specification.md` §5.5 的权威 item/明确空终态规则取代。                                |
| `message-outbox.md` 四～五、七～八、附录                             | 部分适用 | CLI/server 共用边界与既有组件影响仅作回归，归入 IR24-20、IR24-21；历史实施阶段、竞品对照和本单元无关的 tool commitment 不形成新增义务。                                                                                                         |
| `007-message-outbox.md` 全文                                         | 部分适用 | 已接受的 Outbox 顺序层、turn-slot 因果关系、per-target 粒度和 CLI/server 共用原语适用，归入 IR24-12、IR24-13、IR24-20；slot 任意终态/TTL 释放的旧细节由`specification.md` §5.5 收窄，tool-authored commitment 与历史替代方案不形成新增义务。 |
| `conversation-model.md` 一～六、十～十二                             | 部分适用 | Conversation 单一事实源、通道平权、TurnId/turn-slot、渠道接入和 scheduler 来源关系适用，归入 IR24-03、IR24-09、IR24-12、IR24-13、IR24-20；本单元不改变 Conversation/Session/Turn 的既有身份模型。                                               |
| `conversation-model.md` 七～九、十三～十四                           | 不适用   | CLI/server 会话生命周期、transcript 物理格式、历史路线与决策未被本单元修改，仅由 IR24-20 防止现有行为回归。                                                                                                                                     |
| `conversation-model.md` 十五                                         | 不适用   | 术语表不包含独立规范性要求。                                                                                                                                                                                                                    |
| `confirmation-ux.md` 一～五、七～八、十一                            | 适用     | renderer-independent broker、pending 队列、decision、非交互兜底、安全接入和既知风险归入 IR24-03、IR24-08～IR24-10、IR24-16、IR24-17。                                                                                                           |
| `confirmation-ux.md` 六、九～十、十二                                | 不适用   | TTY 细节、历史路线、竞品与术语表不属于渠道确认链；稳定 broker 行为由适用章节承载。                                                                                                                                                              |
| `remote-confirmation-execution.md` §0、§2～§5、§7、§9           | 适用     | 现役文本远程确认、Hub/Broker 与 InboundRouter 合同和本单元签名 challenge/grant 属同一功能面；替代、保留或清退关系归入 IR24-09、IR24-13、IR24-20、IR24-23，生产路径不得形成第二套确认语义。                                                      |
| `remote-confirmation-execution.md` §1、§6、§8、§10               | 不适用   | 竞品对比、工作量、未来扩展和术语表不形成当前功能义务。                                                                                                                                                                                          |
| `remote-interruption-execution.md` §0～§7                          | 适用     | cancel 必须先于 confirmation reply 分类，远程 abort、队列清理和反馈单源不得被新 callback 路径破坏，归入 IR24-09、IR24-17、IR24-20。                                                                                                             |
| `remote-interruption-execution.md` §8                               | 不适用   | 后续工作锚点不属于本单元。                                                                                                                                                                                                                      |
| `interruptible-agent-loop-execution.md` §0、§2～§5、§7、§9      | 部分适用 | 远程中断继承的 controller、AbortReason、清理与 partial 保留合同作为渠道 callback/cancel 交界回归，归入 IR24-17、IR24-20。                                                                                                                       |
| `interruptible-agent-loop-execution.md` §1、§6、§8、附录          | 不适用   | 竞品、已完成里程碑、文档维护与参考实现不形成本单元新增义务。                                                                                                                                                                                    |
| `tools-builtin.md` 一～四、七                                        | 部分适用 | 工具自描述安全边界、权限声明、运行时注册与模块关系决定远程 allow-once 的准入对象；新渠道确认不得绕过或改写这些合同，归入 IR24-09、IR24-16、IR24-20。                                                                                            |
| `tools-builtin.md` 五～六、八                                        | 不适用   | web_fetch 内部实现、system prompt 引导和未来扩展未被本单元修改；其通用确认行为已由适用章节承载。                                                                                                                                                |
| `security-system.md` 设计哲学、架构总览、一～七                      | 部分适用 | ConfirmationBroker 与 SecurityPipeline 的既有决策、队列、审计和执行守卫边界适用，归入 IR24-03、IR24-09、IR24-10、IR24-16、IR24-20；本单元不得以渠道 callback 绕过安全决策。                                                                     |
| `security-system.md` 八～十                                          | 不适用   | Shell 策略、历史实施计划和竞品对比不属于本单元。                                                                                                                                                                                                |
| `unit-development-workbench.md` 第 24 单元                           | 适用     | 已定稿的 D24-01～D24-10、单元边界和明确排除逐项归入 IR24-01～IR24-24；开发事项的`[x]` 仅说明实现与测试代码已完成，不作为审查结论。                                                                                                            |
| 第 23 单元边界与排除表                                                 | 适用     | X23-03、X23-11 的重开条件及第 21～23 单元冻结边界归入 IR24-18、IR24-20、IR24-23、IR24-24。                                                                                                                                                      |
| 第 23 单元迟发现教训表                                                 | 适用     | L23-01、03、05～09、11、13～14、23～27、32、35、41、44～50、52～56、58～59 的检测动作归入 IR24-02～IR24-22、IR24-24；其余未命中本单元重开条件。                                                                                                 |
| 当前完整交付物（68 个功能文件）                                        | 适用     | 6 个 Feishu、27 个 CLI、16 个 core、4 个 executor、10 个 owner-kernel、4 个 server 和 1 个规格文件逐一归入 IR24-01～IR24-24；两份工作台变更属于流程维护，不计入本单元功能审查。                                                                 |

### 审查项

| 编号    | 状态 | 审查点                                    | 完整范围与通过条件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 证据与结论                                                                                                          |
| ------- | ---- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| IR24-01 | [!]  | 单元边界与交付闭包                        | 将 68 个功能文件逐一归入后续审查项；核对新增导出、构造器、生产者、消费者和组合根均有唯一落点。只包含 S6 中继、渠道确认、最终性及直接测试/规格，不漏实现，也不夹带第 25 单元及以后能力。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 当前交付物仍缺 job 交互派生义务的完整恢复闭包：stream-only 欠账不会被恢复索引枚举，取消恢复也未冲刷 mirror；同根 P1 待本轮统一登记。 |
| IR24-02 | [x]  | 协议原语、规范字节与严格校验              | 对 conversation/job challenge token、job grant、prepared/delivered/closed、relay cursor/granted、status/finality 记录逐一核对封闭判别联合、JCS/digest、域分离签名、逐字段反绑、未知字段拒绝和稳定错误分类；所有 builders、对象字面量、wire codecs 与测试夹具使用同一合同。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 当前 token、grant、challenge/cursor、settlement 记录均走封闭类型、规范摘要、严格 validator 与字段反绑；未发现 P0/P1。 |
| IR24-03 | [x]  | 权威、幂等与唯一事实源                    | pending/finished 只由 executor assignment 流权威决定；relay/outbox/status 仅作投影。conversation allow-once、job grant、callback、control 和重复请求均按耐久键先完整比对再回放原结果，禁止在回放前重新验当前时钟、资格、随机数或产生外部副作用。对短期能力接管固定核对 fresh、已耐久接管未完成、已完成三态及首段 fsync 后跨 TTL/吊销重试，接管后不得退回 fresh 资格。                                                                                                                                                                                                                                                                                                                                                                                                                                           | assignment/job journal 仍是唯一业务事实源；callback、grant 与答复重放先核对耐久 winner，派生结构未取得权威写权；未发现 P0/P1。 |
| IR24-04 | [x]  | 无损 stream、spool 与摘要链               | 核对 assignment 全生命周期绝对连续 seq、streamEpoch 仅 fencing、数据帧摘要域、链外 provisional-final、三处 finalSeq 全等、先落 spool 后发送、逐 consumer ACK/重放，以及 inline/ref 阈值和稳定拒绝；崩溃恢复不得重置序列或放弃摘要校验。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | writer、spool、mesh codec、verifier checkpoint、稳定 sourceId 与逐 consumer ACK 合同保持一致；未发现 P0/P1。 |
| IR24-05 | [x]  | 直连、中继与路径降级                      | 第一方 surface 可安全直连时走 direct，仅在不可达或中断时 relay；正反切换均复用同一 assignment、consumer、checkpoint、seq、digest 与 ACK 水位。核对旧 epoch/迟到帧、连接竞态、恢复失败回滚和重连续订，任一路径不得丢帧、重帧或改变授权/终态。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | surface-owned path manager 仍以独立 direct/owner-relay 连接共享同一消费身份与 checkpoint，失败分类未被本批改动弱化；未发现 P0/P1。 |
| IR24-06 | [x]  | 数据面票据与 ref 读取授权                 | surface ticket 的签发、受众、scope、ref/assignment、续签、撤销、自然过期和 abort 权限逐点一致；job owner-relay 不伪造 surface ticket。interaction ref 只能由持有该帧有效 consumer auth 的主体经既有 probe/read 读取，票据不得下发渠道或写入展示载荷。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | ticket registry、owner-relay 独立授权、ref probe/read 与 consumer 资格仍逐字段反绑；job 路径未伪造 surface ticket；未发现 P0/P1。 |
| IR24-07 | [x]  | job owner-relay 游标与 ACK 线性化         | owner-control principal/ControlLease、`(assignmentId, authority)` 逻辑水位、完整 verifier checkpoint、`afterSeq=upToSeq` 和服务端从下一帧返回均一致。requested 必须同 envelope 写 prepared+cursor 后 ACK，finished 写 closed+cursor 后 ACK；重启先重发最新 ACK，lease/连接轮换不重置水位。owner/assignment 的 current、unknown、revoked/deleted、stale epoch/lease 四态以及回退、越界和跳帧逐项拒绝，存在性不得由“未见撤销”推断。                                                                                                                                                                                                                                                                                                                                                                         | JobOwnerRelay 从耐久 checkpoint 建立路径管理器，接管帧后再推进 ACK，lease 轮换仅更新消费授权；未发现 P0/P1。 |
| IR24-08 | [x]  | challenge outbox 生命周期                 | conversation/job 共享 prepared→delivered→closed 生命周期内核，但各域字段与授权不可混用；prepared fsync 后方可 ACK/发送，发送回执只审计，prepared−closed 在重启后以同一 challenge/token 有界重驱。发送失败、回执丢失、重复 callback、过期和取消均不产生第二 challenge、grant 或 pending；耐久写不确定后的恢复检查与下一状态操作必须位于同一串行或事务段。                                                                                                                                                                                                                                                                                                                                                                                                                                                     | conversation/job 共用耐久 outbox 生命周期，job relay 以 journal 恢复 pending challenge/grant；发送与回调不取得第二权威；未发现 P0/P1。 |
| IR24-09 | [x]  | conversation 渠道确认闭环                 | 核对渠道宿主 principal、owner 签票、requested 接管、规范 display、prepared/ACK/send 顺序、平台认证 callback、responder 与 ingress 绑定、allow-once 和 executor resolve 的完整生产链；第一方与渠道决策等价，旁观者不可代答，票据与内部拓扑信息不泄漏。逐入口裁决旧 TextConfirmationRenderer/Hub 文本回复与签名 challenge callback 的替代或保留关系，生产路径只允许一套确认权威和应答语义。                                                                                                                                                                                                                                                                                                                                                                                                                       | 渠道 principal、ticket、prepared/outbox、平台 responder 与 executor answer port 已形成一条生产链；degraded 配置稳定拒绝互动而保留消息能力；未发现 P0/P1。 |
| IR24-10 | [x]  | 定时 job 渠道 grant 闭环                  | job requested 先验证`expiresAt=issuedAt+ttlMs` 并换算单调 deadline，token 不晚于该期限；callback 后先耐久写唯一 signed grant，再以 host principal 转交。executor 分别验证 grant 与内嵌 job token，并以 `(assignmentId, interactionRequestId)` 单次完成；缺 origin/responder、渠道不可达、过期或任一校验失败统一 fail-closed 自动解决。                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | job grant 先写入 owner journal，再由 pendingChannelGrantDeliveries 重驱 executor；最终入口复验 execution、owner key 与全字段绑定；未发现本项 P0/P1。 |
| IR24-11 | [x]  | interaction display 单源与资产生命周期    | display 在写 assignment 前一次确定 inline/ref，assignment、StreamFrame、prepared、token digest 与摘要链复用同一对象；ref 的 digest、长度、JCS、结构和 assignment 来源均校验。pending 阻止回收，finished 经 closed+cursor 后 ACK，再按 spool 生命周期退休；重驱不得重新内联、重算或换发 token。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | preparation、assignment/frame/prepared 复用同一 display；ref materialization 绑定 consumer 与 assignment，重驱不重算；未发现 P0/P1。 |
| IR24-12 | [x]  | 状态、provisional 与权威终态合并          | conversation 按 runId/commitRevision 合并 live 与 history，仅匹配 sealed digest/finalSeq 的 FinalFrame 转正；job 按 ExecutionRef/statusRevision 合并且 committed 只经冻结 delivery plan 投递；delivery 按稳定 itemId/statusRevision 合并。三域 revision、uncertain 开闭、乱序缓冲、去重、断线补读、冻结文案和裁决动作各自成立。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | FirstPartyFinalitySession 将 history/live 串行送入同一 projection，消费者成功后才推进 revision；三域按稳定 subject key 全等续读，失败要求 resync；未发现 P0/P1。 |
| IR24-13 | [x]  | 渠道外发、来源绑定与 turn-slot 顺序       | 渠道只接收原 turnOrigin 白名单状态和结果，禁止跨渠道广播；DeliveryAuthority 保持唯一投递事实源。turn-slot 仅在对应权威 final/status item 耐久接管或明确空终态后关闭，`afterSlot` 恒在其后；第 26 单元前保留现役 scheduler/DeliveryPipeline 路径，不新增第二投递语义。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 当前改动未引入第二投递事实源；job committed 仍经冻结 DeliveryOutbox，conversation frame 保留原 turnOrigin，现役 scheduler/DeliveryPipeline 未被提前退役；未发现 P0/P1。 |
| IR24-14 | [!]  | 生产装配、角色门控与生命周期              | 在唯一 CLI 组合根逐一核对 executor stream、ticket、owner relay/challenge、surface direct/relay、channel callback、status/final 与既有资产服务的生产实例、服务注册和依赖顺序。S6 只在闭环后原子启用；每个长期资源取得后立即进入统一启动回滚，正常停机逆序释放；所有后续失败点可回滚，未启用角色零加载、零监听。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | job worker 虽在启用 job runtime 时唯一创建并拒绝半启用，但其恢复生命周期未覆盖 stream-only 欠账，取消恢复又绕过 mirror 冲刷；同根 P1 待本轮统一登记。 |
| IR24-15 | [x]  | 单机/分布式同构与真实 adapter conformance | single-machine 与 distributed 只替换 adapter，不分叉业务状态机。共享 conformance 套件必须以同一输入/可比输出分别驱动真实进程内入口和真实 mesh client/handler，覆盖每个方法及拒绝分支；共同 fake 只能作 harness 依赖，不能替代任一侧生产语义。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | local/mesh 共用 AssignmentOperationsRouter、ledger 与 worker 状态机，mesh 仅承担认证编解码；S6 套件驱动 conversation 四组合、job 两组合及两类负组合；未发现 adapter 分叉 P0/P1。 |
| IR24-16 | [x]  | 安全、凭证与信息边界                      | 对 ticket/token/grant/callback 逐项执行伪签、错签发者/受众/domain/scope/ref/assignment/request/challenge/responder/displayDigest/decision、过期、重放和字段交换；平台身份只能由已认证 webhook 派生。秘密、票据、内部拓扑和未脱敏错误不得进入渠道、日志、wire 或持久投影；所有拒绝均在副作用前 fail-closed。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | callback 严格 DTO、token/grant 双重验签、durable execution/owner/request/display 全反绑与 mesh peer 授权均在副作用前执行；秘密保持 SecretStore 边界；未发现 P0/P1。 |
| IR24-17 | [!]  | 并发、竞态与单次完成                      | 固定核对五组竞态：direct/relay 切换与旧帧；重复 callback/grant 与转交丢失；callback 与取消/过期/finished；prepared/closed/ACK 与重启；live status/final 与历史补读。每组以耐久身份和线性化点证明至多一次准入、一次 decision、一次状态 revision、一次 slot 关闭，迟到输入只回放或拒绝；cancel control intent 恒先于 confirmation reply 分类，且不误吞签名 callback。                                                                                                                                                                                                                                                                                                                                                                                                                                             | callback/grant winner 本身至多一次，但“取消已认领 assignment”会抑制交互恢复且不冲刷 mirror，形成取消与交互半提交后永久不收敛的确定竞态；同根 P1 待本轮统一登记。 |
| IR24-18 | [x]  | 背压、保留与资源上界                      | 核对 64 MiB/assignment spool、32 KiB inline、512 KiB 单帧、慢 observer 半窗降级、24h 回收窗和有界 challenge outbox 重试的实际生产约束。assignment 终态、全部有效 surface 水位及 owner-relay final ACK 共同决定退休；pending interaction 阻止回收。反查`AssignmentStreamSpool` 生产启用是否触发 X23-11 的治理重开条件；以无关历史 challenge/record 增长做计数差分，证明 pending 扫描、drain、队列、缓存、timer 与消费者数量及单轮工作均有稳定上界。                                                                                                                                                                                                                                                                                                                                                            | spool/frame/inline/retention 常量、分页维护、稳定 workKey 与叶级容量准入仍成立；challenge/outbox 重试有封顶退避，未发现新的 P0/P1 上界问题。 |
| IR24-19 | [!]  | 故障、崩溃与恢复闭环                      | 逐点核对 direct 断开、relay 断开、ACK 丢失、owner/executor/channel 重启，以及 prepared、cursor、send、delivered、closed、final/status 接管前后崩溃；磁盘满或耐久写失败不得提前 ACK、关闭 slot 或丢义务。每个故障用例必须证明注入命中，恢复后零第二事实、零伪 pending、零静默丢失且最终可收敛。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 两个确定崩溃窗未闭合：mirror 成功而 stream 未投影时恢复索引会跳过；取消在 interaction-finished 后、mirror 前崩溃时取消恢复不会补 mirror，proof 可永久缺失；同根 P1 待本轮统一登记。 |
| IR24-20 | [x]  | 前置能力、兼容性与既有功能回归            | 复核第 21～23 单元 stream/spool、ticket、surface asset、WAL/索引和容量治理合同未被削弱；所有新增必填字段、严格 validator 和共享合同覆盖最终验证闭包内的生产者、消费者与手写夹具。核对旧耐久数据/wire 的确定行为、现有单机对话、Feishu、第一方确认、远程文本确认/中断和 scheduler/DeliveryPipeline 仍可用或已由明确唯一的新路径取代，并重新裁决 X23-03、X23-11 的重开条件。                                                                                                                                                                                                                                                                                                                                                                                                                                      | 本批复用既有 spool/WAL/索引/容量原语，未改持久格式；Feishu degraded 兼容、旧文本确认/中断与 scheduler/DeliveryPipeline 边界保留；未发现 P0/P1。 |
| IR24-21 | [!]  | 包依赖、导出与组合根所有权                | core 只承载纯协议/状态原语，owner-kernel 承载权威记录，executor 承载 assignment/spool，server/Feishu 只做接入，CLI 是唯一产品组合根；server 与 executor 零互相 import。每个新增 export 要么被 S6 生产链消费，要么被 IR24-23 明确为后续单元接缝；每个周期/后台任务有唯一且在适用拓扑必然创建的 owner，不得由可选 mesh/channel/surface 组件独占权威义务。                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 包职责与组合根方向正确，job worker 也在启用 job 能力时唯一创建；但 stream-only 欠账没有可被 worker 枚举的耐久义务身份，取消路径又独占认领而不完成 mirror，仍存在无人 owner；同根 P1 待统一登记。 |
| IR24-22 | [!]  | S6 结构性验收证据                         | 建立有限验收账本：总纲不变量 5、6、7、11、12、13、14、16、17、18；§12 中数据面断/控制面断、owner 崩溃、final 未投递、渠道重投/响应丢失/重连、版本与时钟偏斜；安全矩阵中票据、盲中继、原始接入面和权威越权。固定六条生产组合：第一方 surface 的真实 direct 与 owner-relay；conversation 渠道的 owner→本地/远程 executor；job 渠道的 owner→本地/远程 executor。固定两条负组合：job 无渠道来源/应答者时自动解决、conversation/job 凭证或 consumer 跨域使用时拒绝。conversation 组合绑定同一次执行自然产生的 status、provisional-final 与 committed FinalFrame；job 组合绑定同一次执行自然产生的 status、result 与 DeliveryOutbox 状态；逐条驱动生产工厂、journal/reducer 及真实 in-process/mesh client-handler，fake 仅限外部平台、时钟与密码学边界，不能以手工构造终态、组件 happy path 或描述性源码对账替代。 | 六条生产组合与两条负组合已有同套件承载，行为矩阵亦全键对账；但缺少能拦住“mirror 已齐、stream 独缺”和“取消认领后 mirror 未齐”两条崩溃窗的结构用例，因此存在 P1。 |
| IR24-23 | [x]  | 明确排除与后续单元承载                    | 逐项确认未实现或提前启用：第 25 单元 Environment/workscene；第 26 单元 scheduler CRUD、定时触发产品闭环及旧投递退役；第 27～29 单元模块接入；第 30 单元及以后本地域 owner、收编、迁居、备份、服务与发布。当前 S6 只提供这些后续能力所需的稳定接缝，不以占位实现或第二套语义代替。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | job runtime 仍以显式能力接缝启用，未实现第 26 单元触发产品面；Environment、后续模块、本地域 owner/迁移/备份均未提前进入交付；未发现 P0/P1。 |
| IR24-24 | [!]  | 来源、条款、交付物与教训反向对账          | 逐行核对本表每个来源判定均有 IR 落点，每个 IR 均能反向指向规范条款和有限文件/生产链；68 个功能文件无未归项。执行 L23-01、03、05～09、11、13～14、23～27、32、35、41、44～50、52～56、58～59 的检测动作，并对 X23-03、X23-11 给出维持排除或重开的事实；发现缺项时只能补入本单元边界内的有限条目。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 68 文件均有审查归属；L24-01 与 L24-03 已闭合，L24-02 的派生索引崩溃矩阵检测动作发现 index 未绑定 stream 投影完成证据，故本项存在同根 P1。 |

---

## P0/P1 阻断问题列表

> 每轮独立审查结束后，将发现的 P0/P1 问题统一登记于此。本表只保留尚未转入正式问题清单的待解决问题；确认转入后立即删除原记录，禁止两处重复维护。表为空即表示无待转入的阻断问题。

| 编号 | 问题描述 | 产生的影响 | 问题评级 | 相关审查项 |
| ---- | -------- | ---------- | -------- | ---------- |
| N24-02 | job 交互收敛 owner 的恢复判据不完整：`job-interaction-obligation` 派生索引只比较 finished 与 mirror 水位，不记录或核对 stream 投影进度；`JobAssignmentWorker.recover()` 又让 cancellation 认领压过 interaction recovery，而取消收束只 drain stream、不执行 `flushInteractionMirrors`。因此两条同根半提交路径没有 owner：mirror 已成功而 stream 未投影；interaction-finished 已写而取消发生在 mirror 前。 | executor 重启后可能永久缺失交互 stream 帧，或取消证明因 mirror 水位落后而永久无法生成；assignment 会长期卡在未收敛状态，违反零静默丢失、零永久等待和 must-complete 义务唯一 owner 合同。 | P1 | IR24-01、IR24-14、IR24-17、IR24-19、IR24-21、IR24-22、IR24-24 |

## 非阻断级问题列表

> 每轮独立审查结束后，将发现的 P2/P3 问题统一登记于此。本表只保留尚未转入正式问题清单的问题；确认转入后立即删除原记录，禁止两处重复维护。

| 编号 | 问题描述 | 产生的影响 | 最优解决方案 | 工作量评估 | 问题评级 |
| ---- | -------- | ---------- | ------------ | ---------- | -------- |
