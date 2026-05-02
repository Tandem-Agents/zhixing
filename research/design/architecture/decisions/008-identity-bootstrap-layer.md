# ADR-008: 用户凭证存储与首次引导

> **状态**: 接受 | **日期**: 2026-05-01

## 背景

知行的产品定位是**个人助手**——多入口（CLI / server / 第三方通讯软件如飞书 / 未来扩展）共享同一个用户身份与凭证。当前实现存在三个相互关联的缺口：

1. **凭证默认路径不可靠**：`~/.zhixing/config.json` 模板里把 `"apiKey": "env:SILICONFLOW_API_KEY"` 当默认，依赖 shell 环境变量。但 cmd 与 PowerShell 的命令解析行为不同——cmd 默认查 cwd 命中项目根本地 shim（注入 `.env`），PowerShell 不查 cwd 命中全局 shim（不注入 `.env`），同一份配置在两个 shell 下行为分裂。
2. **凭证与公开配置物理混合**：apiKey、channel.appSecret 等敏感字段与服务商 id、模型选择、workspace 路径等公开字段混在 `config.json` 里。**AI 工具体系无法对单一文件做"读自由 / 写须确认 / 部分字段不可读"的细粒度区分**——要么全开 AI 读（含凭证）违反隔离，要么全锁（含非密配置）影响 AI 帮用户改配置。
3. **首次启动没有引导**：`packages/providers/src/config-loader.ts:122` 的 `ensureGlobalConfigTemplate` 在首次运行时写入带 `env:` 占位的模板；之后 `resolveLLMRoles` 在 env 不存在时直接抛错。**用户面对的是命令行错误，不是引导**。

这三个缺口的共性是"**用户级凭证作为一等架构**"未确立——凭证存哪、AI 怎么访问、缺失时怎么收集，没有正式架构定义。

## 决策

引入三条互相支撑的架构约束。**所有扩展点都落在已有体系内**：`@zhixing/providers` 加 credentials 加载、`@zhixing/core/security` 加一条 builtin 规则、`@zhixing/cli` 加首次引导。**不**新建包，**不**新建权限层概念，**不**新建 SecurityAction 类型。

### 决策 1：凭证与公开配置物理分离

`~/.zhixing/` 下两个文件，按"是否敏感"语义切分：

- **`config.json`**（已有，扩展使用）：服务商列表的非密元数据、LLM 角色（`llm.main` / `llm.secondary`）、workspace、agent、channel 公开字段（如 `appId`）、UI 偏好等
- **`credentials.json`**（新增）：所有敏感字段——provider apiKey、channel 各类 secret（appSecret 等），按 `<entity-type>.<id>.<field>` 索引，与 `config.json` 通过 id 关联

这是"已对齐产品方向 #2"（[`research/design/active-problem.md`](../../active-problem.md) 历史归档）的物理落地。

### 决策 2：AI 隔离凭证文件——复用现有安全体系，不新增机制

知行的安全体系（[ADR-006](006-security-system-architecture.md)）已有完整支撑：

- `SecurityRule.bypassImmune: true`（[`packages/core/src/security/types.ts:298`](../../../../packages/core/src/security/types.ts)）= 该规则不可被任何用户配置覆盖、不可被"永远同意"绕过
- `SuggestionMiddleware`（[`packages/core/src/security/security-pipeline.ts:196`](../../../../packages/core/src/security/security-pipeline.ts)）已经实现"匹配到 bypassImmune 规则时不建议自动放行"
- `bi-zhixing-config-write` 规则（[`packages/core/src/security/builtin-rules.ts:60-74`](../../../../packages/core/src/security/builtin-rules.ts)）已经把 `.zhixing/` 写操作设为 `confirm` + `bypassImmune: true`——AI 写 `config.json` 已经被覆盖

本 ADR 在此之上**仅新增一条 builtin 规则** `bi-zhixing-credentials-block`：path 匹配 `.zhixing/credentials.json`，access `any`（读写都拦），action `block`，`bypassImmune: true`。规则的 `message` + `suggestion` 字段承载 AI 引导文案（用户应自己编辑哪个文件、按什么 schema、填哪些字段）——AI 工具调用被拦时，error 中带这两段，AI **动态感知**到这是凭证文件、自然转向引导用户，不需要新的 `block-with-guidance` action 类型。

