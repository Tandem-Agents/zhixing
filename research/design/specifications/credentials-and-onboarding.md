# 用户秘密存储与首次引导

> 本规格承接 [知行分布式运行时架构总纲](../modules/distributed-runtime/distributed-runtime-charter.md) 的秘密纪律，并以 [知行分布式运行时](../modules/distributed-runtime/specification.md) 的 SecretStore、凭据暴露与设备就绪合同为准。旧版 `credentials.json` 只是一次性迁移源，不再是运行时配置入口。

## 一、目标与不变量

- provider、channel、MCP、设备私钥与 webhook 秘密只存目标设备的 SecretStore。
- 秘密不进入公开配置、AI 上下文、网格消息、同步流、备份或迁移流。
- `config.jsonc` 只表达“启用什么、如何使用”，通过稳定 id 引用本地秘密 binding。
- SecretStore 不可解锁、旧明文未清退或目标角色检查未通过时，设备不得进入 ready。
- 首次引导不依赖 LLM；秘密只由用户在目标设备的专用界面录入。

## 二、存储边界

### 2.1 公开配置

`config.jsonc` 保留模型角色选择、消息通道启用项、MCP 连接方式、工作区与产品偏好。以下内容不得出现：

- provider API key；
- channel 的 appId、appSecret、token 等接入字段；
- MCP token、请求头或环境变量秘密；
- `env:VAR`、`helper:CMD` 等旁路秘密来源。

启动期语义校验拒绝旧 `providers`、旧 `channels` 以及 `messaging.<id>.credentials`，错误只给字段、原因和修复入口，不回显秘密值。

### 2.2 SecretStore

统一端口为 `SecretStorePort`：按 `SecretRef { kind, bindingId }` 提供 `put / get / delete / list / unlockState`。后端由产品组合根按平台选择：

- Windows：DPAPI 当前用户保护的主密钥；
- macOS：Keychain；
- 有桌面会话的 Linux：Secret Service；
- 无头宿主：稳定机器身份与私有随机 seed 共同派生的机器绑定主密钥；缺少稳定机器身份时 fail-closed。

秘密载荷统一进入 AES-256-GCM 加密 vault。文件写入采用私有权限、临时文件 fsync、原子替换与目录 fsync；多实例写入和复合凭据换代共用可恢复文件锁。现有 vault 无法解锁时绝不生成或覆盖主密钥。

### 2.3 绑定与内存投影

provider、channel、MCP 分属独立 binding kind。凭据仓库用版本化 generation 保存每个条目，并以单一 manifest 作为当前 generation 的提交点。

组合根解锁后只向消费者发放最小投影：

- provider runtime 只见 provider 投影；
- channel 接入面只见 channel 投影；
- MCP 装配桥只见 MCP 投影；
- 跨域完整投影只允许停留在启动器、配置编辑器和 CLI 组合根。

业务包不得导入 SecretStore 实现；`@zhixing/secrets` 只由 CLI 组合根实例化，providers 与 mesh 只依赖端口合同。

## 三、旧明文迁移

启动发现同目录 `credentials.json` 时，在一个跨进程协调区内执行：

1. 校验源必须是单一普通文件，并记录文件身份、长度、修改时间和摘要；
2. 完整解析嵌套 schema，拒绝未知字段、非法类型与超长 binding；
3. 建立 staging generation marker；
4. 逐 binding 写入并逐条回读比较；
5. 原子切换 manifest；
6. 再次核对源文件身份与摘要后立即删除明文并 fsync 目录；
7. 清理旧 generation 与 marker。

manifest 切换前失败：删除 staging 条目并保留原明文；清理不完整时保留 aborted marker，后续读取继续回收。

manifest 切换后失败：新 generation 已是权威，不得回滚或被旧明文覆盖；启动失败关闭，下一次启动前滚完成 marker 修复与明文清退。

迁移、正常读取、写入、显式导出和恢复清理全部经同一 coordinator 串行化，不能观察到混合 generation。崩溃遗留的明文导出临时文件必须先清退，存在任何旧明文或临时明文时设备不得 ready。

回滚导出只允许显式调用并传入明文风险确认；目标文件使用 create-only 发布，已存在时绝不覆盖。导出不是常规配置路径。

## 四、启动与配置引导

启动顺序：

1. 读取并校验公开配置；配置错误不触碰 SecretStore；
2. 创建并验证平台 SecretStore，确认真实 vault 可认证解密；
3. 在同一协调区完成旧明文迁移、恢复清理、凭据加载与零明文复核；
4. 校验主模型必要字段；非交互环境缺失时 fail-fast；
5. 交互环境进入配置编辑器，完成后分别提交公开配置和 SecretStore generation，再重新加载验证。

