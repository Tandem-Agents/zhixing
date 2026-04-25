# WebFetch 工具草稿

> 为 zhixing 设计 WebFetch 工具。本草稿覆盖 WebFetch 自身实现 + `@zhixing/network`（含 SSRF 安全的 safeFetch 与通用文本净化）两个底层原语。**前置依赖已就绪**：[Step 21A 工具权限/边界基础设施补齐](../specifications/tool-permission-execution.md)（boundaries 自描述 / permissionArgumentKey / builtin scope + namespace registerBuiltinRules）。
>
> distill 模式所需的"二级 LLM 角色"是会话级 capability，由独立 spec [`secondary-llm-capability.md`](../specifications/secondary-llm-capability.md) 提供，作为 21B M0（先于本草稿 M1/M2）实施。本草稿不重新设计该 capability，只描述 WebFetch 作为消费者怎么消费它。

**状态**：spec 重构完成（已对齐 21A 落地现状 + 21B M0 二级 LLM 能力）
**目标合并**：M1 → `specifications/network-egress.md`（新建）；M2 → `specifications/tools-builtin.md`（新建）web_fetch 段
**实施 milestone**：M0（独立 spec 实施）+ M1 + M2 + M3（详见 §三）

---

## 〇、概念

### 〇.1 这是什么？底层用什么查？依赖搜索引擎吗？

WebFetch 是 **URL 抓取工具**：input 是 agent 已知的具体 URL，output 是该 URL 内容（Markdown / text）。底层就是 Node 22+ 自带 `fetch`（实际通过 `undici` 包运行），叠加 SSRF 校验 / DNS pinning / 重定向逐跳 re-validate / Content-Type 路由 / turndown HTML→MD 几层处理。

**不调任何搜索引擎**——agent 必须先**知道**具体 URL 才能用 WebFetch。"我想了解 X 是什么"这类自然语言查询需求由 WebSearch（独立工具，21B 之后的 step）解决；WebFetch 的语义是"我已经有 URL，帮我把内容读回来 + 可选地按 prompt 提取要点"。

典型 agent 触发路径：
- 用户在对话里粘贴链接 → agent 调 WebFetch 读取
- agent 已知文档地址（如 `https://docs.python.org/3/library/asyncio.html`）→ 直接 fetch
- WebSearch 返回结果列表后，agent 选定其中一个 URL 调 WebFetch 读全文（搜索 + 抓取分两步）

### 〇.2 收费吗？为什么不收费？

**WebFetch 自身不产生任何外部账单**——只做 HTTP GET，不调任何第三方付费服务：

| 层 | 实现 | 是否付费 |
|----|------|---------|
| 网络抓取 | Node 自带 fetch + undici 包 | 零外部 API |
| HTML→MD 转换 | turndown（开源 npm 包，纯本地转换） | 零 |
| 文本净化 | `@zhixing/network` 内置（纯函数） | 零 |
| distill（可选） | 调 `ctx.llm.secondary`——用户**自己**的模型 API key | 与主对话同一预算 |

唯一消耗 token 的是 distill 路径，但走的是用户已经为对话付费的 LLM 通道，不是新开支项；不传 `prompt` 时直接返回 raw markdown，零 token。

### 〇.3 vs 付费网络查询服务（Tavily / Perplexity / Brave Search API / Firecrawl）

这些"网络查询"服务与 WebFetch **不是同类工具**，常被混淆——主要区别：

| 维度 | WebFetch（本工具） | 付费网络查询服务 |
|------|------|---|
| 输入 | 已知 URL | 自然语言查询 |
| 内容来源 | 用户指定的单个页面 | 搜索引擎聚合 + 多页抽取 |
| 抓取实现 | 自己 fetch + 解析 | 服务商代理（带 JS 渲染 / 反爬 / 缓存 / robots.txt 处理） |
| 收费 | 零（依赖用户已有 LLM key 做 distill） | 按 query 计费（典型 $5-20 / 1k queries） |
| 适合场景 | 读这篇 PR / spec / docs | 查一下 X 的最新进展 / 找参考资料 |
| 失败模式 | 单 URL 不可达即失败（无 fallback） | 自动多源 fallback / 缓存命中 |

zhixing 的 WebSearch 工具（21B 之后独立 step）才会做"是否接付费搜索引擎"的取舍——本草稿不解决该问题。**WebFetch 不和付费查询服务竞争**——它是付费查询服务返回 URL 之后的"读取"环节。

### 〇.4 其他 agent 怎么做？效果一样吗？