policy-engine 的 action 严格度排序（`block: 3 > confirm: 2 > audit: 1 > allow: 0`，[`policy-engine.ts:28-33`](../../../../packages/core/src/security/policy-engine.ts)）保证：当请求同时命中 `bi-zhixing-credentials-block` 和 `bi-zhixing-config-write`，block 优先，credentials.json 永不被 AI 触达。

### 决策 3：首次启动判定 = 必要字段是否齐全；缺失则程序级向导

- **判定**：纯函数 `checkBootstrap(config, credentials) → MissingField[]`，输入两份文件的当前状态，输出缺失字段列表。"必要字段"指**没有它就无法进入正常使用**的字段——主 LLM 的 provider/model（在 `config.llm.main` 里）+ 该 provider 的 apiKey（在 `credentials.providers[id].apiKey` 里）。可选字段（secondary 角色、workspace 自定义、channel 等）缺失不触发引导。
- **判定时机**：CLI / server / channel 各自启动时，在初始化 LLM provider 之前。
- **引导**：缺失 + stdin 是 TTY → CLI 启动期同步运行**程序级向导**（不依赖任何 LLM——首次使用时连 LLM 都还没起来，引导路径不能依赖 AI）；缺失 + 非 TTY → fail-fast 报错，引用文件位置和 schema 让用户在交互终端跑 `zhixing` 完成首次配置。
- **server / channel 入口**：检测到必要字段缺失时**拒绝启动**，错误信息要求用户先在 CLI 完成首次引导。引导本身不内联——daemon / 远程消息流没 TTY。
- **解耦**：检测层是纯函数（`@zhixing/providers`）；引导逻辑层是流程编排，依赖一个抽象的 `BootstrapInteraction` 接口；交互实现是 CLI 的 readline 适配。三层独立，方便未来替换或加新入口。

## 依据

- **产品方向**：13 条 Phase 1+2 已对齐结果，详见 [`research/design/problems/identity-bootstrap-layer.md`](../../problems/identity-bootstrap-layer.md)
- **现有架构对齐**：
  - [ADR-002 Provider 架构](002-provider-architecture.md)：apiKey 解析的 `env:` / `helper:` / plaintext 三种凭证前缀**全部删除**——凭证唯一入口是 `~/.zhixing/credentials.json` plaintext。配置文件不暴露任何"存储后端"语法（贯彻 problems Phase 1 第 5 条"不留两条路并行的脏代码"）
  - [ADR-003 配置系统](003-config-system.md)：3 层配置级联在公开配置维度沿用；私密配置**不参与级联**（用户级单一来源，避免项目级泄漏到 git）
  - [ADR-006 安全系统架构](006-security-system-architecture.md)：复用 `bypassImmune` 与 builtin 规则机制
  - [`secondary-llm-capability.md`](../../specifications/secondary-llm-capability.md)：LLM 双层抽象（Layer 1 库 + Layer 2 角色）已实现，本 ADR 仅引用

## 考虑过的替代方案

### 方案 A：保留 `env:VAR_NAME` 作为默认凭证路径（现状）

- **未采用**：现状已知 PowerShell 与 cmd 行为分裂，且发布到 npm 后用户机器既无项目目录也无 `.env`，全 shell 跑不通

### 方案 B：引入 OS keyring（操作系统密码管理器）作为存储后端

- **未采用**：增加一层概念 + 多分支（headless Linux 无 DBus 时如何 fallback），违背"清晰、明确、不堆选项"。文件 + builtin 规则隔离已经达到产品需要的安全基线

### 方案 C：单文件混合密非密配置

- **未采用**：物理隔离才能让 AI 工具体系做"读自由 / 写须确认 / 部分字段完全不可读"的细粒度区分。共用一个文件无解

### 方案 D：新建 `@zhixing/identity` 独立包承载身份核心

