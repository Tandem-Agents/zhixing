# 仓库组织与包边界

## 选择与理由

知行采用 pnpm workspace 单仓多包：核心引擎应能独立复用，不要求复用者安装完整产品；相关包又需要在一次变更中协调合同、实现与验证。代码与设计材料同仓，便于追溯决策。

| 组织方式 | 收益 | 代价与取舍 |
|---|---|---|
| 单体包 | 工具链最简单，无包间版本协调 | 核心与 CLI 等产品依赖捆绑，不符合独立复用目标 |
| 多仓库 | 仓库与 CI 可独立管理 | 跨包合同变更需要跨仓协调，版本及评审分散，不适合当前协同迭代 |
| 单仓多包 | 保留包入口，一次评审可覆盖跨包修改 | 仍须维护依赖、构建顺序及发布一致性；统一仓库不会自动消除边界成本 |

包按真实职责划分，不为目录整齐预建包。包边界、进程边界和部署边界不是同一件事；可发布的包也不必是独立服务。具体运行责任以[架构总纲](../../research/design/architecture/overview.md)为准，本文件不另定义产品架构。

## 当前代码布局

[workspace 配置](../../pnpm-workspace.yaml)纳入 `packages/*`、`packages/channels/*` 和 `apps/*`。当前实际实现位于 packages；`apps/*` 只是匹配规则，不证明已有应用。旧 `apps/agent`、`apps/web`、`extensions/channel-*` 蓝图不作为现行目录要求。

| 位置 | 当前职责 |
|---|---|
| `packages/core` | 引擎、领域合同与基础能力；公开入口供其他包使用 |
| `packages/providers`、`tools-builtin`、`mcp`、`network`、`secrets` | 模型协议、工具、外部工具接入、网络出口及设备秘密等能力；Provider 并非按厂商各建一包 |
| `packages/owner-kernel`、`owner-services` | owner 内核与领域服务 |
| `packages/runtime-host`、`executor`、`mesh` | 运行装配、执行角色与设备网格 |
| `packages/orchestrator` | 编排与子 Agent 相关能力 |
| `packages/server`、`rpc`、`cli` | 宿主服务、RPC 投影及命令行入口；完整产品不依赖一个 `apps/agent` 目录 |
| `packages/channels/feishu` | 飞书接入，包名为 `@zhixing/channel-feishu`，不放在旧 extensions 蓝图中 |
| `packages/test-utils` | 内部测试基础设施，标记为 private，不作为公开产品包发布 |

根 package 为 private 的工作区协调入口。源码包的发布属性与公开入口由各自 `package.json` 决定，不以“位于 packages”推断全部公开。文档目录由[目录维护技能](../../.agents/skills/maintain-project-docs/SKILL.md)管理，不再用旧 ADR 将研究材料永久固定在 research。

## 构建与发布边界

各包继承[统一 TypeScript 基线](../../tsconfig.base.json)，按自身源码与输出配置扩展；当前包构建使用 tsup，必要的前置生成由包脚本承担。共享工具链不等于所有包的构建配置必须完全相同。

工作区包的公开 exports 指向 `dist` 产物，修改源码不代表消费者立即获得新实现。跨包开发需要构建受影响依赖；首次构建、后续验证及贡献流程见[贡献指南](../../CONTRIBUTING.md)。根 build 先检查版本一致性，再递归执行包构建。

独立复用不等于独立版本发布。当前[版本检查](../../scripts/release-version.mjs)以根版本为源核对 packages 内各包版本，[发布脚本](../../scripts/publish-npm.mjs)协调公开包及 CLI 的发布；存在发布配置不等于已经发布。交付要求以[公开版本交付文档](../delivery/first-public-release.md)为准。
