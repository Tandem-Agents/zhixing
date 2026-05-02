# 用户凭证存储与首次引导

> 知行用户级凭证文件 `~/.zhixing/credentials.json` 的契约、加载链、AI 访问控制、必要字段检测与首次引导。本规格执行 [ADR-008](../architecture/decisions/008-identity-bootstrap-layer.md)。

## 一、设计原则

- **物理隔离即权限隔离**：`config.json` 与 `credentials.json` 分文件存放、走不同的安全规则。AI 对单一文件无法做"部分字段不可读"——所以"AI 不可读"的字段必须独立成文件。
- **凭证只走单路径作默认**：`credentials.json` 是凭证的**主**来源。`config.providers.<id>.apiKey` 字段保留为**fallback** 入口，承载 `env:VAR_NAME` / `helper:command` / plaintext 三种语义（CI / enterprise vault / 高级 dev 用）；仅当 `credentials.json` 此 provider 没填时启用，不写则不参与解析。
- **扩展点全部在现有包内**：credentials loader 在 `@zhixing/providers`、新规则在 `@zhixing/core/security/builtin-rules`、wizard 在 `@zhixing/cli`。**不新建包**。
- **首次引导不依赖 LLM**：第一次没凭证 = 没 LLM 可调，引导必须是程序级。
- **解耦**：检测（纯函数）/ 引导逻辑（面向接口）/ 文件操作（私有 API）三层独立。

## 二、文件契约

### 2.1 `~/.zhixing/config.json`（沿用现状，仅删除凭证字段）

类型在 `packages/providers/src/types.ts` 已定义。本规格仅约束语义：

```typescript
interface ZhixingConfig {
  llm: { main: LLMRoleConfig; secondary?: LLMRoleConfig };
  providers?: Record<string, ProviderConfig>;
  channels?: Record<string, ChannelConfigEntry>;
  workspace?: WorkspaceConfig;
  agent?: AgentConfig;
  intent?: IntentConfig;
  network?: NetworkConfig;
}
```

约束变更：

- **`ProviderConfig.apiKey` 字段保留**——但语义改为 **fallback**：仅当 `credentials.json` 此 provider 没填、且用户在 `config.json` 显式写了此字段时才被解析（`env:` / `helper:` / plaintext 三种格式由 `parseApiKeyValue` 处理）；默认不写
- **`ChannelConfigEntry` 接口不变**，但 `credentials` 字段语义收紧：
  - `credentials` 字段（沿用现状的 `Record<string, string>` 形态）只放**非密**字段（`appId` 等）
  - 密字段（`appSecret` 等）迁出到 `~/.zhixing/credentials.json` 的 `channels.<id>` 段
  - `setupChannels` 内部合并两份来源；channel adapter（如 `FeishuAdapter`）通过 `ChannelAdapter.connect` 收到的 `ChannelConfig.credentials` 形态完全不变（`Record<string, string>`），无任何 adapter 接口改动

### 2.2 `~/.zhixing/credentials.json`（新增）

```typescript
interface ZhixingCredentials {
  /** schema 版本，用于未来迁移 */
  version: 1;

  /** Provider 凭证：按 provider id 索引 */
  providers?: Record<string, { apiKey: string }>;

  /** Channel 凭证：按 channel id 索引；字段由具体 channel 适配器决定 */
  channels?: Record<string, Record<string, string>>;
}
```

**示例**：

```json
{
  "version": 1,
  "providers": {
    "siliconflow": { "apiKey": "sk-..." },
    "openai":      { "apiKey": "sk-..." }
  },
  "channels": {
    "feishu": { "appSecret": "..." }
  }
}
```

### 2.3 关联机制

`config.json` 与 `credentials.json` 按 **id** 关联：

- provider 维度：`config.providers.<id>`（非密元数据）↔ `credentials.providers.<id>.apiKey`（密）
- channel 维度：`config.channels.<id>`（含 `credentials` 字段放非密如 `appId`）↔ `credentials.channels.<id>`（密如 `appSecret`）

两份文件各自独立，无 schema 嵌套。

### 2.4 模板

