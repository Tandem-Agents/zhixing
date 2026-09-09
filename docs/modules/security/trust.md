# 信任、授权与管理

本篇承载用户信任需求、规则生命周期和当前应用责任；通用安全机制见[安全架构](architecture.md)，确认选项与接入面见[确认交互](../confirmation/surfaces.md)。

## 必须保留的产品语义

1. 主对话与工作场景在权限层都是上下文，各有规则，不互相污染。
2. 用户主动进入工作场景表达信任意图；没有工作目录的场景也应获得相同的场景级便利。
3. 工作区和场景使用统一分级体系，不靠特殊目录补丁获得放行。
4. 放宽不是无限制。凭证、密钥及 Git 内部等明确安全底线不能因信任等级提升而消失。
5. 信任来源是用户意图与主动动作，不是系统凭空增长的信任分数。
6. 同时降低打扰和保持安全：确定性机制处理已知情况，独立安全助理只研判灰色操作，结果沉淀为可回溯、可撤销的上下文规则。

这是从“工作区内写入算 internal、外部一律问用户”演进而来的核心改变。工作区是用户信任的空间而非代码仓库专属概念；文件写入的实际影响不会因所在目录变化，授权便利也不应只惠及有目录的场景。

## 两个维度与两种作用域

操作影响由操作本身及边界决定，信任等级表达用户授权上下文，两者不互相替代。当前等级用于安全助理的判断输入，不是直接 allow 开关。

| 信任上下文 | 本次等级 | 不应误解为 |
|---|---|---|
| global | global | 全局永久授权 |
| workspace | 已解析目标路径全部位于信任目录内才为 workspace；无路径或任一路径越界为 global | 只要在该目录启动，所有命令都免确认 |
| scene | scene，不依赖工作目录 | 任意高危操作可以绕过底线 |

权限存储身份另用带标签的 `main`、`workspace(hash)`、`scene(sceneId)`。它回答“规则属于谁”，不等于本次操作的等级：workspace 中无路径操作可按 global 等级研判，但其自动沉淀仍属于当前 workspace 上下文。场景身份不使用目录代替，以免共享目录造成规则串用。

工作区来源由 Host／配置层确定，场景目录用于实际执行位置，不能由 Kernel 通过启动目录猜测产品身份。改变信任范围必须有用户授权；通用配置与热更新流程另属配置模块，不能仅凭本篇推定专用工作区修改入口已经实现。

## 唯一应用责任与规则生命周期

Trust Administration 的管理应用拥有 list/revoke 的上下文选择、可见性与错误语义；执行应用拥有批准转规则、模式建议、累计与沉淀。Host 适配持久化和运行时，SecurityPipeline 只读匹配。主执行与子执行通过同一运行时树的批准端口反馈，不各自创建第二套规则业务。

| 规则作用域 | 生命周期与来源 |
|---|---|
| session | 显式会话批准；运行时内存，不作为持久用户管理规则 |
| context | 当前 main/workspace/scene；显式上下文批准或自动沉淀，持久保存 |
| global | 用户明确选择跨上下文授权；自动沉淀不得生成 |
| builtin | 工具装配期的内存预置，不属于用户规则，不写入用户规则文件 |

`PermissionStore` 承担存储与匹配机制：用户池命中优先于 builtin 池，用户池内 deny 优先于 allow，再按特异性选择。权限匹配只作用于待确认决策，不能表述成全管线所有操作都必经一次用户 deny 检查。

持久身份使用 `main`、`workspace-<hash>`、`scene-<sceneId>` 对应上下文文件，global 独立；`contextPath` 是辅助展示，不是身份。存储机制保留既有格式读取与规范化，迁移文档不要求用户手工搬规则。运行时累计在执行应用内存中，重建后不能假定累计仍在；持久规则和累计不是同一种状态。

### 反馈与沉淀

用户 allow-once 或安全助理 safe → 按操作模式累计贡献 → 达阈值创建 context allow → 后续命中免重复研判；每次贡献保留 `user/steward` 与时间，显式持久批准记录用户来源，供追溯和撤销。进入场景提供信任背景，不直接建立所有操作的白名单。

当前低／中风险阈值为 3 次，高风险 10 次，critical 不沉淀；bypassImmune 不进入累计。阈值采用本次批准风险，累计最高风险仅作展示，不能误写为按历史最高风险决定阈值。明确逐次确认的工具不通过沉淀规避逐次拍板。

模式由 Trust 应用生成：Shell 提供精确命令及命令／子命令泛化，写入提供路径与目录模式，其他工具默认工具级通配。自动沉淀选择代表模式，不是模型随意生成权限表达式。旧稿“网络自动按 host 沉淀”不是当前通用实现；当前泛化也不能当作已经证明“所有危险变体均被排除”。底线与策略仍必须在规则命中前后各守其责。

## 独立安全助理

