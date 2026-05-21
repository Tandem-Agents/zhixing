# @zhixing/cli

> 知行命令行入口 —— 交互对话、单次执行、常驻服务、RPC 客户端

## 概览

`zhixing` 命令提供四种运行模式：

| 模式 | 命令 | 用途 |
|------|------|------|
| **REPL** | `zhixing` | 交互式多轮对话（开发主力） |
| **单次** | `zhixing -p "prompt"` | 流式执行一条 prompt 后退出（脚本/管道） |
| **服务** | `zhixing serve` | 启动常驻服务（HTTP + WebSocket + 调度器） |
| **RPC** | `zhixing rpc <method>` | 连接已运行的服务调用 RPC 方法 |

REPL / 单次模式独立运行。服务 / RPC 模式配对使用：服务跑常驻进程，RPC 是客户端工具。

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

项目级 `./zhixing.config.jsonc` 以字段级 deep merge 覆盖全局 `config.jsonc`（决策层），凭证不参与项目级级联（用户级单一来源，避免泄漏到 git）。

---

## 模式 1：REPL（交互对话）

```bash
zhixing
```

进入交互式多轮对话。所有内置工具（read/write/edit/glob/grep/bash/memory/schedule）开箱可用。

**斜杠命令**：

| 命令 | 作用 |
|------|------|
| `/help` | 显示所有命令（按分类输出） |
| `/new` | 创建新对话 |
| `/switch` | 列出对话 + 切换到已有对话（typeahead async-enum 选择 / 序号 / 名称 / id 三级匹配） |
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
| `/workscene` | 工作场景管理（增删改查/归档） |
| `/journal` | 查看日志状态 |
| `/people` | 查看关系网络 |
| `/compact` | 手动触发上下文压缩 |
| `/tasks` | 查看定时任务 |
| `/config` | 修改基础配置（服务商 / 模型 / API Key / 消息通道等） |
| `/trust` | 权限规则管理 |
| `/security` | 安全状态概览 |

**对话恢复**：REPL 启动时默认自动恢复用户域最近一个对话，无需手动指定。进入 REPL 后用 `/new` 创建新对话、`/switch` 列出并切换到其它对话。

---

## 模式 2：单次执行

```bash
zhixing -p "用一句话介绍你自己"
```

适合脚本、CI、管道场景。流式输出后退出，不进入 REPL。

```bash
# 与其他命令组合
zhixing -p "总结 README.md" > summary.txt
zhixing -p "今天天气如何？" --provider openai
```

---

## 模式 3：`zhixing serve`（常驻服务）

启动 HTTP + WebSocket 服务，把 Scheduler 从 CLI 进程迁到独立进程。常驻后可被 RPC 客户端连接。

```bash
zhixing serve                       # 默认 127.0.0.1:18900
zhixing serve --port 19000
zhixing serve --host 0.0.0.0        # ⚠️ 暴露到局域网，谨慎使用
zhixing serve -m claude-3-5-sonnet  # 默认模型
zhixing serve -w /path/to/workspace # 工作区
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

**进程锁**：端口监听 + PID 文件双层保护。重复启动会被拒绝（`EADDRINUSE` 或 `ProcessLockError`）。

---

## 模式 4：`zhixing rpc`（RPC 客户端）

连接 `zhixing serve` 启动的服务调用 JSON-RPC 方法。**自动发现服务、自动 auth**，不需要手动管理 token 或端口。

### 速览

```bash
zhixing rpc health                           # 健康检查
zhixing rpc session.send "你好"              # 流式对话
zhixing rpc schedule.list                    # 列出定时任务
zhixing rpc --watch                          # 监听所有事件
zhixing rpc --help                           # 完整帮助
```

### RPC 方法清单

| 方法 | 需 auth | 参数 | 说明 |
|------|---------|------|------|
| `health` | ❌ | — | 健康检查 |
| `auth` | ❌ | `{token, client?}` | （由 CLI 自动调用） |
| `session.send` | ✅ | `{text, sessionId?}` | 发送消息，流式返回 |
| `session.list` | ✅ | — | 列出所有会话 |
| `session.history` | ✅ | `{sessionId, limit?}` | 会话历史 |
| `session.abort` | ✅ | `{sessionId}` | 中止当前轮 |
| `session.delete` | ✅ | `{sessionId}` | 删除会话 |
| `schedule.list` | ✅ | — | 列出定时任务 |
| `schedule.create` | ✅ | `{name, schedule, action, ...}` | 创建任务 |
| `schedule.update` | ✅ | `{id, patch}` | 更新任务 |
| `schedule.delete` | ✅ | `{id}` | 删除任务 |
| `schedule.run` | ✅ | `{id}` | 立即执行 |

### 推送事件（`--watch` 模式可见）

| 事件 | Payload | 何时触发 |
|------|---------|---------|
| `session.delta` | `{sessionId, delta}` | LLM 流式输出（仅推给发起 session.send 的连接） |
| `session.complete` | `{sessionId, result}` | 一轮完成 |
| `schedule.started` | `{taskId, name}` | 定时任务开始执行（广播） |
| `schedule.completed` | `{taskId, name, status, ...}` | 任务完成（广播） |
| `schedule.disabled` | `{taskId, name, reason, ...}` | 任务因连续失败被自动 disable（广播） |

### 三种参数形式（按优先级）

**1. `--json '<json>'`**：完整覆盖 params，适合复杂结构

```bash
zhixing rpc schedule.create --json '{
  "name": "daily-report",
  "schedule": { "kind": "cron", "expr": "0 9 * * *", "tz": "Asia/Shanghai" },
  "action": { "kind": "agent-turn", "prompt": "生成今日工作总结" }
}'
```

**2. `--key=value` / `--key value`**：键值对，自动转换 `true`/`false`/数字

```bash
zhixing rpc session.send --text="你好" --sessionId=sess_abc123
```

**3. 位置参数**：部分方法支持简化形式

| 方法 | 位置参数映射 |
|------|------------|
| `session.send` | `<text>` |
| `session.history` / `abort` / `delete` | `<sessionId>` |
| `schedule.delete` / `run` | `<id>` |

```bash
zhixing rpc session.send "你好"          # 等价于 --text="你好"
zhixing rpc schedule.delete task_abc123  # 等价于 --id=task_abc123
```

### 输出模式

| 模式 | 用途 | 行为 |
|------|------|------|
| 默认 | 人读 | 缩进 JSON + 染色 |
| `--raw` | 管道 | 单行 JSON，无染色 |
| `--watch` | 监控 | 仅订阅通知，Ctrl+C 退出 |

**管道示例**：

```bash
zhixing rpc schedule.list --raw | jq '.[].name'
zhixing rpc health --raw | jq -r '.uptime'
```

**watch 示例**：

```bash
# 终端 1：监听所有事件
zhixing rpc --watch

