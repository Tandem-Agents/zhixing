# Web 搜索工具：三方实现对比

> 调研动机：知行已有 `web_fetch`（直接抓取一个已知 URL 的正文），但没有「网络查询」能力——给一个问题、由工具去搜索引擎找出相关 URL/摘要。本文对比 Claude Code、OpenClaw、Hermes 三个参考项目在**不依赖 MCP** 的前提下如何实现 web 搜索工具，为知行新增 `web_search` 提供事实依据。
>
> 事实基线：所有结论附源码文件:行号或真实 schema/官方文档来源。Claude Code 部分按可信度标注（无开源源码，依据逆向 schema + 官方文档 + 反混淆代码三方印证）。

---

## 核心发现：三种实现范式

三个项目对「网络查询」给出了三条不同的实现路线，本质区别在于**搜索动作发生在哪一侧**：

| 范式 | 谁执行搜索 | 代表 | LLM provider 耦合 |
|------|-----------|------|------------------|
| **① 服务端 hosted tool** | LLM provider 服务端（同一次 API 调用内自动执行） | Claude Code（唯一纯粹形态） | **强绑** 该 provider |
| **② 客户端直调第三方搜索 API** | 客户端自己发 HTTP 到搜索引擎 API | OpenClaw（brave/exa/tavily/ddg/…）、Hermes（parallel/exa/tavily/firecrawl） | **无关** |
| **③ 客户端单发一个「带内置搜索的 LLM」请求** | 在一个独立 LLM 请求里开 server-side search 开关 | OpenClaw（gemini/grok/kimi） | 弱耦合（作为可选 provider） |

**关键共识**：除 Claude Code 外，参考项目都把搜索做成「provider 可插拔」——对模型只暴露**一个工具名**（`web_search`），背后挂多个后端，运行时按配置/可用密钥选一个执行。范式 ② 和 ③ 在这些项目里用**同一套 provider 抽象**统一，对上层是同一个工具。

---

## Claude Code：服务端 hosted tool（客户端零搜索实现）

**可信度**：高。依据三方印证——① 逆向得到的真实工具 schema（`claude-code-reverse/results/tools/WebSearch.tool.yaml`，即模型实际收到的文本）；② Anthropic 官方文档；③ 反混淆客户端源码（`claude-code-deobfuscation/`）中**完全不存在任何搜索后端代码**，全仓库 grep `web_search`/`brave`/`tavily` 等零命中。三者共同指向：客户端只声明 schema，不执行搜索。

### 机制

WebSearch 是 **Anthropic API 的 hosted tool**，在 LLM 请求的 `tools` 数组里声明：

```json
{ "type": "web_search_20250305", "name": "web_search", "max_uses": 5 }
```

- 模型自行决定何时搜索，**搜索在单次 API 调用内由 Anthropic 服务端自动执行**（schema 原文："Searches are performed automatically within a single API call"），可在一次请求里内部多轮搜索。
- 搜索后端是 **Brave Search**（Anthropic 托管，开发者不可见、不可换）。
- 结果以 search result block 返回，字段含 `url` / `title` / `page_age` / `encrypted_content`；多轮对话需把 `encrypted_content` 原样传回，模型才能引用。
- 工具入参（客户端声明的 schema）：`query`（必填，≥2 字符）、`allowed_domains` / `blocked_domains`（域名白/黑名单）。

### 约束（对「能否照搬」至关重要）

- **地域限制**：仅 US 可用（schema 原文："Web search is only available in the US"）。
- **平台限制**：不支持 Bedrock / Vertex——Claude Code 在这些平台**直接隐藏该工具**。
- **强绑 Anthropic**：换成别的 LLM provider 就没有这个工具。
- 计费：按搜索次数 + token，结果是加密黑盒。

### 与 WebFetch 的分工

Claude Code 的 **WebFetch 是另一回事**，且更接近本地管线：域名校验（请求 `claude.ai/api/web/domain_info`）→ 抓取 → Turndown 把 HTML 转 Markdown → 用 Haiku 小模型按 `prompt` 过滤后再交给主 agent。WebSearch（发现 URL）+ WebFetch（读取正文）是配套的两个工具。

---