安全助理是信任机制未覆盖操作的研判器，不是另一个权限 owner。`secure-executor` 仅对需要确认、external、无匹配权限规则、无 bypassImmune 且有 main 模型的操作调用它；显式逐次确认工具直接交 Broker。

助理使用独立请求与专用系统提示，不带主对话历史或主 Agent 中间推理。设计要求输入来自用户原始意图、场景意图或传给子执行的顶层用户意图，再配客观操作事实；不能拿 Agent 自拟子任务冒充用户授权。

| 结果 | 行为 |
|---|---|
| safe | 放行并反馈信任应用 |
| needs-confirm | 交 Broker，研判理由用于说明 |
| escalate | 阻止 |
| 无模型、调用失败或不可解析输出 | 直接确认或保守退回确认，不因失败自动允许 |

非交互路径也先保留灰色研判机会；最终无人处理确认时由 Broker 的保守回退负责，不在 core 提前截断助理路径。确认拒绝与理由回流沿现有确认模块处理。

当前实现限制必须与目标区分：

- `consultSteward` 传入工具名、解析路径和 command，尚未填入接口支持的 hosts；不能宣称已向助理提供完整网络目标／全部业务参数。
- 实际研判读取 `turnContext.userIntent`；不能仅以增强执行上下文还存在 userIntent 就认定所有调用方均已补齐原始意图。
- 高置信放行和等级宽严由提示词表达，当前没有对返回 confidence 做数值阈值门禁。
- 助理自身没有独立超时或取消参数；异常捕获会退回确认，但不能将不返回的调用描述为必定限时降级。
- critical 禁止助理和沉淀，不等于当前实现已经禁止显式 allow 规则放行；差异见安全架构。

## 分布式执行与用户控制

锚点发布 TrustRuleSnapshot 资产并签发绑定版本／摘要的 PermissionSnapshotLease；assignment 在 received 前取得并验证快照。缺失资产按可恢复能力缺口处理，错签名、错摘要或越范围不得放行。

执行时使用该冻结规则集，不改读执行设备的当前规则。安全评估前验权并加载快照，等待确认或研判后，在实际副作用前再次验权，避免等待跨过租约期限。控制租约、吊销、fence 与恢复由现有分布式权威链处理；本机撤销规则不等于直接改写已签发快照。

显示用用户规则快照与执行用完整权限快照分开，后者还需承接适用的 builtin/session 等规则，不能用 `/security` 的用户投影签发执行权。完整协议见[分布式运行规格](../../../research/design/modules/distributed-runtime/specification.md)。

`/trust` 通过 `trust.list/revoke` 调用 Trust Administration，列出当前语境下可管理的 context/global 规则及来源并撤销；不是 CLI 直接访问本地 Store。`/security` 通过 `session.security` 消费 Conversation 的宿主投影，展示规则和运行观察。旧稿 reset/reset-all 与完整历史审计界面不作为当前命令承诺；具体确认选择见确认正文，不在此重复定义。

### 管理交互与授权反馈

`/trust` 的 typeahead 增强入口是管理面板，不是批准选择器：Enter 不接受或提交规则，撤销使用连续两次 Ctrl+D 确认，避免浏览时误操作。候选展示作用范围、贡献来源与匹配次数；实际撤销仍经宿主应用执行。通用状态与退出规则见[输入补全](../cli/input-completion.md)，不在安全模块另建交互状态机。

自动授权必须可见但不重复打扰。CLI 消费安全审计事件：安全助理 safe 用低调一行说明操作与理由；规则沉淀说明生效范围、累计次数、模式及 `/trust` 查看／撤销入口。needs-confirm 的理由交确认面板，escalate 交阻止错误显示，不重复输出审计横幅。用户面统一称“安全助理”，内部 `steward` 命名不改变产品术语；事件发出与各表面实际展示是两层职责，不能据 CLI 渲染推定所有渠道都有相同提示。

当前接线见[管理候选](../../../packages/cli/src/security/trust-rule-arg-provider.ts)、[CLI 事件消费](../../../packages/cli/src/render.ts)及[审计提示渲染](../../../packages/cli/src/security/terminal-renderer.ts)。

## 实现定位

- [Trust 管理应用](../../../packages/core/src/trust-administration/application.ts)、[批准与沉淀应用](../../../packages/core/src/trust-administration/execution.ts)
- [规则存储](../../../packages/core/src/security/permission-store.ts)、[匹配](../../../packages/core/src/security/permission-matcher.ts)、[信任分级](../../../packages/core/src/security/trust-classifier.ts)
- [安全助理](../../../packages/orchestrator/src/security/ai-steward.ts)、[安全执行接线](../../../packages/orchestrator/src/security/secure-executor.ts)
- [Trust RPC binding](../../../packages/server/src/rpc/methods/trust.ts)、[权限快照协议](../../../packages/core/src/protocol/permission-snapshot.ts)
