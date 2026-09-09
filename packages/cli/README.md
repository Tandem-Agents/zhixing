# @zhixing/cli

> 知行命令行入口 —— 交互对话、运行控制、诊断入口

这是知行面向普通用户的安装包；其余 `@zhixing/*` 包是由 CLI 组合使用的内部实现与协议组件，不代表独立 SDK 稳定性承诺。项目总览与英文入口见[知行主文档](https://github.com/Tandem-Agents/zhixing#readme)。

## 概览

`zz` 和 `zhixing` 指向同一 CLI 入口；下文用 `zz` 表示当前构建产物的真实命令面。

外部 `zz` 命令是接入面，不是系统功能的默认承载层：

- 能放进交互模式的用户功能，原则上不新增外部 `zz <command>`。
- 外部命令只保留必要、基础、离开交互模式后仍必须可用的控制入口。
- 历史或隐藏兼容入口只能作为系统事实记录，不能自动上升为用户标准。
- smoke 清单必须区分“当前实现存在”和“产品必须保留”；不能因为历史入口存在，就把它固化为长期用户承诺。

**当前用户可见的外部 `zz` 命令**：

<!-- public-top-level-commands:start -->
- `zz`：进入交互 REPL。
- `zz help`：显示当前公开命令。
- `zz status`：查看知行运行状态。
- `zz stop`：停止知行；显式维护前使用 `zz stop --maintenance`。
- `zz doctor`：只读检查本机运行、托管、配置和恢复状态。
- `zz app`：管理应用生命周期；`zz app remove` 安全停用并准备 npm 卸载，保留全部用户数据。
- `zz pair`：与第二台设备配对；出码与加入都沿同一引导完成。
- `zz device`：查看或永久移除已配对设备。
- `zz duty`：查看接班设备并迁移值班职责。
- `zz backup`：设置、验证和使用恢复备份，管理恢复码。
- `zz workspace`：管理当前设备已授权的本地工作区。
<!-- public-top-level-commands:end -->

**当前真实存在但隐藏 / 过渡中的入口**：

- `zz serve`：内部宿主启动路径；默认 help 不展示，不纳入 0.1 用户 smoke 清单。
- `zz serve logs`：当前仍可调用的后台宿主日志查看入口；默认顶层 help 不展示。

**当前真实存在的 `zz --...` / option 形态**：

- 全局：`zz --help` / `zz -h`。
- 全局：`zz --version` / `zz -V`。
- 全局隐藏诊断入口：`zz --log`。
- `zz status --help` / `zz status -h`。
- `zz stop --help` / `zz stop -h`。
- 隐藏 / 过渡入口：`zz serve --help` / `zz serve -h`。
- 隐藏 / 过渡入口：`zz serve logs --help` / `zz serve logs -h`。
- 隐藏 / 过渡入口：`zz serve logs --tail`。
- 隐藏 / 过渡入口：`zz serve logs --lines <n>`，`n` 必须是 1 到 5000 的整数。

**边界说明**：

- `zz`、`zz serve`、`zz serve logs --tail` 是长运行语义，smoke 不能按“必须立即退出”的基础命令处理。
- `zz serve status` / `zz serve stop` 已从外部命令面清理；运行控制只保留 `zz status` / `zz stop`。
- `zz serve --port` / `zz serve --host` 已从外部命令面清理；端口和监听地址不作为用户 CLI 参数承诺。
- 未发现已实现的外部 `zz logs`、`zz config`、`zz mcp`、`zz task` 等顶层 shell 命令。
- REPL 内部 `/help`、`/new` 等斜杠命令属于交互接入面内部命令，不纳入外部 `zz` 命令清单。

---

## 安装与配置

当前唯一正式安装路径要求 Windows 10/11 x64 与 Node `>=24.0.0`：

```text
npm install -g @zhixing/cli
zz
```

同版修复时先取得当前明确版本，再按该版本重装：

```powershell
$ZhixingVersion = zz --version
zz stop --maintenance
npm install -g "@zhixing/cli@$ZhixingVersion"
zz
```

主动前向升级时，安全停止后安装已经选定的明确新版；安装最新版本可使用：

```powershell
zz stop --maintenance
npm install -g @zhixing/cli@latest
zz
```

不支持已运行新版本后的降级。卸载应用但保留 `ZHIXING_HOME`：

```text
zz app remove
npm uninstall -g @zhixing/cli
```

全局目录不可写时只使用 Node 官方的用户级安装或修复方式；不要使用 `sudo npm`、放宽系统目录权限或修改知行以外的 npm 配置。知行不会后台替换程序，也不会修改用户 Node、npm 或 PATH。

仓库开发使用以下脚本；这些不是用户安装入口：

```bash
pnpm install                   # 安装依赖
pnpm build                     # 构建所有包
pnpm cli                       # 启动 REPL（dev 模式，跑 src/）
pnpm serve                     # 启动常驻服务
pnpm test                      # 运行测试
```

构建后直接运行：

```bash
node packages/cli/dist/index.js [...]
```

首次运行检测必要字段缺失时，在交互终端启动**基础配置编辑器**——五级面板（↑↓ Enter Esc Ctrl+C 导航），完成后写入功能配置与设备本地 SecretStore。

### 配置文件

知行用户级配置按“功能配置 vs 本地秘密”分层：

| 文件 | 内容 | 性质 |
|---|---|---|
| `$ZHIXING_CONFIG_PATH` 指定的文件；未设置时为 `<ZHIXING_HOME>/config.jsonc`，默认 `~/.zhixing/config.jsonc` | 决策层：`llm.main`（必填）/ `llm.light` / `llm.power` 角色选择、`messaging` 启用列表、`workspace`、`agent` / `intent` / `network` 等使用偏好。**支持 JSONC 注释**——VSCode 等编辑器原生识别 | AI 可读；写需用户确认 |
| 设备本地 SecretStore | provider、channel、MCP 的秘密 binding；桌面使用系统凭据保护，无头设备使用机器绑定加密 vault | 不进入 AI、网格、备份或迁移流 |

### 字段对称性

```
config.llm.main.provider="siliconflow"  ─refs─>  SecretStore provider binding
config.messaging.feishu={...options}    ─refs─>  SecretStore channel binding
```

config 是“启用什么 / 用哪个”的引用；SecretStore 是目标设备的本地秘密来源。

### apiKey 来源（凭证唯一入口）

1. **设备本地 SecretStore**：配置编辑器通过专用流程写入 `provider/<id>` binding
2. 缺失 → 启动期触发配置编辑器（TTY）或 fail-fast（非 TTY）

`config.jsonc` **不接受**任何形态的凭证字段——启动期 schema 校验会拒绝 `providers` 字段、`channels` 旧名字段、`messaging.<id>.credentials` 嵌入凭证，三段式（违反字段 / 原因 / 修复步骤）引导用户手工修复。

旧版 `~/.zhixing/credentials.json` 只作为一次性迁移源：逐 binding 写入并回读验证，激活前失败回滚且保留源文件；激活后清退异常则失败关闭并在下次读取继续收敛，不反向覆盖已提交凭据。

配置是用户级单一来源：知行读取 `ZHIXING_CONFIG_PATH` 指定的完整文件路径；未设置时读取当前 `ZHIXING_HOME` 下的 `config.jsonc`（默认 `~/.zhixing/config.jsonc`）。知行不读取启动目录下的项目级配置；秘密只从当前设备 SecretStore 解锁，避免随项目或设备迁移泄漏。

---

## REPL（交互对话）

```bash
zz
```

完成主模型配置后进入交互式多轮对话。当前工具集包括 read/write/edit/glob/grep/bash/schedule；实际执行仍受信任、权限和确认策略约束。

**斜杠命令**：

| 命令 | 作用 |
|------|------|
| `/help` | 显示所有命令（按分类输出） |
| `/new` | 创建新对话 |
| `/resume` | 列出对话 + 切换到已有对话（typeahead async-enum 选择 / 名称模糊匹配 / id 精确匹配） |
| `/clear` | 清空当前对话历史 |
| `/name` | 为当前对话命名 |
| `/enter` | 进入工作场景 |
| `/exit` | 退出工作场景 / 退出知行 |
| `/status` | 显示当前会话状态 |
| `/model` | 显示当前模型信息 |
| `/usage` | Token 用量详情 |
| `/context` | 上下文容量可视化 |
| `/skills` | 查看技能库 |
| `/work` | 工作场景管理（增删改查/归档） |
| `/compact` | 手动触发上下文压缩 |
| `/tasks` | 查看定时任务 |
| `/config` | 修改基础配置（服务商 / 模型 / API Key / 消息通道等） |
| `/mcp` | 管理 MCP 服务（接入外部工具 / 启停 / 查看连接） |
| `/trust` | 权限规则管理 |
| `/security` | 安全状态概览 |

**对话恢复**：REPL 启动时默认自动恢复用户域最近一个对话，无需手动指定。进入 REPL 后用 `/new` 创建新对话、`/resume` 列出并切换到其它对话。

---

## 外部运行控制

```bash
zz status
zz stop
```

`zz status` 用于查看本机知行运行状态；`zz stop` 读取本机发现记录和持久认证 token，请求耐久安全停机并等待同一进程退出。停机被拒绝、超时或无法安全受理时不会强制杀进程；处理提示的阻塞项后可重试同一命令。托管维护前使用 `zz stop --maintenance`。

---

## 多设备、恢复备份与本地工作区

这些命令承接必须在交互对话之外仍可完成的设备级旅程；具体参数以对应的 `--help` 为准：

| 旅程 | 入口 | 作用 |
|---|---|---|
| 第二台设备 | `zz pair [invitation]` | 一台设备显示二维码和同内容文本，另一台扫描或粘贴后继续恢复码回读、完成配置、确认可用并选择值班设备。正常流程不要求地址、端口、中继或内部角色知识。 |
| 永久设备移除 | `zz device list/remove/continue/status` | 查看候选，永久移除设备，并在中断后继续或查看同一操作。应用停用另用 `zz app remove`，两者不会混淆。 |
| 值班迁移 | `zz duty targets/migrate/continue/cancel` | 选择长期在线的接班设备，准备、继续或在切换前取消值班迁移。 |
| 恢复备份 | `zz backup setup/verify/status` | 建立恢复备份、从实际目标回读验证并查看唯一下一步行动。 |
| 灾难恢复 | `zz backup recover/recover-finish` | 值班设备永久丢失后，从完整备份接管，并在旧设备已隔离后完成恢复。 |
| 恢复码 | `zz backup root rotate/invalidate/approve-reset/reset` | 轮换、紧急停用或在另一台已加入设备协助下重置恢复码。 |
| 本地工作区 | `zz workspace status/list/create/create-scene/rename/repath/remove/reset` | 只在当前设备授权和维护本地目录；远端不接收原始路径。 |

---

## 隐藏 / 过渡入口：`zz serve`

`zz serve` 是内部宿主启动路径，默认帮助不展示，不纳入 0.1 用户 smoke 清单。它启动本地 HTTP + WebSocket 宿主，供正式接入面和内部协议客户端连接。

```bash
zz serve
```

**启动后会创建**：

```
<ZHIXING_HOME>/server.pid    # PID + port + 启动时间（JSON）
<ZHIXING_HOME>/server.port   # 端口号（明文，shell 友好）
<ZHIXING_HOME>/server.token  # 持久本机认证 token（首次启动生成，宿主重启复用）
```

端口由当前 `ZHIXING_HOME` 派生（受控内部入口可显式覆盖），并在监听成功后写入 `server.pid` / `server.port` 供正式客户端发现；`18900` 不是固定端口合同。按发现记录访问时，端点形态为：

```
HTTP REST:    http://127.0.0.1:<实际端口>/api/health
              http://127.0.0.1:<实际端口>/api/status
WebSocket:    ws://127.0.0.1:<实际端口>/ws  ← JSON-RPC 2.0
```

**安全停机**：

- 后台宿主使用 `zz stop`；它先完成耐久停止准备，再关闭真实 Server，且没有强制结束兜底。
- 前台宿主收到第一次 `Ctrl+C` / `SIGINT` 或 `SIGTERM` 时走同一安全准备与清理链。停机期间应等待其完成，不重复发送中断。
- 非 Windows 平台的 `SIGUSR1` 也只触发同一安全停机；知行本身不承诺 supervisor 自动重启。

**进程锁**：端口监听是**唯一**单例锁——同 `ZHIXING_HOME` 派生同端口，重复启动被 OS 以 `EADDRINUSE` 原子拒绝。PID / port 文件仅是发现辅助（供客户端找到 owner 的端口 / pid），**不是第二把锁**：宿主 listen 成功即 owner，覆盖任何崩溃残留的 PID 文件、不自杀。

## 故障排查

### 查看后台宿主日志

`zz serve logs` 是当前仍可调用的后台宿主日志查看入口。

```bash
zz serve logs
zz serve logs --tail
zz serve logs --lines 100
```

### `EADDRINUSE` 启动失败

端口被占用。优先停掉占用同一 `ZHIXING_HOME` 的旧进程：

```bash
zz stop
```

### `config.jsonc 含 N 处废弃字段` / `Provider 缺少 API Key`

`config.jsonc` 含旧版凭证字段（如 `providers.<id>.apiKey: "env:VAR"`）或 channel 密字段（如 `channels.<id>.credentials.appSecret`），启动期 schema 校验会逐项打印违反字段、原因与精确修复步骤。

修复路径：

- 按错误消息提示，在配置编辑器显示的实际 `config.jsonc` 路径中删除违反字段
- 在交互终端跑 `zz`，由向导写入设备本地 SecretStore
- channel 接入字段（appId / appSecret 等）通过配置编辑器写入 SecretStore；config.jsonc 只保留启用项与功能选项
- 非交互宿主须先在目标设备完成 SecretStore 解锁与凭据配置，不接受明文文件或 env 注入语法

### REPL 启动时报 `首次配置未完成`

启动期 wizard 检测到必要字段缺失：
- 在交互终端（cmd / PowerShell / bash）直接跑 `zz` —— 向导逐字段询问后自动写盘
- 非交互场景（CI / pipe）会 fail-fast 退出码 2，必须先在 TTY 终端完成首次配置

现有功能配置可通过交互 REPL 的 `/config` 检查和修改；秘密只能通过 `zz` / `/config` 的专用流程查看或更新，不提供明文读取入口。

---

## 相关文档

- [项目与用户指南](https://github.com/Tandem-Agents/zhixing#readme)
- [安装、维护与发布（当前指南）](https://github.com/Tandem-Agents/zhixing/blob/main/research/design/modules/distributed-runtime/release-and-maintenance-guide.md)
- [架构总览](https://github.com/Tandem-Agents/zhixing/blob/main/research/design/architecture/overview.md)
- [常驻服务设计（历史材料，不作为当前实现合同）](https://github.com/Tandem-Agents/zhixing/blob/main/research/design/specifications/persistent-service.md)
- [Server Gateway 协议](https://github.com/Tandem-Agents/zhixing/blob/main/research/design/specifications/server-gateway.md)
- [安全系统](../../docs/modules/security/architecture.md)
- [输入补全](../../docs/modules/cli/input-completion.md)
- [命令系统](../../docs/modules/cli/command-system.md)
- [问题反馈](https://github.com/Tandem-Agents/zhixing/issues)

## 许可

MIT License。许可正文随 npm 包分发。
