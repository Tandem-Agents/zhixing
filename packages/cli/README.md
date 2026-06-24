# @zhixing/cli

> 知行命令行入口 —— 交互对话、运行控制、诊断入口

## 概览

`zz` 和 `zhixing` 指向同一 CLI 入口；下文用 `zz` 表示当前构建产物的真实命令面。

外部 `zz` 命令是接入面，不是系统功能的默认承载层：

- 能放进交互模式的用户功能，原则上不新增外部 `zz <command>`。
- 外部命令只保留必要、基础、离开交互模式后仍必须可用的控制入口。
- 历史或隐藏兼容入口只能作为系统事实记录，不能自动上升为用户标准。
- smoke 清单必须区分“当前实现存在”和“产品必须保留”；不能因为历史入口存在，就把它固化为长期用户承诺。

**当前用户可见的外部 `zz` 命令**：

- `zz`：进入交互 REPL。
- `zz status`：查看知行运行状态。
- `zz stop`：停止知行。

**当前真实存在但隐藏 / 过渡中的入口**：

- `zz serve`：内部宿主启动路径；默认 help 不展示，不纳入 0.1 用户 smoke 清单。
- `zz serve logs`：当前仍可调用的后台宿主日志查看入口；默认顶层 help 不展示，后续应收口到更清晰的诊断入口。

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

`zhixing` 通过本仓库 monorepo 提供。开发期常用以下脚本：

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

首次运行检测必要字段缺失时，在交互终端启动**基础配置编辑器**——五级面板（↑↓ Enter Esc Ctrl+C 导航），完成后事务性写入两份文件。

### 配置文件

知行用户级配置分两份文件——按"功能 vs 内容"分层：

| 文件 | 内容 | 性质 |
|---|---|---|
| `~/.zhixing/config.jsonc` | 决策层：`llm.main`（必填）/ `llm.light` / `llm.power` 角色选择、`messaging` 启用列表、`workspace`、`agent` / `intent` / `network` 等使用偏好。**支持 JSONC 注释**——VSCode 等编辑器原生识别 | AI 可读；写需用户确认 |
| `~/.zhixing/credentials.json` | 内容层：provider 完整字段（apiKey + baseUrl + protocol + 自定义 model 列表等）、channel 完整字段（appId + appSecret 等所有字段） | AI 不可读、不可写 |

### 字段对称性

```
config.llm.main.provider="siliconflow"  ─refs─>  credentials.providers.siliconflow
config.messaging.feishu={...options}    ─refs─>  credentials.channels.feishu
```

config 是"启用什么 / 用哪个"的引用；credentials 是资源完整定义。

### apiKey 来源（凭证唯一入口）

1. **`credentials.json`**：`providers.<id>.apiKey`（配置编辑器写入；用户也可手动编辑）
2. 缺失 → 启动期触发配置编辑器（TTY）或 fail-fast（非 TTY）

`config.jsonc` **不接受**任何形态的凭证字段——启动期 schema 校验会拒绝 `providers` 字段、`channels` 旧名字段、`messaging.<id>.credentials` 嵌入凭证，三段式（违反字段 / 原因 / 修复步骤）引导用户手工修复。

CI / Vault 等场景由启动脚本（用户 / 运维侧）生成 `~/.zhixing/credentials.json`，知行只读 plaintext。

配置是用户级单一来源：知行只读取全局 `~/.zhixing/config.jsonc`（决策层），不读取启动目录下的项目级配置；凭证也只来自 `~/.zhixing/credentials.json`，避免随项目泄漏到 git。

---

## REPL（交互对话）

```bash
zz
```