## OpenClaw：provider 插件 + 单一 `web_search` 工具

**可信度**：高，全部源码可查（仓库根 `E:\Dev\longxia\_refs\openclaw-main`，下列路径相对仓库根）。

> 项目辨析：本地源码是 **OpenClaw**（`github.com/openclaw/openclaw`，多平台个人 AI 助手）。它与用户口中的 **OpenCode**（`opencode.ai`，终端编码助手，web search 用 Exa）是**两个不同项目**——二者有集成（OpenClaw 有 `opencode-controller` skill），但搜索实现各自独立。本节以本地 OpenClaw 源码为准。

### 架构：能力分布在插件，对模型只暴露一个工具

搜索能力**不硬编码在 agent 里**，而是以「插件 provider」形式分布在 `extensions/<name>/`，每个插件在自己的 `index.ts` 调 `api.registerWebSearchProvider(...)` 注册一个 `WebSearchProviderPlugin`。这些 provider 共同支撑一个统一的 agent 工具 `web_search`（`src/agents/tools/web-search.ts:13` `createWebSearchTool`，对外只有这一个工具名），运行时按「显式选定 / 自动探测」挑一个 provider 执行。`x_search` 是单独注册的工具。

- 工具能力契约：`src/plugins/web-provider-types.ts:14`（`WebSearchProviderToolDefinition` = `description` + `parameters`(typebox JSON-Schema) + `execute`）、`:72`（`WebSearchProviderPlugin`，带 `id/label/envVars/autoDetectOrder/credentialPath/requiresCredential` + `createTool(ctx)`）。
- 注册入口：各扩展 `index.ts`（如 `extensions/brave/index.ts:8`）；注册表 `src/plugins/registry.ts:1050`（写入 `registry.webSearchProviders`）。
- provider 选择：`src/web-search/runtime.ts:131` `resolveWebSearchProviderId`——显式 `tools.web.search.provider` 优先，否则按 `autoDetectOrder` 升序选「有密钥的 API provider」，再 fallback 到第一个 keyless provider；`:314` `runWebSearch` 逐个候选 `execute`，无显式选定时失败可回退。

### 12 个 provider × 两种实现类别

| provider | 扩展目录 | 后端 | 类别 | endpoint / 机制 |
|----------|---------|------|------|-----------------|
| `brave` | `extensions/brave` | Brave Search API | ② 客户端直调 | `api.search.brave.com/res/v1/web/search`，头 `X-Subscription-Token` |
| `duckduckgo` | `extensions/duckduckgo` | DDG HTML 页 | ② **无 key** | `html.duckduckgo.com/html`（HTML 抓取，见下文） |
| `exa` | `extensions/exa` | Exa API | ② 客户端直调 | POST `api.exa.ai/search`，头 `x-api-key` |
| `firecrawl` | `extensions/firecrawl` | Firecrawl Search | ② 客户端直调 | POST `api.firecrawl.dev/v2/search` |
| `minimax` | `extensions/minimax` | MiniMax Search | ② 客户端直调 | POST `api.minimax.io/v1/coding_plan/search` |
| `ollama` | `extensions/ollama` | Ollama Web Search | ② 客户端直调 | POST `<host>/api/web_search`（本地或 `ollama.com`） |
| `perplexity` | `extensions/perplexity` | Perplexity Search/Sonar | ② 客户端直调 | `api.perplexity.ai/search` 或 `<baseUrl>/chat/completions` |
| `searxng` | `extensions/searxng` | 自建 SearXNG | ② **自托管** | GET `<baseUrl>/search?format=json` |
| `tavily` | `extensions/tavily` | Tavily API | ② 客户端直调 | `api.tavily.com` |
| `gemini` | `extensions/google` | Google Search grounding | ③ 模型服务端 search | Gemini `generateContent`，请求体 `tools:[{google_search:{}}]` |
| `grok` | `extensions/xai` | xAI Responses 内置 | ③ 模型服务端 search | `api.x.ai/v1/responses`，`tools:[{type:"web_search"}]` |
| `kimi` | `extensions/moonshot` | Moonshot 内置 `$web_search` | ③ 模型服务端 search | `/chat/completions`，`tools:[{type:"builtin_function",function:{name:"$web_search"}}]`，最多 3 轮 tool-call 回填 |
| `x_search`（独立工具） | `extensions/xai` | xAI Responses x_search | ③ | 同 grok，`tools:[{type:"x_search"}]` |

