# 网络出口架构

`@zhixing/network` 为已接入的 WebFetch 与 MCP HTTP 消费者提供共享的 URL/IP 防护、HTTP 传输和文本净化原语，避免各自重复实现网络边界。它不是全项目所有出站请求的统一网关，也不拥有工具权限、业务重试或 MCP 会话协议。

## 一、设计取舍

- 安全检查集中在 URL 校验与实际连接处，不能只预查一次 DNS、随后让客户端重新解析并连接。
- 抓取完整内容与保持协议流使用不同接口，共享防护机制，不强迫长连接套用一次性 GET 的结果模型。
- 默认禁止网段始终并入策略，调用方只能追加，传空数组不能移除内置限制；这一规则不意味着代理端 DNS 也受客户端控制。
- timer、取消监听器与连接池分别有明确生命周期，不能把资源释放交给 GC。
- 代理是基础设施配置，正常使用保持安静，失败提供可诊断且不泄露凭证的信息，不要求用户理解内部传输拓扑。

传输使用同一独立 `undici` 包的 fetch 与 dispatcher，避免混用 Node 内建 fetch 与另一版本 dispatcher。原选型曾遇到内部接口不兼容；该原因支持依赖配对，不代表所有 Node 版本必然不兼容。

## 二、公共接口与责任

| 维度 | `safeFetch(url, policy?, { abortSignal }?)` | `createSafeFetch(policy?)` 返回的 `SafeFetch` |
|---|---|---|
| 用途 | 抓取一个 URL 的完整内容 | 向协议客户端注入 fetch，支持原生响应及长连接 |
| 请求 | GET | `string \| URL` 与 `RequestInit`；方法、headers、body、signal 透传 |
| 结果 | `FetchResult \| FetchError`；成功含 status、headers、字节 body、finalUrl、redirectChain | `Promise<Response>`；HTTP 错误状态仍是 Response，URL／IP 拒绝及传输失败通过 Promise rejection 返回 |
| 重定向 | 手动逐跳校验，默认同 hostname；检测循环与跳数 | 强制 `redirect: "error"`，不允许调用者改为自动跟随 |
| 大小与超时 | 每跳 timeout 覆盖请求及 body 读取；累计 body 字节受限 | 不执行策略中的 body 上限和高层 hop timeout；响应消费、时限与取消由消费者负责 |
| 连接资源 | 每跳创建 dispatcher；当前没有显式关闭该 dispatcher 的路径 | 创建时持有一个 dispatcher，所有者调用 `close()` 释放连接池 |

两种接口都先校验 URL 与字面 IP，再使用受控 dispatcher；标准接口会覆盖调用方传入的 dispatcher，不能借 `RequestInit` 绕过。`safeFetch` 的预期请求失败使用判别联合，并非对任意异常的绝不抛出保证。

其余公共出口：`validateUrl`、`classifyIp`、`sanitizeUntrustedText`，策略／禁止网段默认值，以及 `resolveProxy`、`redactProxyUrl`、`describeProxy` 和相应类型。`extractHostname`、lookup hook 与 dispatcher 工厂是内部实现，不是包公共 API。

`NetworkPolicy` 默认允许 HTTP/HTTPS，URL 上限 2048 字符、body 上限 5 MiB、每跳超时 30 秒、最多 5 次重定向、仅同 hostname 跟随，proxy 为 `auto`。一般字段覆盖默认值，`blockedNetworks` 与内置列表合并；不同接口只消费其实际负责的字段，不能因接受同一策略类型就推定行为相同。

## 三、URL、DNS 与重定向边界

`validateUrl` 拒绝非法格式、超长 URL、不允许的协议及 URL userinfo。字面 IP 不经过 DNS，直接按禁止网段判断。覆盖 IPv4、IPv6，以及 IPv4-mapped IPv6 的文本和十六进制形式，避免地址表达变化绕过检查。

内置网段包括私网、回环、链路本地、CGNAT、组播、保留地址，以及文档／基准测试网段（含 `198.18.0.0/15`）。完整 CIDR 列表由 `url-guard.ts` 维护，不在文档复制第二份名单。

PinnedAgent 的 lookup hook 对解析出的地址检查后再交给连接使用。拒绝错误携带 `ESSRFBLOCKED` 与 `{ hostname, ip, range }`；高层沿 cause 链提取结构化信息，不解析 message 来认定 SSRF。