进入交互式多轮对话。所有内置工具（read/write/edit/glob/grep/bash/memory/schedule）开箱可用。

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
| `/me` | 查看身份画像 |
| `/model` | 显示当前模型信息 |
| `/usage` | Token 用量详情 |
| `/context` | 上下文容量可视化 |
| `/skills` | 查看技能库 |
| `/work` | 工作场景管理（增删改查/归档） |
| `/journal` | 查看日志状态 |
| `/people` | 查看关系网络 |
| `/compact` | 手动触发上下文压缩 |
| `/tasks` | 查看定时任务 |
| `/config` | 修改基础配置（服务商 / 模型 / API Key / 消息通道等） |
| `/trust` | 权限规则管理 |
| `/security` | 安全状态概览 |

**对话恢复**：REPL 启动时默认自动恢复用户域最近一个对话，无需手动指定。进入 REPL 后用 `/new` 创建新对话、`/resume` 列出并切换到其它对话。

---

## 外部运行控制

```bash
zz status
zz stop
```

`zz status` 用于查看本机知行运行状态；`zz stop` 用于停止知行后台宿主。

---

## 隐藏 / 过渡入口：`zz serve`

`zz serve` 是内部宿主启动路径，默认帮助不展示，不纳入 0.1 用户 smoke 清单。它启动本地 HTTP + WebSocket 宿主，供正式接入面和内部协议客户端连接。

```bash
zz serve
```

**启动后会创建**：

```
~/.zhixing/server.pid    # PID + port + 启动时间（JSON）
~/.zhixing/server.port   # 端口号（明文，shell 友好）
~/.zhixing/server.token  # 共享认证 token（首次启动自动生成）
```

**端点**：

```
HTTP REST:    http://127.0.0.1:18900/api/health
              http://127.0.0.1:18900/api/status
WebSocket:    ws://127.0.0.1:18900/ws  ← JSON-RPC 2.0
```

**优雅停机**：

- `Ctrl+C` 一次：停 Scheduler → 等待活跃任务 → 关 WebSocket → 关 HTTP → 释放 PID 锁
- `Ctrl+C` 两次：强制 exit
- `SIGTERM`：同 SIGINT 一次
- `SIGUSR1`（仅 Linux/macOS）：触发停机供 supervisor 重启

**进程锁**：端口监听是**唯一**单例锁——同 `ZHIXING_HOME` 派生同端口，重复启动被 OS 以 `EADDRINUSE` 原子拒绝。PID / port 文件仅是发现辅助（供客户端找到 owner 的端口 / pid），**不是第二把锁**：宿主 listen 成功即 owner，覆盖任何崩溃残留的 PID 文件、不自杀。

## 故障排查

### 查看后台宿主日志

`zz serve logs` 是当前仍可调用的后台宿主日志查看入口，后续应收口到更清晰的诊断入口。

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

- 按错误消息提示在 `~/.zhixing/config.jsonc` 中删除违反字段
- 在交互终端跑 `zz` 让向导写入 `~/.zhixing/credentials.json`，或手动编辑该文件
- channel 密字段（appSecret 等）迁移到 `credentials.json` 的 `channels.<id>` 段；非密字段（appId 等）保留在 config.jsonc
- CI / Vault 用户：由启动脚本生成 `credentials.json`（凭证 plaintext），知行不接受 env 注入语法

### REPL 启动时报 `首次配置未完成`

启动期 wizard 检测到必要字段缺失：
- 在交互终端（cmd / PowerShell / bash）直接跑 `zz` —— 向导逐字段询问后自动写盘
- 非交互场景（CI / pipe）会 fail-fast 退出码 2，必须先在 TTY 终端完成首次配置

检查现有配置：

```bash
cat ~/.zhixing/config.jsonc
cat ~/.zhixing/credentials.json   # AI 不可读；用户可自己 cat
```

---

## 相关文档

- [架构总览](../../research/design/architecture/overview.md)
- [常驻服务设计](../../research/design/specifications/persistent-service.md)
- [Server Gateway 协议](../../research/design/specifications/server-gateway.md)
- [安全系统](../../research/design/specifications/security-system.md)
- [输入补全](../../research/design/specifications/input-typeahead.md)
