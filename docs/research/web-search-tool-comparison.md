# Web 搜索工具：三方实现对比

> 本文是搜索能力的跨产品研究，不是知行的需求、架构规范或实施计划。基于 2026-05-23 的研究材料，比较搜索执行位置、后端解耦和抓取分工；知行现状见末节。
>
> 外部项目的接口、后端数量、限制和源码行号均属于原调研快照，不代表外部产品最新版；原稿未记录对应 commit，不能据这些行号保证精确复现旧版本。外部结论不作为当前服务可用性承诺，具体选型前须复核来源。

---

## 核心发现：三种实现范式

三个项目对「网络查询」给出了三条不同的实现路线，本质区别在于**搜索动作发生在哪一侧**：

| 范式 | 谁执行搜索 | 代表 | LLM provider 耦合 |
|------|-----------|------|------------------|
| **① 服务端 hosted tool** | LLM provider 服务端（同一次 API 调用内自动执行） | Claude Code（原稿归类，见下文证据边界） | **强绑** 该 provider |
| **② 客户端直调第三方搜索 API** | 客户端自己发 HTTP 到搜索引擎 API | OpenClaw（brave/exa/tavily/ddg/…）、Hermes（parallel/exa/tavily/firecrawl） | **无关** |
| **③ 客户端单发一个「带内置搜索的 LLM」请求** | 在一个独立 LLM 请求里开 server-side search 开关 | OpenClaw（gemini/grok/kimi） | 弱耦合（作为可选 provider） |

**关键共识**：除 Claude Code 外，参考项目都把搜索做成「provider 可插拔」——对模型只暴露**一个工具名**（`web_search`），背后挂多个后端，运行时按配置/可用密钥选一个执行。原稿所述 OpenClaw 把范式 ② 和 ③ 接入同一 provider 抽象；Hermes 本文列出的后端仅属于范式 ②。

---

## Claude Code：原稿的 hosted tool 分析与证据边界

原稿依据逆向 schema（`claude-code-reverse/results/tools/WebSearch.tool.yaml`）、Anthropic API 文档及反混淆源码检索，将其归为服务端搜索。原记录称检索 `web_search`/`brave`/`tavily` 等无命中；但字符串未命中不能证明客户端不存在实现，API 的 hosted tool 机制也不能单独证明 Claude Code 客户端采用同一调用链。下述 hosted API 形态保留为研究参照，客户端映射属于待独立验证的推断。

### 机制

原稿引用的 **Anthropic API hosted tool** 请求形态如下；不要与客户端 `WebSearch` schema 直接视为同一层接口：

```json
{ "type": "web_search_20250305", "name": "web_search", "max_uses": 5 }
```

- 模型自行决定何时搜索，**搜索在单次 API 调用内由 Anthropic 服务端自动执行**（schema 原文："Searches are performed automatically within a single API call"），可在一次请求里内部多轮搜索。
- 搜索后端是 **Brave Search**（Anthropic 托管，开发者不可见、不可换）。
- 结果以 search result block 返回，字段含 `url` / `title` / `page_age` / `encrypted_content`；多轮对话需把 `encrypted_content` 原样传回，模型才能引用。
- 工具入参（客户端声明的 schema）：`query`（必填，≥2 字符）、`allowed_domains` / `blocked_domains`（域名白/黑名单）。

### 原稿记录的约束（不代表当前可用性）

- **地域限制**：仅 US 可用（schema 原文："Web search is only available in the US"）。
- **平台限制**：不支持 Bedrock / Vertex——Claude Code 在这些平台**直接隐藏该工具**。
- **强绑 Anthropic**：换成别的 LLM provider 就没有这个工具。
- 计费：按搜索次数 + token，结果是加密黑盒。

### 与 WebFetch 的分工

Claude Code 的 **WebFetch 是另一回事**，且更接近本地管线：域名校验（请求 `claude.ai/api/web/domain_info`）→ 抓取 → Turndown 把 HTML 转 Markdown → 用 Haiku 小模型按 `prompt` 过滤后再交给主 agent。WebSearch（发现 URL）+ WebFetch（读取正文）是配套的两个工具。

---

## OpenClaw：provider 插件 + 单一 `web_search` 工具

**原稿证据类型**：源码定位（仓库根 `E:\Dev\longxia\_refs\openclaw-main`，下列路径相对仓库根）。

> 本节研究对象为 OpenClaw（`github.com/openclaw/openclaw`），不是 OpenCode；不将不同项目的实现混作同一证据。

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

这里统一的是 `createTool/execute` 调用接口，不是搜索结果的全部 payload 结构：范式 ②、③ 仍可能分别返回结构化结果或合成答案，区别见下表述。

### 凭证

