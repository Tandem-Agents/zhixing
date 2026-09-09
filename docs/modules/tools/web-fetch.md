# WebFetch：已知 URL 的内容获取

`web_fetch` 获取已知 URL 的内容，返回 Markdown／文本，或交 light 模型按问题提炼。它不是搜索引擎，也不应猜测 URL。网络防护复用[网络出口](../network/architecture.md)，模型选择复用[模型角色](../providers/model-roles.md)，权限接入见[权限集成](permission-integration.md)。

## 一、输入与结果

| 参数 | 当前合同 |
|---|---|
| `url` | 必填非空字符串；HTTP／HTTPS 的合法性由网络层检查 |
| `prompt` | 可选字符串，最多 1000 字符；非空时选择提炼路径 |
| `format` | `markdown` 或 `text`，默认前者 |
| `maxChars` | 默认 100000；有限数字向下取整后须在 1000～200000。控制未命中缓存时的 raw 净化上限，不是所有返回结果的硬上限 |

成功结果带 `Source: URL`。抓取失败返回错误结果；没有成功取得内容时，不承诺总能降级出有用原文。

| 条件 | 行为 |
|---|---|
| 无非空 prompt | 返回处理后的原文 |
| 有 prompt，但无 `context.llm` | 返回处理后的原文 |
| 有 prompt 且注入 LLM | 调 `context.llm.light.chat()` 提炼 |
| 提炼为空或抛错 | 返回原文，并附空结果／失败说明 |

## 二、内容处理与缓存

`safeFetch → 解码 → HTML 转换 → 不可信文本净化与截断 → raw 缓存 → 原文或提炼`

- 字符集按响应 Content-Type、UTF-8／UTF-16 BOM、UTF-8 默认的顺序选取；不支持的编码退回 UTF-8，解码使用非 fatal 模式。
- 非 HTML 返回解码文本。HTML 的 Markdown 路径按需加载 turndown；text 路径去标签、折叠空白。按需加载避免未使用抓取功能时承担该转换器的加载成本，不承诺固定制品体积。
- 未命中缓存时，有 prompt 按 100000 字符净化，否则按 `maxChars`；提炼结果另行生成，不存入 raw 缓存。
- 缓存为进程内模块级 LRU，容量 50，key 是 `url|format`，不持久化。不同 prompt 应独立提炼，这是不缓存最终摘要的原因。

**当前缓存边界：** 缓存存的是已经截断的文本，却没有把 `maxChars` 或模式计入 key，命中后也不重新截断。因此先前短请求可能限制后续提炼材料，先前长请求可能使后续短请求得到超过其请求上限的文本；不能把 `maxChars` 写成缓存命中时仍严格生效的保证。缓存没有 TTL，也不区分代理，命中时不重新抓取或执行网络检查。WebFetch 没有 cookie／Bearer 输入；若以后支持身份相关内容，不能沿用此无身份维度缓存。

## 三、提炼与不可信输入

提炼将 URL、已净化内容和问题交给 light 角色，显式 `tools: []`，传递该角色 thinking 配置和调用取消信号。流收集只累积文本，不把 thinking 或工具调用当答案；非空结果 trim 后返回。

空工具集合隔离提炼调用的工具执行，不意味着网页内容可信或摘要绝不受提示注入影响。原始内容仍按不可信输入处理。当前提炼 catch 也会把取消类异常退成 raw；主执行链仍需处理取消，不应把这一行为描述为可靠的即时取消保证。内容转换等未被本工具捕获的异常由外层工具执行链处理，旧“任何失败都不抛异常”表述不成立。

## 四、权限、代理与使用提示

WebFetch 声明 `network / egress / dynamic:false`，权限参数为 `url`。默认规则仅预批准 HTTPS，来源为 `WEB_FETCH_PREAPPROVED_HOSTS`：MDN、react.dev、Python 文档、GitHub 与 raw.githubusercontent.com、Stack Overflow、英文／中文 Wikipedia、arxiv.org、npmjs.com、typescriptlang.org、Anthropic 文档，共 12 个主机。按 `https://host/**` 生成规则；用户匹配规则优先，默认规则不解除网络层防护，也不证明站点内容可信。

预批准主机只在权限层，不进入系统提示词。工具提示只说明已知 URL、提炼与原文选择、不编造地址及无 URL 时的处理；模型无需记忆系统授权明细。

Host 将运行环境代理传入工厂，再透传 safeFetch。默认自动读取环境代理，无环境配置时直连；`off` 禁用，也可显式配置代理。状态与错误中的代理描述只是诊断信息，不能承诺模型一定识别根因或所有输出必然脱敏，具体边界见网络出口专题。

## 五、失败信息

| 网络错误 | 返回信息的含义 |
|---|---|
| `url-invalid` | 地址无效及原因 |
| `ssrf-blocked` | 被阻止的 IP／网段；198.18.0.0/15 附 fake-IP 提示 |
| `redirect-blocked` | 重定向来源、目标与阻止原因 |
| `too-large` | 响应字节数超过网络读取上限 |
| `timeout` | 请求超时 |
| `dns` | 域名解析失败及原因 |
| `connect-failed` | 连接失败及原因 |
| `http-error` | HTTP 状态和最多 200 字符的响应片段 |

这些信息用于定位失败，不等于诊断结论；网络读取上限、raw 字符上限与工具结果截断是不同边界。

实现入口：[工具与输入校验](../../../packages/tools-builtin/src/web-fetch.ts)、[缓存与转换](../../../packages/tools-builtin/src/web-fetch/internal.ts)、[提炼](../../../packages/tools-builtin/src/web-fetch/distill.ts)、[默认规则](../../../packages/tools-builtin/src/web-fetch-rules.ts)。
