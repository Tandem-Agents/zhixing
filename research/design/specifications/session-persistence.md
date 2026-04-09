# 会话持久化方案

> **状态**: 📐 方案设计（2026-04-09）
> **前置**: Agent Loop 完成、消息类型已定义
> **关联**: phase2-complete-agent.md Phase 2C、ADR-005 决策 6

## 一、竞品方案对比

### 1.1 OpenClaw

| 维度 | 实现 |
|------|------|
| 格式 | JSONL，每行 `{ message, id?, type? }` |
| 路径 | `<stateDir>/agents/<agentId>/sessions/<sessionId>.jsonl` |
| 索引 | `sessions.json`（`Record<sessionKey, SessionEntry>`），与 JSONL 分离 |
| 恢复 | 网关 RPC `sessions.list` / `sessions.patch`，不是 CLI flag |
| Compaction 标记 | `{ type: "compaction", timestamp }` 行 |
| Session ID | `^[a-z0-9][a-z0-9._-]{0,127}$` |
| Topic | 支持 topic 分支：`<sessionId>-topic-<topicId>.jsonl` |

**优点：** 支持 topic 分支（多话题复用同一 session）；ID 格式有验证；网关 API 完整。

**不足：** 索引与 JSONL 分离需要双写维护；依赖 Gateway 运行，CLI 不能独立恢复会话；Session 管理逻辑分散在 `pi-coding-agent` 闭源包中。

### 1.2 Claude Code

| 维度 | 实现 |
|------|------|
| 格式 | JSONL，每行含 `type, uuid, parentUuid, timestamp, sessionId, cwd, message` |
| 路径 | `~/.claude/projects/<路径编码>/<session-uuid>.jsonl` |
| 编码 | 绝对路径 → `-` 分隔（如 `/home/user/app` → `-home-user-app`） |
| 索引 | `sessions-index.json`（`{ version, entries[] }`） |
| 恢复 | `--continue`（最近会话）/ `--resume [id\|name]`（指定或交互选择） |
| 其他 | `--fork-session`（分叉）/ `--name`（命名）/ `--no-session-persistence`（不存盘） |

**优点：** CLI flag 丰富（continue/resume/fork/name）；DAG 结构（uuid + parentUuid）支持分支；按项目隔离。

**不足：** `sessions-index.json` 与 JSONL 不同步导致 `--resume` 列表过期（多个 GitHub Issue）；路径编码策略脆弱（目录移动后失效）；每行字段过多（uuid/parentUuid/cwd 每行重复）。

### 1.3 差距分析

| 问题 | OpenClaw | Claude Code | 知行策略 |
|------|----------|-------------|---------|
| 索引同步 | 双写可能不一致 | ❌ 已知 bug | **无独立索引**，按需扫描 |
| 项目隔离 | agent ID 隔离 | 路径编码隔离 | **项目哈希隔离** |
| 数据冗余 | 中等 | 高（每行重复 cwd/sessionId） | **低（header 存一次）** |
| CLI 恢复 | 无（需 Gateway） | ✅ 完善 | ✅ 同级别 CLI flag |
| 分支能力 | topic 分支 | DAG 分支 | **Phase 2 不做，Phase 3 考虑** |

## 二、知行会话持久化设计

### 2.1 存储路径

```
~/.zhixing/
  projects/
    <project-id>/                    ← SHA-256(绝对路径) 前 12 位 hex
      project.json                   ← 项目元数据
      sessions/
        <session-id>.jsonl           ← 会话记录
```

#### 项目 ID 生成

```typescript
import { createHash } from 'node:crypto';

function getProjectId(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/').toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}
```

**为什么用 SHA-256 前缀而不用路径编码：**
- Claude Code 的 `-home-user-app` 编码在路径含 `-` 时会歧义
- 固定 12 字符的目录名整洁且碰撞概率极低（16^12 ≈ 2.8×10^14）
- 原始路径存在 `project.json` 中，可反向查找

#### project.json

```json
{
  "path": "E:\\Dev\\longxia\\zhixing",
  "createdAt": "2026-04-09T10:00:00.000Z",
  "lastAccessedAt": "2026-04-09T12:00:00.000Z"
}
```

### 2.2 Session ID

格式：`<日期>-<4位随机hex>`，如 `20260409-a3f1`

