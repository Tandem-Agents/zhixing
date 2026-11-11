# zhixing

> 知行（Zhixing）的安装包：运行在你自己设备上的通用个人智能体，服务生活与工作。

`zhixing` 是知行面向用户的 npm 包，安装后提供 `zz` 和 `zhixing` 两个等价命令。其余 `@zhixing-ai/*` 包是它使用的内部组件，不承诺作为独立 SDK 保持稳定。产品介绍见[知行主页](https://github.com/Tandem-Agents/zhixing#readme)（[English](https://github.com/Tandem-Agents/zhixing/blob/main/README.en.md)）。界面与命令帮助目前只有中文。

## 安装

准备：

- Node.js `>=24.0.0` 与 npm。
- 一个模型服务的 API Key。首次配置目前可以选择[硅基流动](https://cloud.siliconflow.cn/account/ak)或 [DeepSeek 官方](https://platform.deepseek.com/api_keys)。调用费用由服务商收取，你的请求和相关内容会发送给所选服务商。
- 支持的操作系统见[版本说明](https://github.com/Tandem-Agents/zhixing/blob/main/docs/delivery/releases/0.1.0.md)。

```text
npm install -g zhixing
zz
```

npm 安装这一步不会下载额外程序、注册服务或写入数据目录，也不修改 Node、npm、PATH 或系统权限。第一次运行 `zz` 时，知行才在交互与权限边界内创建配置、设备身份和托管服务。

全局目录不可写时只使用 Node 官方的用户级安装或修复方式；不要使用 `sudo npm`、放宽系统目录权限或修改知行以外的 npm 配置。知行不会后台替换程序，也不会修改用户 Node、npm 或 PATH。

## 首次配置

第一次在交互终端运行 `zz` 时，会打开配置界面，用 ↑↓ 选择、Enter 确认、Esc 返回：

- **对话模型（必填）**：选择服务商，添加模型 ID，填写 API Key。可用的模型 ID 见服务商的模型列表页，配置界面里有链接。轻量模型和强力模型可以不配。
- **消息通道（可选）**：如飞书，见下文“在消息通道中使用”。
- **MCP 服务（可选）**：接入外部工具，也可以以后用 `/mcp` 管理。

以后用 `/config` 检查和修改这些配置。非交互场景（管道、CI）如果还没完成首次配置，会以退出码 2 退出，需要先在交互终端完成一次配置。

配置分两处保存：

- 功能配置写在 `<ZHIXING_HOME>/config.jsonc`，默认是 `~/.zhixing/config.jsonc`，也可以用 `ZHIXING_CONFIG_PATH` 指定完整路径。文件支持 JSONC 注释。知行可以读取功能配置，修改需要你确认。
- API Key 等凭据只保存在本机的 SecretStore：桌面系统用系统凭据保护，无头设备用与机器绑定的加密保险库。`config.jsonc` 不接受任何凭据字段。凭据不会交给模型，也不会进入设备间同步、备份或迁移。

知行不读取启动目录下的项目级配置。

## 第一个任务

配置完成后进入对话。先直接提一个请求，例如“我下周要做一次季度汇报，帮我列出准备步骤，并按先后排好”。

要处理某个目录中的文件，先建立并授权工作场景：

1. 输入 `/work`，按 Ctrl+N 新建工作场景。
2. 描述用途和目录的完整路径，例如“整理 D:\Notes 里的读书笔记”。
3. 核对它给出的场景名称和目录。确认后，它会创建场景并授权这个目录。
4. 再次输入 `/work`，选中这个场景，按 Enter 进入。
5. 先让它只读查看，例如“列出这个目录顶层的文件和文件夹，先不要修改任何内容”。

在工作场景里，知行以授权目录为工作范围读写文件、搜索内容、执行命令；有实际影响的操作按信任与确认设置执行，这些设置不是操作系统级的沙箱。`/exit` 回到主对话。

## 交互命令

交互终端使用全屏界面：长对话可以滚动回看，窗口缩放后会重新排版，输入和提示区保持固定，不需要另装 UI 运行时。启动时会自动回到最近的对话。输入 `/` 可以看到候选命令，`/help` 列出全部命令。

通过管道重定向输入时，知行按行接收，使用基础文本对话，读完已有输入后退出。需要首次配置或交互确认时会明确提示，不会把后续管道内容当作授权。

| 分类 | 命令 | 作用 |
|---|---|---|
| 对话 | `/new` | 创建新对话 |
| | `/resume` | 切换到其他对话 |
| | `/name` | 为当前对话命名 |
| | `/clear` | 清空对话历史 |
| | `/compact` | 手动压缩上下文 |
| | `/context` · `/usage` · `/model` | 查看上下文容量、token 用量和当前模型 |
| 工作 | `/work` | 进入、新建（Ctrl+N）或改名（Ctrl+R）工作场景 |
| | `/exit` | 在工作场景中回到主对话；在主对话中关闭界面，后台继续运行 |
| | `/tasklist` · `/task` | 查看当前对话的任务列表；`/task new <内容>`、`/task done <序号或 id>` 管理任务 |
| | `/tasks` | 查看定时任务 |
| | `/advancement` | 查看当前对话的任务推进详情 |
| | `/resolve` | 处理结果待确认的运行 |
| 配置与扩展 | `/config` | 修改模型、消息通道、MCP 等基础配置；`/config logs` 查看或调整日志容量与保留期限 |
| | `/mcp` | 管理 MCP 服务 |
| | `/skills` | 管理技能：浏览、置顶、禁用、改适用模式、归档 |
| | `/trust` · `/security` | 管理权限规则；查看安全状态概览 |
| 运行 | `/status` · `/stop` | 查看运行状态；停止知行 |
| | `/help` | 显示帮助 |

在消息里输入 `@` 可以发起多视角评议（目前只支持文本内容）。

## 在消息通道中使用

消息通道按需接入。安装包已带飞书适配，接入的是飞书企业自建应用的机器人：

1. **在飞书开放平台准备应用**：创建企业自建应用并开启机器人能力；在事件订阅中选择[用长连接接收事件](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)，添加接收消息事件（`im.message.receive_v1`），开通所需的收发消息权限，完成应用发布与可用范围设置。用于群聊时，还需把机器人加入目标群。
2. **在知行中填写凭据**：运行 `/config`，在“消息通道”中添加飞书，填写应用的 App ID 和 App Secret。
3. **完成本人验证**：保存后，按配置面板显示的验证指令（形如“连接 <验证码>”），在飞书里把它发给机器人，再在同一会话中按收到的回复确认。验证通过后，即可在飞书里与知行对话。

普通消息通过长连接收发，不需要公网地址。上面的“连接／确认”用于验证账号与收发，不代表后续任务已获得执行授权。

如果要在飞书中处理任务执行时的权限确认，当前适配器通过卡片按钮接收你的决定，并使用 HTTP 回调接收按钮动作，需要同时满足两个条件：

- 在“消息通道”中成对填写飞书应用的 Verification Token 和 Encrypt Key。只填其中一项会被视为配置错误。
- 有受控且飞书可达的 HTTPS 回调入口，将请求转发到知行的 `/channels/<通道实例 ID>/challenge`，并在飞书应用中登记这个入口。默认飞书实例的 ID 是 `feishu`。知行本机服务默认监听本机地址（127.0.0.1），这个地址不能直接作为飞书的公网回调地址；接入方式见[飞书回调接收说明](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/receive-and-handle-callbacks)中的开发者服务器方式。

未配置卡片按钮时，飞书内处理执行确认的方式尚未经过验证；不要假设回复“允许”或“yes”就会批准操作。

需要其他平台时，在对话中说明想连接哪个应用。知行负责查证接入方式、获取或准备连接；需要本人处理的账号授权和凭据录入会交给你，凭据仍通过 `/config` 的“消息通道”安全填写。完成本人和双向收发验证后才启用；平台没有开放接口、账号权限不足或无法可靠接入时，会说明限制与下一步。

飞书通道的能力边界见[飞书通道架构](https://github.com/Tandem-Agents/zhixing/blob/main/docs/modules/feishu/architecture.md)。

## 运行控制与诊断

- `zz status`：查看本机知行的运行状态。
- `zz stop`：请求安全停止，并等待同一进程退出。停止被拒绝、超时或无法安全受理时，它不会强制结束进程；按提示处理阻塞项后，可以重试同一命令。准备维护（如升级）前使用 `zz stop --maintenance`。
- `zz doctor`：只读检查本机配置、秘密存储、托管服务、备份配置和已建立连接的状态，每次只给一个安全的下一步行动。它不联网、不写状态，也不输出秘密。

## 本机运行日志

`zz logs` 显示本机运行日志的占用、生效策略与待回收状态；`zz logs location` 显示日志目录和格式说明。查询不依赖常驻服务，也不创建或修复日志文件：

```text
zz logs --offline search --source runtime
zz logs read "zxlog://<storeId>/operation/operation/<id>" --view timeline
zz logs policy
```

查询结果包含记录、缺口、覆盖范围和续页 `cursor`，把它传给同一查询的 `--cursor` 即可继续读取；`--view detail` 读取仍保留的脱敏详情。修改策略使用 `zz logs policy --revision <当前版本> --set '<JSON 对象>'`；降低额度时先回收空间，受阻时保留期望值并说明原因。

在对话中，可以用 `/config logs` 查看生效策略，再用 `/config logs <容量MiB> <关键记录天数> <当前版本>` 修改，例如 `/config logs 128 14 1` 把容量设为 128 MiB、关键记录保留 14 天；版本冲突时重新查看即可。修改不需要重启。也可以直接让知行查阅日志，它读取的是同一份记录。

日志不记录凭据、模型请求正文和逐 token 文本；工具调用成功只留安全摘要与长度，失败内容经限长脱敏保存，可能包含与错误相关的输入输出片段。存储结构、访问接口与权限边界见[运行日志与问题追溯](https://github.com/Tandem-Agents/zhixing/blob/main/docs/tasks/runtime-logging-and-diagnostics.md)。

## 多设备、恢复备份与本地工作区

这些命令承接必须在交互对话之外仍可完成的设备级旅程；具体参数以对应的 `--help` 为准：

| 旅程 | 入口 | 作用 |
|---|---|---|
| 第二台设备 | `zz pair [invitation]` | 一台设备显示二维码和同内容文本，另一台扫描或粘贴后继续恢复码回读、完成配置、确认可用并选择值班设备。正常流程不要求地址、端口、中继或内部角色知识。 |
| 永久设备移除 | `zz device list/remove/continue/status` | 查看候选，永久移除设备，并在中断后继续或查看同一操作。应用停用另用 `zz app remove`，两者不会混淆。 |
| 值班迁移 | `zz duty targets/migrate/continue/cancel` | 选择长期在线的接班设备，准备、继续或在切换前取消值班迁移。 |
| 恢复备份 | `zz backup setup/verify/status` | 建立恢复备份、从实际目标回读验证并查看唯一下一步行动。 |
| 灾难恢复 | `zz backup recover/recover-finish` | 值班设备永久丢失后，从完整备份接管，并在旧设备已隔离后完成恢复。 |
| 恢复码 | `zz backup root rotate/invalidate/approve-reset/reset` | 轮换、紧急停用或在另一台已加入设备协助下重置恢复码。 |
| 本地工作区 | `zz workspace status/list/create/create-scene/rename/repath/remove/reset` | 只在当前设备授权和维护本地目录；远端不接收原始路径。 |

## 升级与卸载

以下每一步都要等上一步成功后再执行。某一步失败或被拒绝时，先按提示处理，不要继续执行后面的命令。不要把多条命令一次性粘贴运行。

**同版修复**（按当前版本重新安装）：

1. 记下当前版本：

   ```text
   zz --version
   ```

2. 安全停止，准备维护：

   ```text
   zz stop --maintenance
   ```

3. 停止成功后，按第 1 步看到的版本重新安装（把 `<版本号>` 换成实际版本）：

   ```text
   npm install -g zhixing@<版本号>
   ```

4. 安装成功后启动：

   ```text
   zz
   ```

**升级到新版本**：步骤相同，第 3 步改为安装选定的新版本 `npm install -g zhixing@<新版本号>`；要安装最新版本，可以用 `zhixing@latest`。不支持在已运行新版本后降级。

**卸载但保留数据**（数据保留在 `ZHIXING_HOME`，默认是 `~/.zhixing`）：

1. 停用应用：

   ```text
   zz app remove
   ```

2. 看到停用成功后，再卸载：

   ```text
   npm uninstall -g zhixing
   ```

如果还有工作没有安全结束，`zz app remove` 会拒绝停用。这时按提示处理后重试，不要直接卸载。

## 故障排查

遇到问题，先运行 `zz doctor`，按它给出的下一步处理。

### 提示“本机服务端口 N 已被其他程序占用”

知行的本机服务端口由数据目录（`ZHIXING_HOME`）决定。本机服务启动失败时，如果这个端口正被其他程序使用，就会出现这个提示：关闭占用该端口的程序后重试。其他原因导致的启动失败，会提示用 `zz logs` 查看原因。

### 提示“[配置错误]”或“Provider … 缺少 API Key”

`config.jsonc` 含有旧版凭证字段（如 `providers.<id>.apiKey: "env:VAR"`）或通道秘密字段（如 `channels.<id>.credentials.appSecret`）时，启动检查会逐项列出违规字段、原因和修复方法。处理方式：

- 按提示在实际的 `config.jsonc` 中删除这些字段；
- 在交互终端运行 `zz`，在配置界面重新填写 API Key 或通道凭据，它们会写入本机 SecretStore；
- 无交互的宿主需要先在目标设备上完成 SecretStore 解锁和凭据配置，不接受明文文件或环境变量注入。

### 提示“缺少必要配置，且当前环境非交互终端”

通过管道或 CI 运行时，如果首次配置还没完成，知行会列出缺失项，并以退出码 2 退出。先在交互终端运行 `zz`，在配置界面补全“对话模型”，再回到原来的方式运行。

功能配置可以随时用 `/config` 检查和修改；凭据只能通过配置界面查看状态或更新，不提供明文读取入口。

仍未解决时，请到 [GitHub Issues](https://github.com/Tandem-Agents/zhixing/issues) 反馈，附上 `zz --version` 的输出和脱敏后的现象，不要附凭据或未经检查的完整日志。疑似安全漏洞请按[安全说明](https://github.com/Tandem-Agents/zhixing/blob/main/SECURITY.md)私下报告。

## 外部命令一览

<!-- public-top-level-commands:start -->
- `zz`：进入交互 REPL。
- `zz help`：显示当前公开命令。
- `zz status`：查看知行运行状态。
- `zz stop`：停止知行；显式维护前使用 `zz stop --maintenance`。
- `zz doctor`：只读检查本机运行、托管、配置和恢复状态。
- `zz logs`：查看本机运行日志、占用与保留策略，支持离线查阅。
- `zz app`：管理应用生命周期；`zz app remove` 安全停用并准备 npm 卸载，保留全部用户数据。
- `zz pair`：与第二台设备配对；出码与加入都沿同一引导完成。
- `zz device`：查看或永久移除已配对设备。
- `zz duty`：查看接班设备并迁移值班职责。
- `zz backup`：设置、验证和使用恢复备份，管理恢复码。
- `zz workspace`：管理当前设备已授权的本地工作区。
<!-- public-top-level-commands:end -->

全局选项：`zz --help`（`-h`）显示帮助，`zz --version`（`-V`）显示版本。

## 从源码运行

从源码构建与运行面向贡献者，前提与步骤见[开发与贡献指南](https://github.com/Tandem-Agents/zhixing/blob/main/CONTRIBUTING.md)；源码检出不是受支持的用户安装方式。

## 相关文档

- [项目主页与快速开始](https://github.com/Tandem-Agents/zhixing#readme)
- [安装、维护与发布指南](https://github.com/Tandem-Agents/zhixing/blob/main/research/design/modules/distributed-runtime/release-and-maintenance-guide.md)
- [版本说明](https://github.com/Tandem-Agents/zhixing/blob/main/docs/delivery/releases/0.1.0.md)
- [安全说明](https://github.com/Tandem-Agents/zhixing/blob/main/SECURITY.md)
- [运行时与平台边界](https://github.com/Tandem-Agents/zhixing/blob/main/research/design/modules/distributed-runtime/node-runtime-boundaries.md)
- [运行日志与问题追溯](https://github.com/Tandem-Agents/zhixing/blob/main/docs/tasks/runtime-logging-and-diagnostics.md)
- [公开配置架构](https://github.com/Tandem-Agents/zhixing/blob/main/docs/modules/configuration/architecture.md)
- [秘密存储架构](https://github.com/Tandem-Agents/zhixing/blob/main/docs/modules/secrets/architecture.md)
- [命令系统](https://github.com/Tandem-Agents/zhixing/blob/main/docs/modules/cli/command-system.md)
- [架构总览](https://github.com/Tandem-Agents/zhixing/blob/main/research/design/architecture/overview.md)
- [问题反馈](https://github.com/Tandem-Agents/zhixing/issues)

## 许可

MIT License。许可正文随 npm 包分发。
