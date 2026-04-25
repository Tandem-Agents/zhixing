# WebFetch 工具草稿

> 为 zhixing 设计 WebFetch 工具。本草稿仅覆盖 WebFetch 自身实现 + `core/network` + `text-sanitizer` 两个网络出口/文本净化底层原语。**前置：** 工具权限系统/边界声明/cheap LLM 注入 等基础设施补齐工作（见 [`specifications/tool-permission-execution.md`](../specifications/tool-permission-execution.md) Step 21A），**先做完那个再启动本草稿实施**。

**状态**：起草中（待 21A 落地后实施）· 17 项决策 · 3 个独立可验证 milestone · ~17–22h
**目标合并**：M1 → `specifications/network-egress.md`（新建）；M2+M3 → `specifications/tools-builtin.md`（新建）web_fetch 段

---

## 一、设计基线

### 1.1 已有可复用基建（不重复发明）

| 基建 | 位置 | WebFetch 复用方式 |
|------|------|-------------------|
| `SessionType: "interactive" \| "ci" \| "gateway" \| "api"` | `core/security/types.ts:17` | secure-executor 已注入；WebFetch 无需感知，权限决策由管线据此分流 |
| `BoundaryCrossing { boundaryType, access, dynamic }` | `core/security/types.ts:69-84` | WebFetch 通过 **`ToolBoundaryRegistry`** 注册 `{ network, egress, false }`；BoundaryImpactClassifier 自动归为 external |
| `PermissionRule { pattern, decision, scope }` | `core/security/types.ts:126` + `permission-store.ts` | 默认 allow 规则注册到 PermissionStore；用户可在 `~/.zhixing/permissions/*.json` 覆盖 |
| `PermissionScope: session/workspace/global` | 同上 | 用户在确认时选 scope，**等于"记住决策"** |
| `SecurityPipeline + middleware chain` | `core/security/security-pipeline.ts` | WebFetch 不接触；secure-executor 包裹工具调用前后自动跑 pipeline |
| `ConfirmationTracker` | `core/security/confirmation-tracker.ts` | 累计用户手动确认次数，达阈值后建议创建持久 PermissionRule |
| `ConfirmationBroker` | `core/confirmation/broker.ts` | 现有交互式渲染（TTY / TextRenderer / RPC Bridge）—— WebFetch 触发确认时复用 |
| Node 22+ 内置 `fetch` | runtime | safeFetch 直接基于（fetch 内部走 undici，可挂 dispatcher） |

### 1.2 真正缺失的设施（本草稿沉淀）

| 设施 | 位置 | 缺口 | 多 consumer 证据 |
|------|------|------|-----------------|
| `core/network/url-guard.ts` + `safe-fetcher.ts` | 新建 | 项目**完全无** SSRF / 安全 fetch 代码 | WebFetch / 未来 webhook 实际投递（TD） / 第二通道出站 / MCP HTTP / OAuth callback |
| `core/security/text-sanitizer.ts` | 新建 | 仅 `env-sanitize.ts` 针对环境变量；**无通用文本净化** | WebFetch / 未来 channel 入站净化 / MCP 工具结果净化 / 记忆内容净化 |

### 1.3 设计原则

- **WebFetch 是消费者，不是发明者**：能挂到现有管线就挂，不在工具内重建权限/确认/分级
- **底层设施按"已有 ≥ 2 个未来 consumer"门槛抽出**：满足则沉淀；只服务一个 consumer 的抽象延后到第二个出现时再做（避免过度设计 = 也是债务）
- **boundaries 通过 ToolBoundaryRegistry 注册**（zhixing 既定的工具/边界解耦设计），不在 ToolDefinition 加字段
- **preapproved hosts 是 PermissionRule（用户授权语义）**，注入 PermissionStore；不进 builtin-rules.ts（那是策略规则）

## 二、架构设计

### 2.1 调用链（WebFetch 视角）