- **未采用**：现有 monorepo 边界已经能装下所有功能（凭证加载在 providers、规则在 core/security、向导在 cli）。新包没有独立价值，反而引入新依赖关系

### 方案 E：引入新 SecurityAction 类型 `block-with-guidance`

- **未采用**：现有 `SecurityRule` 已有 `message` 和 `suggestion` 字段，承载引导文案足够。新 action 会扩散到 policy-engine、auditor、pipeline final result、UI 渲染等多处分支

### 方案 F：引入新工具 `update_config` 让 AI 改 config 必经此工具

- **未采用**：`bi-zhixing-config-write` 是 path-based 规则，AI 用通用 `fs-write` 写 `~/.zhixing/config.json` 已被自动拦截。新工具是冗余抽象

## 影响

### 积极

- 多入口（CLI / server / 飞书 / 未来扩展）共享同一份凭证存储，路径无关
- 任何 shell / 任何 cwd 跑 `zhixing` 都成功（PowerShell 故障的根因消除）
- 凭证物理隔离 AI，AI 改公开配置自动经现有 `bypassImmune` 确认流程
- 全部扩展点落在现有体系内——不新增包、不新增架构概念
- channel 的 appSecret 也按同模式分离，避免后续债务

### 代价

- 新增 `~/.zhixing/credentials.json` 一份文件 + 一份 schema + 一份 loader
- 新增 `bi-zhixing-credentials-block` 一条 builtin rule
- 新增 `checkBootstrap` 一段纯函数 + CLI 启动期向导
- 移除项目根 `zhixing.cmd` / `zhixing` shim 与 dev 团队习惯调整（dev 通过 `pnpm cli` 启动，凭证写入 `~/.zhixing/credentials.json` 与生产路径完全一致；CI / Vault 用户的凭证注入是启动脚本责任，由用户自己生成 credentials.json，不在知行接口表面）
- 改 `~/.zhixing/config.json` 模板：移除 `apiKey: "env:..."` 占位
- 移除 `presets[id].envKey` 字段及其相关代码——不保留为元数据。预设仅含服务商技术配置（`baseUrl` / `protocol` / `defaultModel` / `quirks`）；`apiKey: "env:VAR"` 中的 env 名由用户自己决定，知行不预设特定 env 命名约定

### 约束

- 任何代码路径**不允许**直接读 `~/.zhixing/credentials.json`——必须经 `@zhixing/providers` 暴露的 credentials 加载接口
- 任何敏感字段（apiKey / appSecret / token / password 等）**不允许**进 `config.json` schema——由启动期 `validateConfigSemantics`（可插拔 `ConfigValidator` 层）fail-fast 拒绝；若新 channel / 集成有秘密字段，写到 `credentials.json` 的对应段
- `ProviderConfig.apiKey` 字段从 schema 删除；`parseApiKeyValue` 三合一函数删除——`config.json` 不接受任何形态的凭证（明文 / `env:VAR` / `helper:CMD`）
- 项目根**不存在** `.env` 文件；`dist/` 与 dev script（如 `pnpm cli` / `pnpm serve`）都**不依赖** `--env-file` 或 `.env` 注入。CI / Vault 用户的凭证注入由启动脚本（用户/运维侧）生成 `credentials.json`，知行只读 plaintext

## 相关决策

- **依赖**：[ADR-002](002-provider-architecture.md) · [ADR-003](003-config-system.md) · [ADR-005](005-cli-architecture.md) · [ADR-006](006-security-system-architecture.md)
- **不在本 ADR 范围**：实现细节（schema 字段、loader API、wizard 步骤、规则 `message` 文案、迁移顺序等）下放到 [`specifications/credentials-and-onboarding.md`](../../specifications/credentials-and-onboarding.md)

## 引用

- 触发与对齐过程：[`research/design/problems/identity-bootstrap-layer.md`](../../problems/identity-bootstrap-layer.md)
- 实现规格：[`specifications/credentials-and-onboarding.md`](../../specifications/credentials-and-onboarding.md)