`ensureGlobalConfigTemplate`（[`config-loader.ts:122`](../../../packages/providers/src/config-loader.ts)）首次运行时创建 `config.json`。修订后的模板：

- 保留 `llm.main` 默认指向某个 preset provider + 该 preset 的默认模型
- `providers` 段为空对象（不再预填 `apiKey: "env:..."` 占位）
- `workspace` 沿用现有平台默认（Windows 优先 `D:\ZhixingWorkspace`）

`credentials.json` 同时创建空骨架：

```json
{ "version": 1 }
```

两份文件**总是存在**——所以判定是否需要引导**不**看文件存在性，看必要字段（§五）。

## 三、加载与解析

### 3.1 Loader 与 Writer

`@zhixing/providers` 暴露读写两组函数：

```typescript
// 读：已有，扩展使用
function loadConfig(options?: ...): ZhixingConfig;

// 读：新增
function loadCredentials(options?: {
  homeDir?: string;
  noAutoCreate?: boolean;
}): ZhixingCredentials;

// 写：新增（供 wizard 与未来的 Tier B `update_config` 流程使用）
function writeConfig(
  patch: Partial<ZhixingConfig>,
  options?: { homeDir?: string },
): Promise<void>;

function writeCredentials(
  patch: Partial<ZhixingCredentials>,
  options?: { homeDir?: string },
): Promise<void>;
```

**Loader 行为**：文件不存在时自动创建空骨架（与现有 `ensureGlobalConfigTemplate` 同模式）。

**Writer 行为**：
- **原子写**（write-temp-then-rename）—— 防止 wizard 中途中断或进程崩溃造成半截损坏的私密文件
- **shallow merge**：读现有文件 → 与 patch 合并 → 写回。`Partial` 是浅合并，调用方需提供完整的子树（如要改 `llm.secondary` 需提供完整 `llm` 字段）
- **不经任何 AI 工具体系**：是程序级 file IO，wizard 与 Tier B `update_config` 流程直接调；与 `bi-zhixing-credentials-block` / `bi-zhixing-config-write` 规则无关（规则约束的是 AI 工具，不是程序级写）

### 3.2 apiKey 解析链与 API 形态

#### 3.2.1 解析顺序

`resolveApiKey`（[`resolve.ts:254`](../../../packages/providers/src/resolve.ts)）内部按以下顺序，**`credentials.json` 是主路径**：

1. **`credentials.providers.<id>.apiKey`** —— 主来源（向导写、用户编辑）
2. **`config.providers.<id>.apiKey`** —— fallback，承载 `env:` / `helper:` / plaintext 三种格式（既有 `parseApiKeyValue` 逻辑保留）；仅当 1 缺失时启用
3. 都缺失 → 抛 `ProviderConfigError`，消息引 `~/.zhixing/credentials.json` 的位置与 schema，建议用户跑 `zhixing` 触发首次引导

**为什么 credentials.json 优先**：旧版用户的 `~/.zhixing/config.json` 可能有 `"apiKey": "env:SILICONFLOW_API_KEY"` 死引用——把 credentials.json 放主路径，向导写完即生效，**无需迁移用户的 config.json**。CI / 高级用户依赖 `apiKey: "env:VAR"` 时不写 credentials.json 即可，fallback 自然命中。

**移除**：`presets[id].envKey` 字段及其相关代码全部删除——既不参与默认解析，也不作为元数据保留。`presets[id]` 仅保留 `name` / `baseUrl` / `protocol` / `defaultModel` / `quirks` 等服务商技术配置；用户在 `apiKey: "env:VAR_NAME"` 中使用什么 env 名由用户自己决定，知行不预设特定 env 命名约定。

#### 3.2.2 Resolve 内部链签名

resolve 内部链在原 `env` 之外**显式增加 `credentials` 参数**——避免内部懒加载文件、避免 thread 不到的 implicit 状态：

```typescript
function resolveLLMRoles(
  config: ZhixingConfig,
  credentials: ZhixingCredentials,
  options?: LLMRolesResolveOptions,
  env?: Record<string, string | undefined>,
): ResolvedLLMRoles;

function resolveFromConfig(
  config: ZhixingConfig,
  credentials: ZhixingCredentials,
  providerId?: string,
  env?: Record<string, string | undefined>,
): ResolvedProvider;

function resolveProvider(
  providerId: string,
  userConfig: ProviderConfig,
  credentials: ZhixingCredentials,
  env: Record<string, string | undefined>,
): ResolvedProvider;
```