```
LLM 决定调 web_fetch
  ↓
secure-executor.executeTool(input, ctx)
  ↓
SecurityPipeline.evaluate("web_fetch", input, cwd)
  ├── BoundaryImpactClassifier 查 ToolBoundaryRegistry → external
  ├── PermissionMatcher 查 PermissionStore：
  │     • 命中 allow（preapproved 或用户已授权 host）→ allowed=true
  │     • 命中 deny → allowed=false
  │     • 未命中 + sessionType="interactive" → requiresConfirmation
  │     • 未命中 + sessionType="ci"/"gateway"/"api" → 视具体策略：
  │       (gateway 走远程确认；ci/api 走 NonInteractiveResolver 默认 deny)
  └── 触发 ConfirmationBroker（如需）
  ↓
allowed=true → 调用 webFetchTool.call(input, ctx)
  ↓
1. safeFetch(input.url) [core/network]
2. content-type 路由 → turndown HTML→MD
3. sanitizeUntrustedText [core/security]
4. 内容缓存（in-tool LRU）
5. 若 input.prompt → ctx.cheapLLM.chat(distillRequest)
6. 返回 ToolResult
```

### 2.2 `core/network/`

```
packages/core/src/network/
  ├── url-guard.ts    # validateUrl / classifyIp / DEFAULT_BLOCKED_NETWORKS
  ├── safe-fetcher.ts # safeFetch
  ├── types.ts         # NetworkPolicy / FetchResult / FetchError union
  └── index.ts
```

**关键 interface**：

```typescript
interface NetworkPolicy {
  allowedProtocols: ("http" | "https")[];   // 默认 ["https", "http"]
  maxUrlLength: number;                       // 默认 2048
  maxBodyBytes: number;                       // 默认 5 * 1024 * 1024
  timeoutMs: number;                          // 默认 30_000
  maxRedirects: number;                       // 默认 5
  redirectPolicy: "same-host-only" | "follow-all";
  blockedNetworks: IpRange[];                 // 默认见下
}

const DEFAULT_BLOCKED_NETWORKS: IpRange[] = [
  // IPv4
  "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
  "169.254.0.0/16", "100.64.0.0/10", "224.0.0.0/4", "240.0.0.0/4", "0.0.0.0/8",
  // IPv6
  "::1/128", "fc00::/7", "fe80::/10", "ff00::/8", "::/128",
];

type FetchError =
  | { kind: "url-invalid"; reason: "protocol" | "userinfo" | "too-long" | "malformed" }
  | { kind: "ssrf-blocked"; ip: string; range: string }
  | { kind: "redirect-blocked"; from: string; to: string; reason: "cross-host" | "ssrf" | "loop" }
  | { kind: "too-large"; bytes: number; limit: number }
  | { kind: "timeout"; ms: number }
  | { kind: "dns"; host: string; cause: string }
  | { kind: "http-error"; status: number; bodySnippet?: string };  // ≤4KB

interface FetchResult {
  status: number;
  headers: Headers;
  body: Uint8Array;
  finalUrl: string;
  redirectChain: string[];
}

function safeFetch(url: string, policy?: Partial<NetworkPolicy>, opts?: { abortSignal?: AbortSignal }): Promise<FetchResult | FetchError>;
```

**安全契约**：

1. **DNS pinning（双层防御）**：
   - **层 A：URL 预校验** —— `validateUrl` 先识别 host 是不是 IP 字面量（IPv4 或 IPv6 形式），如果是，直接对该 IP 跑 `classifyIp` 拒绝私网（不需要解析 DNS）
   - **层 B：DNS lookup 钩子** —— 经过层 A 的非 IP 字面量 host，用 `undici.fetch + new undici.Agent({ connect: { lookup } })`，在 lookup 钩子里 `dns.lookup` 后 `classifyIp`，命中私网 → `cb(error)` 拒绝；放行后传 IP 给底层 socket，绑定到这个 IP（**spike 已验证**：lookup 钩子能拿到 hostname、能拒绝、能放行后正常请求；example.com 实测 200 OK）
2. **重定向逐跳完整复检**：用 `redirect: "manual"` 拿到 30x → 自己读 Location → 重做 `validateUrl` + 层 A + 层 B → 直至完成或拒绝。**不复用首跳的解析结果**。
3. **cross-host 重定向默认拒绝**：返回 `redirect-blocked`，由 caller 决定是否显式 fetch 新 URL。
4. **错误是返回值不是异常**：`Promise<FetchResult | FetchError>`。

