# 身份与引导层 — 问题对齐记录

> 触发于 2026-05-01 PowerShell 凭证加载故障。本文件是"对齐过程的脱过程版"——保留问题描述、各阶段对齐结果、设计落地引用，去掉对话原文。最终架构以下列文档为权威：
>
> - [ADR-008 身份与引导层](../architecture/decisions/008-identity-bootstrap-layer.md)
> - [identity-layer.md](../specifications/identity-layer.md)
> - [config-write-permission.md](../specifications/config-write-permission.md)
> - [bootstrap-wizard.md](../specifications/bootstrap-wizard.md)

## 问题描述

**现象**：项目目录下，cmd 跑 `zhixing` 正常进入 REPL；PowerShell（含 pwsh 7.6）跑 `zhixing` 报错 `Provider "siliconflow" 的 apiKey 引用了环境变量 SILICONFLOW_API_KEY，但该变量未设置`。

**直接原因**：项目同时存在两个 `zhixing` 入口——

1. 项目根本地 shim（`zhixing.cmd` / `zhixing`）：`node --env-file=.env packages/cli/dist/index.js`，会把 `.env` 注入 process.env
2. npm 全局 shim（pnpm 把 `@zhixing/cli` symlink 到 `packages/cli` 后产生）：直接 `node packages/cli/dist/index.js`，**不带** `--env-file`

cmd 默认先查当前目录，命中本地 shim → `.env` 注入 → 成功。
PowerShell 出于安全不查当前目录，直接走 PATH → 命中全局 shim → 环境变量空 → 失败。

**本质**：当前架构把"项目根 `.env`"当成了用户接口。`.env` 应该只是**开发者便利**——一旦 `npm i -g @zhixing/cli` 发布，用户机器既无项目目录也无 `.env`，全局 shim 在任何 shell 下都会重现 PowerShell 现在的错。PowerShell 故障只是这个错位的最早信号，根问题是**用户级凭证存储与首次引导路径**未设计。

## 解决方向（一句话）

把"用户接口"从项目根 `.env` 迁出到用户身份根 `~/.zhixing/`；开发者侧 `.env` + dev script 路径不变。**具体形态分阶段对齐**。

---

## Phase 1（schema 层）

### Q1：受众边界

是否仍按"严肃 CLI"档定位（同 Claude Code / OpenClaw / GitHub CLI / AWS CLI）？

- **A**：是。用户是装 CLI 的人，懂终端、懂 API key、能接受手动配置；不做面向非技术用户的图形引导
- **B**：否。需要纳入非技术用户路径（OAuth 登录、deep links、桌面引导）
- **C**：折中或其他

**助理倾向**：A。`npm i -g` 这个分发渠道天然过滤受众；非技术用户应留给"桌面应用 / 服务端"另开产品线，不是 CLI 本身的责任。

---

### Q2：配置文件 schema 是否暴露存储后端

用户跑完 `zhixing login siliconflow` 之后，`~/.zhixing/config.json` 里写不写 `"apiKey": "keyring:siliconflow"` 这种带**存储后端名字**的字符串？

- **A**：不写。resolve 自动按级联查（env → keyring → fallback → config plaintext），存储后端对配置层完全透明
- **B**：写。前缀显式（`keyring:` / `env:` / `helper:` / plaintext 四种），用户/CLI 自己写进 config
- **C**：折中。默认不写；只保留 `env:VAR` / `helper:cmd` / plaintext 三种**用户显式覆盖**的前缀

**助理倾向**：C。Claude Code 的 settings.json 里没有 `keychain:` 后端字符串——行业事实标准。**默认行为不入配置；显式覆盖才入。**

---

### Q3：multi-account / multi-profile 维度

同一 provider（如 SiliconFlow）允许多个账号（个人 / 工作）吗？schema 何时开口子？

- **A**：schema 现在就开（如 `<provider>#<account>`，account 默认 `default`）；UX 可后置
- **B**：先单 account，schema 不留位
- **C**：明确不支持，单一身份

**助理倾向**：A。OpenClaw 已有 Auth Profile 轮换、Claude Code 支持团队账号——同品类常见需求；schema 加一个可选 `#account` 后缀不增复杂度。

---

### Phase 1 对齐结果

1. **多入口共享身份核心**
   - 知行有多种使用方式：CLI、server、第三方通讯软件（如飞书），未来还会扩展
   - 但身份 / 凭证 / 配置 / 功能配置是**单一中心**，不绑定到任何具体入口
   - 含义：身份与凭证作为独立模块（不是 CLI 的子命令、不是 server 的特性），所有入口共享