业界三家参考实现都把"抓 URL"和"搜索"分成两个独立工具，本草稿延续这个分工：

| Agent | URL 抓取工具 | 抓取层做法 |
|-------|------------|-----------|
| Claude Code | `WebFetch` | 自实现 fetch + 内置 small fast model distill |
| Hermes | `web_extract_tool` | 自实现 fetch + auxiliary model distill；**大页面并行分块** distill |
| OpenClaw | `web-fetch` | Readability 抽取 + Firecrawl 选配（处理 JS 渲染 / 反爬） |

效果差异：

- **静态 HTML 页面**（docs / GitHub / blog 等占大多数）：三家基本同质——HTML→MD 都用 turndown / Readability 类库，质量差距在边角字符处理
- **JS 重渲染页面**（SPA / 单页应用）：OpenClaw + Firecrawl 路线领先；Claude Code / Hermes / 本工具 MVP 都不支持 JS 渲染，等真出现需求再接 Puppeteer / Firecrawl（决策 #17 + §六 暂不做）
- **大页面 distill**（>100KB）：hermes 的并行分块给 cheap 模型并发处理是可见加速优化，本工具未来可参考；MVP 先用单次 distill
- **distill 质量**：主要取决于 secondary 模型本身能力——三家都用 cost-quality 偏 cost 端的模型（Haiku / Gemini-Flash / Kimi-Turbo 等），效果同档

**对 zhixing 用户感知**：80% 场景（静态 HTML 文档抓取）三家无可见差异；JS 重渲染场景在 MVP 后增量补足。

---

## 一、设计基线

### 1.1 已有可复用基建（21A 完成后）

| 基建 | 位置 | WebFetch 复用方式 |
|------|------|-------------------|
| `SessionType: "interactive" \| "ci" \| "gateway" \| "api"` | `core/security/types.ts` | secure-executor 已注入；WebFetch 无需感知，权限决策由管线据此分流 |
| `ToolDefinition.boundaries?` 自描述字段（21A M1） | `core/types/tools.ts:240` | WebFetch 直接在 `createWebFetchTool()` 内声明 `boundaries: [{ network, egress, false }]`；BoundaryRegistry.fromTools(tools) 自动 snapshot |
| `ToolDefinition.permissionArgumentKey?` 自描述字段（21A M1） | `core/types/tools.ts:261` | WebFetch 声明 `permissionArgumentKey: "url"`；ToolArgumentExtractor.fromTools(tools) 自动接入；PermissionStore.match 按声明字段提取，避免多 string 字段歧义 |
| `BoundaryCrossing { boundaryType, access, dynamic }` | `core/security/types.ts:69` | WebFetch boundaries 字段使用此类型 |
| `PermissionRule` + `PermissionStore` | `core/security/types.ts:197` + `permission-store.ts` | preapproved hosts 用 `scope: "builtin"` 通过 `store.registerBuiltinRules("web_fetch", rules)` 注册（21A M4 多源 namespace API）；用户可在 `~/.zhixing/permissions/*.json` 覆盖 |
| `PermissionScope: "session" \| "workspace" \| "global" \| "builtin"`（21A M4 加 builtin） | `core/security/types.ts` | builtin 是系统预置语义；不写盘；与用户池**两阶段独立匹配**（user 池任一命中 → 完全决定结果，builtin 不参与）；保证用户最终决定权 |
| `SecurityPipeline + middleware chain` | `core/security/security-pipeline.ts` | WebFetch 不接触；secure-executor 包裹工具调用前后自动跑 pipeline（含 SuggestionMiddleware order=30、PermissionMatcher order=40） |
| `ConfirmationTracker` + `SuggestionMiddleware` | `core/security/confirmation-tracker.ts` + 同名 middleware | 累计用户手动确认次数，达阈值后建议创建持久 PermissionRule |
| `ConfirmationBroker` | `core/confirmation/broker.ts` | 现有交互式渲染（TTY / TextRenderer / RPC Bridge）—— WebFetch 触发确认时复用；远程通道也通（远程确认已落地） |
| **二级 LLM 角色**（`ctx.llm.secondary`，21B M0） | `core/types/tools.ts:llm?: LLMRoles`（M0 注入） | WebFetch distill 模式调 `ctx.llm.secondary.chat()`；graceful degrade（`!ctx.llm` 时返回 raw） |
| Node 22+ 内置 `fetch` | runtime | safeFetch 基于（fetch 内部走 undici，可挂 dispatcher），但因 spike 实测内嵌 undici 与独立包不兼容，最终方案改为 `undici.fetch + undici.Agent` 直调 |

