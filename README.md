<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a>
</p>

<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="assets/brand/readme-hero-static.png">
  <img src="assets/brand/readme-hero.png" width="100%" alt="知行：不同地点的办公室电脑、户外手机和咖啡厅笔记本通过光流协作，服务同一个人。伴身智能愿景示意，非产品界面。">
</picture>

<h1 align="center">生活与工作中的个人助手</h1>

<p align="center">
  <a href="#开始使用">开始使用</a> · <a href="docs/README.md">文档</a> · <a href="docs/philosophy.md">产品哲学</a> · <a href="research/design/architecture/overview.md">架构</a> · <a href="assets/brand/readme-hero-static.png">静态图</a>
</p>

**知行（Zhixing）是可独立部署的通用个人智能体。** 它运行在你自己的设备上，从阅读资料、讨论想法，到整理计划、处理文件、编写代码和执行任务，服务于日常生活，也面向专业工作。

我们的方向是**伴身智能**：同一个知行在你的手机、电脑和服务器间协作，通过离你最近的设备与你交互，持续陪伴生活与工作。产品不依附于特定模型、界面或设备；技术为人的需要服务。

## 从一段讨论，到持续的工作

**一起想清楚。** 研究资料、比较方案、写作和分析；需要不同判断时，可以从多个视角推敲同一个问题。讨论本身就有价值，不必每次都变成执行任务。

**把事情做出来。** 读取、搜索、编辑文件，运行命令，处理数据或代码。复杂任务可以拆分、委派、跟踪；寻找办法和调用工具服务于你要的结果，而不是让你手工编排每一步。

**把工作接起来。** 保存与恢复对话，用“工作场景”组织不同工作的上下文与工作目录；按日程安排任务。独立对话也能互相读取和发消息，协作不必依靠你来回转述。

**用你自己的环境。** 从终端使用，也可接入飞书。自行选择模型服务，用 Skills 保存可复用的方法，通过 MCP 接入外部工具与服务；单设备即可完整运行，多设备协作按需启用。

例如，你可以带着自己的资料开始：

> “比较这几份旅行资料，按我的预算和时间安排一份行程草案，把还需要我决定的事情列出来。”

> “梳理这个项目的资料和代码，解释它如何运行，再把有依据的问题整理成清单。先不要修改文件。”

## 一心多身

知行不是把每个入口做成一套独立助手。**“一心”是共同的产品规则与可信状态，“多身”是不同的交互入口和运行设备。** 终端、飞书和设备协作，共同服务于同一个产品。

- **产品不绑模型。** 对话、工作场景、日程等能力有自己的规则；模型负责理解、推理与行动，不负责定义整个系统。
- **可靠性不靠模型自觉。** 状态持久化、权限、确认与恢复由系统承担；模型说“完成了”，不能替代真实执行结果。
- **扩展不拆散产品。** 模型、工具、消息通道与设备通过明确接口接入；更换实现，不必复制一套业务规则。

这让知行既能利用模型不断进步的能力，也能保持长期可维护的结构。进一步了解[产品哲学](docs/philosophy.md)与[架构设计](research/design/architecture/overview.md)。

## 开始使用

> [!IMPORTANT]
> **首个公开版本尚未发布，npm 包暂不可用。** 现在希望从源码运行，请先看[开发环境说明](CONTRIBUTING.md#development-environment)。以下为发布后的用户安装流程。

首发支持 **Windows 10/11 x64 · Node.js ≥ 24**。需要可用的模型服务与 API key；模型调用可能产生费用，并将请求内容发送给所选服务。

### 1. 安装

在 PowerShell 中运行：

```powershell
npm install -g @zhixing/cli
zz --version
```

### 2. 启动与配置

进入希望让知行工作的目录，再运行 `zz`（也可使用 `zhixing`）。初次体验可先建立一个单独目录：

```powershell
New-Item -ItemType Directory -Force .\zhixing-start | Out-Null
Set-Location .\zhixing-start
zz
```

缺少必要配置时，知行会打开配置编辑器。选择主模型的服务商与模型，填入 API key 并保存；飞书与 MCP 可稍后配置。凭据保存在设备本地 SecretStore，不应写进对话或公开配置。

工作目录以显式运行工作区或 `workspace.root` 配置为先，否则交互启动使用当前目录。单独目录便于试用，**不是沙箱**。

### 3. 完成第一件事

```text
请只在当前工作目录新建 hello-zhixing.txt，写入“你好，知行”，
再读回来核对。不要修改其他文件。
```

出现确认时先检查动作与路径，完成后可在该目录查看文件。接下来，用 `/new` 开始新对话、`/resume` 找回历史、`/work` 管理工作场景、`/skills` 查看技能。完整用法见 [CLI 指南](packages/cli/README.md)。

## 数据与边界

- **本地部署，不等于离线运行。** 运行状态保存在自己的设备上；提示词、上下文与工具结果可能发送给模型服务。MCP、飞书及网络工具也会连接相应外部服务。
- **执行会产生真实影响。** 工具受信任、权限与确认策略约束，但并非每次操作都弹出确认，也不提供操作系统级强隔离。请从你愿意交给它处理的资料与工作目录开始。
- **区分已有能力与长期方向。** 当前提供对话持久化与恢复，尚不具备长期记忆；伴身智能是长期方向，不是已经实现全天候、全场景陪伴的承诺。

运行状态用 `zz status` 查看，离线只读诊断用 `zz doctor`。更新、备份、卸载与数据保留见[安装与维护指南](research/design/modules/distributed-runtime/release-and-maintenance-guide.md)；当前版本边界见 [0.1.0 发布说明](docs/delivery/releases/0.1.0.md)。

## 一起把知行做好

欢迎带着真实的使用问题、改进建议或代码参与。我们关心的是生活与工作中是否真的更好用了。

[提交问题或建议](https://github.com/Tandem-Agents/zhixing/issues) · [贡献指南](CONTRIBUTING.md) · [行为准则](CODE_OF_CONDUCT.md) · [安全政策](SECURITY.md)

请勿公开凭据、私人资料或未经检查的日志；疑似漏洞按安全政策中的当前渠道处理，不在公开 Issue 披露细节。

---

<p align="center">
  知而后行，行而后知。<br>
  <a href="LICENSE">MIT License</a>
</p>