#### 3.2.3 Factory 层签名（外层公共 API）

`packages/providers/src/create-provider.ts` 的三个公共工厂——`createProvider` / `createProviderDirect` / `createProviderRoles` ——**对外签名完全不变**，内部增加 `loadCredentials()` 调用，与现有 `loadConfig()` 同步：

```typescript
// 签名不变
function createProviderRoles(options?: ProviderRolesOptions): ProviderRolesResult;
// 内部：loadConfig() + loadCredentials() → resolveLLMRoles(config, credentials, ...)

function createProvider(
  config: ZhixingConfig,
  providerId?: string,
  env?: Record<string, string | undefined>,
): LLMProvider;
// 内部：loadCredentials() → resolveFromConfig(config, credentials, providerId, env)

function createProviderDirect(
  providerId: string,
  config?: ProviderConfig,
  env?: Record<string, string | undefined>,
): LLMProvider;
// 内部：loadCredentials() → resolveProvider(providerId, config, credentials, env)
```

**约束**：所有 factory consumer（`@zhixing/orchestrator/runtime/create-agent-runtime.ts:293` 调 `createProviderRoles`、测试调 `createProvider*`）零改动。Factory 是黑盒——内部 load 凭证；resolve 是 transparent 函数——接收已加载状态。这两层职责分离。

### 3.3 channel secret 解析

`SetupChannelsOptions`（[`packages/cli/src/serve/channels.ts:40`](../../../packages/cli/src/serve/channels.ts)）显式增加 `credentials` 字段：

```typescript
export interface SetupChannelsOptions {
  entries: Record<string, ChannelConfigEntry>;
  credentials: ZhixingCredentials;  // 新增
  conversations?: ConversationManager;
  logger: ChannelLogger;
  confirmationHub?: ConfirmationHub;
  cancelKeywords?: readonly string[];
}
```

`setupChannels` 内部合并：

- 非密字段（`appId` 等）从 `config.channels.<id>.credentials`（沿用现状的 `Record<string, string>`）取
- 密字段（`appSecret` 等）从 `options.credentials.channels.<id>` 取
- 合并后传给 `ChannelAdapter.connect`，channel adapter（如 `FeishuAdapter`）通过 `ChannelConfig.credentials` 收到的形态完全不变（`Record<string, string>`）；**`ChannelConfigEntry` 接口与 adapter 接口都不动**

**Caller 改动点**（已知两处，发布前 grep 全仓核对）：

- [`cli/repl.ts:715-731`](../../../packages/cli/src/repl.ts)：`loadConfig` 之外加 `loadCredentials`，把 credentials 传入 `setupChannels`
- [`cli/serve/command.ts:210-230`](../../../packages/cli/src/serve/command.ts)：同上

## 四、AI 访问控制

### 4.1 现有规则继续生效

`bi-zhixing-config-write`（[`builtin-rules.ts:60-74`](../../../packages/core/src/security/builtin-rules.ts)）已经覆盖 `.zhixing/` 写操作：`action: confirm`、`bypassImmune: true`。AI 用通用 `fs-write` / `edit` 工具写 `config.json` 自动命中此规则——每次都需用户当面确认，不可"永远同意"。**无需新规则、无需新工具**。

### 4.2 新增规则：凭证文件完全隔离

加入 `BUILTIN_RULES`：

```typescript
{
  id: "bi-zhixing-credentials-block",
  name: "知行凭证文件隔离",
  description: "AI 不可读、不可写 ~/.zhixing/credentials.json——含 provider apiKey、channel secret 等敏感字段",
  enabled: true,
  match: { type: "path", paths: [".zhixing/credentials.json"], access: "any" },
  action: "block",
  bypassImmune: true,
  severity: "critical",
  category: "data_exfiltration",
  source: "builtin",
  message: "知行凭证文件 ~/.zhixing/credentials.json 不允许 AI 读写——含敏感凭证",
  suggestion: "若用户需要修改凭证，请告知用户：(1) 文件位置 ~/.zhixing/credentials.json (2) schema：providers.<id>.apiKey / channels.<id>.<field> (3) 让用户自己编辑该文件，AI 不参与"
}
```