### 1.2 真正缺失的设施（本草稿沉淀）

| 设施 | 位置 | 缺口 | 多 consumer 证据 |
|------|------|------|-----------------|
| `@zhixing/network` 新包：`url-guard.ts` + `safe-fetcher.ts` | 新建包 packages/network | 项目**完全无** SSRF / 安全 fetch 代码 | WebFetch / 未来 webhook 实际投递（TD） / 第二通道出站 / MCP HTTP / OAuth callback |
| `@zhixing/network` 内 `text-sanitizer.ts` | 新建（同包） | 仅 `core/security/env-sanitize.ts` 针对环境变量；**无通用文本净化** | WebFetch / 未来 channel 入站净化 / MCP 工具结果净化 / 记忆内容净化 |

**新包 `packages/network` 的选址理由**（决策见 §四 #3）：
- 不放 `packages/core`：避免 `undici` 这个 ~600KB 依赖污染所有下游（tools-builtin / providers / channels / server / cli 全部）
- 不放 `packages/tools-builtin`：webhook 投递 / 第二通道出站 / MCP HTTP 等未来消费者位于 server 而非 tool，server 不该 depends on tools-builtin
- 独立包让网络出口原语可被 server 与 tools-builtin 同时消费，依赖向上而非交叉

### 1.3 设计原则

- **WebFetch 是消费者，不是发明者**：能挂到现有管线就挂，不在工具内重建权限/确认/分级——21A 已让"工具自描述 boundaries + permissionArgumentKey → 自动接入 SecurityPipeline"成为既定路径
- **底层设施按"已有 ≥ 2 个未来 consumer"门槛抽出**：满足则沉淀；只服务一个 consumer 的抽象延后到第二个出现时再做（避免过度设计 = 也是债务）
- **boundaries 通过 ToolDefinition 自描述**（21A M1 后的既定路径），fromTools(tools) 自动 snapshot 到 BoundaryRegistry——**不**用集中 map 注入
- **preapproved hosts 是 builtin 规则**（系统预置语义），通过 `store.registerBuiltinRules("web_fetch", rules)` 注入；scope 必须是 `"builtin"` 不是 `"global"`——后者会写盘成为"幽灵规则"，违反 21A M4 设计意图（详见 ADR-TPE-008）
- **distill 是 capability 消费**：用 `ctx.llm.secondary` 调二级模型，graceful degrade 让 raw 模式与 distill 模式自然共存
- **网络出口原语沉到独立包** `@zhixing/network`，不放 core（dep weight 考虑）也不放 tools-builtin（server-side 消费需求）

## 二、架构设计

### 2.1 调用链（WebFetch 视角）

```
LLM 决定调 web_fetch（args: { url, prompt?, format?, maxChars? }）
  ↓
secure-executor.executeTool(input, ctx)
  ↓
SecurityPipeline.evaluate("web_fetch", input, cwd)
  ├── BoundaryImpactClassifier 查 BoundaryRegistry（21A 已 snapshot）→ external（network/egress）
  ├── SuggestionMiddleware (order=30)：累计用户 confirm 次数，到阈值后透传 suggest=true
  └── PermissionMatcher (order=40) 查 PermissionStore（21A M4 两阶段匹配）：
        ① 用户池（session/workspace/global）匹配
           - 命中 → 完全按 user pool resolveConflict 决定（builtin 不参与）
        ② 用户池空 → builtin 池兜底
           - 命中 web_fetch namespace 内某条 allow（如 `https://docs.anthropic.com/**`）→ allowed=true
        ③ 都不命中 + sessionType="interactive" → requiresConfirmation
           ├── ctx.confirmationBroker 弹 confirm（携带 suggestion 信息）
           ├── 用户选 "始终允许（本工作区）" → 创建 workspace scope 规则
           └── 用户拒绝 → deny
        ④ 都不命中 + sessionType="ci"/"gateway"/"api" → 走 NonInteractiveResolver
           - 当前默认 fail-to-deny；gateway 路径上层有可能走远程确认（remote-confirmation 已落地）
  ↓