**HTTP 客户端最终决策**：用 `undici` 包（添加为 packages/core 依赖），调用 `undici.fetch` + `undici.Agent`——**不通过** `globalThis.fetch + dispatcher`。原因：spike 实测发现 Node 22 内嵌 undici 与独立 undici 包的内部 API 契约不兼容（`invalid onRequestStart method`），独立调用 `undici.fetch` 可绕开此问题，行为完全可控。

### 2.3 `core/security/text-sanitizer.ts`

```typescript
function sanitizeUntrustedText(text: string, opts?: {
  maxChars?: number;
  normalizeForm?: "NFC" | "NFKC";  // 默认 NFC
  truncationMarker?: string;        // 默认 "[... truncated]"
}): string;
```

操作：① Unicode 归一化 ② 剥离零宽字符（`U+200B`–`U+200F` / `U+2060`–`U+206F` / `U+FEFF`）③ 长度截断 + marker。纯函数、零依赖、可单测。

### 2.4 WebFetch 工具

**新建 `packages/tools-builtin/src/web-fetch.ts`**。新增依赖：`turndown`（~70KB，行业标准 HTML→MD）。

```typescript
export function createWebFetchTool(): ToolDefinition {
  return {
    name: "web_fetch",
    description: "Fetch a URL and return content as Markdown. Provide `prompt` to extract specific information using a cheap model.",
    inputSchema: Type.Object({
      url: Type.String({ format: "uri", maxLength: 2048 }),
      prompt: Type.Optional(Type.String({ maxLength: 1000 })),
      format: Type.Optional(stringEnum(["markdown", "text"], { default: "markdown" })),
      maxChars: Type.Optional(Type.Number({ minimum: 1000, maximum: 200_000 })),
    }),
    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: true,        // SecurityPipeline 据 ToolBoundaryRegistry + 规则自动判定
    maxResultChars: 100_000,
    
    async call(input, ctx) {
      const result = await safeFetch(input.url, defaultWebFetchPolicy, { abortSignal: ctx.abortSignal });
      if ("kind" in result) return formatErrorAsToolResult(result);
      
      const text = await processContent(result, input.format ?? "markdown");
      const sanitized = sanitizeUntrustedText(text, {
        maxChars: input.prompt ? 100_000 : (input.maxChars ?? 100_000),
      });
      
      contentCache.set(cacheKey(input), sanitized);
      
      if (input.prompt) {
        const summary = await ctx.cheapLLM.chat({
          system: DISTILL_SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildDistillPrompt(input.url, sanitized, input.prompt) }],
          abortSignal: ctx.abortSignal,
        });
        return { content: `Source: ${input.url}\n\n${summary.text}`, isError: false };
      }
      
      return { content: `Source: ${input.url}\n\n${sanitized}`, isError: false };
    },
  };
}
```

**Boundary 注册**：tools-builtin/src/boundaries.ts（如已存在则追加；不存在则新建）：

```typescript
export const TOOLS_BUILTIN_BOUNDARIES: Record<string, BoundaryCrossing[]> = {
  // ... 现有工具
  web_fetch: [{ boundaryType: "network", access: "egress", dynamic: false }],
};
```

调用方（CLI 入口 / serve 入口）把这个 map 注入 SecurityPipeline 的 `toolBoundaryRegistry`。

**默认 PermissionRule 注入**：tools-builtin/src/default-permissions.ts 导出一组 `PermissionRule`，由调用方在创建 `PermissionStore` 后批量 `store.addRule(...)`：

