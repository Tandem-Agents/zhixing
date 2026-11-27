/**
 * 内置能力的内容 —— 与登记处机制(builtin.ts)分离:机制恒定,能力是内容。
 * 新增内化能力 = 在此加一份 def(+ 随能力登记关联工具),机制零改动。
 *
 * 内容纪律:
 *   - 五大 `system:*` 包作为纯 TS 常量与同源生成资源编译进 `@zhixing-ai/core`
 *   - 单个能力 `BuiltinSkillDef.tools` 保持 `<= 1` 个主锚点工具名
 *   - 所有成员均为无 NUL 的纯 UTF-8 文本，总成员 <= 64、路径深度 <= 6
 */

import type { BuiltinSkillDef } from "./builtin.js";
import { GENERATED_EXTENSION_KIT_RESOURCES } from "./generated-extension-kit-resources.js";

const SYSTEM_COGNITION_SKILL: BuiltinSkillDef = {
  name: "知行系统认知",
  description:
    "需要了解知行拓扑角色、8 类运行会话、工作区/模型与凭据表面边界、MCP 与扩展管理入口、斜杠/CLI 命令或日志源两层查法时加载",
  modes: ["main", "work"],
  tools: ["runtime_inspect"],
  body: `# 知行系统认知

需要核实当次运行实例的实时窄状态时调用 \`runtime_inspect\`；需要核对静态机制、命令、日志源与引导口径时，用 \`skill_read\` 附 \`expectedVersion\` 按需读取对应子页。

## 能力与表面三原则

1. **只宣称当轮冻结工具列表与实时返回证明的能力**：不猜测宿主机目录、不索要 API Key/Token/私钥或本地物理路径。
2. **区分三类用户表面给出准确指引**：
   - **完整交互终端**：可直接让用户打开 \`/mcp\`、\`/config\`、\`/skills\`、\`/trust\`、\`/model\` 完成凭据录入、开关配置与授权审批。
   - **纯文本/单次终端**：说明先运行 \`zz\` 进入交互界面，再打开对应斜杠命令面板。
   - **飞书等外部受管消息通道**：绝不在聊天窗口输出无效斜杠指令或索要秘密/设备路径，明确指引用户回到知行宿主机终端运行 \`zz\` 后在对应面板完成配置与验证。
3. **控制动作以正式提交与管理状态为准**：\`propose_advancement\`、\`workmode_enter\`、\`workmode_exit\` 等动作只在同一轮成功提交后生效，不提前宣称已切换或已恢复。

## 子资源导航

- \`topology-and-context.md\`：宿主拓扑、8 类 \`sessionKind\`、通道并集门控与首控推进前提
- \`workspaces-and-models.md\`：工作区绑定、模型三角色摘要（无秘密）与选模入口
- \`mcp-and-extensions.md\`：MCP 管理动作、受管扩展接入链与等待态语义
- \`diagnostics-and-logs.md\`：全部同源 \`SHIPPED_LOG_SOURCES\` 与两层日志查法
- \`commands-and-surfaces.md\`：终端斜杠命令、宿主机 CLI 子命令与三类用户表面边界`,
  resources: [
    {
      path: "topology-and-context.md",
      mediaType: "text/markdown",
      summary: "宿主拓扑（hybrid/anchor/executor/surface）、8 类 sessionKind、通道并集门控与首控推进边界",
      content: `# 宿主拓扑与运行上下文

## 设备与角色拓扑

- **单机混合（\`anchor+executor\`）**：同一台知行宿主机既拥有权威账本、调度、投递、工作场景与对话 owner，也执行本地运行时与工具调用。
- **多机分工（\`anchor\` / \`executor\` / 纯 \`surface\`）**：
  - \`anchor\`：家庭唯一权威 owner，持有持久对话账本、技能库、全局配置与调度触发权。
  - \`executor\`：已配对的执行设备，按冻结指派执行工具、工作区访问与本地 MCP；可持有设备本机 \`local-*\` 对话直到迁移至 \`anchor\`。
  - **纯 \`surface\`**：仅转发输入输出与确认卡片，自身不运行 \`AgentRuntime\`。

## 8 类 \`sessionKind\` 与安全门控

\`runtime_inspect(scope: "summary")\` 与日志门控统一将当次运行归类为以下 8 种之一：

- \`main\`：常规主对话或共享顶层对话
- \`workscene\`：工作场景对话（主用 \`power\` 模型与绑定工作区）
- \`channel\`：外部受管通道轮次。按**固有通道会话 ID（\`classifyConversationDirectoryScope(id) === "channel"\`）与当轮通道入站/出站（含映射到共享 \`"default"\` 的飞书私聊轮次）的并集**强制裁定；进入 \`channel\` 后 \`runtime_inspect\` 仅开放 \`["summary"]\`，且日志查询强制降为 \`manageStorage: false\` 与单会话范围
- \`isolated\`：隔离支持会话（仅读 \`system:*\` 包，禁用户技能与写入）
- \`local\`：执行器本机对话（\`local-*\`，不直接操作全局工作场景）
- \`ephemeral\`：耐久定时或后台作业（禁授写技能工具，即使存量冻结清单亦在写前硬拒全局技能写）
- \`sub-agent\`：普通 \`Task\` 子助手（只读 \`system:*\` 包与 \`runtime_inspect(summary)\`；\`Task(logOnly: true)\` 仅保留 \`log_search\`/\`log_read\`）
- \`orchestration-node\`：多视角等编排子节点（按节点 \`modelRole\` 如 \`light\` 运行，继承或冷恢复重建受信 \`RunContext\`）

## 排他首控与回合末控制

- 排他首控 \`propose_advancement\` 仅在系统/宿主当前轮次允许且尚未锁定推进会话时生效。
- \`workmode_enter\`、\`workmode_exit\`、\`workscene_set_workdir_current\` 与 \`workscene_clear_workdir_current\` 在本轮成功提交前只暂存意图，必须先结束本轮，由宿主在提交后完成切换与 \`handoff\` 续接。
- 模型工具、终端斜杠命令与宿主机 CLI 子命令各守其责，互不替代。`,
    },
    {
      path: "workspaces-and-models.md",
      mediaType: "text/markdown",
      summary: "工作区目录选择边界、main/light/power 三角色摘要（无秘密）与选模入口",
      content: `# 工作区与模型

## 工作区查询与绑定边界

- 模型工具侧**绝不暴露宿主机物理路径、\`deviceId\` 或内部 \`bindingRef\`**，只通过公开显示名 \`(deviceName, workspaceName)\` 指定授权工作区。
- \`runtime_inspect(scope: "workspaces")\` 仅在顶层 \`main\` 或 \`workscene\` 且当次冻结清单包含场景工作区选择工具（\`workscene_change_approve\` 或 \`workscene_set_workdir_current\`）时返回 \`availability: "ok"\`（附重名 \`ambiguous\` 与分页 \`nextCursor\`）；在 \`channel\`、\`isolated\`、\`local\`、\`ephemeral\` 与子运行中固定返回 \`availability: "ineligible"\`。
- 宿主机注册、迁移或重命名工作区由用户在宿主机终端通过 \`zz workspace\` 命令完成。

## 模型三角色与 \`runtime_inspect(scope: "models")\`

- 知行按职责使用三角色：\`main\`（主对话）、\`light\`（轻量/节点视角）、\`power\`（工作场景主循环与复杂任务）。
- 非通道顶层会话（\`main\` / \`workscene\` / \`isolated\` / \`local\`）可调用 \`runtime_inspect(scope: "models")\` 查询 \`effectivePrimaryRole\`、三角色 \`{ source, ready }\` 摘要及当前会话/派发选模模式。
- 结果**绝不包含 API Key、凭据密文、\`secretRef\`、\`baseURL\` 或内部 \`connectionId\`**；凭据录入与切换模型由用户在终端运行 \`/model\` 或 \`/config\` 完成。`,
    },
    {
      path: "mcp-and-extensions.md",
      mediaType: "text/markdown",
      summary: "MCP 接入管理（search/source/presets/status/pending）与受管扩展生命周期边界",
      content: `# MCP 与受管扩展

## MCP 管理入口

- \`mcp_discover\` 支持 5 个动作：
  - \`search\` / \`source\`：检索或查看开源 MCP 包自述来源；
  - \`presets\`：查看内置 MCP 服务候选预设；
  - \`status\`：查看当前设备实际已连接的 MCP 状态，并在连接失败时读取脱敏的白名单 \`failure\` 结构（绝无原始含密错误文本）；
  - \`pending\`：仅对符合条件的非通道、非 \`local-*\` 顶层耐久会话返回等待处理的工作场景 MCP 接入/委派待办摘要；通道、本机对话、子运行与作业返回 \`ineligible-conversation\`。
- \`mcp_connect\` 与 \`mcp_delegate\` 负责申请安装或委派；需要用户填写环境凭据或确认启停时，指引回到宿主机终端打开 \`/mcp\` 或 \`/config\`。
- \`runtime_inspect(scope: "summary")\` 中的 \`mountedMcpServers\` 严格取当次冻结工具名中的 \`mcp__<serverId>__*\` 与宿主已连服务器求交，不虚报父会话挂载给子运行。

## 受管扩展生命周期

- 通过 \`extension\`（\`prepare\` / \`update\` / \`repair\` / \`status\` / \`cancel\` / \`disable\` / \`guide\`）、\`skill_materialize\`、\`extension_validate\`、\`extension_connect\` 与 \`extension_source\` 闭环管理受管通道扩展。
- 详细合同、SDK、schema 与分步流程见 \`system:外部能力接入\`（同样无任何宿主机安装物理路径暴露）。`,
    },
    {
      path: "diagnostics-and-logs.md",
      mediaType: "text/markdown",
      summary: "同源 SHIPPED_LOG_SOURCES 全表、filter.source 纯源名查法与 health 窄状态探针",
      content: `# 诊断与日志查询

## 1. \`log_search.filter.source\` 可传入的纯日志源名（不带版本号）

调用 \`log_search\` 按来源筛选时，\`filter.source\` 必须传下列不带 \`:version\` 后缀的纯源名：

- \`authority\`
- \`channel\`
- \`configuration\`
- \`extension\`
- \`handoff\`
- \`kernel\`
- \`logging\`
- \`mcp\`
- \`process\`
- \`product-api\`
- \`provider\`
- \`runtime\`
- \`stdio\`
- \`terminal-input\`

## 2. 宿主登记的日志结构版本（\`SHIPPED_LOG_SOURCES\`）

\`SHIPPED_LOG_SOURCES\` 用 \`<source>:<sourceVersion>\` 登记记录结构版本，仅反映于返回条目的 \`sourceVersion\` 数字字段，切勿把 \`:1\` 或 \`:2\` 拼入 \`filter.source\`（其中 \`mcp\` 登记 \`mcp:1\` 兼容脱敏版与 \`mcp:2\` 现行无密版，其余 13 源当前均为 \`:1\`）：

- \`authority:1\`
- \`channel:1\`
- \`configuration:1\`
- \`extension:1\`
- \`handoff:1\`
- \`kernel:1\`
- \`logging:1\`
- \`mcp:1\`
- \`mcp:2\`
- \`process:1\`
- \`product-api:1\`
- \`provider:1\`
- \`runtime:1\`
- \`stdio:1\`
- \`terminal-input:1\`

## 3. 两层日志查法与可运行示例

1. **顶层非通道会话（\`manageStorage: true\`，拥有 \`scopes: []\`）**：
   - 可查存储级（\`storage\` scope）运维日志与历史/现行脱敏结果；
   - 示例：\`log_search({ "filter": { "source": "mcp", "level": "error" } })\`
   - 支持细粒度 \`filter.ref\`（如 \`toolCall\`、\`extension\`、\`operation\` 等）与 \`mcp\` 存储级联查，再以 \`log_read(address, view)\` 查看 \`overview\` / \`timeline\` / \`detail\`。
2. **外部通道轮次或 \`Task(logOnly: true)\`（\`manageStorage: false\`，限定当前对话 \`conversation\` 范围）**：
   - 仅限读取本会话归属日志，不可跨会话或读全局 \`storage\` 域；
   - **切勿因细粒度 \`ref\` 筛选为空就误判系统无故障**：应改按纯 \`source\`（如 \`kernel\` / \`channel\` / \`extension\`）、\`level\`（\`warn\` / \`error\`）、时间窗或已知 \`zxlog://<storeId>/...\` 地址查询；
   - 示例：\`log_search({ "filter": { "source": "kernel", "level": "error" } })\`
   - 返回若含 \`gaps\`（\`insufficient\` 等）或历史 \`mcp:1\` / \`kernel:1\` 脱敏占位，必须如实说明证据不足或已脱敏，严禁推断成功。

## 进程健康探针 \`runtime_inspect(scope: "health")\`

- 仅对非通道顶层会话开放，绑定当前宿主明确的 \`ZHIXING_HOME\` 返回 \`{ availability, processStatus, healthCode }\`；绝不返回备份路径、PID 或端口号。宿主机排查命令为 \`zz doctor\` 与 \`zz logs\`。`,
    },
    {
      path: "commands-and-surfaces.md",
      mediaType: "text/markdown",
      summary: "权威斜杠命令表、CLI 子命令表与三类用户表面（交互终端/纯文本命令行/外部通道）引导口径",
      content: `# 命令与三类用户表面指引

## 交互终端内置斜杠命令（BUILTIN_COMMANDS）

用户仅在知行宿主机终端内输入斜杠命令（不向模型开放直接代点或绕过确认）：

- \`/advancement\`：查看当前对话的任务推进详情
- \`/clear\`：清空对话历史
- \`/compact\`：手动触发上下文压缩
- \`/config\`：修改基础配置（支持 \`/config logs\` 查看或调整日志容量与保留期限）
- \`/context\`：上下文容量可视化
- \`/exit\`（别名 \`/quit\`）：退出工作场景或退出知行
- \`/help\`：显示帮助信息
- \`/mcp\`：管理 MCP 服务（接入外部工具 / 启停 / 查看连接）
- \`/model\`：查看、搜索、切换当前模型与原位调参
- \`/name\`：为当前会话命名
- \`/new\`：创建新对话
- \`/resolve\`：处理结果待确认的运行
- \`/resume\`：切换到其他对话
- \`/security\`：安全状态概览
- \`/skills\`：管理技能（浏览 / 置顶 / 禁用 / 改适用模式 / 归档）
- \`/status\`：查看当前运行状态
- \`/stop\`：停止知行
- \`/task\`：管理任务（\`new <内容>\` / \`done <序号或 id>\`）
- \`/tasklist\`：查看当前对话的任务列表
- \`/tasks\`：查看定时任务
- \`/trust\`：权限规则管理
- \`/usage\`：查看 token 用量详情
- \`/work\`：进入或管理工作场景

> 用户自定义且启用的非保留技能 \`user:<id>\` 可由用户以 \`/<id>\` 触发；模型不自行伪装用户发送斜杠命令。

## 宿主机 CLI 子命令（\`zz\`）

- \`zz status\` / \`zz stop\` / \`zz doctor\` / \`zz help\`
- \`zz logs location|search|read|policy\`（以及内部后台日志 \`zz serve logs\`）
- \`zz app remove\`
- \`zz pair\` / \`zz device list|remove|continue|status\`
- \`zz duty targets|migrate|continue|cancel\`
- \`zz backup setup|verify|status|recover|recover-finish\`
- \`zz backup root rotate|invalidate|approve-reset|reset\`
- \`zz workspace status|list|create|create-scene|rename|repath|remove|reset\`
- \`zz conversation list|new|read|send|result\`

## 三类用户表面的精准引导规范

1. **完整交互终端（TUI）**：直接指引用户在当前终端使用对应斜杠命令（如打开 \`/mcp\`、\`/config\`、\`/skills\`、\`/trust\`、\`/model\` 完成凭据录入或审批）。
2. **纯文本/单次终端 CLI**：明确说明先运行 \`zz\` 进入交互界面，再执行对应 \`/mcp\`、\`/config\`、\`/skills\`、\`/trust\`、\`/model\`；需运维排查时给出对应 \`zz\` 子命令。
3. **飞书等外部受管消息通道（\`sessionKind === "channel"\`）**：**严禁直接在聊天消息里让用户点或输入 \`/config\`、\`/mcp\` 等终端斜杠命令，也绝不索要密钥、Token 或设备文件路径**；必须明确告诉用户“请回到运行知行的宿主机终端执行 \`zz\`，在交互界面打开 \`/config\`（或 \`/mcp\` / \`/skills\` / \`/trust\` / \`/model\`）完成凭据保存或配置确认”。`,
    },
  ],
};

