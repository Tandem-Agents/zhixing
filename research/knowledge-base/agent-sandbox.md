# 智能体沙箱

沙箱是由操作系统或隔离运行时强制执行的权限边界，规定智能体可以访问哪些文件、网络和系统资源，使模型出错或遭遇恶意输入时也不能越权影响宿主系统。

沙箱是把智能体执行的命令、代码和工具操作限制在隔离环境与明确权限内的安全边界，使模型出错或遭遇恶意输入时也不能越权影响宿主系统。

## 知行现状

知行当前尚未实现操作系统、容器或虚拟机强制执行的沙箱：主 Agent 和子 Agent 的工具调用会先经过策略与路径检查、AI 和人工审批，以及应用层的超时、输出和频率守卫，但获准后的 Bash、ripgrep、stdio MCP 子进程仍以知行进程的用户权限直接启动，内置文件工具也直接操作宿主文件系统；OS 加固和 Docker 隔离仍属 Phase 3 规划。

## 本地工作区沙箱

本地 Codex 使用操作系统原生机制约束智能体进程，允许它直接操作授权工作区中的真实文件，同时阻止未授权访问。

```text
真实电脑
├── 已授权工作区              ← 允许读写，修改直接写入真实文件
├── 其他指定目录              ← 可能只读
├── 系统目录                  ← 禁止修改
├── 用户凭据目录              ← 禁止访问
└── 网络                      ← 默认禁止或需要确认
```

这相当于在真实电脑上划定一块有门禁的工作区域：智能体可以直接使用区域内的文件，但不能越过边界。

- 工作区内的读写直接作用于用户的真实文件。
- 工作区外的访问由权限策略拒绝或限制为只读。
- 网络访问、外部程序和扩大权限等操作可以要求用户确认。
- Git、包管理器、测试程序等子进程继承相同边界。

## 沙箱与权限审批

沙箱定义智能体默认不能越过的技术边界；权限审批决定用户是否允许某个具体操作临时跨越该边界。一次授权只放行对应操作，不会取消其他沙箱限制。

这种分工让智能体可以自主完成工作区内的日常任务，同时在访问更高风险资源前停下来取得用户授权。

以本地编码任务为例：

- 已授权工作区中的修改直接写入用户电脑上的真实文件。
- 写工作区以外的目录会被系统阻止。
- 访问网络、启动某些外部程序或扩大权限，需要另行批准。
- 子进程、Git、包管理器和测试命令也继承同样的限制。

需要“出沙箱”时也不是沙箱失效，而是一次明确的权限升级：系统说明要做什么，用户批准后才允许这个具体动作。类似 Windows 普通权限与管理员确认——偶尔允许管理员操作，不代表日常权限隔离没有价值。

