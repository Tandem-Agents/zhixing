# 内置工具集（@zhixing/tools-builtin）

> 知行 agent 的内置工具集合。每个工具是一个 `ToolDefinition` 工厂，自描述能力与安全约束，由 cli/serve 入口注册到运行时。

## 一、设计原则

- **自描述安全**：工具通过 `boundaries` + `permissionArgumentKey` 字段声明跨越的安全边界，由 `BoundaryRegistry.fromTools(tools)` 与 `ToolArgumentExtractor.fromTools(tools)` 自动接入 SecurityPipeline——工具实现不直接调用权限/确认 API
- **fail-closed 默认值**：未声明的属性取保守值（`isReadOnly=false` / `isParallelSafe=false` / `needsPermission=true`）——忘了声明的工具被默认按最危险处理
- **错误是 ToolResult**：任何失败转为 `{ content, isError: true }` 返回给 LLM，**不抛异常**给 secure-executor 通用 catch
- **graceful degrade**：可选 capability（`ctx.llm` / `ctx.commitToUser` / `ctx.turnId` 等）缺失时退到合理 fallback，单测/automation 路径与正常路径共用

## 二、工具清单

| 工具 | 定位 | 权限分级 |
|---|---|---|
| `read` | 读文件（带行号、offset/limit） | `isReadOnly` 不需确认 |
| `write` | 写文件（创建或全量覆盖） | filesystem 写边界，需确认 |
| `edit` | 文件局部替换 | filesystem 写边界，需确认 |
| `glob` | 文件名模式查找 | 只读，不需确认 |
| `grep` | 文件内容正则搜索 | 只读，不需确认 |
| `bash` | 系统命令 / git / 包管理等 | shell 执行边界，需确认 |
| `memory` | 用户记忆持久化 | 工作空间内文件操作 |
| `schedule` | 创建 / 列表 / 更新 / 删除定时任务 | 任务系统副作用 |
| `web_fetch` | 抓取 URL，可选 secondary LLM 蒸馏 | network egress 边界，需确认 |
| `task_list` | LLM 自我组织当前任务列表（`task_list.set` 单动作） | 只读副作用（写 conversation meta） |

> 2026-05-11 更新：新增 `task_list`（`packages/tools-builtin/src/task-list.ts` + orchestrator 接线 `packages/orchestrator/src/tools/task.ts`），随 context-management v3 Phase 1 落地，仅 main profile 启用，是段切换 in-progress 判定的前置依赖（见 [context-management-v3-redesign.md](./context-management-v3-redesign.md) §8.1）。

`read / write / edit / glob / grep / bash` 通过专属 context classifier（FileSystemClassifier / ShellClassifier）接管分类，**不**声明 `boundaries`。`memory / schedule` 同理走 Internal classifier。`web_fetch` 是首个无 context classifier、走 `BoundaryImpactClassifier` 的工具，因此**必须**声明 `boundaries`。

## 三、自描述模式（21A + 21B 既定路径）

工具通过自描述字段声明能力与提示，cli 无需为每个工具 hardcode 任何配置：

```typescript
function createMyTool(): ToolDefinition {
  return {
    name: "my_tool",
    needsPermission: true,
    // 1. 安全边界(21A) — BoundaryImpactClassifier 自动接入
    boundaries: [{ boundaryType: "network", access: "egress", dynamic: false }],
    // 2. 权限匹配字段(21A) — ToolArgumentExtractor 自动接入,避免多 string 字段歧义
    permissionArgumentKey: "url",
    // 3. system-prompt 引导(21B) — buildToolUsage 自动透传到 ## Tool Usage 段
    systemPromptHints: [
      "- Use `my_tool` for X scenarios",
      "- Important constraint: Y",
    ],
    // ... 其他字段
  };
}
```

三类自描述同属一个哲学——**工具携带自身的元数据/约束/提示，cli 只是装配机制不带业务逻辑**。

入口（`cli/run-agent.ts`）启动时 `BoundaryRegistry.fromTools(tools)` / `ToolArgumentExtractor.fromTools(tools)` 自动 snapshot；`buildSystemPrompt` 的 `buildToolUsage` 通用 loop `tool.systemPromptHints` 拼接——**任何**工具加入这三个字段立即接入对应链路，零 cli 代码修改。

## 四、内置 PermissionRule 注入

工具可定义一组默认 builtin 规则（通常用于 preapproved hosts / 命令白名单等场景），通过 namespace 注入：

```typescript
// tools-builtin/src/web-fetch-rules.ts
export const WEB_FETCH_DEFAULT_RULES: readonly PermissionRule[] = ...

// cli/run-agent.ts
persistentStore.registerBuiltinRules("web_fetch", [...WEB_FETCH_DEFAULT_RULES]);
```