类别 ② 的精髓：无论自己发 HTTP 调搜索 API（②），还是单发一个开了 server-side search 的 LLM 请求（③），**对上层都返回同一 payload 形状**，由统一的 `createTool/execute` 抽象屏蔽差异。

### 凭证

统一顺序「plugin-scoped config（支持 SecretRef）→ 环境变量」（`src/agents/tools/web-search-provider-common.ts:63`）。如 brave=`BRAVE_API_KEY`、exa=`EXA_API_KEY`、grok=`XAI_API_KEY`、perplexity=`PERPLEXITY_API_KEY`/`OPENROUTER_API_KEY`、searxng=`SEARXNG_BASE_URL`。auto-detect 模式下只解析被选中 provider 的 SecretRef。

### 返回格式（两形态）

都带统一安全包裹 `externalContent:{untrusted:true, source:"web_search", provider, wrapped:true}`：

- **结构化结果型**（brave/exa/firecrawl/ddg/searxng/tavily/minimax/ollama/perplexity-search）：`{ query, provider, count, results:[{title, url, snippet|description, siteName, published?}] }`。
- **合成答案型**（gemini/grok/kimi/perplexity-chat）：`{ query, provider, model, content:<合成正文>, citations:[url…] }`。

### 安全设计（值得借鉴）

- 统一出口 `withTrustedWebSearchEndpoint`（`src/agents/tools/web-search-provider-common.ts:77`）→ `withTrustedWebToolsEndpoint`（`web-guarded-fetch.ts:64`）套 **SSRF 网络守卫**（白名单允许私网，专为自建 SearXNG / 本地 Ollama）。
- `wrapWebContent`（`src/security/external-content.ts:419`）给每段外部文本加**唯一随机边界标记防 prompt 注入**。
- `count` 钳到 1–10（Exa 例外上限 100），结果默认缓存 15 分钟。

### DuckDuckGo：唯一无 key 的特殊实现

标记 `requiresCredential:false`、`autoDetectOrder:100`（API provider 之后的首个 keyless fallback，`extensions/duckduckgo/src/ddg-search-provider.shared.ts:5`）。机制 = **抓 DDG 的非 JS HTML 搜索页 + 正则解析**，不是官方 API：

- endpoint `https://html.duckduckgo.com/html`（`ddg-client.ts:18`），GET 拼 `q`/`kl`(region)/`kp`(safeSearch)，伪装浏览器 `User-Agent`。
- 纯正则解析（无 DOM 库）：`result__a` 取 title/href、`result__snippet` 取摘要，从跳转链接的 `uddg` 参数还原真实 URL（`parseDuckDuckGoHtml` `:87`）。
- 反爬检测：命中 `g-recaptcha`/`challenge-form` 且无结果时抛 "bot-detection challenge"。

---

## Hermes：客户端多后端可插拔

**可信度**：高，全部源码可查（仓库根 `E:\Dev\longxia\_refs\hermes-agent-main`，Python 3.11）。

### 工具与后端

工具 `web_search`（`tools/web_tools.py:1035`，schema `:2054`，注册 `:2093`）。`_get_backend()`（`:83`）选后端后**客户端直接发请求**（范式 ②，无范式 ③ 路线）：

| 后端 | 发请求位置 | 方式 |
|------|-----------|------|
| Parallel | `_parallel_search` `:961` | 官方 SDK `parallel` |
| Exa | `_exa_search` `:899` | 官方 SDK `exa_py`，头 `x-exa-integration` |
| Tavily | `_tavily_request` `:288` | **裸 HTTP POST** `api.tavily.com/search`，body 带 `api_key` |
| Firecrawl（默认/兜底） | `:1129` | 官方 SDK `firecrawl` |

后端选择：`~/.hermes/config.yaml` 的 `web.backend`，否则按 env key 探测（firecrawl > parallel > tavily > exa），全无则默认 firecrawl。**无 Brave/SerpAPI/Perplexity 内置后端**；DuckDuckGo 仅作 optional skill（`optional-skills/research/duckduckgo-search/`，terminal 调 `ddgs` CLI，非注册工具）。