### 4.3 AI 动态感知

策略引擎在 `block` 时短路（[`security-pipeline.ts:96-105`](../../../packages/core/src/security/security-pipeline.ts)），返回 `SecurityMiddlewareResult` 含 `decision.reason` 与 `decision.suggestion`。工具调用层把这两段作为工具失败结果返回给 AI，**不**包装成抽象错误。

AI 看到的是结构化文本——"工具调用被拦，原因 X，建议 Y"——自然根据 suggestion 引导用户自改。**不需要新的 SecurityAction 类型**、**不需要在系统提示里预先告知 AI 哪些路径不能读**——动态感知通过现有 `message` + `suggestion` 字段完成。

### 4.4 path 匹配优先级

`bi-zhixing-credentials-block` 与 `bi-zhixing-config-write` 都可能被 credentials.json 的写操作命中（前者 access `any` 含写；后者 access `write`）。`policy-engine.ts:328` 的 `ACTION_SEVERITY: { allow: 0, audit: 1, confirm: 2, block: 3 }` 保证 `block` 优先——credentials.json 永远是 block，不会降级到 confirm。

## 五、首次启动检测与引导

### 5.1 必要字段定义

「必要字段」= 没有它就**无法进入正常使用**的字段：

- `config.llm.main.provider` —— 主对话用哪家 LLM 提供方
- `config.llm.main.model` —— 主对话用哪个模型
- `credentials.providers[<main.provider>].apiKey` —— 主 provider 的 key
- **如 `config.llm.secondary` 显式配置且 `secondary.provider !== main.provider`**：`credentials.providers[<secondary.provider>].apiKey` 也是必要字段。理由：`resolveLLMRoles`（[`resolve.ts:228`](../../../packages/providers/src/resolve.ts)）对不同 provider 的 secondary 走独立解析、失败 fail-fast——不补这条会启动期抛错，绕过引导

**其他字段不触发引导**：
- `llm.secondary` 缺省时 secondary 角色落到 main（[`secondary-llm-capability.md`](secondary-llm-capability.md) 已实现）
- `llm.secondary` 与 main 同 provider 时复用 main 的解析，不需要独立 key
- `workspace.root` 有 `cwd-fallback` 兜底（[`config-loader.ts:resolveWorkspace`](../../../packages/providers/src/config-loader.ts)）
- channels 仅在 server / channel 模式下需要——由各模式启动期自检

### 5.2 检测函数

`@zhixing/providers/src/bootstrap-check.ts`（新增）：

```typescript
export interface MissingField {
  /** 字段路径，如 "credentials.providers.siliconflow.apiKey" */
  path: string;
  /** 人类可读说明，如 "SiliconFlow 的 API Key" */
  humanLabel: string;
  /** 落到哪份文件 */
  file: "config" | "credentials";
}

/** 纯函数：输入两份文件状态，输出缺失字段列表。空数组表示 ready。 */
export function checkBootstrap(
  config: ZhixingConfig,
  credentials: ZhixingCredentials,
): MissingField[];
```

复用方：CLI 启动 / server 启动期自检 / 未来 `zhixing doctor` / 测试。

### 5.3 引导接口

`@zhixing/cli/src/bootstrap/`（新增目录）：

```typescript
/** 入口无关的交互抽象——CLI 用 readline 实现，其他入口可用别的实现 */
export interface BootstrapInteraction {
  printIntro(missing: MissingField[]): Promise<void>;
  askField(field: MissingField, schemaExample: string): Promise<string | "cancel">;
  printSummary(written: { config: boolean; credentials: boolean }): Promise<void>;
}

/** 程序级引导编排——不直接读 stdin / 写 stdout，所有交互经 BootstrapInteraction */
export async function runBootstrap(
  missing: MissingField[],
  interaction: BootstrapInteraction,
  writers: {
    writeConfig(patch: Partial<ZhixingConfig>): Promise<void>;
    writeCredentials(patch: Partial<ZhixingCredentials>): Promise<void>;
  },
): Promise<"completed" | "cancelled">;
```

