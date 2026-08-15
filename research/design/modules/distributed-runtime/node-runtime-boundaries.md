# 知行 Node.js 运行时边界

> 状态：当前架构约束与迁移基线（2026-08-15）

## 目标

把开发环境、官方产品和源码安装使用的 Node.js 责任彻底分开：开发者可以升级工具链，官方用户不承担 Node 管理成本，发布制品仍具有可复现、可验证的精确运行时身份。

## 三种 Node 身份

| 身份 | 谁负责 | 版本合同 | 用途 |
|---|---|---|---|
| 开发者 Node | 开发团队 | 固定受支持 LTS 基线 | 执行 pnpm、构建、测试、仓库脚本和本地链接的 `zz` |
| 官方制品私有 Node | 知行发布系统 | manifest 记录并验证精确版本 | 随知行安装、更新和移除；运行正式程序 |
| 源码/npm 使用者 Node | 使用者 | 只声明经过验证的最低兼容版本，不锁补丁版本 | 高级用户从源码或 npm 入口自行运行 |

精确版本只属于开发可复现基线和官方制品身份，不是官方用户的系统前置要求。

## 与操作系统的关系

| 系统位置或机制 | 开发者 Node | 官方制品私有 Node | 边界要求 |
|---|---|---|---|
| `PATH`、npm/pnpm | 由开发者或用户维护 | 不加入 `PATH`，不依赖全局包和缓存 | 安装、更新和移除知行不得改变用户配置 |
| 启动器与内部子进程 | 本地链接的 `zz` 使用开发者 Node | 使用 current 版本目录内 runtime 的绝对路径或 `process.execPath` | 禁止内部使用裸 `node` 命令 |
| 用户 Shell、MCP 和外部工具 | 继续使用用户环境 | 不注入私有 Node | 用户主动执行 `node` 时仍得到自己的版本 |
| 系统所有权 | 开发者或用户自行管理 | 不注册成系统 Node，不改全局环境变量和文件关联 | 私有 runtime 只属于知行程序树 |
| 磁盘与生命周期 | 独立于知行 | 每个保留版本携带一份已验证 runtime | 随 ProgramStore 更新、回滚和清理 |

### 与用户 Node 共存

知行私有 Node 与用户 Node 不冲突，也不得影响彼此：

```text
用户 Node：C:\Program Files\nodejs\node.exe
知行 Node：<知行程序根>\versions\<版本>\runtime\node.exe
```

- 用户终端中的 `node`、`npm`、`pnpm` 继续由原有 `PATH` 解析；知行启动器始终以绝对路径调用当前版本的 `runtime/node.exe`。
- 知行更新或移除私有 Node 不得升级、覆盖或删除用户 Node；用户升级、损坏或删除自己的 Node 也不得改变已安装知行。
- 安装器严禁把私有 Node 加入 `PATH`、修改 npm/pnpm 配置或全局环境变量、覆盖系统 `node.exe`。
- 当前发布设计已采用私有 runtime 绝对路径，方向正确。用户无需知道或管理它；产品代价只是每个保留版本额外占用一份运行时的磁盘空间，通常为几十 MB。

## 构建、类型和原生代码

- 根 `package.json` 的开发命令由开发者 Node 执行；切换 Node 不会自动重写已有 `dist`，必须重新构建才会产生新构建证据。
- `target: ES2023` 决定 JavaScript 输出语法；`module: Node16` 只决定 TypeScript 的 Node 模块解析规则，不代表运行时是 Node 16。
- `@types/node` 与构建 target 约束编译期 API 和输出语法，必须对齐产品实际支持的最低运行时，避免产生虚假兼容承诺。
- Windows checkpoint child bridge 是独立 C# helper，不绑定 Node ABI；Linux/macOS bridge 通过 N-API/node-gyp 构建，必须在对应目标与正式 runtime 上重建并验证。
- pnpm 锁文件固定依赖解析结果，但 Node 版本仍可能改变安装脚本、原生构建、标准库行为和测试结果，因此 Node 升级后必须取得新的构建与验证证据。

