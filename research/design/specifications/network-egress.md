# 网络出口原语（@zhixing/network）

> 知行项目所有出站 HTTP 请求的共享底座。集中实现 SSRF 安全的 fetch、URL/IP 防护、文本净化，避免每个 consumer（WebFetch / 未来 webhook 投递 / MCP HTTP / 第二通道出站）各自重新发明。

## 一、设计原则

- **错误是返回值，不是异常**：`safeFetch` 返回 `Promise<FetchResult | FetchError>` 判别联合，consumer 用 `if ("kind" in result)` 类型层穷尽匹配；调用栈深处不会突然 throw
- **API 表面最小**：只导出 5 个函数 + 2 个常量 + 5 个类型；内部模块（Agent 工厂、lookup hook 等）不暴露
- **防御性默认不可关闭**：`DEFAULT_BLOCKED_NETWORKS` 始终并入 `NetworkPolicy.blockedNetworks`，consumer 传 `[]` 也无法关闭内置 SSRF 防御——`blockedNetworks` 字段只能追加
- **依赖隔离**：`undici` (~600KB) 隔离在本包，不污染 core / providers / cli / server / channels / tools-builtin
- **资源可控**：`HopLifecycle` 显式管理 timer + abort，覆盖整个 hop（fetch + body 读取），不依赖 GC

## 二、包结构

```
packages/network/src/
├── types.ts                    # 公共类型契约（NetworkPolicy / FetchResult / FetchError / SanitizeOptions / IpRange）
├── url-guard.ts                 # 纯函数: validateUrl / classifyIp / extractHostname + DEFAULT_BLOCKED_NETWORKS
├── text-sanitizer.ts            # 纯函数: sanitizeUntrustedText
├── safe-fetcher.ts              # 公共: safeFetch + DEFAULT_NETWORK_POLICY
├── safe-fetcher-internal.ts     # 内部: makeSecureLookup / createPinnedAgent / isSsrfError / SsrfBlockInfo
├── index.ts                     # 公共 API 出口
└── __tests__/
    ├── url-guard.test.ts
    ├── text-sanitizer.test.ts
    ├── safe-fetcher.test.ts        # mock createPinnedAgent → undici.MockAgent
    └── safe-fetcher-internal.test.ts # mock node:dns/promises
```

## 三、公共 API 契约

### `safeFetch(url, policy?, opts?)`

```typescript
function safeFetch(
  url: string,
  policyOverride?: Partial<NetworkPolicy>,
  opts?: { abortSignal?: AbortSignal },
): Promise<FetchResult | FetchError>;
```

发起 SSRF 安全的 HTTP GET：
- URL 校验（同步：协议 / 长度 / userinfo / 格式）
- IP 字面量同步 SSRF 检查（不走 DNS）
- DNS 解析后 lookup hook 复检
- 重定向逐跳完整复检（每跳 validateUrl + classifyIp + 新 Agent + lookup hook）
- body 大小限制 + timeout/abort 双控

### `validateUrl(url, policy)` / `classifyIp(ip, blockedNetworks)`

纯函数，consumer 可单独使用做预校验。`extractHostname(url)` 提取 hostname 并去 IPv6 brackets。

### `sanitizeUntrustedText(text, opts?)`

纯函数文本净化：① Unicode NFC/NFKC 归一化 ② 剥离零宽与不可见字符（U+200B–U+200F / U+2060–U+206F / U+FEFF）③ 字符级长度截断 + marker。零依赖。

### 默认值导出

- `DEFAULT_NETWORK_POLICY`：完整 NetworkPolicy 对象
- `DEFAULT_BLOCKED_NETWORKS`：`readonly IpRange[]`，覆盖 IPv4 + IPv6:
  - 私网/回环/链路本地/CGNAT/multicast/保留段（127/8 / 10/8 / 172.16/12 / 192.168/16 / 169.254/16 / 100.64/10 / 224/4 / 240/4 / 0/8 / ::1/128 / fc00::/7 / fe80::/10 / ff00::/8 / ::/128）
  - IANA 测试与基准保留段（192.0.2.0/24 / 198.51.100.0/24 / 203.0.113.0/24 — RFC 5737；198.18.0.0/15 — RFC 2544 benchmark，**Clash/V2Ray 等代理 fake-IP 模式默认范围**）

