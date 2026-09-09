# 工具与权限体系集成

本篇说明工具如何接入安全分类、规则匹配和批准反馈，不定义整套信任政策或确认界面。安全模块正文尚在[安全系统](../../../research/design/specifications/security-system.md)、[权限与信任需求](../../../research/design/drafts/permission-architecture-evolution.md)及[确认交互](../../../research/design/specifications/confirmation-ux.md)；其中旧实施接线须与当前源码区分。

## 一、为何需要声明式接入

早期文件和 Shell 工具有专项分类器，能工作不等于新工具已获得完整安全接入。WebFetch 暴露的核心问题是：边界声明、分类器注册和权限参数之间缺少实际连接，多字符串输入可能匹配错字段，系统预置规则又不能伪装成用户授权。

这些问题通过以下分工解决，而不是让每个工具自行实现确认流程：

| 合同 | 为什么这样设计 |
|---|---|
| 安全特征随工具定义，装配时派生快照 | 避免工具改动而外部安全配置漏改；元数据本身仍需可信装配和验证，不能自授权限 |
| 专项分类优先，声明边界作通用后备 | 保留文件／Shell 的语义分析，不叠加一份实际不生效的冗余分类；未识别工具无边界时保守归 `critical` |
| 显式权限参数，函数注入规则存储 | 不让字段顺序决定授权对象，也不让 PermissionStore 反向持有整套工具 |
| 用户池先匹配，builtin 仅兜底 | 保证用户匹配规则整体优先于系统默认规则，而不只是 deny 优先。若两池混合，builtin deny 仍可能压过用户 allow；分池使系统默认值只在用户没有匹配规则时参与 |
| builtin 在内存按 namespace 注册 | 系统默认值不是用户数据，不应每次启动写盘或污染用户规则；各来源可以替换自己的贡献 |
| 批准反馈交 Trust 应用 | Broker 表达交互决定，工具执行器连接批准结果；业务落库与累计不由界面或工具实现独立持有 |

## 二、当前生产链

1. Host 工具实现端口提供工具与 `permissionRuleSets`；Kernel 用 `ToolArgumentExtractor.fromTools(baseTools)` 和 `BoundaryRegistry.fromTools(baseTools)` 派生声明。Task 等后装配工具补充相应声明。
2. Kernel 将参数提取函数与有限规则贡献交给 Host 的安全执行工厂。`permission-storage-infrastructure.ts` 创建运行体实例级 PermissionStore、注册 builtin，并绑定 Trust Administration 执行应用。
3. SecurityPipeline 消费上下文绑定的只读规则来源和边界分类，不持有产品管理写入口；`secure-executor` 连接策略、研判、Broker 与有限 `recordApproval` 能力。
4. 批准记录由 Trust 应用处理。Host 的管理侧使用独立的读取入口；不能把旧 `pipeline.getPermissionStore().create()` 或 Renderer 落库描述成当前架构。
5. 存在 assignment 执行权威时，执行器在策略前和实际效果前检查授权；冻结权限快照与设备执行不允许被本地当前规则或工具声明绕过。拓扑合同归分布式运行架构，本篇不另建授权协议。

运行期变更工具集合通过 reload 重建以上装配快照。`register` 是装配能力；旧稿中的 `unregister` 热卸载与远程可替换注册框架不属于当前合同。

## 三、声明与分类

- 文件工具与 Bash 由 context classifier 优先处理；没有专项分类器的工具由 `boundaries` 表达资源类型、访问方式及动态性。多个 crossing 取最高影响，缺少声明不会默认放行。
- `permissionArgumentKey` 对 write/edit 为 `path`，Bash 为 `command`，WebFetch 为 `url`。声明缺失或对应值不是字符串时，提取器仍退回 `path / file_path / target / destination` 优先列表，再取字符串候选；因此显式字段不是 schema 校验的替代物。
- `needsPermission`、只读标识与影响分类不是同一层。安全包装器会评估实际操作；不能据旧稿推导 `needsPermission=false` 的工具完全不经过权限规则或安全检查。
- BoundaryRegistry 对声明做拷贝隔离；参数提取器按小写工具名登记。非法空声明／空参数 key 不应通过注册悄悄清除状态。

## 四、规则与生命周期

PermissionStore 当前用户池为 `session / context / global`，上下文以 PermissionContextId 绑定；旧 `workspace` scope 不是应继续照抄的新接口。匹配先收集用户池候选，任一命中则只在用户池裁决；没有用户命中才汇集 builtin，各 namespace 平级参与规则冲突裁决。该优先级只说明规则匹配，不表示任何 allow 都能越过系统安全底线。

两池各自使用相同的冲突裁决：先选 deny 候选（存在时排除 allow），再在候选中比较参数模式的特异性。因此，精确 allow 不会压过同池的通配 deny；两阶段的价值是用户规则与系统默认规则的来源优先级，而非修复池内 deny 的优先级。

`registerBuiltinRules(namespace, rules)` 的合同：

- namespace 非空，规则非空且 scope 必须为 `builtin`；非法输入报错，不静默修正。
- 同 namespace 替换，不同 namespace 累加；注册和读取均拷贝规则，避免外部修改污染内部状态。
- 只存在内存，不通过用户 `create()` 或磁盘反序列化注入；`resetAll()` 清用户规则，不清 builtin。
- 生命周期跟随 store 实例，当前没有独立卸载 API。工具集换代必须保持工具与权限贡献一致，不能把规则清理遗漏在另一个全局单例。

当前 Host 提供 WebFetch 默认规则贡献，并非只在 `web_fetch` 被选中时才返回贡献；实际工具集合仍由运行档决定，规则存在本身不会创建工具。

确认允许、研判允许与拒绝必须保留各自语义，不能把“发生过一次执行”当作用户永久授权。累计、作用域和规则撤销属于 Trust 领域；非交互执行也不能因为没有界面就跳过确认边界。

## 五、维护与直接验证

新增或变更工具时，核对实际生产集合、专项／通用分类路径、显式参数及 fallback、用户 deny 与 builtin allow 的冲突，以及批准到领域应用的消费链。只测试声明对象存在，不能证明管线接通。

实现依据：[运行体装配](../../../packages/orchestrator/src/runtime/create-agent-runtime.ts)、[Host 权限基础设施](../../../packages/cli/src/serve/permission-storage-infrastructure.ts)、[安全执行](../../../packages/orchestrator/src/security/secure-executor.ts)、[分类器](../../../packages/core/src/security/classifier.ts)、[参数提取](../../../packages/core/src/security/tool-aware-extractor.ts)、[规则存储](../../../packages/core/src/security/permission-store.ts)。