namespace 语义（21A M4）：
- 每个 caller 独立 namespace，互不污染
- 同 namespace 重复 register 替换该 namespace 规则集
- builtin 规则 in-memory，不写盘
- **用户池任一命中击败 builtin**（ADR-TPE-008 用户最终决定权）

## 五、web_fetch 工具

### 5.1 输入 schema

```typescript
{
  url: string;                          // 必填,https 或 http
  prompt?: string;                      // 可选,触发 distill 模式
  format?: "markdown" | "text";         // 默认 markdown
  maxChars?: number;                    // 1000–200000,默认 100000,distill 模式忽略
}
```

### 5.2 三层 graceful degrade

| 触发条件 | 行为 |
|---|---|
| `!ctx.llm`（单测 / automation / 未配置 secondary） | 返回 raw markdown |
| `!input.prompt`（用户未要求蒸馏） | 返回 raw markdown |
| distill 调用失败 / secondary 返回空 | 返回 raw markdown + 在 source 段附 `(distill failed: ...)` 提示 |

工具永远返回有用内容——对未配置 secondary 的用户友好，对 LLM 友好。

### 5.3 文件结构

```
packages/tools-builtin/src/
├── web-fetch.ts                       # 主体: createWebFetchTool() + ToolDefinition
├── web-fetch-rules.ts                 # WEB_FETCH_DEFAULT_RULES (preapproved hosts)
└── web-fetch/
    ├── internal.ts                    # defaultPolicy + LRU 缓存 + processContent (charset+turndown lazy)
    ├── distill.ts                     # DISTILL_SYSTEM_PROMPT + buildDistillPrompt + collectStream
    └── __tests__/
```

### 5.4 内容处理流程

```
safeFetch(url)
  ↓
processContent(result, format)
  ├── detectCharset(headers, body)  # Content-Type charset > BOM > utf-8
  ├── decodeBody(body, charset)     # TextDecoder fatal:false
  └── 路由:
      ├── 非 HTML → 原样返回
      ├── HTML + format=markdown → turndown (lazy import)
      └── HTML + format=text → 去标签 + 折叠空白
  ↓
sanitizeUntrustedText(text, { maxChars: prompt ? 100K : userMaxChars })
  ↓
contentCache.set(`${url}|${format}`, sanitized)
  ↓
distill 路径（ctx.llm + prompt）OR raw 路径
```

### 5.5 内容缓存（LRU）

- 模块级单例，容量 50
- key = `${url}|${format}`，**只缓存 sanitized raw content**
- 不缓存 distill 结果（同 url + 不同 prompt 应独立蒸馏）
- 进程级，不持久化
- 当前不带认证维度——WebFetch 不支持 cookie/Bearer。**未来若加认证，必须给 cacheKey 加 auth 维度**

### 5.6 distill 路径

```typescript
ctx.llm.secondary.chat({
  systemPrompt: DISTILL_SYSTEM_PROMPT,
  messages: [userMessage(buildDistillPrompt(url, content, prompt))],
  tools: [],                          // 显式空,蒸馏不允许工具调用
  abortSignal: ctx.abortSignal,
})
  ↓
collectStream                         // 累积 text_delta, 忽略 thinking/tool_call
  ↓
trim → 空则退 raw + 提示 / 非空则返回 summary
```

### 5.7 turndown 动态 import

`packages/tools-builtin` 启动 bundle 不付 70KB 成本，`turndown` 只在 HTML markdown 路径首次调用时加载。

### 5.8 boundaries 声明

```typescript
boundaries: [{ boundaryType: "network", access: "egress", dynamic: false }],
permissionArgumentKey: "url",
```

`BoundaryImpactClassifier` 据此分类为 `external` / `egress`，触发 PermissionMatcher 匹配 `web_fetch` namespace 的 builtin 规则。

### 5.9 preapproved hosts

12 个公开技术文档 / 参考站，每条规则形如：