统一顺序「plugin-scoped config（支持 SecretRef）→ 环境变量」（`src/agents/tools/web-search-provider-common.ts:63`）。如 brave=`BRAVE_API_KEY`、exa=`EXA_API_KEY`、grok=`XAI_API_KEY`、perplexity=`PERPLEXITY_API_KEY`/`OPENROUTER_API_KEY`、searxng=`SEARXNG_BASE_URL`。auto-detect 模式下只解析被选中 provider 的 SecretRef。

### 返回格式（两形态）

都带统一安全包裹 `externalContent:{untrusted:true, source:"web_search", provider, wrapped:true}`：

- **结构化结果型**（brave/exa/firecrawl/ddg/searxng/tavily/minimax/ollama/perplexity-search）：`{ query, provider, count, results:[{title, url, snippet|description, siteName, published?}] }`。
- **合成答案型**（gemini/grok/kimi/perplexity-chat）：`{ query, provider, model, content:<合成正文>, citations:[url…] }`。

### 安全设计（值得借鉴）

- 统一出口 `withTrustedWebSearchEndpoint`（`src/agents/tools/web-search-provider-common.ts:77`）→ `withTrustedWebToolsEndpoint`（`web-guarded-fetch.ts:64`）套 **SSRF 网络守卫**（白名单允许私网，专为自建 SearXNG / 本地 Ollama）。
- `wrapWebContent`（`src/security/external-content.ts:419`）给每段外部文本加**唯一随机边界标记以区分外部内容**，但标记不是权限隔离，也不能保证模型不受提示注入影响。
- `count` 钳到 1–10（Exa 例外上限 100），结果默认缓存 15 分钟。

### DuckDuckGo：免 key 的 HTML 抓取实现

标记 `requiresCredential:false`、`autoDetectOrder:100`（API provider 之后的首个 keyless fallback，`extensions/duckduckgo/src/ddg-search-provider.shared.ts:5`）。机制 = **抓 DDG 的非 JS HTML 搜索页 + 正则解析**，不是官方 API：

- endpoint `https://html.duckduckgo.com/html`（`ddg-client.ts:18`），GET 拼 `q`/`kl`(region)/`kp`(safeSearch)，伪装浏览器 `User-Agent`。
- 纯正则解析（无 DOM 库）：`result__a` 取 title/href、`result__snippet` 取摘要，从跳转链接的 `uddg` 参数还原真实 URL（`parseDuckDuckGoHtml` `:87`）。
- 反爬检测：命中 `g-recaptcha`/`challenge-form` 且无结果时抛 "bot-detection challenge"。

---

## Hermes：客户端多后端可插拔

**原稿证据类型**：源码定位（仓库根 `E:\Dev\longxia\_refs\hermes-agent-main`，Python 3.11）。

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

## 横向对比（原调研快照）

| 维度 | Claude Code | OpenClaw | Hermes |
|------|------------|----------|--------|
| 实现范式 | 原稿推断为 ①；客户端调用链未证实 | ② + ③（provider 插件） | ②（多后端可插拔） |
| 搜索后端 | 原稿记载 API hosted 后端为 Brave；不能据此确认客户端后端 | 12 provider | Parallel/Exa/Tavily/Firecrawl |
| LLM provider 耦合 | API hosted 形态依赖 Anthropic；客户端映射未证实 | 无关 | 无关 |
| 客户端是否发搜索 HTTP | 未证实；源码关键词未命中不足以断言“否” | 是（②）/ 单发 LLM 请求（③） | 是 |
| 暴露给模型的工具数 | 1（WebSearch） | 1（web_search）+ 1（x_search） | 1（web_search）+ web_extract |
| 凭证 | API hosted 形态使用 API 凭证，无须另配搜索 key；客户端凭证链未证实 | per-provider，SecretRef→env | per-backend，config/env |
| 无 key 选项 | 本文未证实客户端是否存在免 key 选项 | DDG（HTML 抓取）/ SearXNG（自托管） | 仅 optional skill |
| 结果形态 | API hosted 返回含 encrypted_content 的 result block；客户端映射未证实 | results[] 或 content+citations | JSON 元数据（title/url/description） |
| 正文获取 | 搜索结果与引用不等同于完整正文；另有 WebFetch | results 的摘要或合成答案不等同于完整正文；另配 web_fetch | 配 web_extract |
| 外部内容处理证据 | 本文不足以说明其完整防注入机制 | `wrapWebContent` 随机边界与 untrusted 标识，不保证防住注入 | 本文未充分分析，不表示没有防护 |
| 地域/平台限制 | 原稿记载 US-only、Bedrock/Vertex 限制，当前适用性未复验 | 按具体后端核对，不能统一断言无限制 | 按具体后端核对，不能统一断言无限制 |