## 四、NetworkPolicy

```typescript
interface NetworkPolicy {
  allowedProtocols: readonly ("http" | "https")[];   // ["https", "http"]
  maxUrlLength: number;                                // 2048
  maxBodyBytes: number;                                // 5 MB
  timeoutMs: number;                                   // 30_000
  maxRedirects: number;                                // 5
  redirectPolicy: "same-host-only" | "follow-all";    // "same-host-only"
  blockedNetworks: readonly IpRange[];                 // DEFAULT_BLOCKED_NETWORKS（追加语义）
}
```

`mergePolicy(override)` 把 consumer 的 `Partial<NetworkPolicy>` 与 DEFAULT 合并：
- 普通字段：override 覆盖默认
- `blockedNetworks`：`[...DEFAULT_BLOCKED_NETWORKS, ...override]`，**强制并入 DEFAULT**

## 五、安全契约

### DNS pinning 双层防御

1. **URL 预校验**：hostname 是 IP 字面量（IPv4 / IPv6 / IPv4-mapped IPv6 hex 形式 `::ffff:a00:1` 与文本形式 `::ffff:10.0.0.1` 全覆盖）→ 直接 `classifyIp` 拒绝私网，不走 DNS
2. **Agent lookup hook**：非 IP 字面量走 `undici.Agent({ connect: { lookup } })`，hook 内 `dns.lookup` 后 `classifyIp`，命中私网 → callback 错误（携带 SSRF 结构化字段）

### 重定向逐跳完整复检

- `redirect: "manual"` 拿到 30x → 自实现追踪
- 每跳重做 `validateUrl + extractHostname + classifyIp（IP 字面量时）+ 新 Agent`
- **不复用首跳的 DNS 解析结果**（防 DNS rebinding）
- cross-host 重定向默认拒绝（`redirectPolicy: "same-host-only"`）
- loop 检测（visited Set）+ maxRedirects 触顶 → `redirect-blocked: too-many`

### IPv4-mapped IPv6 防御

经典 SSRF bypass：`http://[::ffff:10.0.0.1]/` 跳过纯 IPv6 范围匹配。`parseIp` 同时识别两种形式：
- 文本形式 `::ffff:a.b.c.d` → regex 提取 IPv4
- hex 形式 `::ffff:hhhh:hhhh`（URL parser 规范化结果） → bigint 高 96 位匹配 `0xFFFF` → 提取低 32 位按 IPv4 处理

### 错误结构化（避免字符串解析）

`makeSecureLookup` 拒绝时构造的 Error 携带 `.ssrf: { hostname, ip, range }` 字段 + `.code = "ESSRFBLOCKED"`。`safe-fetcher` 沿 cause chain 用 `isSsrfError` 类型守卫提取，**不依赖 message 字符串解析**——message 仅作日志/调试。

## 六、错误模型

```typescript
type FetchError =
  | { kind: "url-invalid"; reason: "protocol" | "userinfo" | "too-long" | "malformed" }
  | { kind: "ssrf-blocked"; ip: string; range: IpRange }
  | {
      kind: "redirect-blocked";
      from: string; to: string;
      reason: "cross-host" | "ssrf" | "loop" | "too-many";
    }
  | { kind: "too-large"; bytes: number; limit: number }
  | { kind: "timeout"; ms: number }
  | { kind: "dns"; host: string; cause: string }
  | { kind: "connect-failed"; host: string; cause: string }
  | { kind: "http-error"; status: number; bodySnippet?: string };
```