```typescript
{
  pattern: { tool: "web_fetch", argument: `https://${host}/**` },
  decision: "allow",
  scope: "builtin",
}
```

涵盖：MDN / GitHub (含 raw.githubusercontent.com) / Stack Overflow / Wikipedia (en/zh) / npmjs.com / docs.python.org / react.dev / arxiv.org / typescriptlang.org / docs.anthropic.com。

**仅 https 协议**——故意只 preapprove HTTPS，提倡 secure。

### 5.10 错误转换

`safeFetch` 返回的 8 种 `FetchError` kind 全部转为友好的 `ToolResult.isError = true` 消息：

| FetchError.kind | ToolResult.content 模板 |
|---|---|
| `url-invalid` | `Failed to fetch X: Invalid URL ({reason})` |
| `ssrf-blocked` | `Failed to fetch X: Blocked: target IP {ip} is in restricted network {range}`（命中 `198.18.0.0/15` 时附 fake-IP 提示） |
| `redirect-blocked` | `Failed to fetch X: Redirect blocked ({reason}): {from} → {to}` |
| `too-large` | `Failed to fetch X: Response too large ({bytes} > {limit})` |
| `timeout` | `Failed to fetch X: Request timed out after {ms}ms` |
| `dns` | `Failed to fetch X: DNS resolution failed for {host}: {cause}` |
| `connect-failed` | `Failed to fetch X: Connection failed for {host}: {cause}`（cause 含 `(via proxy ...)` 标注时 LLM 自动诊断为代理问题） |
| `http-error` | `Failed to fetch X: HTTP {status} — {bodySnippet}` |

LLM 看到的是 actionable 信息，不是栈追踪。

### 5.11 代理支持（透传 `safeFetch` 的 NetworkPolicy.proxy）

`createWebFetchTool` 工厂接受可选 `opts.proxy` 参数，透传给 `safeFetch` 的 NetworkPolicy：

```typescript
createWebFetchTool({ proxy: config.network?.proxy })
```

- 默认 `undefined` → safeFetch 默认 `"auto"` 行为（从 env 读 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`）
- `"off"` → 显式禁用
- `"http://host:port"` → 显式代理 URL

代理详细机制见 [`network-egress.md` §十三](network-egress.md#十三代理支持httphttps-proxy)——**对用户无感**：99% 中国用户已被代理软件（Clash/V2Ray）自动设了 env，zhixing 默认 follow，零配置。

**cli 装配链**：
- `cli/run-agent.ts` 读 `ZhixingConfig.network?.proxy` 注入到 `createWebFetchTool({ proxy })`
- `cli/repl.ts` 的 `/status` 命令展示 `state.networkProxy`（启动时调 `describeProxy(config.network?.proxy)` 计算 `ProxyDescription` 三元组——区分 off / auto+null / auto+url / explicit 四态，display 字段永远脱敏避免凭证泄露）
- 失败诊断由 safeFetch 在 cause 自动注入 `(via proxy ...)` 标注——已脱敏 + scheme-aware（每跳按目标 URL scheme 选 env，与 EnvHttpProxyAgent 对齐），LLM 看到能直接识别"是代理问题还是目标问题"

## 六、System prompt 引导

`web_fetch` 通过 `systemPromptHints` 字段（§三 自描述模式）自描述 5 条引导：
- "fetches a URL, does not search the web"
- prompt vs raw 模式选择
- preapproved hosts 列表（**字符串拼自 `WEB_FETCH_PREAPPROVED_HOSTS`，与 builtin rules 同源**——加 host 改一处自动同步两处）
- "Do not invent URLs"
- 无 URL 不 guess

`buildToolUsage` 通用 loop 透传，cli 不知道 web_fetch 的存在——未来加 web_search / mcp 等工具按相同自描述路径接入即可。

## 七、与其他模块的关系

- **@zhixing/network**：`web_fetch` 唯一消费 `safeFetch` + `sanitizeUntrustedText` 的内置工具
- **二级 LLM 能力（LLMRoles）**：通过 `ctx.llm.secondary.chat()` 消费，graceful degrade 让无 secondary 路径同样工作
- **21A 安全管线**：`boundaries` + `permissionArgumentKey` + `registerBuiltinRules` 自描述接入，零侵入
- **Step 21 子 agent / Step 22 BackgroundAgent**：子 agent 入口设 `sessionType="ci"`（已是合法值），SecurityPipeline 自动按 non-interactive 处理；preapproved host builtin 规则仍生效，killer use case 通

## 八、未来扩展点

| 工具 | 复用基建 |
|---|---|
| `web_search` | `@zhixing/network` safeFetch（搜索结果二次抓取）+ `ctx.llm.secondary`（结果摘要） |
| `mcp_http`（MCP HTTP transport） | `@zhixing/network` safeFetch + 21A `BoundaryRegistry.register` 动态接入（非启动 snapshot） |
| `task`（子 agent 委托） | 21A `boundaries: [{ subagent, spawn, false }]`+ `permissionArgumentKey: "agent"` |

新工具按 §三自描述模式接入即可，无需修改 SecurityPipeline / BoundaryRegistry / PermissionStore 任何内部逻辑。
