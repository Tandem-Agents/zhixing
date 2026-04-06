# ADR-001: Monorepo 项目结构

> **状态**: 接受 | **日期**: 2026-04-06

## 背景

知行是一个智能体产品，由多个独立但相关的部分组成：核心引擎、LLM 接入层、工具集、CLI、网关、Web UI、通道适配等。需要决定如何组织这些代码。

## 决策

采用 **pnpm workspace monorepo**，所有代码在同一仓库（`zhixing`）中管理，按 `packages/`、`apps/`、`extensions/` 分类：

```
zhixing/
├── packages/                        ← 可独立使用的库（发布到 npm）
│   ├── core/                        ← @zhixing/core
│   │   引擎核心：Agent Loop、事件系统、工具管线、上下文引擎
│   │   别人可以 pnpm add @zhixing/core 造自己的智能体
│   │
│   ├── provider-anthropic/          ← @zhixing/provider-anthropic
│   ├── provider-openai/             ← @zhixing/provider-openai
│   │   LLM 接入层，每个厂商一个包
│   │
│   ├── tools-builtin/               ← @zhixing/tools-builtin
│   │   内置工具：读文件、写文件、执行命令、搜索等
│   │
│   └── cli/                         ← @zhixing/cli
│       命令行客户端，像 Claude Code 那样在终端里用
│
├── apps/                            ← 可部署运行的应用（不发布到 npm）
│   ├── agent/                       ← 完整的智能体服务（独立部署）
│   │   把 core + providers + tools + 网关 + 通道 组装起来
│   │   这就是"知行"本体，类比 OpenClaw 本身
│   │
│   └── web/                         ← 网页客户端（连接到 agent 服务）
│       浏览器里的对话界面，通过 WebSocket 连智能体
│
├── extensions/                      ← 可选的扩展
│   ├── channel-wechat/              ← 微信通道适配
│   └── channel-dingtalk/            ← 钉钉通道适配
│
└── research/                        ← 研究文档（不发布）
```

### 各部分角色

| 部分 | 是什么 | 是否发布到 npm | 类比 |
|------|--------|--------------|------|
| `packages/core` | 引擎，别人能拿去用的库 | 是 | 发动机，可以卖给其他车厂 |
| `packages/provider-*` | LLM 连接器 | 是 | 不同型号的油管 |
| `packages/tools-*` | 工具集 | 是 | 车载工具箱 |
| `packages/cli` | 终端客户端 | 是 | 一种操控方式（终端） |
| `apps/agent` | 完整的智能体服务 | 否（自行部署） | 组装好的整车 |
| `apps/web` | 网页客户端 | 否（自行部署） | 另一种操控方式（浏览器） |
| `extensions/channel-*` | 通道适配 | 可选 | 通信天线 |

### `packages/` vs `apps/` vs `extensions/` 的区分标准

- **packages/** = 可以发布到 npm 的**库**，别人 `pnpm add @zhixing/xxx` 就能用
- **apps/** = 我们自己部署运行的**应用**，不发布到 npm，但源码公开，别人可以 clone 后自己部署
- **extensions/** = 可选的扩展模块，对接特定第三方服务，按需安装

## 依据

- 基于源码分析: OpenClaw 使用相同的 pnpm monorepo 模式，[架构概述](../../source-analysis/openclaw/architecture-overview.md)
- 基于竞品对比: Next.js、Vue、Babel、TypeScript 本身都采用 monorepo
- 基于认知研究: [q01-核心智能框架](../../_private/questions/q01-core-intelligence-framework.md) 确认了自研核心循环的必要性，核心引擎需要作为独立包存在

## 考虑过的替代方案

### 方案 A: 单体包（所有代码一个 package.json）

- 优势: 最简单，无需处理包间依赖
- 劣势: 别人只想用核心引擎，必须安装整个项目（含 CLI、Web UI 等无关依赖）；无法独立发版
- 未采用原因: 无法满足"核心引擎可独立复用"的需求

### 方案 B: 多仓库（每个包一个 GitHub 仓库）

- 优势: 包之间完全隔离，独立 CI/CD
- 劣势: 改一个核心类型要跨多个仓库改，版本对齐困难，PR 和 Issue 分散
- 未采用原因: 开发效率太低，尤其在项目早期快速迭代阶段

## 影响

- **积极影响**: 改一处全部立刻生效；一个 PR 覆盖所有相关改动；各包可独立发版；研究文档与代码同仓，决策可追溯
- **消极影响/代价**: monorepo 工具链有学习成本（pnpm workspace）；CI 配置稍复杂
- **约束**: 所有包必须使用统一的 TypeScript 配置（`tsconfig.base.json`）和构建工具链

## 相关决策

- 依赖: 无（这是基础性决策）
- 被依赖: 后续所有包的创建都遵循此结构