```typescript
export const WEB_FETCH_DEFAULT_RULES: PermissionRule[] = [
  ...[
    "developer.mozilla.org", "react.dev", "docs.python.org",
    "github.com", "raw.githubusercontent.com",
    "stackoverflow.com", "en.wikipedia.org", "zh.wikipedia.org",
    "arxiv.org", "npmjs.com", "typescriptlang.org", "docs.anthropic.com",
  ].map((host) => ({
    id: `web-fetch-allow-${host}`,
    pattern: { tool: "web_fetch", argument: `https://${host}/**` },
    decision: "allow" as const,
    scope: "global" as const,
    createdAt: 0,
    source: "builtin",
  })),
];
```

**前提验证**（M2 实施前 1h spike）：
- `extractArgument(toolName="web_fetch", args)` 当前在没有 path/file_path/target/destination 字段时取"第一个 string 参数"——`url` 是 input 的第一个字段，应当被选中。需写测试确认。
- glob `https://github.com/**` 能匹配 `https://github.com/anthropics/sdk`：当前 globToRegex `**` 匹配任意（含 `/`），应该可以。需测试确认。

**若 spike 失败的兜底**：扩展 `permission-matcher` 加 host 模式（`{ kind: "host-in"; hosts: string[] }`）作为 PermissionRule.pattern 的替代分支。这是对现有 matcher 的**正向扩展**（host 模式对其他工具未来也有用，例如未来的 ssh / proxy 工具），不是 WebFetch 私有逻辑。

### 2.5 ToolExecutionContext 扩展

```typescript
interface ToolExecutionContext {
  // ... 现有字段（workingDirectory, abortSignal, turnId, emissionTarget, commitToUser, turnOrigin）
  /**
   * Cheap-model LLMProvider 实例。
   * 由调用方（CLI / serve 入口）创建并注入；从 ZhixingConfig.providers 中按 llm.cheapModel 解析。
   * 工具内部调便宜模型用于摘要/提炼/分类（WebFetch distill / 未来 search 后处理等）。
   */
  cheapLLM: LLMProvider;
}
```

**为什么不抽 `LLMService`**：当前唯一 consumer 是 WebFetch。Provider 已是统一抽象；再包一层 service 是过度设计——属于"按抽象本身，不按需求"的债务。第二个 consumer 出现且需求形态分化时再抽（YAGNI）。

**ZhixingConfig 扩展**（`packages/cli/src/config.ts` 或同名）：

```typescript
{
  llm: {
    defaultModel: string;     // 现有，主模型
    cheapModel: string;       // 新增，默认 "claude-haiku-4-5-20251001"
    cheapProviderId?: string; // 可选：cheap model 用哪个 provider 配置（默认与 defaultModel 同 provider）
  },
}
```

入口（CLI / serve）创建 cheap Provider 实例并把它放进每次工具调用的 context.cheapLLM。

## 三、3 个 milestone（独立可验证）

### M1：core/network/ + core/security/text-sanitizer.ts

**新建**：4 个文件（见 §2.2 / §2.3）。

**关键工作**：
- `validateUrl` / `classifyIp` 含 IPv4 + IPv6 + 子网匹配（CIDR）
- `safeFetch` 用 Node fetch + undici dispatcher 实现 DNS pinning（**spike 先行**）
- 重定向逐跳重做完整 URL 校验 + DNS + IP 分类
- 错误是结构化联合类型
- `sanitizeUntrustedText` 纯函数 + 单测

**验收**：
- 私网 / 回环 / link-local / ULA / CGNAT / multicast / 0.0.0.0 / unspecified / IPv6 各 IP range 命中 → `ssrf-blocked`
- 同 host 5 跳重定向 → 跟随；任何一跳 cross-host → `redirect-blocked`
- DNS rebinding 模拟（首跳公网，重定向解析到内网）→ 第二跳 IP 检查命中
- 超时 / DNS 失败 / 5xx / 4xx / >5MB body → 各产生正确 error kind
- text-sanitizer：含零宽字符的输入被剥离；NFC 归一化；超长截断 + marker

**估工**：8–10h

### M2：WebFetch 工具 + boundary 注册 + 默认 PermissionRule

**新建**：`tools-builtin/src/web-fetch.ts` + boundaries 注册 + 默认 rules 数组。

