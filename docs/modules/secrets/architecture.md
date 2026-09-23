# 秘密存储架构

本模块承载各入口共享的设备本地秘密存储，不是 CLI 子命令专属功能，也不是跨设备秘密中心。设备拓扑与角色合同以[分布式运行时规格](../../../research/design/modules/distributed-runtime/specification.md)为准；配置交互见[首次引导](onboarding.md)，通用访问控制见[安全架构](../security/architecture.md)。

## 需求与设计理由

- CLI、服务与通道共享产品身份和配置责任；同一用户的不同设备分别持有本机所需秘密，不通过网格共享凭据。
- 公开配置与秘密物理分离、通过稳定 id 关联：AI 读取公开配置无需用户确认，写入须逐次确认，不允许“永远同意”或跳过；秘密禁止 AI 读取或写入，只能由用户通过目标设备的专用流程管理。
- 文件工具按文件读取，若公开配置与秘密混存，保护整个文件会阻断正常配置协助，允许读取又会暴露秘密；物理分离使这两类访问政策可以分别执行。
- 凭据加载不依赖项目目录、shell shim、项目 `.env` 或 `env:` / `helper:` 前缀，开发与正式运行走同一产品路径。否则入口与 shell 的差异会改变用户能否启动。
- 不引入额外多身份／profile 体系。服务商库与模型角色是不同职责，引用[模型角色](../providers/model-roles.md)，不在秘密仓库重复定义。
- 复用现有安全规则及其 message、suggestion 提供阻断原因和安全操作指引，不为引导新增安全动作或专用 AI 配置工具。旧明文文件和“不使用系统密钥库”的方案已被设备本地加密存储替代，不再是现行约束。

## 存储与所有权

`config.jsonc` 表达模型选择、功能开关、MCP 连接方式、工作区与偏好，不存 provider API key、channel 接入凭据（含 appId、appSecret、token）或 MCP 秘密。秘密不参与公开配置级联，不进入 AI 上下文、网格消息、同步流、备份或跨设备迁移流。旧 `credentials.json` 仅是一次性迁移源。

`SecretStorePort` 按 `SecretRef { kind, bindingId }` 提供 `put / get / delete / list / unlockState`。provider、channel、MCP、设备私钥与 webhook 等秘密按用途分开绑定。平台实现由 CLI 产品组合根实例化；providers、mesh 等消费者依赖端口，而非自行打开后端。

| 环境 | 主密钥保护 |
|---|---|
| Windows | 当前用户 DPAPI |
| macOS | Keychain |
| Linux 桌面会话 | Secret Service |
| 无头宿主 | 稳定机器身份与私有随机 seed 共同派生；缺少稳定机器身份则拒绝 |

载荷统一存入 AES-256-GCM vault；私有文件权限、临时文件 fsync、原子替换与目录 fsync 保护写入，多实例操作通过可恢复文件锁协调。已存在的 vault 无法解锁时不得生成或覆盖主密钥；受管宿主可重开既有后端，不负责首次初始化。

启动与配置编辑域可接触跨用途凭据快照；离开此边界后，provider、channel、MCP 只接收各自需要的投影。运行配置与秘密投影分别装配，不让完整凭据对象随业务调用传播。关键实现为 [平台存储](../../../packages/secrets/src/platform-secret-store.ts)、[vault](../../../packages/secrets/src/vault-secret-store.ts)、[凭据仓库](../../../packages/providers/src/credentials-loader.ts)及[用途投影](../../../packages/cli/src/runtime/runtime-secret-projections.ts)。

## 凭据换代与旧明文清退

凭据仓库把每个条目写入版本化 generation，并以单一 manifest 指向当前代。读取、写入、迁移、显式导出与恢复清理共用 coordinator 串行化，不让消费者观察混合代。

发现本机旧 `credentials.json` 时：

1. 验证源为单一普通文件，记录身份、长度、修改时间与摘要；完整校验嵌套 schema，拒绝未知字段、非法类型与超长 binding。
2. 写 staging marker，逐 binding 写入并逐条回读比较。
3. 原子切换 manifest，随后重新核对源身份与摘要，删除旧明文并同步目录。
4. 清理旧 generation 与 marker。

切换前失败，回收 staging 并保留原明文；回收失败保留 aborted marker，后续继续清理。切换后，新代已经成为权威，必须前滚完成修复与明文清退，不能以旧文件逆向覆盖。若切换结果无法确定，也必须根据 manifest 恢复，不猜测未提交。

旧明文或崩溃遗留的明文导出临时文件未清退时不得就绪。回滚导出必须显式确认明文风险，采用 create-only 发布，目标存在则拒绝；它不是常规配置或备份入口。