allowed=true → 调用 webFetchTool.call(input, ctx)
  ├── 1. safeFetch(input.url) [@zhixing/network]
  ├── 2. content-type 路由 → turndown HTML→MD
  ├── 3. sanitizeUntrustedText [@zhixing/network]
  ├── 4. 内容缓存（in-tool LRU，~30 行）
  ├── 5. 分支：
  │   ├── ctx.llm 注入 + input.prompt 提供 → ctx.llm.secondary.chat(distillRequest)
  │   └── 否则 → graceful degrade，返回 raw markdown（含 truncate marker）
  └── 6. 返回 ToolResult { content, isError: false }
```

### 2.2 `@zhixing/network` 包结构

```
packages/network/
  ├── src/
  │   ├── url-guard.ts     # validateUrl / classifyIp / DEFAULT_BLOCKED_NETWORKS
  │   ├── safe-fetcher.ts  # safeFetch
  │   ├── text-sanitizer.ts # sanitizeUntrustedText（详见 §2.3）
  │   ├── types.ts          # NetworkPolicy / FetchResult / FetchError union
  │   └── index.ts          # 公共 API 出口
  ├── package.json          # 依赖：undici（核心）；devDeps: vitest 等
  └── tsconfig.json
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

function safeFetch(
  url: string,
  policy?: Partial<NetworkPolicy>,
  opts?: { abortSignal?: AbortSignal },
): Promise<FetchResult | FetchError>;
```

**安全契约**：

1. **DNS pinning（双层防御）**：
   - **层 A：URL 预校验** —— `validateUrl` 先识别 host 是不是 IP 字面量（IPv4 或 IPv6 形式），如果是，直接对该 IP 跑 `classifyIp` 拒绝私网（不需要解析 DNS）
   - **层 B：DNS lookup 钩子** —— 经过层 A 的非 IP 字面量 host，用 `undici.fetch + new undici.Agent({ connect: { lookup } })`，在 lookup 钩子里 `dns.lookup` 后 `classifyIp`，命中私网 → `cb(error)` 拒绝；放行后传 IP 给底层 socket，绑定到这个 IP（**spike 已验证**：lookup 钩子能拿到 hostname、能拒绝、能放行后正常请求；example.com 实测 200 OK）
2. **重定向逐跳完整复检**：用 `redirect: "manual"` 拿到 30x → 自己读 Location → 重做 `validateUrl` + 层 A + 层 B → 直至完成或拒绝。**不复用首跳的解析结果**。
3. **cross-host 重定向默认拒绝**：返回 `redirect-blocked`，由 caller 决定是否显式 fetch 新 URL。
4. **错误是返回值不是异常**：`Promise<FetchResult | FetchError>`。

**HTTP 客户端最终决策**：用 `undici` 包（添加为 packages/network 依赖），调用 `undici.fetch` + `undici.Agent`——**不通过** `globalThis.fetch + dispatcher`。原因：spike 实测发现 Node 22 内嵌 undici 与独立 undici 包的内部 API 契约不兼容（`invalid onRequestStart method`），独立调用 `undici.fetch` 可绕开此问题，行为完全可控。

### 2.3 `@zhixing/network` 内 text-sanitizer

```typescript
function sanitizeUntrustedText(text: string, opts?: {
  maxChars?: number;
  normalizeForm?: "NFC" | "NFKC";  // 默认 NFC
  truncationMarker?: string;        // 默认 "[... truncated]"（英文，详见 §四 #18）
}): string;
```

操作：① Unicode 归一化 ② 剥离零宽字符（`U+200B`–`U+200F` / `U+2060`–`U+206F` / `U+FEFF`）③ 长度截断 + marker。纯函数、零依赖、可单测。

### 2.4 WebFetch 工具（`packages/tools-builtin/src/web-fetch.ts`）

新增依赖：`turndown`（~70KB，行业标准 HTML→MD），加在 packages/tools-builtin（仅本工具用）。

```typescript
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@zhixing/core";
import { safeFetch, sanitizeUntrustedText } from "@zhixing/network";
import { defaultWebFetchPolicy, processContent, contentCache } from "./web-fetch/internal.js";
import { DISTILL_SYSTEM_PROMPT, buildDistillPrompt, collectStream } from "./web-fetch/distill.js";