**取舍**：范式 ① 减少客户端维护搜索后端的工作，但仍需处理服务接口、结果与引用，并依赖承载请求的模型服务能力；范式 ② 可与主模型解耦，代价是后端接入、凭证、结果归一化与运维，自托管或免 key 取决于所选后端；范式 ③ 把模型服务端搜索作为独立后端，不必绑定主对话模型，但仍有模型服务依赖和费用。统一工具入口可以隔离调用方式，不能抹平结果形态、质量及可用性差异。

---

## 知行现状与研究建议

### 当前内置能力

[内置工具工厂](../../packages/tools-builtin/src/factories.ts)注册了 `web_fetch`，未注册 `web_search`。这说明内置工具的边界，不等于断言通过 MCP 等外部工具也无法搜索。

[WebFetch](../../packages/tools-builtin/src/web-fetch.ts)读取已知 URL，不负责搜索发现 URL。它复用安全网络出口、内容转换与不可信文本净化；有 prompt 且具备 light 能力时尝试提炼，无 light、提炼为空或失败时可返回原文。当前调用为 `context.llm.light.chat()`，具体缓存、取消和权限边界以 [WebFetch 模块文档](../modules/tools/web-fetch.md)为准，网络职责见 [网络架构](../modules/network/architecture.md)。

[collectStream](../../packages/tools-builtin/src/web-fetch/distill.ts)注释将未来 WebSearch 摘要列为潜在复用场景；注释不等于已存在搜索接入、已批准需求或已完成接口设计。

### 选型理由与候选方向

以下为研究建议，不是当前发布范围、默认配置或已批准工作：

1. **执行位置与模型耦合。** 若目标是搜索独立于主模型，可考虑范式 ②，或将范式 ③ 包成独立后端。范式 ① 并非天然违反多 provider 架构，但不能在其他模型不支持时仍承诺同等能力；选择应依据明确需求，而非过时的地域限制推导。
2. **统一入口与后端差异。** 可参考 OpenClaw 的统一工具入口及后端接口，也保留显式选择、可用性检测与失败回退的比较价值。是否需要多个后端、自动探测和回退必须由实际场景证明，不能照搬整套插件框架。工厂注册是现有接入线索，原稿的角色默认启用建议不是现行装配合同。
3. **搜索与抓取分工。** 搜索发现 URL、标题和摘要，正文交给 `web_fetch`；合成答案需保留引用与来源边界，不把摘要、引用或答案当作已获取完整原文。结果摘要可评估复用 light consumer，而非默认再增加一次 LLM 调用。
4. **候选后端。** 原稿提出 DDG HTML 免 key 默认入口，Brave／Tavily／Exa 作为 API 可选项，并将 Gemini／Grok／Kimi 服务端搜索列为扩展方向。后端数量按需求选择：HTML 抓取有页面变化、反爬与可用性风险，服务端搜索也不等于免费；具体选型前再核对服务条件。
5. **安全与凭证。** 可以复用现有网络出口和不可信内容处理，但文本净化或随机标记不能保证防住提示注入。当前 WebFetch 的权限声明为 `network / egress / dynamic:false`，不是原稿所称 read 类；搜索的目的地址、输入和执行边界需按实际设计确认。后端凭证应走相应配置解析及授权边界，不混入用户身份凭证；若采用自动选择，只解析必要候选，不能为探测遍读秘密。

---

## 信息来源

调研时间 2026-05-23。

**原稿源码定位（历史本地路径，未附版本锁定）**
- OpenClaw：`E:\Dev\longxia\_refs\openclaw-main`（`extensions/*/`、`src/agents/tools/`、`src/plugins/`、`src/web-search/`、`src/security/`）
- Hermes：`E:\Dev\longxia\_refs\hermes-agent-main`（`tools/web_tools.py`、`tools/registry.py`、`model_tools.py`）
- Claude Code 逆向 schema：`E:\Dev\longxia\_refs\claude-code-reverse\results\tools\WebSearch.tool.yaml`；反混淆源码 `E:\Dev\longxia\_refs\claude-code-deobfuscation`（原稿检索依据，不能单独证明客户端不存在搜索实现）
- 知行现状：`packages/tools-builtin/src/web-fetch.ts`、`web-fetch/distill.ts`、`factories.ts`

**原研究的网页来源（历史资料）**
- [Introducing web search on the Anthropic API](https://www.anthropic.com/news/web-search-api)
- [Web search tool — Claude API Docs](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool)
- [Inside Claude Code's Web Tools: WebFetch vs WebSearch — Mikhail Shilkov](https://mikhail.io/2025/10/claude-code-web-tools/)
- OpenClaw 官方文档 `docs.openclaw.ai/tools/web`、`/tools/brave-search`、`/tools/duckduckgo-search` 等（与本地源码交叉验证 provider 列表与 autoDetectOrder）