discriminated union 的 `kind` 字段保证 consumer 可穷尽匹配；增加新 `kind` 不破坏现有 consumer（默认未处理时编译器会提醒）。

**`dns` vs `connect-failed` 区分**（避免误导性归类）：
- `dns`：明确的 DNS 解析失败 code（ENOTFOUND / EAI_AGAIN / EAI_NODATA / EAI_SERVICE / EAI_FAIL）
- `connect-failed`：连接级失败 code（ECONNREFUSED / ECONNRESET / ECONNABORTED / ETIMEDOUT / EHOSTUNREACH / ENETUNREACH / ENETDOWN / EPIPE / EHOSTDOWN）
- **未识别错误兜底归 `connect-failed`**——DNS 错误一般有明确 libuv code，未知错误更可能是 socket/TLS/proxy 问题

## 七、HopLifecycle（资源管理）

每次 hop 由主循环创建 `HopLifecycle`，覆盖 fetch + body 读取**全程**：

```typescript
interface HopLifecycle {
  readonly signal: AbortSignal;     // timer 或 user abort 任一触发
  readonly timeoutMs: number;
  isTimedOut(): boolean;            // 区分 abort 来源
  dispose(): void;                  // 幂等释放 timer + listener
}
```

- `safeFetch` 主循环 `try { performHop(...) } finally { lifecycle.dispose() }`
- `performHop` / `readBodyWithLimit` / `readBodySnippet` 仅消费 `lifecycle.signal`，不自建 controller
- body 读取阶段 timeout 仍生效（解决"fetch 后立即清理 timer 导致 body 阶段无 protection"的债务）

## 八、HopOutcome 三态

```typescript
type HopOutcome =
  | { kind: "redirect"; nextUrl: string }
  | { kind: "result"; status: number; headers: Headers; body: Uint8Array }
  | FetchError;
```

主循环穷尽匹配（`redirect` 继续 / `result` 包装返回 / `FetchError` 直接返回），编译器保证不漏分支。`resolveRedirect` 是纯函数（无 I/O），可独立单测。

## 九、文本净化（sanitizeUntrustedText）

服务于"外部不可信文本进入 LLM 上下文前"的清洗：
1. **归一化** —— 消除视觉等价但 codepoint 不同的字符差异
2. **剥离零宽与不可见格式字符** —— 封堵不可见 prompt 注入（attacker 在网页中插入零宽 instruction）
3. **字符级长度截断 + marker** —— 防 LLM 上下文溢出

操作顺序固定为 normalize → strip → truncate（顺序变化会导致截断长度不准）。

## 十、HTTP 客户端依赖决策

使用 `undici` 包（添加为 packages/network 依赖）的 `undici.fetch + undici.Agent`，**不通过** `globalThis.fetch + dispatcher`：spike 实测发现 Node 22 内嵌 undici 与独立 undici 包的内部 API 契约不兼容（`invalid onRequestStart method`），独立调用 `undici.fetch` 行为完全可控。

## 十一、测试策略

| 模块 | mock | 覆盖 |
|------|------|------|
| `url-guard` | 无 | IPv4/IPv6 各类、IPv4-mapped IPv6 双形式、CIDR 匹配、URL 校验 |
| `text-sanitizer` | 无 | NFC/NFKC、零宽字符、截断 marker |
| `safe-fetcher-internal` | `vi.mock("node:dns/promises")` | makeSecureLookup 各路径、isSsrfError 类型守卫 |
| `proxy-helpers`（safe-fetcher-internal 子集） | 无（纯函数 + env 注入） | hasProxyEnvConfigured 大小写、resolveProxy 4 场景 + scheme-aware（targetUrl 参数）、redactProxyUrl 凭证脱敏（幂等/容错/无 auth 不变）、describeProxy 4 态判别（off / auto+null / auto+url / explicit）、createDispatcher 4 分支 dispatcher 类型 |
| `safe-fetcher` | `vi.hoisted` + `vi.mock` 替换 `createDispatcher` 为 `undici.MockAgent` + mock `resolveProxy`，**`redactProxyUrl` 走真实实现**（验证脱敏链路真的生效） | 重定向、HTTP 错误、body 限制、AbortSignal、代理上下文标注 (via proxy ...) 注入、凭证脱敏防泄露、scheme-aware targetUrl 透传到 resolveProxy |