# 终端 2：触发事件（终端 1 实时打印）
zhixing rpc schedule.run task_abc123
```

### 退出码

| 码 | 含义 | 例子 |
|----|------|------|
| `0` | 成功 | 调用返回 result |
| `1` | RPC 错误 | 方法不存在、未授权、参数无效 |
| `2` | 客户端错误 | 服务未运行、JSON 解析错、参数缺失 |

适合在 shell 脚本里区分错误来源：

```bash
zhixing rpc health > /dev/null
case $? in
  0) echo "ok" ;;
  1) echo "rpc error" ;;
  2) echo "client error" ;;
esac
```

### 完整端到端示例

```bash
# 1. 启动服务
pnpm serve &

# 2. 健康检查
zhixing rpc health
# → { status: "ok", version: "0.1.0", uptime: 12 }

# 3. 流式对话
zhixing rpc session.send "用一句话介绍你自己"
# → 流式打印文本
# → (session sess_xxx → completed)

# 4. 创建定时任务（每天早 9 点）
zhixing rpc schedule.create --json '{
  "name": "morning-report",
  "schedule": { "kind": "cron", "expr": "0 9 * * *", "tz": "Asia/Shanghai" },
  "action": { "kind": "agent-turn", "prompt": "生成今日待办" }
}'

# 5. 立即触发一次（不等到明早）
zhixing rpc schedule.run task_xxx

# 6. 查看任务执行状态
zhixing rpc schedule.list --raw | jq '.[].state'

# 7. 监听所有未来事件
zhixing rpc --watch

# 8. 删除任务
zhixing rpc schedule.delete task_xxx
```

---

## 故障排查

### `Server is not running`

`zhixing rpc *` 报此错时，先确认服务是否启动：

```bash
ls ~/.zhixing/server.pid          # 文件存在？
cat ~/.zhixing/server.pid         # PID 存活？
ps -p $(jq -r .pid ~/.zhixing/server.pid)
```

如果服务真的没起，启动它：

```bash
pnpm serve
```

### `EADDRINUSE` 启动失败

端口被占用。改端口或停掉占用进程：

```bash
zhixing serve --port 19000
```

### `config.json 含 N 处废弃字段` / `Provider 缺少 API Key`

`config.json` 含旧版凭证字段（如 `providers.<id>.apiKey: "env:VAR"`）或 channel 密字段（如 `channels.<id>.credentials.appSecret`），启动期 schema 校验会逐项打印违反字段、原因与精确修复步骤。

修复路径：

- 按错误消息提示在 `~/.zhixing/config.json` 中删除违反字段
- 在交互终端跑 `zhixing` 让向导写入 `~/.zhixing/credentials.json`，或手动编辑该文件
- channel 密字段（appSecret 等）迁移到 `credentials.json` 的 `channels.<id>` 段；非密字段（appId 等）保留在 config.json
- CI / Vault 用户：由启动脚本生成 `credentials.json`（凭证 plaintext），知行不接受 env 注入语法

### `Method not found` (RPC error -32601)

方法名拼错，或服务版本不支持。`zhixing rpc --help` 查看本版本支持的方法。

### `Method requires authentication` (RPC error -32001)

通常不会发生（`zhixing rpc` 自动 auth）。如果出现，删除 token 文件后重启服务：

```bash
rm ~/.zhixing/server.token
# 重启 server，会自动重新生成
```

### REPL 启动时报 `首次配置未完成`

启动期 wizard 检测到必要字段缺失：
- 在交互终端（cmd / PowerShell / bash）直接跑 `zhixing` —— 向导逐字段询问后自动写盘
- 非交互场景（CI / pipe）会 fail-fast 退出码 2，必须先在 TTY 终端完成首次配置

检查现有配置：

```bash
cat ~/.zhixing/config.json
cat ~/.zhixing/credentials.json   # AI 不可读；用户可自己 cat
```

---

## 相关文档

- [架构总览](../../research/design/architecture/overview.md)
- [常驻服务设计](../../research/design/specifications/persistent-service.md)
- [Server Gateway 协议](../../research/design/specifications/server-gateway.md)
- [安全系统](../../research/design/specifications/security-system.md)
- [输入补全](../../research/design/specifications/input-typeahead.md)