`runBootstrap` 与 `BootstrapInteraction` 物理分离：流程编排在 `cli/bootstrap/`、CLI 的 readline 实现也在 `cli/bootstrap/`，但接口是显式 seam，方便未来加新入口或换交互形式（GUI、TUI 等）。

### 5.4 引导职责

向导一次会话内：

- **告知**（向导开始）：打印两个文件的**绝对路径**（Windows 下 `C:\Users\<user>\.zhixing\config.json`、`...\credentials.json`，不显示 `~/.zhixing/...`）；说明公私两份文件的语义；这次需要用户做什么
- **逐字段询问**：每个 `MissingField` 附 schema 示例（如 `apiKey: "sk-xldthyx..."`）；输入 apiKey 等敏感字段时关闭终端 echo
- **可选连通性自检**：收完 key 后向 provider 发最小请求确认 key 可用；失败可让用户重输或跳过；失败不阻塞引导完成
- **写文件**：通过 `writeConfig` / `writeCredentials` 落盘；不与 AI 工具体系交互
- **总结**：打印写入结果与下一步建议（如"现在跑 `zhixing -p '你好'` 试一下"）

### 5.5 入口适配

| 入口 | 行为 |
|---|---|
| **CLI / TTY** | 启动期同步执行 `runBootstrap`；完成后进 REPL；用户取消 → 退出 |
| **CLI / 非 TTY**（CI / pipe） | `runBootstrap` 检测 `process.stdin.isTTY === false` → 直接返回 `cancelled`，CLI 报清晰错误："首次配置需 TTY，请在终端中跑 `zhixing`"；退出码 2 |
| **`zhixing server`** | 启动期 `checkBootstrap` 缺失 → 拒绝启动，日志引导用户先在终端跑 `zhixing` 完成首次配置；不内联引导（无 TTY） |
| **Channel（飞书等）** | 跟随 server，不独立判定；server 没起来 channel 自然不可达 |

### 5.6 Reload

用户改完 `credentials.json`（自己用编辑器）或 AI 经现有 `bi-zhixing-config-write` 流程改完 `config.json` 后，运行中的进程需要重新加载：

| 触发 | 实现 |
|---|---|
| CLI REPL | slash 命令（如 `/reload`），由 [`input-typeahead.md`](input-typeahead.md) 的命令注册体系承载 |
| server | 文件 watch 监听 `~/.zhixing/*.json`，变更后重新加载并 hot-swap LLM client |
| channel | 跟随 server 同进程，watch 触发即生效 |

`reload` 内部：重读两份文件 → 重做 `checkBootstrap` → 必要字段仍齐全则刷新缓存 LLM client；缺失则记日志，下次操作时报错（不主动重启向导——用户在 reload 间删字段是边界情况）。

## 六、移除项

落地本规格时，以下内容**移除**（不留并行路径，避免架构债务）：

| 项 | 处置 |
|---|---|
| 项目根 `zhixing.cmd` / `zhixing` shim（`node --env-file=.env ...`） | 删除 |
| `dist/` 包内任何对项目根 `.env` 的依赖 | 不存在则保持，存在则删除 |
| `presets[id].envKey` 字段及其在 `resolveApiKey` 中的引用 | 全部删除（字段不再保留为元数据） |
| 项目根 `.env` / `.env.example` 文件 | 删除 |
| `package.json` dev script 中的 `--env-file=.env` 注入 | 删除 |
| `ensureGlobalConfigTemplate` 模板中的 `"apiKey": "env:SILICONFLOW_API_KEY"` 占位 | 删除 |
| `~/.zhixing/config.json` 中已有的 `providers.<id>.apiKey: "env:..."`（用户机器上） | **不需要迁移**——§3.2.1 解析顺序中 credentials.json 是主路径，向导写完即生效；旧 config.apiKey 字段被自然忽略（仍可作为 CI / 高级用户的 fallback） |