公开配置和秘密 generation 仍分别存储，由 [配置保存 owner](../../../packages/providers/src/configuration-edit.ts)统一协调编辑和恢复。它按“公开配置文件锁 → SecretStore coordinator”的顺序核对编辑基线，只合入真正修改的秘密条目，保留未编辑或未读取的其他条目。同一条目并发修改明确拒绝，不用完整旧快照覆盖。

通过检查后，owner 将合并后的最终配置／凭据交给 Channel 准备发布；完整保存计划与发布记录仅写入加密 SecretStore，配置文件旁的临时标记只含随机操作标识。标记文件先同步载荷，再原子替换并同步目录，才接纳后续来源写入；公开配置采用同一耐久写入。中断后前滚收束，不回填旧快照。计划尚未接纳时恢复只清理准备材料，已接纳时恢复核对操作标识和目标路径并重建接纳屏障。未收束期间其他普通写入口及裸凭据读取拒绝继续；启动与配置入口先恢复，再从同一锁定来源读取完整配对，不会将新 MCP 凭据发给旧地址。完成后删除公开标记并同步目录，最后清理加密计划；恢复看到无标记也先同步目录再清理，避免未持久删除造成孤儿标记。目录同步沿用 core 对 Windows 不支持操作的受控兼容语义。具体交互见[配置保存边界](onboarding.md#保存取消与失败)。

重开未应用的 Channel 配置时，使用最终来源修复发布配对，保留原发布 revision 与启停意图版本校验；已确认清理的发布不因旧面板重试而重建。其他入口后来的停用仍能使旧启用失效。

MCP 接入只在秘密 owner 内核对目标 MCP 的实际凭据与已发放投影是否一致，不因无关 Channel 的局部轮换要求整个 Host 重启；目标自身变化仍拒绝旧投影。

## AI 访问边界

- 内置规则阻断 AI 文件工具及可解析 shell 路径对默认 `.zhixing/credentials.json`、`.zhixing/secret-vault*` 的访问。
- [实际秘密路径解析](../../../packages/cli/src/security/secret-boundary.ts)使用与加载器相同的目录解析，覆盖 `ZHIXING_HOME`、`ZHIXING_CONFIG_PATH`，由宿主向执行守卫注入保护路径；动态秘密路径为不可覆盖的 block。
- 系统凭据库命令同样由不可覆盖规则保护；产品后端只调用受信绝对路径，并清除动态链接器注入环境变量。
- 阻断反馈说明原因并引导用户在专用配置入口操作，不让 AI 读取秘密、替用户传递秘密或指导手工编辑 vault。

这些是 L2 执行守卫，不是 OS 进程沙箱，不能声称隔离用户明确批准的任意同用户代码。进程隔离属于独立安全能力。公开配置逐次确认的要求不因此降低；具体规则覆盖由[安全架构](../security/architecture.md)负责。

## 设备就绪、暴露与撤销交界

SecretStore 必须真实解锁、旧明文为零；但凭据字段齐全不等于设备 ready。分布式设备还须通过目标角色配置、所声明 provider／MCP／channel 检查与协议兼容性检查。设备状态 `unpaired → paired → configured → ready`，检查失效后 degraded，恢复后可 ready；revoked 为终态，安全域重置后进入 pending-reenroll。角色入口须执行 ready 与角色 guard，失败须有可行动原因。

暴露记录只含非秘密的设备、binding、服务、经服务核验的 principal 指纹、tenant、scope、状态及轮换指引。输入须规范、身份唯一、深度不可变，状态时间不得倒退。撤销只将目标设备的 active 暴露标为 compromised，并提供受影响外部账号及操作指引，不自动轮换第三方账号。

当前 [CredentialExposureAuthority](../../../packages/cli/src/serve/credential-exposure-authority.ts)通过 AuthorityCommitLog 的 exposure 流耐久提交、投影并执行路由检查。凭据描述与执行能力匹配属于分布式执行合同，本模块不另立权威。

## 错误与验证边界

公开配置 I/O／schema 失败与 SecretStore 失败分别报告；结构错误只给字段与原因，不回显秘密。vault 篡改、主密钥丢失、平台凭据库不可用、锁超时及迁移收尾失败均拒绝继续。已激活或激活状态未知的错误必须区分，禁止伪装成未写入并逆向覆盖。

本模块直接验证应覆盖：后端重开与篡改拒绝、坏 seed／钥匙库不可用、并发及跨实例锁；源替换与硬链接拒绝、逐条回读、切换前回收／切换后前滚、旧代及临时明文回收、导出 create-only；最小投影、包依赖、默认与覆盖目录守卫；就绪退化、撤销终态、暴露身份与时间及受影响账号边界。源码入口与结构检查是定位依据，不代替真实后端和故障恢复测试。