`safeFetch` 使用手动重定向：每跳重新校验 URL、字面 IP 并创建 dispatcher；直连时再次执行连接处的 DNS 检查，不沿用首跳解析。`same-host-only` 比较 hostname，不是完整 origin；`follow-all` 也不跳过下一跳的防护。重复 URL 与跳数超限分别返回 loop／too-many。标准 fetch 不具备逐跳复检流程，因此直接拒绝重定向。

### 代理选择

`proxy` 支持 `auto`／未指定、`off`、显式 HTTP/HTTPS 代理 URL。自动模式由环境变量驱动，未配置代理环境变量时使用直连；不假定代理软件已经替用户设置环境变量。

| proxy 输入 | dispatcher | 本包安全 lookup hook |
|---|---|---|
| `off` | PinnedAgent | 有 |
| `auto`／未指定，无代理环境变量 | PinnedAgent | 有 |
| `auto`／未指定，有代理环境变量 | EnvHttpProxyAgent | 无 |
| 显式代理 URL | ProxyAgent | 无 |

不把目标网段过滤器套在代理地址上：本地代理可合法位于回环地址，而且检查代理 DNS 不能替代检查代理解析的目标地址。显式代理与环境代理是传输信任配置，不应来自任意不可信请求。

### 直连与代理的防护差异

| 检查点 | PinnedAgent 直连 | 代理 dispatcher 路径 |
|---|---|---|
| URL 格式／协议／userinfo | 校验 | 校验 |
| 目标字面 IP，包括 mapped IPv6／保留段 | 拦截禁止网段 | 同样拦截 |
| hostname 解析后的目标 IP | 连接 lookup 检查 | 本包没有目标 DNS 检查，代理转发时由代理解析 |
| `safeFetch` 重定向 | 每跳重做 URL、字面 IP 和 DNS 检查 | 每跳重做 URL、字面 IP 检查，不增加目标 DNS 检查 |
| `createSafeFetch` 重定向 | 拒绝 | 拒绝 |
| 代理地址是否可为内网／回环 | 不适用 | 允许，不套目标网段限制 |

因此代理路径不能声称与 PinnedAgent 具有相同的 SSRF 保证。攻击者不必控制代理服务器，就可能使其访问一个解析到内网的目标；目标访问边界还依赖代理自身的出口策略。EnvHttpProxyAgent 的 `NO_PROXY` 分流由 undici 执行，但本包未向该 dispatcher 注入安全 lookup，不能把其绕过代理的连接视作 PinnedAgent 防护已经成立。这里记录现状与边界，不降低安全目标，也不在文档迁移中改变实现。

## 四、失败与资源生命周期

`safeFetch` 以 `kind` 区分 url-invalid、ssrf-blocked、redirect-blocked、too-large、timeout、dns、connect-failed、http-error。消费者应按语义处理，不能根据文本猜测故障；增加判别分支时须检查消费者，而非假定自动兼容。

- DNS 失败依据明确的解析错误码识别；socket／TLS／代理等连接问题与未知错误归 connect-failed，避免全部误报 DNS。
- HTTP 错误可附最多 4096 字节读取范围内的 bodySnippet；读取失败或超限时可无片段，仍返回 HTTP 错误。
- 重定向到禁止 IP 的实际路径返回 ssrf-blocked；类型里有 `redirect-blocked.reason = "ssrf"`，不能据此宣称生产会返回该形态。
- 当前没有独立 canceled 判别；主动取消不能一概写成 timeout。

每跳主循环创建 `HopLifecycle`，在 finally 中释放 timer 与用户取消监听器；请求和 body reader 共用其 signal，防止收到响应头就提前移除 body 阶段的超时保护。内部 hop 结果区分 redirect、result 与错误，主循环负责继续或返回。

body reader 累积字节，超限取消；取消监听器在结束时移除。但当前实现存在需与设计义务区分的边界：取消后若 reader 以 done 正常结束，循环没有最终复查取消状态；`HopLifecycle.dispose()` 也只释放 timer／监听器，不等于关闭每跳 dispatcher。不能用“有 finally”证明所有资源与取消终态都已闭合。

`SafeFetch.close()` 显式关闭连接池。MCP HTTP transport 将它作为 dispose 返回，连接所有者负责在断开时调用；MCP 查源／搜索的 `defaultHttpGetText` 则封装 fetch 并读取 `res.text()`，当前未暴露 close，也没有因此获得高层 GET 的 body 上限。保留明确所有权与受控资源的设计要求，不把这些缺口写成已解决。