const EXTENSION_SKILL: BuiltinSkillDef = {
  name: "外部能力接入",
  description: "接入外部 APP，或更新、修复、查询、取消和停用受管扩展连接时加载（内含随包 kit 合同、SDK、starter 与错例）。",
  modes: ["main", "work"],
  tools: ["extension"],
  body: `# 外部能力接入

管理外部分发/受管通道扩展（Channel Extension）时遵循无物理路径暴露的耐久操作闭环：

1. **启动与接纳**：新接入调 \`extension(action: "prepare")\`；更新调 \`update\`；报障调 \`repair\`。先查询 \`extension(action: "status")\` 检查既有操作；接纳进入 \`preparing\` 后结束本轮，等待或收到扩展续接时复用原 \`operationId\`。
2. **获取指南与物化 SDK**：调 \`extension(action: "guide")\` 确认当前运行作者状态（仅在有已授权工作区且挂有 \`skill_materialize\`、\`extension_validate\` 时 \`authoringState === "ready"\`；无工作区返回 \`read-only-requires-authorized-workscene\`）。就绪后先用 \`skill_read(id: "system:外部能力接入", resource, expectedVersion)\` 查阅 \`kit/authoring.md\`、\`kit/manifest.schema.json\`、\`kit/channel-sdk.d.ts\` 及 \`kit/contracts/**\`、\`examples/starter-channel.ts\` 与四层错例，再用 \`skill_materialize\` 将所需包内文件写到已授权工作区目录。
3. **制作、静态校验与提交**：按 \`kit/authoring.md\` 与工作区构建说明生成单一独立 Node ESM 入口并封装 \`candidate.json\`；调用只读 \`extension_validate(candidatePath)\` 完成规范校验与无环境 \`node --check\`，再调 \`extension_connect\` 提交 \`candidatePath\` 与核验摘要。
4. **宿主机凭据配置与双向验证**：禁止在对话或候选中放入密钥；按 \`config-and-verification.md\` 指引用户在宿主机 \`zz\` 终端 \`/config\` 完成凭据与启停，并走完 \`ChannelVerification\` 双向验证直到终态就绪。

## 子资源与包内资产

- \`inbound.md\`：入站事件、认证字段与群聊归组规则
- \`delivery.md\`：出站投递幂等、回执与 HTTP 回调规则
- \`config-and-verification.md\`：三类表面 \`/config\` 指引与 \`ChannelVerification\` 三终态
- \`update-repair-rollback.md\`：\`extension_source\` 导出、\`update\`/\`repair\` 约束与取消/回退规则
- \`kit/**\`：同源打包的 \`authoring.md\`、\`manifest.schema.json\`、\`channel-sdk.mjs\`、\`channel-sdk.d.ts\` 与 \`contracts/**\` 声明闭包
- \`examples/**\`：通过 TS 检查的最小双向 \`starter-channel.ts\`、\`manifest.json\` 与四层对照错例`,
  resources: [
    {
      path: "inbound.md",
      mediaType: "text/markdown",
      summary: "受管通道入站消息、认证发送方、group 归组与挑战应答规范",
      content: `# 入站消息与归组约束

- 入站消息须先 \`await ctx.onMessage(msg)\` 耐久接纳成功后，再向外部平台确认游标/ACK；失败必须保留平台侧重投机会，不可仅凭内存去重丢弃。
- \`msg\` 必须携带平台认证的 \`from\`、稳定 \`messageId\`、实例 \`channelId\` 与真实 \`chatType\`（\`"dm" | "group" | "thread"\`）。
- 群聊归组由 \`manifest.declaration.bindingPolicy.group\`（默认 \`"per-group"\`，或 \`"per-user-in-group"\`）唯一决定；适配器实例的 \`bindingPolicy\` 必须与声明完全一致，更新或修复期间绝不更改既有归组。
- 交互确认回调经 \`await ctx.onChallengeAction(action)\` 交核心耐久裁决；不支持按钮卡片的平台保留纯文本确认/取消应答通路，不私建第二确认权威。`,
    },
    {
      path: "delivery.md",
      mediaType: "text/markdown",
      summary: "出站 send 幂等、DeliveryResult 必选字段、HTTP 路由与进程生命周期",
      content: `# 出站投递与 HTTP 回调规范

- 所有 \`send(target, content, meta)\` 返回必须包含布尔型 \`success\` 与 \`retryable\`（失败且未进网时设 \`attempted: false\`）；成功响应保留平台返回的消息 ID 或只读回执字节。
- 对重试语义消费 \`meta?.idempotencyKey\` 与 \`meta?.deliveryAttempt\`；网络状态未知时不伪造 \`success: true\`。
- \`registerHttpRoute(path, handler)\` 仅注册 \`/channels/<instanceId>/...\` 相对路径，校验平台签名并在结束后显式调用 \`res.end(...)\`；SDK 已缓冲请求体，不依赖 Express/原生 \`socket\`。
- \`health()\` 同步返回真实传输状态（\`"ready" | "unavailable"\`），而非仅仅返回进程存活；\`disconnect()\` 与 \`abortSignal\` 必须完整释放连接与定时器。`,
    },
    {
      path: "config-and-verification.md",
      mediaType: "text/markdown",
      summary: "绝不索要密钥、三类表面 /config 凭据引导与 ChannelVerification 双向验证三终态",
      content: `# 凭据配置与双向验证

- 敏感凭据在 \`manifest.declaration.requiredFields\` 标为 \`sensitive: true\`，账号隔离字段标在 \`identityFields\`（须为非敏感必填公开字段）。
- **配置入口指引口径**：
  - 交互终端：让用户在当前终端打开 \`/config\` 填写凭据并启用，再按面板提示在对应 APP 会话完成双向确认。
  - 纯文本终端：让用户先运行 \`zz\` 进入交互界面后打开 \`/config\`。
  - 飞书等外部消息通道：明确提示用户回到宿主机终端运行 \`zz\`，打开 \`/config\` 面板完成凭据保存与验证（聊天内不发 \`/config\` 斜杠指令，不索要秘密）。
- \`ChannelVerification\` 以真实入站与原路回复回执为准，存在三类结果终态：验证通过开放业务、等待用户/配置、明确受阻阻断（\`blocked\`）；未通过前严禁宣称连接可用。`,
    },
    {
      path: "update-repair-rollback.md",
      mediaType: "text/markdown",
      summary: "extension_source 导出、update/repair 同实例演进边界、取消与失败回退",
      content: `# 更新、修复与回退

- 更新（\`update\`）与报障修复（\`repair\`）必须复用已有实例 \`instanceId\`，禁止另起新实例或擅自更换 \`identityFields\`、扩大能力、清空对话历史。
- 先用 \`extension_source\` 将原已保存候选源码、清单与构建说明导出到已授权工作区，结合 \`extension(action: "status")\` 定位故障；改候选目录并经 \`extension_validate\`、\`extension_connect\` 提交。
- \`repair\` 不得放宽或缩水既有能力声明；首次试运行未通过验证而受阻时允许同实例延续修订。
- \`cancel\` 撤销当前未终结操作并保留或恢复原已验证绑定；\`disable\` 撤销启用意图，任何迟到的候选或验证通知均不得绕过停用状态复活实例。`,
    },
    ...GENERATED_EXTENSION_KIT_RESOURCES,
  ],
};