```typescript
function generateSessionId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(16).slice(2, 6);
  return `${date}-${rand}`;
}
```

**为什么不用 UUID：**
- UUID 对人类不友好（`--resume 550e8400-e29b-41d4-a716-446655440000`？）
- 日期前缀天然支持按时间排序
- 4 位 hex 的碰撞率在单项目内可忽略（同一天同一项目 65536 个会话）
- 用户在 `--resume` 时只需输入 `20260409-a3f1`

### 2.3 JSONL 格式

#### 第一行：Header

```json
{
  "type": "header",
  "version": 1,
  "sessionId": "20260409-a3f1",
  "name": null,
  "projectPath": "E:\\Dev\\longxia\\zhixing",
  "createdAt": "2026-04-09T10:00:00.000Z",
  "model": "deepseek-chat",
  "provider": "deepseek"
}
```

`name` 可选，用户通过 `--name` 或 `/name <名称>` 设置。

#### 后续行：Turn 记录

```json
{
  "type": "turn",
  "turnIndex": 0,
  "timestamp": "2026-04-09T10:00:05.000Z",
  "userMessage": { "role": "user", "content": "..." },
  "assistantMessage": { "role": "assistant", "content": [...] },
  "toolCalls": [
    { "name": "read_file", "input": { "path": "..." }, "result": "..." }
  ],
  "usage": { "inputTokens": 1234, "outputTokens": 567 }
}
```

**Turn 级粒度而非消息级：**
- 一轮 turn（user → assistant + tools）要么完整保存要么不保存
- 避免 Claude Code 的问题：消息级写入可能在中途崩溃留下不完整的 assistant 消息
- 减少行数：一个含 5 次工具调用的 turn 在 Claude Code 可能是 10+ 行，在知行只有 1 行

#### Compact 标记行

```json
{
  "type": "compact",
  "timestamp": "2026-04-09T11:00:00.000Z",
  "summary": "## 核心目标\n...",
  "turnsCompacted": 15,
  "tokensBefore": 45000,
  "tokensAfter": 8000
}
```

压缩后的新 turn 在 compact 标记之后继续追加。恢复时：
1. 从后向前找最近的 `compact` 行
2. 用 `summary` 作为上下文前缀
3. 加载 compact 之后的所有 turn

### 2.4 无独立索引文件

**不创建 sessions-index.json**。

Claude Code 的已知 bug 就是索引与 JSONL 不同步。知行方案：

```typescript
async function listSessions(projectDir: string): Promise<SessionInfo[]> {
  const sessionsDir = path.join(projectDir, 'sessions');
  const files = await fs.readdir(sessionsDir);
  const sessions: SessionInfo[] = [];

  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    // 只读第一行（header）获取元数据
    const header = await readFirstLine(path.join(sessionsDir, file));
    if (header?.type === 'header') {
      sessions.push({
        sessionId: header.sessionId,
        name: header.name,
        createdAt: header.createdAt,
        model: header.model,
        // 用文件修改时间作为 lastAccessedAt
        lastAccessedAt: (await fs.stat(path.join(sessionsDir, file))).mtime,
      });
    }
  }

  // 按最近访问时间降序
  return sessions.sort((a, b) =>
    b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime()
  );
}
```

**性能考虑：** 每次 list 扫描目录 + 读首行。对于个人使用场景（<1000 个会话），这个操作在毫秒级完成。如果未来需要支持大规模会话，再引入缓存索引。

## 三、CLI 集成

### 3.1 命令行 Flag

```bash
zhixing                          # 新会话
zhixing --continue               # 继续当前项目最近的会话
zhixing --resume                 # 交互式选择会话
zhixing --resume 20260409-a3f1   # 恢复指定会话
zhixing --name "重构数据库"       # 为会话命名
```

### 3.2 交互式选择器

`--resume` 不带 ID 时显示最近 10 个会话：

```
? 选择要恢复的会话：
  1. [20260409-a3f1] 重构数据库 (2 小时前, deepseek-chat)
  2. [20260409-b2e3] (3 小时前, deepseek-chat)
  3. [20260408-c4d5] 修复登录bug (昨天, gpt-4o)
  ...
  0. 新建会话
```