确实还有另一类沙箱会使用容器、虚拟机、临时文件系统或文件副本，但那只是沙箱的一种实现，不是“沙箱”这个概念的必要条件。Codex 官方说明也是：沙箱规定智能体能修改哪些文件、能否访问网络，并由不同操作系统的原生机制强制执行。[官方 OpenAI 文档](https://learn.chatgpt.com/docs/sandboxing)

## 调研项目速览

- [OpenAI Codex](./openai-codex-architecture-research.md)：默认以 `workspace-write` 运行，并把整棵命令进程树交给平台原生 OS 沙箱——macOS Seatbelt、Linux/WSL2 bubblewrap；Windows 优先使用低权限专用账户、防火墙和私有桌面，提权安装不可用时明确降级为 restricted token + ACL——审批只处理明确扩权。
- [OpenClaw](./openclaw-architecture-research.md)：沙箱默认关闭；启用后的默认基线是每个 Agent 一个 Docker 工具沙箱，默认不挂载工作区、无网络、只读根文件系统、移除 capabilities 并启用 `no-new-privileges`，Gateway 与原生插件仍留在宿主。
- [OpenCode](./opencode-architecture-research.md)：没有 OS/容器沙箱；内置工具受 `allow`、`ask`、`deny` 与外部目录规则约束，但 Shell 仍拥有宿主用户的文件、进程和网络权限，命令参数路径只有尽力而为的告警。
- [Pi](./pi-agent-harness-architecture-research.md)：默认以宿主用户完整权限运行；官方 SRT 示例只包住 Bash，Gondolin 扩展把全部内置文件/Shell 工具送入本地 QEMU microVM，整进程 Docker/OpenShell 外部包裹才覆盖全部代码路径。
- [Hermes Agent](./hermes-agent-architecture-research.md)：默认本机后端不隔离；非本机终端后端只隔离 Shell/文件工具，整进程 Docker/OpenShell 外部包裹才会让代码执行、MCP、插件、Hook 与 Skill 共享同一 OS 边界。
- [DeepSeek Harness](./deepseek-harness-architecture-research.md)：TUI/Web 默认采用 `workspace-write + ask`，Bash/PowerShell/PTY 与文件变更共享 fail-closed 文件策略，Linux 使用 bubblewrap 并以 Landlock 作为降级后端、macOS 使用 Seatbelt、Windows 使用 restricted-token ACL 且明确报告为 partial；网络和进程可见性不在该沙箱合同内。

## 常见实现

智能体沙箱可以由操作系统原生访问控制、容器、虚拟机或临时文件系统实现。实现方式不同，但共同合同都是限制智能体的可见资源和可产生的效果。

Codex 会按操作系统采用相应的原生强制机制，并让内置文件操作及其启动的命令共享同一权限边界。参见[官方 OpenAI 文档](https://learn.chatgpt.com/docs/sandboxing)。

## 业界前沿

当前最先进的实践不是押注单一容器，而是把四件事做成同一合同：**受信控制面与不可信执行面分离、整棵进程树和所有文件工具共享一个执行世界、网络与凭据由宿主代理、审批只签发最小临时能力**。

- 轻量本地路线以 OS 原生进程沙箱为主：Anthropic Sandbox Runtime 已把 macOS Seatbelt、Linux bubblewrap/namespace/seccomp、Windows 专用低权限账户/restricted token/Job Object/WFP/ACL 封装成跨平台 Node 运行时，省去镜像拉取和 VM 启动，但仍是 Beta，Windows 仍为 Alpha。
- 高隔离路线以容器或 microVM 为执行面：NVIDIA OpenShell 已统一 Docker、Podman、microVM 与 Kubernetes，并把文件、网络、进程、模型调用和凭据代理纳入声明式策略；它更适合不可信仓库、第三方代码和远程执行，不适合作为个人助手所有本机动作的唯一默认形态。
- Microsoft MXC 正在用统一 TypeScript SDK 装配 Windows ProcessContainer、Windows Sandbox、Linux bubblewrap/LXC 和 macOS Seatbelt，是值得跟踪的前沿方向；但其官方仍明确声明为 early preview，现有 profile 不得当作安全边界，当前不能成为知行的生产基座。
- 成熟产品会明确报告 `full`、`partial` 或不可用并 fail closed，不会在平台能力不足时静默退化到宿主权限。

## 知行目标方案

最优方案是“**原生轻量默认层 + 高风险强隔离层**”：

1. Agent Loop、权限审批、凭据、用户设备与渠道操作留在受信宿主控制面。
2. 建立独立 sandbox worker，把 Bash 及其后代、Read/Write/Edit/Glob/Grep、stdio MCP 和其他不可信代码全部迁入同一执行世界；任何入口不能旁路。
3. 默认层采用平台原生 OS 强制：macOS Seatbelt；Linux bubblewrap + PID/user/mount/network namespace + seccomp；Windows 专用低权限账户 + restricted token + Job Object + WFP + ACL + 私有桌面。worker 按会话保温，避免每次工具调用重新启动。
4. 工作区与专用临时目录按需开放，宿主其他文件默认不可读写；网络默认拒绝，只能经宿主 egress broker 按域名、端口和协议放行；模型、MCP 与平台凭据永不进入 worker。
5. 用户批准跨界时签发一次性、短时、资源精确的 capability；宿主 broker 执行本机动作，沙箱本身仍保持有效。
6. 不可信依赖、未知仓库和高风险任务切换到 OpenShell 管理的容器/microVM 后端；普通本机助手不承担其启动、同步和兼容成本。

实现上应由知行自己的 `SandboxBackend` 合同拥有语义；可固定版本并审计 Anthropic Sandbox Runtime 作为首个原生适配器，不能把其 Beta/Windows Alpha 状态直接当作知行已经获得生产级安全保证。OpenShell 适合作为第二个高隔离后端，不应自行重造 Firecracker 控制平面。

## 主要资料

- [OpenAI Codex Sandbox](https://developers.openai.com/codex/sandboxing)
- [OpenClaw Sandboxing](https://github.com/openclaw/openclaw/blob/main/docs/gateway/sandboxing.md)
- [OpenCode Permissions](https://opencode.ai/v2/docs/permissions)
- [Pi Containerization](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/containerization.md)
- [Hermes Agent Security Policy](https://github.com/NousResearch/hermes-agent/blob/main/SECURITY.md)
- [DeepSeek Harness Process Sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/sandbox.md)
- [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime)
- [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)
- [Microsoft MXC](https://github.com/microsoft/mxc)