const DISTILL_SKILL: BuiltinSkillDef = {
  name: "提炼技能",
  description:
    "用户想把一套做法存成单文件或多成员技能包，或刚一起验证走通值得复用的做法时加载（配对 skill_save）。",
  modes: ["main", "work"],
  tools: ["skill_save"],
  body: `# 提炼技能（skill_save）

把与用户共同验证过的做法保存或更新为可复用的 \`user:<id>\` 纯文本技能包。全程走对话起草与结构化确认，绝不绕过本人确认自动入库。

## 何时提议与起草原则

1. 仅在用户明确要求保存，或刚共同验证出一套含特定约定/避坑经验的可复用做法时提议（被拒则同一事项不再重提）。
2. 先用一句话说明“收自哪件事”。只保留特定约定与有效路径，丢掉通用常识；\`description\` 写清“何时该用”；只允许无 NUL 的纯 UTF-8 文本与源码资源（单文件或多成员 \`resources\`）。
3. **正交可见性**：可通过 \`visibility\` 正交设置 \`modelAutoIndex\`（是否进模型自动索引）与 \`userSlashCommand\`（是否展示于 \`/\` 菜单，默认均为 \`true\`）；需要临时停用技能时通过管理面开关 \`disabled\`。

## 创建与更新的读写基准硬规矩

- **新建技能**：可省略写回基准，但仅限目标 \`user:<id>\` 尚不存在。若同名条目已存在而未带基准，系统直接拒绝并要求先读核对。
- **更新已有技能**：必须先调 \`skill_read(id: "user:<id>")\` 取得当前 \`writeTemplate\`（\`expectedRevision\` / \`expectedVersion\`），原样带入 \`skill_save\`（并发冲突返回 \`revision-conflict\`，严禁猜版本号盲写）。
- **保留原附件**：更新多成员技能包但仅改根 \`SKILL.md\` 或 \`visibility\` 时，**省略 \`resources\` 参数**以完整保留既有附属文件；只有需要增删改附件时才显式传入完整新 \`resources\`。

## 确认与如实回报

- 必须先拿到用户明确同意，再调用 \`skill_save\` 打开 \`ConfirmationBroker\` 确认卡片（卡片展示完整正文、\`visibility\`、写回基准及附属 \`resources\` 清单）。
- 高置信凭据会被自动脱敏并随结果返回计数：\`scrubbedCount > 0\` 时明确告知已自动抹除 N 处密钥；同时如实交代后续可通过 \`/<id>\`（若 \`userSlashCommand\` 开启）或相关场景唤醒。`,
};