**前置已确认**（spike 完成）：
- ✅ glob `https://github.com/**` → 编译为 `^https:\/\/github\.com\/.*$`，能匹配 `https://github.com/anthropics/sdk` 等嵌套路径（globToRegex 行 50-80 验证：`**` 不分 path-aware，始终匹配任意；`/` 不在 escape 列表所以原样保留；`.` 自动转义）
- ⚠️ **必须扩展 `extractArgument`**：当前函数（permission-store.ts 行 381-399）priority list 只含 `path / file_path / target / destination`，未包含 `url`。WebFetch input `{ url, prompt? }` 中 `prompt` 也是 string，若 LLM 以 `{prompt, url}` 顺序传 args，`Object.values` 会先返回 `prompt` —— 命中错误 argument。**修复**：priority list 追加 `"url"`（一行变更），未来 web_search / http 类工具同样受益

**关键工作**：
- 工具核心：`safeFetch → processContent → sanitize → optional distill`
- turndown 集成（lazy import + 添加为 tools-builtin 依赖）
- 内容 LRU（自实现，~30 行）
- Boundary 注册到 ToolBoundaryRegistry（具体注册位置由 CLI / serve 入口现有的 registry 注入逻辑决定）
- 默认 PermissionRule 数组导出 + 入口启动时注入 PermissionStore
- **小扩展 `extractArgument` 加 `url` 到 priority list**（见上）

**验收**：
- 工具单测：safeFetch mock → 验证 turndown 转换 / 缓存命中 / prompt 模式触发 distill
- 集成测：preapproved host → SecurityPipeline 自动 allow
- 集成测：未配置 host + interactive → 触发 ConfirmationBroker
- 集成测：未配置 host + ci → NonInteractiveResolver deny
- 集成测：SSRF 命中（任何路径）→ 工具不被调用（pipeline 拦截）

**估工**：5–7h（含 spike）

### M3：cheapLLM 注入 + ZhixingConfig + system-prompt + spec 提升

**关键工作**：
- ToolExecutionContext 加 cheapLLM 字段
- ZhixingConfig 加 llm.cheapModel + 可选 cheapProviderId
- 入口（CLI run-agent / serve session）创建 cheap Provider 实例并注入 ToolExecutionContext.cheapLLM
- tool-executor 创建 context 时透传
- system-prompt.ts buildToolUsage 加 web_fetch 引导
- E2E 手测（CLI / serve / 飞书路径）
- spec 提升：M1 → `network-egress.md`（新建）；M2 → `tools-builtin.md`（新建）

**估工**：4–5h

**总工**：~17–22h（约 2.5 工作日）

## 四、决策清单（17 项）

| # | 决策项 | 决策 | 理由 |
|---|--------|------|------|
| 1 | 工具数 MVP | 仅 web_fetch | WebSearch 独立工作量，下个 Step |
| 2 | Schema | `{url, prompt?, format?, maxChars?}` | prompt 模式 + raw 模式双用 |
| 3 | HTTP 客户端 | `undici` 包（packages/core 加依赖），调 `undici.fetch + undici.Agent` | spike 实测：Node 22 内嵌 undici 与独立 undici 包内部 API 不兼容，必须直接用 undici.fetch 才能正确挂 connect.lookup 钩子 |
| 4 | HTML→MD | turndown（lazy import） | 行业标准，~70KB |
| 5 | SSRF 深度 | URL 校验 + IP 分类 + DNS pinning + 重定向逐跳 re-validate | 零妥协，含 IPv6 / CGNAT |
| 6 | 重定向 | 同 host 自动 + cross-host 拒绝 | 防 open redirect 利用 |
| 7 | 截断 | 字符（raw 100K，distill 后 5K） | 简单可预测 |
| 8 | 缓存 | 工具内自实现小 LRU | 单 consumer，避免新依赖 |
| 9 | 权限分级 | 复用 SecurityPipeline + PermissionRule | 现有基建已成熟 |
| 10 | Boundary 声明 | 通过 ToolBoundaryRegistry 注册（不在 ToolDefinition 加字段） | 遵循 zhixing 既定的工具/边界解耦 |
| 11 | preapproved hosts 注入位置 | PermissionRule 注入 PermissionStore | 用户授权语义；用户可改可删 |
| 12 | LLM 服务抽象 | **不抽 LLMService**，用 ctx.cheapLLM (Provider 直注) | 当前仅 1 个 consumer；YAGNI |
| 13 | cheap model 配置 | ZhixingConfig.llm.cheapModel | 模型 ID 会变，配置避免改代码 |
| 14 | 编码处理 | Content-Type 嗅探 + UTF-8 fallback + sanitizer | 防 prompt 注入 |
| 15 | 错误格式 | 结构化 union type | LLM 友好 reason |
| 16 | 认证 | MVP 不支持 | 公开 URL 80%+ |
| 17 | JS 渲染 | 不支持 | 重依赖 + 慢 + SSRF 难控 |