**禁止任何真实 HTTP / DNS**——所有测试 mock 化，全部 ms 级完成。

## 十二、与其他模块的关系

- **WebFetch 工具**（[tools-builtin.md §五](tools-builtin.md#五web_fetch-工具)）：消费 `safeFetch` + `sanitizeUntrustedText`；通过 `createWebFetchTool({ proxy })` 接受代理配置
- **cli/run-agent.ts**：从 `ZhixingConfig.network.proxy` 读代理配置注入 web_fetch；扩展 `/status` 命令通过 `resolveProxy` 显示当前生效代理
- **未来 webhook 投递 / 第二通道出站 / MCP HTTP transport / OAuth callback**：复用同一 `safeFetch` 入口，避免每个 consumer 各自实现 SSRF 防御 + 代理支持

## 十三、代理支持（HTTP/HTTPS proxy）

让 `safeFetch` 支持 HTTP/HTTPS 代理，使 web_fetch（及未来出站 consumer）在中国等需要代理的网络环境下可用。代理是底层管道，**对用户无感**——99% 用户已被代理软件（Clash/V2Ray）自动设了 `HTTP_PROXY` 环境变量，zhixing 默认 `auto` 模式直接 follow，零配置。

### 13.1 配置入口（NetworkPolicy.proxy）

```typescript
proxy?: "auto" | "off" | string;
```

- `undefined` / `"auto"`：从环境变量读 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`（Unix 惯例）
- `"off"`：显式禁用代理（即使 env 有也不用，escape hatch 给本地 server 调试）
- `"http://host:port"` / `"https://host:port"`：显式代理 URL（支持 Basic Auth：`http://user:pass@host:port`）

### 13.2 创建 dispatcher（createDispatcher 工厂）

| 输入 proxy | 选用 dispatcher | connect.lookup |
|---|---|---|
| `"off"` | `Agent`（PinnedAgent 带 lookup hook） | ✅ 启用 |
| `"auto"` / undefined + 无 env | `Agent`（PinnedAgent） | ✅ 启用 |
| `"auto"` / undefined + 有 env | `EnvHttpProxyAgent`（undici 原生读 env） | ❌ **故意不传** |
| 显式 URL | `ProxyAgent`（undici 原生） | ❌ **故意不传** |

**故意不传 `connect.lookup` 给 ProxyAgent / EnvHttpProxyAgent 的 4 条理由**：
1. lookup hook 在 client 端只能干预**代理 hostname** 解析，不能干预目标 hostname（HTTP 代理用 CONNECT 隧道，目标解析在代理服务器端完成）
2. 中国用户最常配 `HTTP_PROXY=http://127.0.0.1:7890`，本地代理 IP 命中 `DEFAULT_BLOCKED_NETWORKS` 的 `127.0.0.0/8`。强制 lookup 会让所有本地代理失效
3. 安全 trade-off：用户主动配的代理 URL 视为信任，代理 hostname 不做 SSRF 检查（用户对自己代理的安全负责）
4. 目标 URL 的字面 IP 检查仍在 safeFetch 主循环同步执行，不受代理影响（`http://127.0.0.1/` 经代理仍被拦截）

### 13.3 SSRF 与代理的安全契约

| SSRF 检查点 | 直连模式 | 代理模式 |
|---|---|---|
| URL 字面 IP（`http://127.0.0.1/`）| ✅ 同步拦截 | ✅ 同步拦截（url-guard 不依赖网络层） |
| URL 字面 IPv4-mapped IPv6 / IANA 保留段（含 fake-IP） | ✅ 同步拦截 | ✅ 同步拦截 |
| URL hostname → 目标 IP（DNS 解析） | ✅ lookup hook 拦截 | ⚠️ **失效**（代理自行解析 DNS，client lookup 触不到目标 hostname） |
| 重定向逐跳目标 IP 检查 | ✅ 每跳重做 | ⚠️ **失效**（同上） |
| 代理 hostname 自身的 IP 检查 | N/A | ⚠️ **故意跳过**（本地代理常用 127.0.0.1，见 §13.2 第 2 点） |

**威胁模型澄清**：
- DNS-resolved 内网攻击在代理路径下不被网络层拦截
- 但攻击者必须**先控制代理服务器**才能让其解析到内网 IP → 不在 zhixing 标准威胁模型内
- 用户使用商业/自建代理 = 信任该服务

### 13.4 错误诊断（cause 注入 (via proxy) 标注）

代理路径下的 `connect-failed` 错误，cause 字段自动注入代理上下文：

```typescript
// 代理 host 不可达(本地代理软件没运行)
{ kind: "connect-failed", host: "docs.python.org",
  cause: "ProxyConnectFailed: ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:7890 (via proxy http://127.0.0.1:7890)" }

// 代理可达但目标不可达
{ kind: "connect-failed", host: "docs.python.org",
  cause: "ECONNREFUSED: connect ECONNREFUSED 1.2.3.4:443 (via proxy http://127.0.0.1:7890)" }

// 含凭证的代理 URL —— 自动脱敏(明文 password/username 不进 cause)
{ kind: "connect-failed", host: "docs.python.org",
  cause: "ProxyConnectFailed: ECONNREFUSED: ... (via proxy http://***@corp-proxy:8443)" }

// 直连模式连接失败(无代理上下文标注)
{ kind: "connect-failed", host: "example.com",
  cause: "ECONNREFUSED: connect ECONNREFUSED 1.2.3.4:443" }
```

**安全契约（凭证零泄露）**：

`(via proxy ...)` 中嵌入的 URL 必走 `redactProxyUrl` 脱敏 —— 任何 `username:password@` 形式都替换为 `***@`；用户单独存在（无 password）也脱敏。原始 URL 仅在内部用于 `causeIncludesProxyHost` 与 dispatcher 选择，**绝不进入 LLM 上下文 / transcript JSONL / 终端显示**。

**Scheme-aware 精确化**：

每跳 `enrichWithProxyContext` 用本跳 `currentUrl` 调用 `resolveProxy(proxy, env, currentUrl)` 解析 effective URL —— 与 `EnvHttpProxyAgent` 实际 dispatch 选择对齐：
- target 是 `https:` → 优先 `HTTPS_PROXY`
- target 是 `http:` → 优先 `HTTP_PROXY`

corporate 用户分别配 HTTP_PROXY / HTTPS_PROXY 时 `(via proxy ...)` 标注指向**实际通路**的 URL，不再误指。重定向链中跨 scheme（http → https）也得到精确逐跳标注。

**已知限制**：本函数不识别 `NO_PROXY` 白名单——undici 内部正确处理 NO_PROXY，本函数只用于诊断显示与 enrich 标注；NO_PROXY 命中目标时此函数返回的 URL 在 cause 标注里不精确（实际未走代理却显示走了）。真实 dispatch 行为不受影响——可接受的诊断不精确。

**实现职责切分**（保持单一职责）：
- `resolveProxy(proxy, env?, targetUrl?)`：纯函数，解析 effective URL；scheme-aware（`targetUrl` 可选）；不关心脱敏
- `redactProxyUrl(url)`：纯 util，凭证脱敏；幂等、容错（非法 URL 原样返回）；不关心 dispatch
- `describeProxy(proxy, env?)`：纯函数，返回 `ProxyDescription` 三元组（mode + resolved + display）；display 走 redact，user-facing 直接打印安全；详见 §13.5
- `createDispatcher(blockedNetworks, proxy)`：工厂，不关心诊断标注
- `classifyFetchError(err, hostname)`：纯归类，**不知道** proxy
- `safeFetch` 主循环：每跳调 `enrichWithProxyContext(error, policy.proxy, currentUrl)`——本调用点唯一聚合 `policy + currentUrl`，scheme-aware + redact 在此一次性完成

### 13.5 UX 路径（代理对用户无感）

```bash
# 用户什么都不用做 —— Clash/V2Ray 已自动设了 HTTP_PROXY/HTTPS_PROXY
$ pnpm cli
> 帮我读一下 https://docs.python.org/3/library/asyncio.html
# zhixing 自动 auto 模式,从 env 读代理,通过代理 fetch 成功
# 启动完全静默,日常零打扰
```

**显式覆盖**（power user）：在 `~/.zhixing/config.json` 配 `network.proxy: "http://..."` 或 `"off"`。

**按需诊断查询**（不主动打扰）：
- `/status` 命令：基于 `describeProxy(config.network?.proxy)` 展示，区分四态——
  - `mode=off`：`off (explicitly disabled)`
  - `mode=auto` + 无 env：`direct (auto: no HTTP_PROXY/HTTPS_PROXY env detected)` (灰色 dim)
  - `mode=auto` + 有 env：`http://proxy.example:8080 (auto: from env)`
  - `mode=explicit`：`http://proxy.example:8080 (from config)`

  显式禁用 vs 未检测到 env 在 UI 上明确区分（避免 `direct` 二义性误导）；`display` 字段已脱敏（含凭证 URL 显示为 `http://***@host:port`），凭证不会泄露到终端 / 日志录屏。
- 失败时 cause 字段自动含 `(via proxy ...)` 标注（已脱敏 + scheme-aware，详见 §13.4）

### 13.6 决策与边界

**MVP 仅 HTTP/HTTPS，不做 SOCKS**：Clash/V2Ray 默认同时监听 HTTP+SOCKS，HTTP 已 cover 99% 用户；undici 7+ 原生不支持 SOCKS（需 `socks-proxy-agent` 第三方包）；真实需求出现再加。

**单一 `network.proxy` 字段**：zhixing 是单进程 agent，不需 OpenClaw 那种 per-channel 多粒度路由；`NO_PROXY` 已能 cover "某些 host 不走代理"。

## 十四、暂不做（明确边界）

| 项 | 原因 | 触发再做的条件 |
|---|------|-----------------|
| POST / PUT / DELETE 等 method | 当前唯一 consumer（WebFetch）只用 GET | 第二个 consumer 出现且需要其他 method 时加 `method` 参数（向后兼容扩展） |
| 流式 response（streamFetch） | WebFetch 一次性读 body 足够 | webhook 投递大数据时新增 `streamFetch` API（不影响 `safeFetch`） |
| 认证（cookie / Bearer / OAuth） | 公开 URL 覆盖 80%+ 场景 | 接私域时加 `headers` 参数；同步必须给 `cacheKey` 加 auth 维度 |
| retries / circuit breaker | 编排层职责（core/resilience 已有） | 出现实际 quota 触顶 |
| HTTP/3 | undici 默认 HTTP/1.1 + HTTP/2 已足够 | 真实需求出现 |
| SOCKS 代理 | Clash/V2Ray 默认开 HTTP+SOCKS 双端口，HTTP 已 cover；增量复杂度不匹配收益 | 出现真实需求且代理软件无 HTTP 端口 |
| 系统代理自动检测（macOS scutil / Windows 注册表） | env 已 cover 99% 用户场景 | macOS/Windows GUI 用户真实需求出现 |
| per-host 代理路由 / PAC | zhixing 单进程 agent 不需 | 多通道异构出口需求出现 |
| 任意 dispatcher 注入 escape hatch | 增加 SSRF bypass 风险 + 当前 ProxyAgent 已 cover 主流需求 | 出现 mTLS 等需要完全自定义 dispatcher 的合法场景 |