const ADMIT_SKILL: BuiltinSkillDef = {
  name: "接入技能",
  description:
    "用户给出工作区内外部候选技能包并请求接入技能库时加载（配对 skill_admit，执行安全管线、高置信阻断与三向授权审查）。",
  modes: ["main", "work"],
  tools: ["skill_admit"],
  body: `# 接入技能（skill_admit）

将用户明确指出的已授权工作区内部外部纯文本技能候选接入 \`user:<id>\` 技能库。安全检查、三向授权与发布审批由宿主机安全管线与独立裁判负责，调用方严禁借 \`skill_save\` 绕过外部候选准入。

## 前置条件与本地安全管线

- \`skill_admit\` 仅在已授权工作区且挂有工作区能力时可用，不替用户主动搜索外部目录，也不要求或接受工作区外敏感路径。
- 宿主机先在工作区内校验非符号链接、非二进制（无 NUL/合法 UTF-8）、无 \`.git\` 及逐成员过免顶层配额 \`authorizeFileAccess\` 读鉴权（任一成员命中 \`/trust\` \`deny\` 整包 \`block\`），再于**外发任何模型审查前**执行高置信秘密扫描；命中即硬阻断（0 次模型外送、无 \`admissionToken\`）。

## 三向授权分离与整包审查

1. **三向独立授权范围**：正式送审前由宿主机通过 \`ConfirmationBroker\` 核验本人对本次 \`candidateDigest\` 的三项授权：① 指定 \`AdmissionLlm\` 审查处理方、② 当前会话是否获准读取候选内容或报告摘录、③ 审查通过后发布入本实例常规技能库（支持同卡合并确认）。若本人拒绝送审或无可用裁判，直接止步清退暂存。
2. **全成员整包送审**：\`AdmissionLlm\` 审阅拟入库候选包的全部可读成员（根 \`SKILL.md\` 与全部附属文本成员），而非仅看根入口。
3. **返回分支处理**：
   - \`admitted\`：如实告知已接入的技能名与 ID、可在 \`/skills\` 管理；
   - \`escalated\`：确凿高风险阻断，如实说明原因，**严禁试探绕过**；
   - \`needs-confirm\`（含需本人审阅决策的情形）：若当前会话未获原文回执授权，工具只返回不含原文与命中摘录的中性脱敏状态，引导本人在宿主确认界面审阅完整审查报告并明确批准；**即使模型持有 \`admissionToken\`，也绝不能单独作为发布授权，必须在本人针对本次 \`candidateDigest + admissionToken\` 显式批准后再完成发布**；
   - 遇 \`candidate-changed\` 或 \`confirmation-expired\` 如实重头发起新准入，不尝试复用失效令牌。`,
};