2. **配置分两份，物理分离、逻辑关联**
   - **普通配置**（已有 `~/.zhixing/config.json`）：服务商、模型、功能开关、Agent 设置等
     - **AI 读** = 不需请求权限，直接读
     - **AI 写** = 必须经用户权限请求；**且这个请求不可被设为"永远同意"或跳过**——区别于其他权限请求（其他权限可一次确认后默许永远放行），配置写每次都要当面确认
   - **私密配置**（待定文件名，与上同目录）：密钥等敏感数据。**AI 完全不可访问**
   - 两份通过 provider id 关联（普通配置选了 siliconflow → 私密配置按这个 id 取 key）

3. **一个身份；多 provider 库 + 主 / 二级两层 LLM 角色**（两层独立的抽象）
   - 单一身份模型——不引入 multi-account / multi-profile 维度
   - **Layer 1（LLM 库 = 有哪些可用）**：
     - 用户 ↔ 服务商：1 对多
     - 服务商 ↔ 模型：1 对多
     - 服务商 ↔ key：1 对 1
     - 即一个用户可配 SiliconFlow / OpenAI / DeepSeek 等多个服务商，每家一个 key、提供多个模型；这是 LLM 的最底层，沿用现状
   - **Layer 2（LLM 角色 = 实际用什么）**：会话级共享的"角色"抽象，**独立于 Layer 1**。当前两个角色：
     - `llm.main`（必填）：主对话用
     - `llm.secondary`（可选）：用于 I/O 边界净化任务——上下文压缩 / WebFetch distill / 工具结果摘要 / 子 agent 返回压缩 / 通道入站分类等。**没配 secondary 时自动落到 main 上**（仍保留隔离价值，仅放弃任务专门化和 cost 优化）
     - 每个角色绑定一个 `(provider, model)`，从 Layer 1 中选——main 和 secondary 可同 provider 也可不同
   - **未来方向**（仅记录、当前不做）：角色层可能扩到 3 级——例如"高级模型用于复杂任务"+"主模型用于日常便宜大量调用"+"低级模型用于 WebFetch 整理等更便宜场景"。当前两级是事实，方向已定
   - 详见 spec [`secondary-llm-capability.md`](../specifications/secondary-llm-capability.md)

