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
- `DEFAULT_BLOCKED_NETWORKS`：`readonly IpRange[]`，covering IPv4 + IPv6 私网/回环/链路本地/CGNAT/multicast/保留段共 14 条 CIDR

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
  | { kind: "http-error"; status: number; bodySnippet?: string };
```

discriminated union 的 `kind` 字段保证 consumer 可穷尽匹配；增加新 `kind` 不破坏现有 consumer（默认未处理时编译器会提醒）。

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
| `safe-fetcher` | `vi.hoisted` + `vi.mock` 替换 `createPinnedAgent` 为 `undici.MockAgent` | 重定向、HTTP 错误、body 限制、AbortSignal |

**禁止任何真实 HTTP / DNS**——所有测试 mock 化，全部 ms 级完成。

## 十二、与其他模块的关系

- **WebFetch 工具**：消费 `safeFetch` + `sanitizeUntrustedText`
- **未来 webhook 投递 / 第二通道出站 / MCP HTTP transport / OAuth callback**：复用同一 `safeFetch` 入口，避免每个 consumer 各自实现 SSRF 防御

## 十三、暂不做（明确边界）

| 项 | 原因 | 触发再做的条件 |
|---|------|-----------------|
| POST / PUT / DELETE 等 method | 当前唯一 consumer（WebFetch）只用 GET | 第二个 consumer 出现且需要其他 method 时加 `method` 参数（向后兼容扩展） |
| 流式 response（streamFetch） | WebFetch 一次性读 body 足够 | webhook 投递大数据时新增 `streamFetch` API（不影响 `safeFetch`） |
| 认证（cookie / Bearer / OAuth） | 公开 URL 覆盖 80%+ 场景 | 接私域时加 `headers` 参数；同步必须给 `cacheKey` 加 auth 维度 |
| retries / circuit breaker | 编排层职责（core/resilience 已有） | 出现实际 quota 触顶 |
| HTTP/3 | undici 默认 HTTP/1.1 + HTTP/2 已足够 | 真实需求出现 |
| dispatcher 注入 escape hatch | 当前无场景，且暴露后增加 SSRF bypass 风险 | 出现合法的代理 / mTLS 等场景 |