export function createWebFetchTool(): ToolDefinition {
  return {
    name: "web_fetch",
    description:
      "Fetch a URL and return content as Markdown. Provide `prompt` to extract specific information using a secondary model (typically smaller and faster than the main agent model; falls back to main when secondary is not configured). Without prompt, returns raw Markdown.",
    inputSchema: Type.Object({
      url: Type.String({ format: "uri", maxLength: 2048 }),
      prompt: Type.Optional(Type.String({ maxLength: 1000 })),
      format: Type.Optional(stringEnum(["markdown", "text"], { default: "markdown" })),
      maxChars: Type.Optional(Type.Number({ minimum: 1000, maximum: 200_000 })),
    }),
    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: true,

    // ─── 21A 自描述（自动接入 SecurityPipeline）───
    boundaries: [{ boundaryType: "network", access: "egress", dynamic: false }],
    permissionArgumentKey: "url",

    maxResultChars: 100_000,

    async call(input, ctx) {
      const result = await safeFetch(
        input.url,
        defaultWebFetchPolicy,
        { abortSignal: ctx.abortSignal },
      );
      if ("kind" in result) {
        return formatErrorAsToolResult(result);
      }

      const text = await processContent(result, input.format ?? "markdown");
      const sanitized = sanitizeUntrustedText(text, {
        maxChars: input.prompt ? 100_000 : (input.maxChars ?? 100_000),
      });

      contentCache.set(cacheKey(input), sanitized);

      // graceful degrade: ctx.llm 缺失 OR 用户未传 prompt → 返回 raw markdown
      // ADR-SLLM-006：所有 LLMRoles consumer 必须支持 ctx.llm===undefined 路径
      if (!ctx.llm || !input.prompt) {
        return {
          content: `Source: ${input.url}\n\n${sanitized}`,
          isError: false,
        };
      }

      // 主路径：通过会话级 capability 调二级模型蒸馏
      // ctx.llm.secondary 在 cli/serve 入口已注入；其背后 provider 由配置决定
      const summary = await collectStream(
        ctx.llm.secondary.chat({
          systemPrompt: DISTILL_SYSTEM_PROMPT,
          messages: [{
            role: "user",
            content: buildDistillPrompt(input.url, sanitized, input.prompt),
          }],
          abortSignal: ctx.abortSignal,
        }),
      );

      return {
        content: `Source: ${input.url}\n\n${summary}`,
        isError: false,
      };
    },
  };
}
```

**Boundary 注册路径（21A 既定）**：
- WebFetch ToolDefinition 内 `boundaries` 字段直接声明（见上代码）
- CLI / serve 入口已调 `BoundaryRegistry.fromTools(tools)`（21A run-agent.ts:357 现状）→ 自动 snapshot
- **不需要**新建 `tools-builtin/src/boundaries.ts` 集中映射文件——21A 自描述路径已替代

**默认 PermissionRule（preapproved hosts）注册路径**：

```typescript
// packages/tools-builtin/src/web-fetch-rules.ts
import { PermissionStore } from "@zhixing/core";
import type { PermissionRule } from "@zhixing/core";

const PREAPPROVED_HOSTS = [
  "developer.mozilla.org", "react.dev", "docs.python.org",
  "github.com", "raw.githubusercontent.com",
  "stackoverflow.com", "en.wikipedia.org", "zh.wikipedia.org",
  "arxiv.org", "npmjs.com", "typescriptlang.org", "docs.anthropic.com",
];

export const WEB_FETCH_DEFAULT_RULES: PermissionRule[] = PREAPPROVED_HOSTS.map(host =>
  PermissionStore.createRule({
    pattern: { tool: "web_fetch", argument: `https://${host}/**` },
    decision: "allow",
    scope: "builtin",  // 21A M4 系统预置语义；createRule 只接受 pattern/decision/scope/workspace 字段
  })
);
```

CLI / serve 入口在 web_fetch 工具启用时调用：

```typescript
// cli/run-agent.ts（仅在 web_fetch 工具启用时）
import { WEB_FETCH_DEFAULT_RULES } from "@zhixing/tools-builtin";

permissionStore.registerBuiltinRules("web_fetch", WEB_FETCH_DEFAULT_RULES);
```

**关键点**：
- scope 必须 `"builtin"`，不可 `"global"`——前者是 in-memory 系统预置（不写盘 / 严格让位用户池），后者是用户授权（写盘 / 与其他用户规则同池）
- 用户在 `~/.zhixing/permissions/global.json` 加一条 `web_fetch deny *` 通配规则**会击败**所有 builtin allow——保证用户最终决定权（21A ADR-TPE-008）
- glob `https://github.com/**` 匹配 `https://github.com/anthropics/sdk` 正确（globToRegex `**` 不分 path-aware；spike 静态分析已确认）

### 2.5 ToolExecutionContext 扩展

**不在本草稿 scope**——`ToolExecutionContext.llm?: LLMRoles` 字段及其注入由独立 spec [`secondary-llm-capability.md`](../specifications/secondary-llm-capability.md) 提供（实施作为 **21B M0**，先于本草稿 M1/M2）。