## 五、代理诊断与秘密边界

诊断与实际 dispatcher 选择分离：

- `resolveProxy(proxy, env?, targetUrl?)` 返回原始候选代理 URL，按目标 scheme 选择环境变量；不处理 `NO_PROXY`，不是实际通路证明。
- `redactProxyUrl` 将可解析 URL 的 username／password 替换为脱敏形式；非法 URL 原样返回，所以不是任意错误文本的通用秘密过滤器。
- `describeProxy` 区分显式关闭、自动但无环境代理、自动发现代理、显式配置四态；展示使用 `display`，不得直接展示原始 `resolved`。
- `safeFetch` 对 connect-failed 按当前跳追加已脱敏的候选代理标注；原错误含代理 host:port 时增加 `ProxyConnectFailed` 前缀。这是定位线索，不是确定性根因判断，标准 fetch 不自动获得此错误包装。

`NO_PROXY` 命中时可能实际直连而标注仍显示候选代理；不能把这种显示当作传输事实。诊断不得泄露凭证是要求，当前 URL 脱敏并不证明所有上游异常文本已被过滤。

## 六、不可信文本

`sanitizeUntrustedText` 固定执行 normalize → strip → truncate：先以 NFC（可选 NFKC）归一化，再剥离指定零宽／不可见格式字符，最后按配置长度截断并附标记。顺序确保清洗后再计算截断。

它减少字符混淆与控制输入规模，不是提示词注入隔离器，也不负责模型 token 预算。外部文本仍是不可信内容，不能通过清洗提升为指令权威。

## 七、当前集成与维护入口

| 消费者 | 实际职责 |
|---|---|
| WebFetch | `safeFetch` 取得内容，文本净化后交给工具上层；缓存、内容提取和权限不归网络包 |
| MCP HTTP transport | 注入 `createSafeFetch`，保留协议方法／headers／流，由 MCP 连接生命周期处置额外连接池 |
| MCP 查源与搜索 | `defaultHttpGetText` 复用标准 fetch，继承代理配置与调用方 signal；来源裁决不归网络包 |
| CLI Host 装配 | runtime 配置投影向 Kernel 工具实现传递 networkProxy，MCP 管理／运行端接收所需 proxy；展示投影只传脱敏描述，不向表面泄露整个配置 |

网络请求发生在消费者所在的实际执行进程／设备，自动代理读取该处环境；配置字段统一不代表所有设备共享一个进程或连接池。没有接入本包的 Provider、通道等出站路径，不因本文而自动获得其防护保证。

当前不提供业务重试／熔断、SOCKS、系统代理探测、PAC 或任意 dispatcher 注入。方法、鉴权 headers 与流式响应已由标准 fetch 支持，不再列为未来能力；具体认证协议和业务策略仍属于消费者。

实现依据：

- [公共出口](../../../packages/network/src/index.ts)、[策略与结果类型](../../../packages/network/src/types.ts)、[URL/IP 防护](../../../packages/network/src/url-guard.ts)。
- [两种 fetch 与 hop 生命周期](../../../packages/network/src/safe-fetcher.ts)、[lookup／代理与诊断](../../../packages/network/src/safe-fetcher-internal.ts)、[文本净化](../../../packages/network/src/text-sanitizer.ts)。
- [WebFetch](../../../packages/tools-builtin/src/web-fetch.ts)、[MCP transport](../../../packages/mcp/src/transport.ts)、[MCP HTTP 文本请求](../../../packages/mcp/src/http.ts)；业务边界见 [MCP 架构](../mcp/architecture.md)。
- [Kernel 配置接线](../../../packages/cli/src/runtime/kernel-runtime-bindings.ts)、[工具实现装配](../../../packages/cli/src/runtime/kernel-tool-implementation.ts)、[展示配置投影](../../../packages/cli/src/runtime/runtime-configuration-provider.ts)。

验证重点是 URL／IP 表达、DNS 实际连接检查、两种重定向合同、body 与取消边界、代理分支、诊断脱敏及消费者释放路径。纯函数与可控 DNS／HTTP 替身用于确定性验证；单元测试绿灯不能代替生产消费链证据，也不把旧测试数量与耗时当架构合同。
