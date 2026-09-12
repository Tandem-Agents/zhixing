# 首次引导与配置编辑

## 产品要求

首次使用时模型尚未可用，引导必须由程序完成，不依赖 AI。触发条件是必要字段缺失，不是配置文件是否存在；只要求补齐当前使用不可缺少的信息，可选项不能阻塞启动。交互应说明要填什么、为何需要和必要示例，不要求用户记忆一组命令行参数或理解存储后端。

CLI 与服务复用检查和编辑责任；秘密只在目标设备专用界面录入。AI 可以帮助理解公开配置、经逐次确认修改公开配置，但不读取或代填秘密。用户看产品语言与可执行操作，不看 vault、generation、binding 等内部结构。[存储架构](architecture.md)负责秘密安全与耐久性。

## 当前启动链

[runStartupCheck](../../../packages/cli/src/startup.ts)在创建模型和接入通道前执行：

1. 读取公开配置，校验结构、废弃秘密字段与 mesh 角色配置；失败不打开 SecretStore。
2. 打开平台 SecretStore，确认解锁，加载同一代凭据并完成旧明文迁移及恢复清理。仅当信任记录存在、`device-key/device/v1/` 下恰有一个设备密钥引用，且对应设备在信任记录中为 active 时，才注入凭据暴露读取检查；任一条件不满足时不注入该检查。
3. 使用纯函数 [checkModel](../../../packages/cli/src/config-editor/checks/model.ts)检查 main 的 provider、model、API key。
4. 缺失且非 TTY 时返回 non-tty，入口报缺失字段并以错误退出；有 TTY 则进入所需配置 section。
5. 编辑完成后重新读取公开配置与凭据快照，生成冻结运行配置及用途秘密投影；取消则正常退出。

当前 main 必填，light／power 为可选角色，缺失不进入阻塞检查，解析和降级遵循[模型角色](../providers/model-roles.md)。CLI 与 host 启动都不因可选 messaging 凭据缺失触发本引导；通道未能装配时由接入层告警处理。这不免除分布式角色的就绪检查：本函数返回的 ready 是启动配置结果，不等于整个设备获得 ready 资格。

公开配置语义检查拒绝旧 providers、channels、messaging 内嵌 credentials 等入口，不接纳明文或 `env:`／`helper:` 秘密来源。错误提示给字段、原因和专用修复入口，不给秘密值或手工编辑秘密文件路径。

## 共享编辑器

[配置编辑器](../../../packages/cli/src/config-editor/index.ts)以 stdin、stdout、writers、sections、标题及初始数据作为边界。必要字段检查是纯函数，由启动与编辑 section 复用；面板交互不承担后端装配。配置选择、列表、实体、输入和模型选择按面板状态组织，通过方向键、Enter、Esc、Ctrl+C 导航。

初始配置、服务启动和 REPL `/config` 复用编辑器与秘密仓库；后续 MCP 专用接入见[MCP 接入与管理](../mcp/onboarding-and-management.md)。编辑后的运行配置应用不由秘密存储重复定义，见[运行期配置应用](../configuration/runtime-application.md)。

## 保存、取消与失败

编辑改动先存内存，只有“完成”才调用 writers。取消或 Ctrl+C 不提交编辑期改动；这不表示撤销进入编辑器以前的启动迁移等动作。写入失败必须传播，不能显示保存或启动成功。

**公开配置与秘密应一同保存，不出现半成功状态；当前尚未实现跨存储事务。** `runConfigEditor` 顺序等待 `writeConfig`、`writeCredentials`，第二步失败可能留下已更新的公开配置。凭据内部 generation 的原子切换并不能证明公开配置与秘密共同原子提交。

编辑完成后启动器重读落盘数据，但不会再完整调用一次启动语义检查与 main 缺失检查；编辑器校验、重读成功不能表述为全部就绪门禁复验。当前结果包括 ready、cancelled、schema-error、semantic-error、secret-store-error、non-tty；写入阶段异常向调用方传播，不被包装成完成结果。

## 多设备引导交界与验证

首次扩展的产品顺序为：配对 → 保存并验证恢复包 → 补齐目标设备登录信息 → 设备就绪 → 选择值班设备。配对、恢复包、角色切换由[分布式运行时](../../../research/design/modules/distributed-runtime/specification.md)负责，本编辑器不自建第二套设备状态机，也不传输秘密。

直接验证应区分：首次与再次缺字段、可选角色／通道不阻塞、无 LLM 引导、TTY／非 TTY、取消不提交、两次写入各自失败、完成后重读失败、敏感值不出现在错误中。不得以表单填写成功证明外部服务可用或设备角色已经就绪。