WebFetch 作为消费者按 `ctx.llm?.secondary.chat()` + graceful degrade pattern 调用即可——见 §2.4 工具实现。

## 三、4 个 milestone（独立可验证）

> M0 单独立项是因为它服务多个未来 consumer（不只 WebFetch），且其设计已在独立 spec 中完成。M1/M2/M3 是 WebFetch 自身的实施工作。

### M0：二级 LLM 能力（参见 [`secondary-llm-capability.md` §七](../specifications/secondary-llm-capability.md)）

**实施按那份 spec 的 §8.1 milestone 执行**——本草稿不重复。

**与 21A 的关系**：21A 完成的是权限/边界基础设施；M0 是会话级 capability 注入。两者正交，但都是 21B WebFetch 的前置依赖。

**M0 验收交付**：
- `packages/providers/src/types.ts`：新增 LLMRoleConfig，扩展 ZhixingConfig.llm
- `packages/core/src/types/llm.ts`：新增 LLMRole / LLMRoles
- `packages/core/src/types/tools.ts`：ToolExecutionContext.llm? 字段
- `packages/providers/src/create-provider.ts`：新增 createProviderRoles
- `packages/cli/src/run-agent.ts` + `packages/server/src/runtime/session-adapter.ts`：注入 roles 到 ToolExecutionContext

### M1：`@zhixing/network` 包（safe-fetcher + text-sanitizer）

**新建 packages/network 包**：4 个文件（见 §2.2 / §2.3）+ package.json + tsconfig.json + index.ts。

**关键工作**：
- 新包 boilerplate（package.json 加 undici 依赖；workspace 配置加入 `pnpm-workspace.yaml`）
- `validateUrl` / `classifyIp` 含 IPv4 + IPv6 + 子网匹配（CIDR）
- `safeFetch` 用 undici.fetch + undici.Agent 实现 DNS pinning（**spike 已完成**，详见 §七）
- 重定向逐跳重做完整 URL 校验 + DNS + IP 分类
- 错误是结构化联合类型
- `sanitizeUntrustedText` 纯函数 + 单测

**验收**：
- 私网 / 回环 / link-local / ULA / CGNAT / multicast / 0.0.0.0 / unspecified / IPv6 各 IP range 命中 → `ssrf-blocked`
- 同 host 5 跳重定向 → 跟随；任何一跳 cross-host → `redirect-blocked`
- DNS rebinding 模拟（首跳公网，重定向解析到内网）→ 第二跳 IP 检查命中
- 超时 / DNS 失败 / 5xx / 4xx / >5MB body → 各产生正确 error kind
- text-sanitizer：含零宽字符的输入被剥离；NFC 归一化；超长截断 + marker

### M2：WebFetch 工具 + boundary 自描述 + builtin namespace 规则

**新建**：
- `tools-builtin/src/web-fetch.ts`（工具主体，见 §2.4 代码）
- `tools-builtin/src/web-fetch-rules.ts`（preapproved hosts → builtin scope rules）
- `tools-builtin/src/web-fetch/internal.ts`（fetch policy / cache / content processing）
- `tools-builtin/src/web-fetch/distill.ts`（distill prompt 模板 + stream collector）

**关键工作**：
- 工具核心：`safeFetch → processContent → sanitize → optional distill via ctx.llm.secondary`
- turndown 集成（lazy import + 添加 packages/tools-builtin 依赖）
- 内容 LRU 自实现（~30 行；多 consumer 化决策见 §六）
- ToolDefinition 上声明 `boundaries` + `permissionArgumentKey: "url"`（21A 自描述）
- 默认 PermissionRule 数组导出（scope: "builtin"）
- 入口（cli/serve）启用 web_fetch 工具时调 `permissionStore.registerBuiltinRules("web_fetch", WEB_FETCH_DEFAULT_RULES)`

**验收**：
- 单测：safeFetch mock → 验证 turndown 转换 / 缓存命中 / prompt 模式触发 distill
- 集成测：preapproved host → SecurityPipeline 自动 allow（builtin namespace 命中）
- 集成测：未配置 host + interactive → 触发 ConfirmationBroker
- 集成测：未配置 host + ci → NonInteractiveResolver fail-to-deny
- 集成测：用户加 `web_fetch deny *` 用户规则 → 即使 preapproved host 也 deny（验证 21A 两阶段匹配）
- 集成测：`!ctx.llm` 时调 web_fetch with prompt → 返回 raw markdown（graceful degrade 验证）
- 集成测：SSRF 命中（任何路径）→ 工具不被调用（pipeline 不阻挡，但 safeFetch 内部立即返回 ssrf-blocked）

