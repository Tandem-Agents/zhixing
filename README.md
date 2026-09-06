# 知行（Zhixing）

> 知而后行，行而后知。知行是运行在你自己设备上的个人智能体，既能对话，也能在明确边界内执行真实任务。

[English](./README.en.md) · [文档导航](./docs/README.md)

> 发布状态：首个公开版本正在准备中；下列 npm 安装命令仅适用于包正式发布后。

## 适合做什么

- 延续可恢复的日常对话，并在不同工作场景中保持清晰上下文。
- 在信任与权限策略允许的范围内读写文件、搜索内容、运行命令和完成多步骤任务。
- 管理工作场景、任务清单和日程，并支持多视角分析与子任务编排。
- 使用技能（Skills）、接入经过配置的 MCP 服务，以及可选的飞书和设备协作能力。

## 支持环境

首个公开版本正式支持：

- Windows 10/11 x64
- Node.js `>=24.0.0`
- npm 全局安装

其他操作系统、CPU 架构和包管理器尚不在首发支持范围内。

## 快速开始

### 1. 安装

发布后，在 PowerShell 中运行：

```powershell
npm install -g @zhixing/cli
zz --version
```

不要使用 `sudo npm` 或通过放宽系统目录权限来安装。若 npm 全局目录不可写，请按 Node.js 官方方式配置用户级安装环境。

### 2. 在单独的试用目录中首次启动

知行依次使用运行时明确指定的工作区、配置中的 `workspace.root`，或在交互模式下回退到当前目录。普通工作目录不是沙箱，不能阻止工具访问其他路径。首次试用可以从单独目录启动；若已有工作区配置，请先确认实际目标目录：

```powershell
New-Item -ItemType Directory -Force .\zhixing-first-task | Out-Null
Set-Location .\zhixing-first-task
zz
```

首次交互式启动会在配置不完整时打开配置编辑器。完成最小可运行配置需要：

- 主模型的 Provider 和模型名；
- 对应 Provider 的 API key；
- 接受并保存配置。

公开配置默认位于 `%USERPROFILE%\.zhixing\config.jsonc`；设置 `ZHIXING_HOME` 可以改变知行的数据根目录。API key 由设备本地 SecretStore 保存，不应写进 `config.jsonc`、提示词、仓库、Issue 或日志。消息通道和 MCP 都是可选项，不阻断基础对话就绪。之后可在 REPL 中使用 `/config` 和 `/mcp` 修改配置。

### 3. 完成第一个真实任务

进入 REPL 后发送：

```text
请只在当前工作目录创建 zhixing-check.txt，写入“知行已完成首次任务”，然后重新读取文件并告诉我内容。不要修改其他文件。
```

知行会按当前信任与权限策略直接放行、拒绝或请求确认。出现确认请求时，先核对目标路径和操作再批准。退出 REPL 后可在同一 PowerShell 中核验：

```powershell
Get-Content .\zhixing-check.txt
```

这个任务会调用你配置的模型 Provider，可能产生网络请求与费用，并受该 Provider 的数据政策约束。

## 继续对话与管理工作

直接运行 `zz` 会进入默认 REPL：存在可恢复的主会话时恢复最近一段，否则创建新会话。常用命令包括：

| 目的 | REPL 命令 |
| --- | --- |
| 新建、恢复、命名或清空会话 | `/new`、`/resume`、`/name`、`/clear` |
| 查看状态、模型、用量和上下文 | `/status`、`/model`、`/usage`、`/context` |
| 管理工作场景和任务 | `/work`、`/tasks` |
| 管理配置、MCP、信任与安全 | `/config`、`/mcp`、`/trust`、`/security` |
| 查看可用 Skill | `/skills` |
| 压缩当前上下文或退出 | `/compact`、`/exit` |

设备级诊断和维护使用 `zz status`、`zz doctor`、`zz stop`、`zz app`、`zz pair`、`zz device`、`zz duty`、`zz backup` 和 `zz workspace`。完整参数以 `zz help` 和 [CLI 使用说明](./packages/cli/README.md) 为准。

## 数据、网络和执行边界

- 知行的运行时与本机状态存放在你的设备上，但这不表示所有数据永不离开设备。提示词、上下文和工具结果会按任务需要发送给你配置的模型 Provider。
- MCP、消息通道和网络工具会连接相应的外部服务；各服务的权限、费用、保留和隐私政策分别适用。
- 文件和命令工具会产生真实效果。知行具有信任、权限与确认边界，但当前不应被视为操作系统级强隔离沙箱。权限策略允许的操作可能直接执行；出现确认请求时，请检查路径和动作后再批准。
- `zz doctor` 是只读、离线诊断入口，不应打印秘密或内部敏感路径。公开求助时也不要粘贴 API key、SecretStore、私有文件内容或未审查的完整日志。

## 诊断、更新和卸载

检查当前状态与本机环境：

```powershell
zz status
zz doctor
```

同版修复时，先取得当前明确版本，再按该版本重新安装：

```powershell
$ZhixingVersion = zz --version
zz stop --maintenance
npm install -g "@zhixing/cli@$ZhixingVersion"
zz
```

主动前向升级时，在安全停止后安装目标新版；安装最新版本的命令是：

```powershell
zz stop --maintenance
npm install -g @zhixing/cli@latest
zz
```

也可以把 `latest` 替换为已经选定的明确新版号。知行不会在后台自动替换程序；运行新版本后不支持降级。卸载程序但保留全部用户数据：

```powershell
zz app remove
npm uninstall -g @zhixing/cli
```

永久移除当前设备及其本机数据是独立且破坏性的操作：`zz device remove --permanent`。不要把它当作普通卸载。完整流程见[安装、维护与发布指南](./research/design/modules/distributed-runtime/release-and-maintenance-guide.md)。

## 当前限制

- 首发只正式支持 Windows 10/11 x64 和 Node.js 24 及以上版本。
- 没有后台自动更新，也不支持安装新版本后的降级。
- 技能（Skills）和 MCP 已是正式能力，但当前没有宣称“无限插件平台”；未发布的长期记忆等未来能力不属于首发合同。
- 强隔离、外部服务可用性、模型质量和 Provider 费用不由知行单独保证。

## 仓库与文档

```text
packages/   生产代码包
docs/       用户与交付文档入口
research/   架构、设计与研究
scripts/    构建、验证与发布脚本
```

- [文档导航](./docs/README.md)
- [CLI 使用说明](./packages/cli/README.md)
- [架构概览](./research/design/architecture/overview.md)
- [首个公开版本交付计划](./docs/delivery/first-public-release.md)
- [0.1.0 发布说明](./docs/delivery/releases/0.1.0.md)
- [验证手册](./research/design/workbench/verification-runbook.md)
- [贡献指南](./CONTRIBUTING.md)
- [行为准则](./CODE_OF_CONDUCT.md)
- [安全政策](./SECURITY.md)
- [缺陷与需求反馈](https://github.com/Tandem-Agents/zhixing/issues)

疑似安全漏洞请勿在公开 Issue 中披露细节。当前私密报告渠道与支持版本状态以[安全政策](./SECURITY.md)为准。

## 许可证

[MIT](./LICENSE)