## 官方安装与更新合同

1. 官方安装器不检查、安装、升级、覆盖或删除用户的系统 Node。
2. 稳定 launcher 只读取已验证 current pointer，并启动该版本目录内的私有 runtime 与固定 entry。
3. 私有 runtime 可执行文件必须进入签名 ProgramArtifact 的路径和字节摘要闭包；manifest 与 health snapshot 还须把声明版本和实际 `process.versions.node` 全等绑定，版本字符串不能替代字节完整性。
4. 私有 Node 随 ProgramStore 完成更新、回滚和清理；系统无 Node，或有任意其他版本 Node 时，官方知行行为必须相同。

源码或 npm 高级入口可以声明最低 Node 版本，但该要求不得泄漏到官方安装主路径。

## 当前仓库现状

- 开发基线由 `.node-version` 固定为 Node `24.19.0`；源码入口要求 `node >=24.0.0`，pnpm 固定为 `10.8.0`。
- release tooling、manifest decoder、health、直接测试与五目标程序树统一要求 exact Node 24 私有 runtime。
- 全部 17 个代码包统一使用 `@types/node 24` 和 `tsup target: node24`。
- 本地全局 `zz` 链接由开发者 Node 执行；正式制品 launcher 使用程序树中的私有 runtime，两者已经是不同入口。
- Windows checkpoint helper 由既有 C# 构建路径生成；Linux/macOS 继续在对应目标和正式 runtime 上通过 N-API/node-gyp 构建。

## 本轮执行结果

- 复用 `E:` 盘 Node `24.19.0` 与 pnpm `10.8.0`，未安装第二套 Node，未修改系统 `PATH`、全局 npm/pnpm 或用户项目。
- package manifest 与 lockfile 已统一到 `@types/node 24.13.3`；Windows `mesh` 安装显式复用既有平台构建入口，不再误触发 `node-gyp`，失败尝试产生的 C 盘 Node 24 缓存已清除。
- Node 24 全量构建通过；核心发布合同 9/9、发布工具 7 项通过（1 项按主机能力跳过）、CLI runtime/update 生命周期 20/20、Windows checkpoint helper 实际读写 1/1 通过。
- 当前 `dist` 已由最终 Node 24 构建输入生成，既有全局 junction 下的 `zz --version` / `zz --help` 已通过，可直接开始本机产品测试。

正式发布时仍须在五个目标上嵌入并验证同一 exact Node 24 runtime，完成签名、公证和既有 candidate-only smoke；该发布证据不阻塞当前本机测试。

### 执行边界与清洁性

- 开始前记录工作区、暂存区及本任务文件的基线差异；只修改本任务闭包，保留已有变更且不执行暂存、重置或检出，结束时逐项对账。
- 只修改版本库内的版本来源、合同、依赖与测试；复用现有 `E:` 盘 Node 24，不再安装 Node，不改系统 `PATH`、全局 npm/pnpm 或用户项目。
- 全部依赖声明修改完成后只解析一次，同步 package manifest 与 lockfile；不创建第二套 `node_modules`、私有 runtime 或过渡目录。
- 构建只更新仓库正常 `dist`，测试副作用只进入隔离临时目录；禁止发布制品、切换真实 ProgramStore 或读写用户数据，失败即停，因此所有变更均可由版本库完整回退。
- 完成时确认无遗留测试进程、临时日志或任务生成的无关文件，并复核系统 Node 解析结果未变；共享 pnpm 缓存不是任务残留，不做破坏性清理。

## 验收底线

- 安装知行前后，用户终端中的 `where node` / `which node` 与 `node --version` 不变。
- 用户没有系统 Node 时，官方知行仍能完成安装、启动、更新、恢复和移除。
- 用户 Node 换代、损坏或卸载不影响已安装知行；知行私有 Node 换代不影响用户项目。
- 所有知行内部启动链都能反向证明使用当前版本目录的 exact runtime，零 PATH 偶然解析。
- 官方移除完成后不留下私有 runtime，同时用户 Node 与包管理器状态完全不变。