### M3：system-prompt 引导 + spec 提升

**关键工作**：
- `system-prompt.ts buildToolUsage` 加 web_fetch 引导段：何时用 / prompt vs raw 模式选择 / preapproved host 列表
- E2E 手测（CLI / serve / 飞书路径）—— 真实 fetch + distill 端到端跑通
- spec 提升：
  - M1 → 新建 `network-egress.md`（@zhixing/network 包的 spec 化）
  - M2 → 新建 `tools-builtin.md`（首条 web_fetch 段，未来 web_search / mcp-http 在此扩展）

## 四、决策清单

| # | 决策项 | 决策 | 理由 |
|---|--------|------|------|
| 1 | 工具数 MVP | 仅 web_fetch | WebSearch 独立工作量，下个 Step |
| 2 | Schema | `{url, prompt?, format?, maxChars?}` | prompt 模式（distill）+ raw 模式（无 prompt） |
| 3 | HTTP 客户端依赖位置 | 新建 `packages/network` 包，加 undici 依赖 | 不放 core 避免 ~600KB 污染所有下游；不放 tools-builtin 因为 server-side 消费者（webhook 投递）需要；独立包让 server / tools-builtin 同级消费 |
| 4 | HTML→MD | turndown（lazy import） | 行业标准，~70KB |
| 5 | SSRF 深度 | URL 校验 + IP 分类 + DNS pinning + 重定向逐跳 re-validate | 零妥协，含 IPv6 / CGNAT |
| 6 | 重定向 | 同 host 自动 + cross-host 拒绝 | 防 open redirect 利用 |
| 7 | 截断 | 字符（raw 100K，distill 后 5K） | 简单可预测 |
| 8 | 缓存 | 工具内自实现小 LRU | 单 consumer，避免新依赖；多 consumer 出现时沉到 @zhixing/network/cache.ts（见 §六） |
| 9 | 权限分级 | 复用 SecurityPipeline + PermissionRule | 21A 已成熟 |
| 10 | Boundary 声明 | 通过 ToolDefinition.boundaries 自描述 | BoundaryRegistry.fromTools(tools) 自动 snapshot；不用集中 map |
| 11 | preapproved hosts 注入位置 | builtin scope rules + `store.registerBuiltinRules("web_fetch", ...)` | 21A M4 多源 namespace API；in-memory 不写盘；与用户池两阶段隔离；用户最终决定权 |
| 12 | LLM 服务抽象 | **不抽 LLMService**，consumer 直接调 `roles.secondary.chat()` / `ctx.llm.secondary.chat()` | 当前 2 个 consumer（compaction / WebFetch distill）但 task 形态不同——抽象阈值是"3+ consumer 共享同一 task 形态"（见 secondary-llm-capability.md ADR-SLLM-007） |
| 13 | 二级 LLM 配置 | 由独立 spec 提供：`ZhixingConfig.llm.secondary` + 内置默认 + 降级到 main | 见 [secondary-llm-capability.md §二](../specifications/secondary-llm-capability.md) |
| 14 | 编码处理 | Content-Type 嗅探 + UTF-8 fallback + sanitizer | 防 prompt 注入 |
| 15 | 错误格式 | 结构化 union type | LLM 友好 reason |
| 16 | 认证 | MVP 不支持 | 公开 URL 80%+ |
| 17 | JS 渲染 | 不支持 | 重依赖 + 慢 + SSRF 难控 |
| 18 | text-sanitizer truncationMarker 默认 | 英文 `"[... truncated]"`（用户可通过 opts 覆盖） | 项目当前无统一 i18n 系统；marker 是可选参数不影响内容；统一 i18n 化是另一个独立 step（见 §六） |
| 19 | argument 提取键 | ToolDefinition.permissionArgumentKey: "url" 自描述 | 与 21A `ToolArgumentExtractor.fromTools(tools)` 自动接入；不污染 fallback priority list |

## 五、与其他模块的关系