使用 Node.js `readline` 实现（不引入额外交互库），与 ADR-005 的 MVP 策略一致。

### 3.3 斜杠命令

```
/sessions       — 列出当前项目的会话
/name <名称>    — 为当前会话命名
/save           — 手动保存当前状态（正常情况下自动保存）
```

### 3.4 恢复流程

```
zhixing --resume 20260409-a3f1
  ├ 1. 扫描 ~/.zhixing/projects/<project-id>/sessions/
  ├ 2. 找到 20260409-a3f1.jsonl
  ├ 3. 读取 header → 确认项目路径匹配
  ├ 4. 从后向前找最近的 compact 行
  │    ├ 有 compact → 用 summary 作为上下文 + compact 后的 turns
  │    └ 无 compact → 加载所有 turns 重建消息列表
  ├ 5. 重建 Message[] 传入 Agent Loop
  ├ 6. 显示 "已恢复会话 20260409-a3f1（15 轮对话）"
  └ 7. 等待用户输入
```

## 四、核心类型

### 4.1 SessionHeader

```typescript
interface SessionHeader {
  type: 'header';
  version: number;
  sessionId: string;
  name: string | null;
  projectPath: string;
  createdAt: string;
  model: string;
  provider: string;
}
```

### 4.2 SessionTurn

```typescript
interface SessionTurn {
  type: 'turn';
  turnIndex: number;
  timestamp: string;
  userMessage: Message;
  assistantMessage: Message;
  toolCalls: Array<{
    name: string;
    input: Record<string, unknown>;
    result: string;
  }>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}
```

### 4.3 SessionCompact

```typescript
interface SessionCompact {
  type: 'compact';
  timestamp: string;
  summary: string;
  turnsCompacted: number;
  tokensBefore: number;
  tokensAfter: number;
}
```

### 4.4 SessionRecord

```typescript
type SessionRecord = SessionHeader | SessionTurn | SessionCompact;
```

### 4.5 SessionStore 接口

```typescript
interface SessionStore {
  /** 保存一轮对话（追加到 JSONL） */
  appendTurn(sessionId: string, turn: SessionTurn): Promise<void>;

  /** 记录压缩事件 */
  appendCompact(sessionId: string, compact: SessionCompact): Promise<void>;

  /** 加载会话（从 JSONL 重建） */
  load(sessionId: string): Promise<{
    header: SessionHeader;
    messages: Message[];
    turnCount: number;
  }>;

  /** 列出当前项目的所有会话 */
  list(): Promise<SessionInfo[]>;

  /** 创建新会话 */
  create(options: {
    name?: string;
    model: string;
    provider: string;
  }): Promise<SessionHeader>;

  /** 更新会话名称 */
  rename(sessionId: string, name: string): Promise<void>;

  /** 删除会话 */
  delete(sessionId: string): Promise<void>;
}
```

## 五、写入策略

### 5.1 Turn-complete 时追加

```typescript
// 在 run-agent 的消费循环中
case 'turn_complete':
  if (sessionStore && currentTurn) {
    await sessionStore.appendTurn(sessionId, {
      type: 'turn',
      turnIndex: turnCounter++,
      timestamp: new Date().toISOString(),
      userMessage: currentTurn.userMessage,
      assistantMessage: currentTurn.assistantMessage,
      toolCalls: currentTurn.toolCalls,
      usage: currentTurn.usage,
    });
  }
  break;
```

### 5.2 写入实现

```typescript
async function appendToJSONL(
  filePath: string,
  record: SessionRecord,
): Promise<void> {
  const line = JSON.stringify(record) + '\n';
  await fs.appendFile(filePath, line, 'utf-8');
}
```

**不做 fsync**：追加模式在正常退出时由 OS flush。异常退出最多丢失最后一轮——可接受的折中（vs 每轮 fsync 的性能开销）。

### 5.3 读取实现

```typescript
async function loadSession(filePath: string): Promise<{
  header: SessionHeader;
  turns: SessionTurn[];
  compacts: SessionCompact[];
}> {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);

  let header: SessionHeader | null = null;
  const turns: SessionTurn[] = [];
  const compacts: SessionCompact[] = [];

  for (const line of lines) {
    try {
      const record: SessionRecord = JSON.parse(line);
      switch (record.type) {
        case 'header': header = record; break;
        case 'turn': turns.push(record); break;
        case 'compact': compacts.push(record); break;
      }
    } catch {
      // 跳过损坏的行
    }
  }

  if (!header) throw new Error('Missing session header');
  return { header, turns, compacts };
}
```

