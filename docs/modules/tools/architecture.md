# 工具体系架构

工具把模型意图连接到实际操作。工具协议描述输入、结果与操作特征；产品领域拥有业务事实，执行管线负责准入、安全和执行约束，Host 选择具体实现。不能以工具名的允许列表代替操作级安全，也不能让用户承担系统内部的正确性责任。

## 一、设计取舍

| 选择 | 保留的理由与边界 |
|---|---|
| 按操作与上下文判断权限，而非只判断能否使用某个工具 | 同一 Bash 或网络工具的不同操作风险不同；授权必须约束实际对象和作用域。旧 `capabilities[] / SecurityContext` 方案不是当前接口，不能据此预建另一套授权模型 |
| 工具协议与执行环境分离 | 不为本地、隔离或远程环境复制业务实现；安全与设备执行由外部边界负责。远程部署不天然等于沙箱，旧六级隔离光谱不是当前已交付功能 |
| 在用户意图范围内应用信任 | 避免反复确认，也不以执行次数无限扩大权限；上下文隔离和不可绕过的安全底线必须保留。具体信任规则归安全模块，不在工具内另建一套 |
| 统一消费工具合同，保留来源边界 | builtin、MCP、Task 进入同一模型工具消费与安全执行路径，但来源、装配和生命周期不同；不以统一为由建设插件平台或万能注册中心 |
| 结果有界、失败隔离 | 单个工具输出不能无界占用模型窗口，单工具失败应能反馈模型而非摧毁整轮。中断和未知副作用不能伪装成普通成功 |

早期比较的实质取舍是：不把容器作为所有用户的前置要求，不照搬另一项目的整套防御实现，也不把安全交回用户自行负责。这些理由仍成立；旧竞品代码量与能力判断不作为当前设计证据。

## 二、当前装配与责任

`AgentRoleProfile.enabledTools → Kernel 请求工具名 → Host 工厂提供实现 → Kernel 合并附加工具并装配安全 → 模型循环调用`

- `tools-builtin/src/factories.ts` 是 builtin 实现表；运行档决定启用集合。Host 的 `kernel-tool-implementation.ts` 查表并验证返回名称，注入技能领域端口和网络代理，返回工具及有限默认权限规则贡献。
- `createAgentRuntime` 消费实现端口，合并 `extraTools`，派生权限参数提取器与边界快照；Task 在后续装配。MCP 接入职责见 [MCP 架构](../mcp/architecture.md)，不把其连接管理塞进工具工厂。
- 委托不能扩大父级授权。当前 Task 的子工具集合由父级 `baseTools` 与 `SUB_AGENT_ENABLED_TOOLS` 取交集，不凭空增加父级没有的工具；这是工具可用集合的收窄，不等于已经获得这些工具每次操作的执行权限，实际调用仍须通过安全与执行权威检查。
- Kernel 负责智能执行；Host 持有具体基础设施。技能写入等业务工具通过领域应用处理事实，工具包装不成为第二业务 owner。
- 工具集合变更走运行体 reload 重建，不是修改一个永久共享的可变工具注册中心。装配期补注册不代表运行期热插拔协议。

当前 builtin 工厂集合如下；这不是全部运行时工具的枚举。

| 工具 | 职责 | 安全接入特点 |
|---|---|---|
| `read / glob / grep` | 文件读取、路径查找、内容搜索 | 文件系统专项分类；只读不等于绕过受保护资源规则 |
| `write / edit` | 全量写入、局部替换 | 文件系统专项分类，权限参数为 `path` |
| `bash` | 命令执行 | Shell 专项分类，权限参数为 `command` |
| `load_skill / save_skill / admit_skill` | 技能读取、保存与独立接入审查 | 绑定 Skill Catalog 应用；不能由 `needsPermission=false` 推导写入没有安全约束 |
| `web_fetch` | 获取已知 URL，可选模型提炼 | network/egress 声明，权限参数为 `url` |

`schedule`、`task_list` 有各自业务入口，不在上述工厂表中；Task 由编排器装配。任务列表合同见[会话任务列表](../conversation/task-list.md)，技能合同见[技能架构](../skills/architecture.md)。文件搜索专题见 [grep](grep.md)。

## 三、工具合同与执行

`ToolDefinition` 承载名称、输入 schema、调用实现及元数据。`boundaries` 描述跨越资源边界，`permissionArgumentKey` 指定规则匹配参数，`systemPromptHints` 说明工具使用方式；提示词不是授权机制。接入规则见[权限集成](permission-integration.md)。

保守声明约定为未标明只读、并行安全时不视作安全；实际准入以执行管线为准，不能把布尔字段解释成直接允许或每次必定弹窗。新增工具还需正确接入工厂、运行档或对应来源，不能宣称只加三个元数据字段就自动完成全部接线。

主循环的 `executeToolCalls` 规划调用并通过注入的执行器执行；安全包装器先检查执行权威，再进行策略评估、必要的研判／确认，应用执行约束，并在实际执行前再次核验权威。它不是旧文档中尚待建设的五阶段占位管线。

- 批次至少两项、全部已注册且明确 `isParallelSafe=true` 才并行；否则串行。不能由工具名称或只读声明推断并行安全。
- 普通异常与未注册工具形成错误结果反馈模型；工具自身也可返回 `ToolResult.isError`。不能要求所有实现绝不抛异常，或把取消当普通错误吞掉。
- `maxResultChars` 在结果处理处约束模型可见内容；这与工具内部读取／抓取预算不同。
- 已完成结果在中断后仍需保留；未执行调用由清理路径补结果。并发中断时已完成子集与补位子集不承诺原批次全序，按调用 ID 对应。

可选能力须有明确缺省语义：WebFetch 缺少提炼能力可以返回原文；技能应用等必要装配缺失则应拒绝构造，不能统一称为“缺什么都降级”。

## 四、工具直接反馈

`turnId`、投递目标和可选 `commitToUser` 由执行上下文承接；工具可以报告自己已完成的事实，避免模型重复叙述，但只应在反馈确实成立后设置 `committedToUser`。无反馈通道时仍返回正常工具结果供模型表达。

该机制不替代效果权威、可靠投递或因果排序，也不保证省去一次模型调用。当前 schedule 不主动发送 commitment；取舍与现状以 [Outbox 专题](../delivery/outbox.md#六工具直接反馈的取舍)为准。

## 五、实现入口

- [协议与元数据](../../../packages/core/src/types/tools.ts)、[循环执行](../../../packages/core/src/loop/tool-executor.ts)
- [builtin 工厂](../../../packages/tools-builtin/src/factories.ts)、[Host 实现选择](../../../packages/cli/src/runtime/kernel-tool-implementation.ts)
- [运行体装配](../../../packages/orchestrator/src/runtime/create-agent-runtime.ts)、[安全执行包装](../../../packages/orchestrator/src/security/secure-executor.ts)
- [WebFetch](web-fetch.md)、[轻量工具循环](lightweight-tool-loop.md)：分别负责具体抓取工具与程序发起的小任务循环，不重复定义本合同。
