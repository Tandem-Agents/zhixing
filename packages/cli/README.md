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
pnpm cli                       # 启动 REPL（带 --env-file=.env）
pnpm serve                     # 启动常驻服务
pnpm test                      # 运行测试
```

构建后可用以下方式运行：

```bash
node packages/cli/dist/index.js [...]   # 直接走 dist
node --env-file=.env --import=tsx/esm packages/cli/src/index.ts [...]   # 走源码（开发）
```

### 配置加载顺序

由 `@zhixing/providers` 处理，按优先级：

1. 环境变量（`SILICONFLOW_API_KEY` 等）
2. 项目配置 `./zhixing.config.json`
3. 全局配置 `~/.zhixing/config.json`

---

## 模式 1：REPL（交互对话）

```bash
zhixing
```

进入交互式多轮对话。所有内置工具（read/write/edit/glob/grep/bash/memory/schedule）开箱可用。

**斜杠命令**：

| 命令 | 作用 |
|------|------|
| `/help` | 显示所有命令 |
| `/clear` | 清空对话历史 |
| `/status` | 当前会话状态 |
| `/sessions` | 列出本项目所有保存的会话 |
| `/me` | 查看身份画像 |
| `/skills` | 技能库管理（含 `audit` 子命令） |
| `/journal` | 日志状态 |
| `/people` | 关系网络 |
| `/usage` | Token 用量详情 |
| `/context` | 上下文容量可视化 |
| `/compact` | 手动触发上下文压缩 |
| `/tasks` | 查看定时任务（S1 Scheduler） |
| `/trust` | 权限规则管理 |
| `/security` | 安全状态概览 |
| `/exit` | 退出 |

**会话恢复**：

```bash
zhixing -c                     # 继续本项目最近的会话
zhixing -r                     # 交互式选择恢复
zhixing -r <sessionId>         # 恢复指定会话
zhixing -n "我的会话名"         # 启动时命名
```

**模型选择**：

```bash
zhixing -m claude-3-5-sonnet
zhixing --provider siliconflow
zhixing -w /path/to/workspace  # 指定工作区（安全信任边界）
```

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

### `Provider 的 apiKey 引用了环境变量 X，但该变量未设置`

服务进程没加载 `.env`。用 `pnpm serve`（已配置 `--env-file=.env`），或：

```bash
node --env-file=.env packages/cli/dist/index.js serve
```

### `Method not found` (RPC error -32601)

方法名拼错，或服务版本不支持。`zhixing rpc --help` 查看本版本支持的方法。

### `Method requires authentication` (RPC error -32001)

通常不会发生（`zhixing rpc` 自动 auth）。如果出现，删除 token 文件后重启服务：

```bash
rm ~/.zhixing/server.token
# 重启 server，会自动重新生成
```

### REPL 启动时找不到模型

检查 `.env` 是否含 API key，配置文件 `defaultProvider` 是否正确：

```bash
cat ~/.zhixing/config.json
cat ./zhixing.config.json
```

---

## 相关文档

- [架构总览](../../research/design/architecture/overview.md)
- [常驻服务设计](../../research/design/specifications/persistent-service.md)
- [Server Gateway 协议](../../research/design/specifications/server-gateway.md)
- [安全系统](../../research/design/specifications/security-system.md)
- [输入补全](../../research/design/specifications/input-typeahead.md)