const CONVERSATION_SKILL: BuiltinSkillDef = {
  name: "对话通信",
  description: "需要联系其他知行对话、了解其进展、分页发现目标或按五分支输入来源头规则处理来信时加载。",
  modes: ["main", "work"],
  tools: ["conversation"],
  body: `# 对话通信

## 五动作分页协作

- **\`discover\`**：查找目标对话与工作场景候选；支持 \`query\`、\`scope\`、\`limit\`、\`cursor\` 按最近活跃分页，沿 \`nextCursor\` 续页。
- **\`new\`**：按指定 \`name\` 或工作场景 \`sceneId\` 显式创建新会话。
- **\`read\`**：按需读取目标对话消息并沿 \`next\` 翻页，省略 \`conversationId\` 时读取当前对话。
- **\`send\`**：向目标知行对话发送消息，返回仅代表已被目标 owner 耐久接纳，不代表对方已完成任务（需要异步回复时在正文写明）。
- **\`observe\`**：查询已发消息的消费与运行状态；\`stopped\` 表示投递已停止且未消费，不靠轮询死等。

## 五分支输入来源识别

宿主在发送视图为每条普通用户消息前置防伪 \`<input-source ... />\` 来源头，对应五类可信来源：

1. \`user\`：终端用户直接输入，正常响应；
2. \`conversation\`：来自其他知行对话的 \`send\`，如需回复可调用 \`conversation(action: "send")\` 回信至 \`conversationId\`（对方空闲即开始处理，运行中则排至当前 Turn 后）；
3. \`program\`：来自本机 \`zz conversation send\` 外部程序的调用，**本轮正常助手回复即为调用方最终取回的结果**，通常直接给出完整结果即可，除非协作协议明确要求回访其对话入口；
4. \`channel\`：来自外部受管消息通道（如飞书）的入站，按通道礼仪与三表面指引回复；
5. \`system\`：宿主内部子系统（如 \`scheduled-job\`、\`workscene-continuation\`、\`extension-continuation\`、\`advancement-proxy\`）触发，按对应子系统职责执行，不误作普通对话 \`send\` 或用户原话。`,
};

/** 全部内置能力 def —— 登记处(builtin.ts)从此组装注册集。 */
export const BUILTIN_SKILL_DEFS: readonly BuiltinSkillDef[] = [
  SYSTEM_COGNITION_SKILL,
  EXTENSION_SKILL,
  DISTILL_SKILL,
  ADMIT_SKILL,
  CONVERSATION_SKILL,
];