4. **位置：用户目录而非项目目录**
   - 用户身份相关的文件统一在 `~/.zhixing/`（Windows 下 `C:\Users\<user>\.zhixing\`）
   - 项目根 `.env` 仅由开发者的 `pnpm cli` 等 dev script 使用，**不再是用户接口**

5. **开发与生产环境对齐——彻底不保留 `env:VAR_NAME` 这种凭证前缀**
   - 不留"两条路并行"的脏代码
   - 开发期凭证也走 `~/.zhixing/`，与生产路径一致

6. **UX：交互式优先，拒绝命令行 `--flag`**
   - 用户使用方式是 `zhixing` / `zhixing server` 进入运行态，不是记忆一堆 `--flag`
   - 配置 / 凭证管理也走交互式（在 REPL 内或单独向导）

7. **设计原则**：清晰、明确、方便；不给用户"分支 A 还是 B"的选择题

---

## Phase 2（具体形态）

### Q4：AI 不能访问私密配置——靠什么保证？

私密配置是文件这件事已对齐。问题是"AI 不能读这个文件"在工程上怎么落实——

**助理看法**：靠**两层叠加**

- **第一层**（必须）：复用项目已有的安全模块（`packages/core/src/security/path-guard.ts` 那套），把 `~/.zhixing/credentials.json`（或其他名字的私密配置文件）加入**禁止读路径**——AI 想用 read / glob / grep 这类工具读它一律被拦
- **第二层**（必须）：操作系统层面文件权限收紧（POSIX chmod 600 / Windows ACL 仅本人）——防其他用户、防误同步到 OneDrive 等

**不引入 OS keyring**（操作系统密码管理器，如 Windows 凭据管理器、macOS Keychain、Linux libsecret）作为存储后端。理由：已经明确"配置文件方式"，引入 keyring 等于又多一层概念、又分一种运行环境。文件 + 安全模块禁路径 + OS 文件权限三件套已经够。

**对齐**：

- ✅ **第一层 path-guard** 思路确认；增加要求——**AI 在被拦时需要"动态感知"**：不是凭空回答"我访问不了"、也不是预先被提示，而是在实际尝试访问时**即时理解发生了什么**并自然转向引导用户。具体感知 / 转应对的机制留到 spec 阶段细化
- ⏸ **第二层 OS 文件权限** 暂缓——OpenClaw / Claude Code 都没做，谨慎引入；归入"日后研究"
- ❌ **OS keyring 不引入**

> **协作约定**：今后用专业词（如 OS keyring、path-guard）必加中文解释（如：OS keyring = 操作系统密码管理器；path-guard = 路径访问守卫），避免阻塞理解

---

### Q5：AI 改普通配置——边界在哪？

**助理草拟分级**：

- **AI 可直接改**（无需用户确认）：默认模型、Agent 显示名、UI 偏好等纯偏好类
- **AI 改前需用户确认**：默认 provider（换 LLM 提供方）、workspace.root（影响安全边界）、新增 provider（信任新外部服务）
- **AI 不能改**：私密配置（绝对不可访问）、安全规则

按这套分级，"AI 改配置"复用项目已有的安全确认 UX（ADR-006 那一套）——不需要额外设计。

**对齐**：

- **普通配置**：
  - **读** = 自由，不请求权限
  - **写** = **统一走权限请求，且该请求不可被设为"永远同意"或跳过**——区别于其他权限可一次确认后默许，配置写每次都要当面确认
- **私密配置**：完全不可读、不可写
  - 当用户想改私密配置时，AI **引导用户自己处理**（清晰告知文件位置 / 内容格式 / 要填什么）
- 实现：复用项目已有的安全 / 权限体系（ADR-006 那套），不另起炉灶

---

### Q6：用户从来没配过密钥时，第一次跑 `zhixing` 怎么办？

**助理草拟三种自然路径**：

- **A 进 REPL 之前拦截**：检测到没密钥 → 直接跑独立配置向导 → 完成后才进 REPL
- **B 直接进 REPL，AI 自己引导**：把配置当成第一次对话内容
- **C 进 REPL，但用 slash 命令**

**助理倾向 B**（基于"个人助手 = 助手主动引导"的定位）。

**对齐**：

- **关键事实**：第一次没凭证 = 没 LLM 可调 = **没 AI 在场**——引导路径不能依赖 AI
- **正确路径**：**zhixing 程序自身的交互式向导**（独立于任何 AI），在进入 REPL 之前完成
- 向导要做的：
  - 清晰告知：**文件位置**、**要填什么内容**、**需要做什么**
  - 给一个**示例**
  - 让用户只填**必要字段**（minimum required fields，必填字段），可选字段后续再补
- 这是**程序级**向导，不是工具级——AI 还没起来

---

### Phase 2 对齐结果

1. **私密配置访问控制**：路径在安全模块（path-guard）的禁止读名单里；AI 被拦时能"动态感知"并合理转应对（非硬编码"访问不了"），具体机制留 spec 阶段。**OS 文件权限暂不做**。
2. **AI 改普通配置一律须请求，且该请求不可设为"永远同意"或跳过**：读自由；写统一权限请求，**无例外字段、不能跳过**——区别于其他权限可一次确认后默许，配置写每次都要当面确认
3. **私密配置完全隔离**：不可读、不可写；用户需修改时 AI **引导**用户自己处理（位置、格式、要填什么）
4. **第一次启动的判定 = "必要字段是否齐全"，不是"文件是否存在"**
   - 配置文件在首次运行时自动创建（现状已是），所以"文件存不存在"不是判定依据
   - 真正的判定是**必要字段是否齐全**——例如主模型（main model）没填就没法运行 → 触发引导
   - 可选字段缺失不触发引导
5. **第一次启动的引导**：zhixing **程序级**交互式向导（**没有 AI 参与**）——清晰告知 / 给示例 / 只填必要字段
6. **引导交互的实现必须高度解耦**：功能设计与代码设计上都保持解耦，方便后续优化 / 替换 / 重构

---

## 设计落地

最终架构与执行规格：

- [ADR-008 用户凭证存储与首次引导](../architecture/decisions/008-identity-bootstrap-layer.md) —— 顶层架构决策
- [credentials-and-onboarding.md](../specifications/credentials-and-onboarding.md) —— 凭证文件契约 / 加载链 / AI 访问控制 / 必要字段检测 / 程序级向导