## 五、与其他模块的关系

| 模块 | 关系 |
|------|------|
| 安全基建（SecurityPipeline / PermissionRule / Broker / ConfirmationTracker / Boundary） | **完全复用，零侵入** |
| Step 21 子 agent | 子 agent 入口设 sessionType="ci"（已是合法值），SecurityPipeline 自动按 non-interactive 处理；preapproved host rules 仍生效，killer use case 通；**Step 21 spec 无需为 WebFetch 单独设计任何东西** |
| Step 22 BackgroundAgent | 同 Step 21 |
| TD 修复（webhook 实际投递） | 复用 `safeFetch` 替换当前 stub |
| 第二社交通道（钉钉 / 企微） | 出站 webhook 复用 `safeFetch` |
| MCP HTTP transport（未来） | 复用 `safeFetch` + `text-sanitizer` |
| Channel 入站净化（未来） | 复用 `text-sanitizer` |
| WebSearch（未来工具） | 复用 ctx.cheapLLM 做 search 后处理 |

## 六、暂不做（明确边界）

| 项 | 原因 | 触发再做的条件 |
|---|------|-----------------|
| WebSearch 工具 | 独立工作量 | M3 之后下个独立 Step |
| JS 渲染 | Puppeteer 重 + SSRF 难控 | 出现真实需求 |
| 认证（cookie / Bearer） | 公开 URL 已覆盖 80%+ | 接私域 wiki 时 |
| 持久化缓存 | 进程级足够 | 不计划 |
| Readability 正文抽取 | turndown 已可用 | 质量真不够时增量加 |
| 多源并行 fetch | 暂无场景 | 不计划 |
| 智能 rate limit | 现有 `rate-limiter.ts` 可后续接入 | 出现 quota 触顶 |
| 路径级 preapproved | host 级足够 | 出现真实需求 |
| `LLMService` 通用抽象 | 仅 1 个 consumer，YAGNI | 第二个 consumer 出现且需求形态分化时 |

## 七、Spike 验证结果（已完成）

| Spike | 结果 | 决策落地 |
|-------|------|---------|
| Node fetch + undici dispatcher 拦截 IP | ⚠️ 部分通过：直接用 Node fetch + dispatcher **不通**（Node 22 内嵌 undici 与独立 undici 包 API 不兼容，报 `invalid onRequestStart method`）；**改用 `undici.fetch` 直接调用通过**（lookup 钩子能拿到 hostname、能拒绝、能放行后正常 200） | 决策 #3 改为"添加 undici 依赖到 packages/core，用 undici.fetch" |
| `extractArgument` 对 `web_fetch` 选中 `input.url` | ❌ 不可靠：当前函数 priority list 只含 path/file_path/target/destination，fallback 是 `Object.values()` 第一个 string；若 LLM 以 `{prompt, url}` 顺序传则匹配 prompt | 修复方案：M2 实施时把 `"url"` 加入 priority list（permission-store.ts:389 一行变更）。**正向沉淀**（未来 web_search / http_request 等工具受益） |
| glob `https://host/**` 匹配嵌套 URL | ✅ 通过（globToRegex 静态分析）：`**` 始终匹配任意；`/` 不在 escape 列表原样；`.` 自动转义 → `^https:\/\/github\.com\/.*$` 匹配 `https://github.com/anthropics/sdk` | 默认 PermissionRule 直接用此 pattern 形态，无需扩 matcher |

**净结果**：M1 准备就绪（HTTP 客户端方案已锁定）；M2 准备就绪（含 1 行 extractArgument 扩展），无需引入 `host-in` 这种新 matcher 模式。