### 5.4 消息重建（恢复时）

```typescript
function rebuildMessages(
  turns: SessionTurn[],
  compacts: SessionCompact[],
): Message[] {
  // 找最近的 compact
  const lastCompact = compacts.length > 0
    ? compacts[compacts.length - 1]
    : null;

  const messages: Message[] = [];

  if (lastCompact) {
    // 注入摘要作为上下文
    messages.push({
      role: 'user',
      content: `[对话已压缩] 以下是之前对话的摘要：\n\n${lastCompact.summary}`,
    });
    messages.push({
      role: 'assistant',
      content: '已了解之前的对话上下文，请继续。',
    });
    // 只加载 compact 之后的 turns
    const compactTime = new Date(lastCompact.timestamp).getTime();
    const recentTurns = turns.filter(
      t => new Date(t.timestamp).getTime() > compactTime
    );
    for (const turn of recentTurns) {
      messages.push(turn.userMessage);
      messages.push(turn.assistantMessage);
    }
  } else {
    // 加载所有 turns
    for (const turn of turns) {
      messages.push(turn.userMessage);
      messages.push(turn.assistantMessage);
    }
  }

  return messages;
}
```

## 六、文件结构

```
packages/core/src/session/
  index.ts                ← 公共导出
  types.ts                ← SessionHeader / SessionTurn / SessionCompact / SessionRecord
  store.ts                ← SessionStore 实现
  serializer.ts           ← JSONL 读写工具函数
  __tests__/
    store.test.ts
    serializer.test.ts
```

## 七、实现路线

### Step M16-1：类型定义 + 序列化

```
内容：
  - types.ts：SessionHeader / SessionTurn / SessionCompact / SessionRecord
  - serializer.ts：appendToJSONL / loadSession / readFirstLine
验证：
  - 单元测试：serialize → parse → 与原始数据一致
  - 损坏行跳过测试
```

### Step M16-2：SessionStore

```
内容：
  - store.ts：create / appendTurn / appendCompact / load / list / rename / delete
  - 项目目录管理：getProjectDir / ensureProjectDir / project.json
验证：
  - 集成测试：create → append × 3 → load → 3 轮 turn
  - list 测试：多个会话 → 按时间排序
  - delete 测试：删除后 list 不包含
```

### Step M16-3：CLI 集成

```
内容：
  - --continue / --resume [id] / --name CLI flag
  - /sessions / /name 斜杠命令
  - 交互式会话选择器
验证：
  - 端到端：对话 → 退出 → --resume → 上下文保持
  - --continue 恢复最近会话
  - --resume 无 ID 显示选择器
```

## 八、ADR-005 决策 6 修正

原方案中存在路径矛盾（`~/.zhixing/sessions/<id>.jsonl` vs `~/.zhixing/sessions/<project-hash>/<session-id>.jsonl`）。

**统一为**：`~/.zhixing/projects/<project-id>/sessions/<session-id>.jsonl`

以本文档为准。理由：
1. 项目隔离是必需的——`--continue` 需要找"当前项目的最近会话"
2. `projects/<project-id>/` 层级比 `sessions/<project-hash>/` 更清晰，因为同一项目下还可能有其他数据（如 `project.json`、未来的 `memory/`）
3. 12 字符的 SHA-256 前缀 vs Claude Code 的路径编码：更短、无歧义

## 九、设计原则

1. **无索引文件**：避免 Claude Code 的同步 bug，按需扫描 + 读首行
2. **Turn 级粒度**：一轮要么完整保存要么不保存，不会留下半成品
3. **Header 内联**：首行包含所有元数据，无需额外 metadata 文件
4. **人类友好 ID**：`YYYYMMDD-xxxx` 比 UUID 好记好输入
5. **项目隔离**：SHA-256 前缀作为项目目录，`project.json` 存原始路径
6. **最小写入**：不 fsync，追加模式，最多丢一轮——可接受的折中
7. **渐进增强**：Phase 2 实现基础 CRUD + resume；Phase 3 考虑分支/fork