| 模块 | 关系 |
|------|------|
| 21A 安全基建（SecurityPipeline / PermissionRule / Broker / ConfirmationTracker / BoundaryRegistry / ToolArgumentExtractor） | **完全复用，零侵入**——WebFetch 通过自描述（boundaries + permissionArgumentKey）+ namespace 规则注入接入 |
| 21B M0 二级 LLM 能力（ctx.llm.secondary） | **强依赖**——distill 模式调它；graceful degrade 让 raw 模式不依赖 |
| Step 21 子 agent | 子 agent 入口设 sessionType="ci"（已是合法值），SecurityPipeline 自动按 non-interactive 处理；preapproved host builtin 规则仍生效，killer use case 通；**Step 21 spec 无需为 WebFetch 单独设计任何东西** |
| Step 22 BackgroundAgent | 同 Step 21 |
| TD 修复（webhook 实际投递） | 复用 `@zhixing/network` 的 `safeFetch` 替换当前 stub |
| 第二社交通道（钉钉 / 企微） | 出站 webhook 复用 `safeFetch` |
| MCP HTTP transport（未来） | 复用 `safeFetch` + `text-sanitizer`；MCP 工具暴露后用 21A `BoundaryRegistry.register` / `ToolArgumentExtractor.register` 动态接入 |
| Channel 入站净化（未来） | 复用 `text-sanitizer` |
| WebSearch（未来工具） | 复用 `ctx.llm.secondary` 做 search 后处理 + 复用 `safeFetch` 抓 HTML snippets |

## 六、暂不做（明确边界）

| 项 | 原因 | 触发再做的条件 |
|---|------|-----------------|
| WebSearch 工具 | 独立工作量 | M3 之后下个独立 Step |
| JS 渲染 | Puppeteer 重 + SSRF 难控 | 出现真实需求 |
| 认证（cookie / Bearer） | 公开 URL 已覆盖 80%+ | 接私域 wiki 时 |
| 持久化缓存 | 进程级足够 | 不计划 |
| Readability 正文抽取 | turndown 已可用 | 质量真不够时增量加 |
| 多源并行 fetch | 暂无场景 | 不计划 |
| 智能 rate limit | 现有 `core/security/rate-limiter.ts` 可后续接入 | 出现 quota 触顶 |
| 路径级 preapproved | host 级足够 | 出现真实需求 |
| `LLMService` 通用抽象 | 仅 1 个 consumer，YAGNI | 3+ consumer 共享同一 task 形态时（详见 [secondary-llm-capability.md §八](../specifications/secondary-llm-capability.md)） |
| LRU 沉到 `@zhixing/network/cache.ts` | 仅 1 个 consumer（web_fetch 工具内） | WebSearch / MCP 大结果摘要等出现，需要类似缓存语义时 |
| text-sanitizer i18n | marker 是可选参数 + 项目暂无 i18n 系统 | 项目引入统一 i18n 时一并处理 marker 字符串集合 |
| Per-task auxiliary 模型（hermes 风格 per-task secondary） | secondary 1 个就够 | secondary 需要按工具差异化 |

## 七、Spike 验证结果（已完成）

| Spike | 结果 | 决策落地 |
|-------|------|---------|
| Node fetch + undici dispatcher 拦截 IP | ⚠️ 部分通过：直接用 Node fetch + dispatcher **不通**（Node 22 内嵌 undici 与独立 undici 包 API 不兼容，报 `invalid onRequestStart method`）；**改用 `undici.fetch` 直接调用通过**（lookup 钩子能拿到 hostname、能拒绝、能放行后正常 200） | 决策 #3 改为"添加 undici 依赖到 `@zhixing/network` 新包，用 undici.fetch" |
| `extractArgument` 对 `web_fetch` 选中 `input.url` | ✅ 通过：`ToolArgumentExtractor` 通过 `ToolDefinition.permissionArgumentKey` 字段解析（21A M3 路径）；WebFetch 声明 `permissionArgumentKey: "url"` 即正确命中，不需要扩展 priority list | 决策 #19：声明 `permissionArgumentKey: "url"` 即可 |
| glob `https://host/**` 匹配嵌套 URL | ✅ 通过（globToRegex 静态分析）：`**` 始终匹配任意；`/` 不在 escape 列表原样；`.` 自动转义 → `^https:\/\/github\.com\/.*$` 匹配 `https://github.com/anthropics/sdk` | 默认 PermissionRule 直接用此 pattern 形态，无需扩 matcher |

**净结果**：M1 准备就绪（HTTP 客户端方案已锁定）；M2 准备就绪（permissionArgumentKey 自描述路径已存在，无需修改 fallback 启发式）；21A 引入的 namespace builtin scope 让 preapproved hosts 注入语义清晰，无需重新设计。