**开发期路径**：项目根不存在 `.env` 文件，`pnpm cli` 等 dev script 不再 `--env-file=.env`。开发者首次跑 `pnpm cli` 与最终用户一样——走首次引导写入 `~/.zhixing/credentials.json`，此后无差别。如开发者偏好用 env 注入（与 CI / vault 用户路径一致），自行在 shell 中 `export VAR=...` 后跑，并在 `~/.zhixing/config.json` 显式写 `apiKey: "env:VAR"` 走 fallback（§3.2.1 第 2 步），与主路径不冲突。

## 七、错误契约

| 场景 | 行为 |
|---|---|
| `config.json` schema 不合法 | 启动期抛 `ConfigSchemaError`，附字段路径与具体错误；建议跑 `zhixing` 触发引导重新初始化 |
| `credentials.json` schema 不合法 | 同上抛 `CredentialsSchemaError`——错误消息**不含密值**，仅引字段路径 |
| 必要字段缺失 + TTY | 不抛错——`checkBootstrap` 返回 missing 列表 → 触发向导 |
| 必要字段缺失 + 非 TTY | 启动失败，退出码 2，错误消息引文件路径与必要字段列表 |
| AI 工具触达 `credentials.json` | `bi-zhixing-credentials-block` 命中 → block，message + suggestion 返回给 AI |
| AI 工具触达 `config.json` 写 | `bi-zhixing-config-write` 命中 → confirm（bypassImmune），用户当面确认；不可"永远同意" |

**统一约束**：脱敏由 [`packages/core/src/security/env-sanitize.ts`](../../../packages/core/src/security/env-sanitize.ts) 串联——任何已读凭证值不进 logs / telemetry / 错误 stack / prompt。

## 八、测试要求

| 类型 | 覆盖 |
|---|---|
| 单元 | `loadCredentials` schema 校验各 case；`checkBootstrap` 必要字段缺失各组合；`resolveApiKey` 解析顺序（credentials.json 主路径 / config.apiKey fallback / 缺失抛错）；`bi-zhixing-credentials-block` 规则匹配 fixture（read / write / glob 各种工具调用） |
| 集成 | 临时 HOME 跑全链路：空 → CLI 启动期向导 → 写两份文件 → 重新加载 → providers / cli / channel 各自取凭证；`channel.feishu` setup 从 `credentials.channels.feishu` 取 `appSecret` |
| 安全 | 错误消息中**不含**任何 apiKey / secret 值（fuzz 含 `sk-` 前缀的输入，检查所有日志/错误路径输出）；`bi-zhixing-credentials-block` 经 `policy-engine` 与 `bi-zhixing-config-write` 共同命中时 block 优先 |
| E2E | CLI 在 cmd / PowerShell / Git Bash / WSL / macOS-Linux 各 shell 下从空状态跑通首次引导（CI 矩阵） |

## 九、不在范围内（Out of Scope）

- **OS keyring 集成**：归入"日后研究"
- **OS 文件权限收紧**（chmod 600 / Windows ACL）：归入"日后研究"
- **多机同步 / 云端身份**：远期方向
- **多 profile（个人 / 工作切换）**：明确不做
- **schema 版本迁移工具**：当前 version 固定为 1；未来需要时再加
- **OAuth 风格 provider 鉴权**（如 Anthropic 官方账号登录）：远期方向
- **`zhixing doctor` / `zhixing whoami` 等诊断命令**：复用本规格的 `checkBootstrap` 但 UX 独立，单独 spec

## 引用

- 决策：[ADR-008](../architecture/decisions/008-identity-bootstrap-layer.md)
- 协同 ADR：[ADR-002 Provider 架构](../architecture/decisions/002-provider-architecture.md) · [ADR-003 配置系统](../architecture/decisions/003-config-system.md) · [ADR-006 安全系统架构](../architecture/decisions/006-security-system-architecture.md)
- 协同 spec：[`secondary-llm-capability.md`](secondary-llm-capability.md)（LLM 双层抽象）· [`security-system.md`](security-system.md)（已有的策略引擎与 builtin 规则体系）
- 上下文：[`research/design/problems/identity-bootstrap-layer.md`](../problems/identity-bootstrap-layer.md)