### 注册装配

中央 `ToolRegistry`（`tools/registry.py:176`），`discover_builtin_tools()`（`:56`）用 AST 扫 `tools/*.py` 找顶层 `registry.register(...)` 自动 import 注册；`model_tools.py` 是其上的薄编排层（`:277` 取 schema、`:589` 路由执行）。每个工具 schema 是手写 OpenAI function-calling 风格 dict。可用性由 `check_fn=check_web_api_key` 按后端密钥是否存在动态决定是否暴露。

### 返回格式 + 正文分工

`web_search` 返回 JSON 字符串，归一化为 `{success, data:{web:[{title, url, description, position}]}}`，**只含元数据不含正文**（`:1042` 注释明确）。正文要另用 **`web_extract`**（`tools/web_tools.py:1171`，对应别人的 web_fetch）：返回 markdown `content`，>5000 字用辅助 LLM（默认 `gemini-3-flash`，经 OpenRouter）压缩成摘要，>2M 字拒绝，剥离 base64 图片。凭证 `EXA_API_KEY`/`TAVILY_API_KEY`/`FIRECRAWL_API_KEY` 等（`.env.example:123`）。

---

## 横向对比

| 维度 | Claude Code | OpenClaw | Hermes |
|------|------------|----------|--------|
| 实现范式 | ① 服务端 hosted | ② + ③（provider 插件） | ②（多后端可插拔） |
| 搜索后端 | Brave（托管不可换） | 12 provider | Parallel/Exa/Tavily/Firecrawl |
| LLM provider 耦合 | 强绑 Anthropic | 无关 | 无关 |
| 客户端是否发搜索 HTTP | 否 | 是（②）/ 单发 LLM 请求（③） | 是 |
| 暴露给模型的工具数 | 1（WebSearch） | 1（web_search）+ 1（x_search） | 1（web_search）+ web_extract |
| 凭证 | 无需（随 API key） | per-provider，SecretRef→env | per-backend，config/env |
| 无 key 选项 | 无 | DDG（HTML 抓取）/ SearXNG（自托管） | 仅 optional skill |
| 结果形态 | 加密 result block | results[] 或 content+citations | JSON 元数据（title/url/description） |
| 正文获取 | 同 tool（服务端） | results 自带 或 配 web_fetch | 配 web_extract |
| 外部内容防注入 | Anthropic 服务端 | `wrapWebContent` 随机边界标记 | 未特别强调 |
| 地域/平台限制 | US-only，不支持 Bedrock/Vertex | 无 | 无 |

**取舍**：范式 ① 对开发者零维护、结果新鲜带引用，但绑死单一 provider 且有地域/平台/计费/黑盒约束；范式 ② 完全 provider 无关、可控、可自托管/无 key，代价是自己管密钥、解析归一化、必要时二次摘要。OpenClaw 的 provider 插件抽象把 ②③ 统一到一个工具名，是「既要 provider 无关、又要在支持的模型上白嫖服务端 search」的折中范本。

---

## 对知行的启示

### 现状与缺口（基于知行源码）

- 知行已有 `web_fetch`，是**编排型工具**：串联 `@zhixing/network` 的 `safeFetch`（含 SSRF/网络策略）+ `sanitizeUntrustedText`、`processContent`（charset + Turndown HTML→MD）、可选 `ctx.llm.light` 蒸馏（`packages/tools-builtin/src/web-fetch.ts:1`）。两模式：带 `prompt` 时 light LLM 只提取所需信息，否则返回 raw markdown。
- `web_fetch` 的 system hint 已白纸黑字声明它**不搜索网络**：「this tool fetches a URL, it does not search the web」「If the user asks a question without a URL… ask for the URL or suggest a search engine」（`web-fetch.ts:45,49`）——功能缺口由工具自己点明。
- 知行**已预留** WebSearch 接入：`distill.ts` 注释明确「collectStream 是通用的 light LLM consumer，可被其他 consumer 复用（如未来 WebSearch 的搜索结果摘要）」（`packages/tools-builtin/src/web-fetch/distill.ts:6`）。