`/config` 使用同一 SecretStore 仓库与编辑器，不提供秘密文件路径、手工编辑或明文读取入口。取消时编辑期改动全部丢弃；提交失败时启动/重载保持失败可见，不伪装成功。

用户只看到“设备本地 SecretStore”“补齐这台设备需要的登录信息”等产品语言，不暴露 vault、generation 或 binding 的内部细节。

## 五、AI 与运行时隔离

- 静态内置规则阻断 AI 文件工具及可解析 shell 路径对默认 `.zhixing/credentials.json` 与 `.zhixing/secret-vault*` 的访问。
- CLI 按实际配置目录解析旧明文路径和 SecretStore 文件族，经 RuntimeHost 注入每个 SecurityPipeline；因此 `ZHIXING_HOME` 与 `ZHIXING_CONFIG_PATH` 覆盖不会脱离保护。
- 动态保护路径使用 bypass-immune block，不能被用户、项目规则或一次确认覆盖。
- 系统凭据库命令由独立 bypass-immune 规则阻断；产品后端只调用受信绝对路径，并移除动态链接器注入环境变量。
- 运行时结构门禁禁止完整跨域凭据对象离开允许的组合根与编辑域，并禁止非 CLI 包实例化 SecretStore 实现。

上述合同是全平台一致的 L2 执行守卫，不是 OS 进程沙箱；路径策略不得被描述为能隔离用户明确批准的任意同用户代码。秘密值不进入 AI 上下文、协议或公开配置，后续 L3 进程隔离属于独立安全能力。

## 六、设备就绪与撤销

设备状态为 `unpaired → paired → configured → ready`，已 ready 的检查失效进入 `degraded`，恢复后回 ready；`revoked` 为终态，安全域重置后的设备进入 `pending-reenroll`。

ready 至少要求：

- 目标角色配置完整；
- 所声明的 provider、MCP、channel 检查全部 ready；
- SecretStore 可真实解锁；
- 协议版本兼容；
- 旧明文及其临时文件为零。

每个失败检查必须携带可行动原因。角色承担入口必须调用 ready guard；状态非 ready 或角色不匹配时拒绝。

首次扩展引导保持单线：配对 → 保存并验证恢复包 → 补齐目标设备登录信息 → 设备 ready → 选择值班设备。

`CredentialExposureRecord` 只记录非秘密的设备、binding、服务、经服务核验的 principal 指纹、tenant、scope、状态与轮换指引。设备撤销时只把该设备的 active 暴露置为 compromised，并返回可操作的外部账号清单；记录输入必须规范、唯一、深度不可变，撤销时间不得早于暴露时间。

## 七、错误契约

- 公开配置失败与 SecretStore 失败分开报告，不能把配置 I/O 误报为秘密存储故障。
- schema 错误只指出结构位置，不包含密值。
- vault 篡改、主密钥丢失、平台凭据库不可用、锁超时与迁移收尾失败全部 fail-closed。
- 已提交 generation 的收尾错误必须明确为“已激活、待前滚收敛”，不能伪装为未写入或执行逆向覆盖。

## 八、验收

- SecretStore：各平台后端重开、篡改拒绝、并发写、跨实例复合锁、坏 seed、钥匙库不可用与崩溃临时文件。
- 迁移：逐条回读、源替换/硬链接拒绝、切换前回滚、切换后前滚、并发换代、旧 generation 回收、显式导出 create-only。
- 隔离：明文引用门禁、完整凭据投影门禁、默认与自定义目录路径阻断、系统凭据命令阻断、包依赖拓扑。
- 就绪：全部状态边、缺检查、失败原因、SecretStore/协议/明文退化、撤销终态、pending reenroll、角色 guard 与线性引导。
- 撤销：错误设备不受影响、暴露身份唯一、服务核验指纹、时间倒退拒绝、受影响账号清单与嵌套字段不可变。

## 九、不在本规格范围

- 跨设备同步秘密；该能力被架构明确禁止。
- CredentialBindingDescriptor 与 ExecutionManifest 匹配；由后续能力描述节点实现。
- CredentialExposureRecord 的耐久 exposure 流；由 AuthorityCommitLog 节点实现，本规格只冻结记录与投影行为。
- 第三方服务自动轮换；只有服务存在可信管理授权时才可在后续接入，否则产品引导用户手工轮换。