### 范式选择：知行应走范式 ②，而非 ①

知行是**多 provider 架构**（`@zhixing/providers`，`primaryRole=main/power` 可绑不同 provider/model）。范式 ①（服务端 hosted）会把搜索能力绑死在 Anthropic 且受 US-only / 不支持 Bedrock-Vertex 限制，与多 provider 设计冲突——不可作为基础能力。

**推荐：范式 ② 为主，OpenClaw 式「单工具名 + provider 后端」抽象**，理由是它与知行既有装配机制天然契合：

- 新增内置工具 `web_search` 走 `BUILTIN_TOOL_FACTORIES`（`packages/tools-builtin/src/factories.ts`），在 `AgentRoleProfile.enabledTools` 里启用——与现有 builtin 工具同一条装配路径，main / 有 workdir 的 workscene 默认带上。
- 复用 `web_fetch` 已验证的编排骨架：`@zhixing/network` 的 `safeFetch` + `sanitizeUntrustedText`（对应 OpenClaw 的 `withTrustedWebSearchEndpoint` SSRF 守卫 + `wrapWebContent` 防注入），以及 `distill.ts` 的 `collectStream`（注释已点名给 WebSearch 复用）做可选的结果摘要。
- provider 抽象参考 OpenClaw 的 `WebSearchProviderPlugin`：`id + autoDetectOrder + requiresCredential + execute`，运行时按密钥/配置选一个，失败回退。

### 落地建议

1. **工具分工对齐 Hermes/OpenClaw**：`web_search` 只返回元数据（`{title, url, snippet}` 列表，发现 URL），正文交给已有 `web_fetch`。两者配套，职责清晰。
2. **起步后端**：先接 1 个无门槛默认 + 1 个高质量可选。DuckDuckGo（HTML 抓取、零配置、无 key）适合做开箱默认；Brave / Tavily / Exa 任一做 API key 可选项。（注意 DDG HTML 抓取有反爬风险，需处理 bot-challenge。）
3. **范式 ③ 可作为后续可选 provider**：当 `primaryRole` 用 Gemini / Grok / Kimi 等自带 server-side search 的模型时，可加对应 provider（在一个独立 LLM 请求里开 `google_search` / `web_search` / `$web_search`），与范式 ② 共用同一 `web_search` 工具名。非首期必需。
4. **安全**：搜索结果是外部不可信内容，必须经 `sanitizeUntrustedText` 并标注 untrusted（知行已有 `@zhixing/network` 与 security pipeline，沿用即可）；工具走自描述 `boundaries`（read 类）接入 `SecurityPipeline`，与 `web_fetch` 一致。
5. **凭证**：per-provider key 走知行现有配置/凭证体系（与身份层凭证物理分离原则一致），auto-detect 时只解析选中 provider 的密钥。

---

## 信息来源

调研时间 2026-05-23。

**源码（本地，可逐行复核）**
- OpenClaw：`E:\Dev\longxia\_refs\openclaw-main`（`extensions/*/`、`src/agents/tools/`、`src/plugins/`、`src/web-search/`、`src/security/`）
- Hermes：`E:\Dev\longxia\_refs\hermes-agent-main`（`tools/web_tools.py`、`tools/registry.py`、`model_tools.py`）
- Claude Code 逆向 schema：`E:\Dev\longxia\_refs\claude-code-reverse\results\tools\WebSearch.tool.yaml`；反混淆源码 `E:\Dev\longxia\_refs\claude-code-deobfuscation`（用于反证客户端无搜索实现）
- 知行现状：`packages/tools-builtin/src/web-fetch.ts`、`web-fetch/distill.ts`、`factories.ts`

**网上（模糊点确认）**
- [Introducing web search on the Anthropic API](https://www.anthropic.com/news/web-search-api)
- [Web search tool — Claude API Docs](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool)
- [Inside Claude Code's Web Tools: WebFetch vs WebSearch — Mikhail Shilkov](https://mikhail.io/2025/10/claude-code-web-tools/)
- OpenClaw 官方文档 `docs.openclaw.ai/tools/web`、`/tools/brave-search`、`/tools/duckduckgo-search` 等（与本地源码交叉验证 provider 列表与 autoDetectOrder）
