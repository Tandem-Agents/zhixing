# 知行 Node.js 运行时边界

> 当前产品合同（2026-08-16）：用户 Node + npm 全局包。知行不携带或管理私有 Node。

## 唯一责任边界

| 对象 | 责任方 | 合同 |
|---|---|---|
| 开发者 Node | 开发团队 | `.node-version` 固定可复现基线，用于 pnpm、构建、测试和仓库脚本 |
| 用户 Node | 用户/Node 安装器 | 满足 `engines.node` 的最低版本；运行 npm 安装的 `zz` |
| 知行托管进程 | 知行 | definition 绑定安装时实际的 `process.execPath` 与绝对 CLI 入口，不调用裸 `node` 或 PATH 猜测 |

当前发布验证范围是 Windows 10/11 x64、Node `>=24.0.0`；不锁死补丁或最高版本。macOS/Linux 的源码与平台 adapter 保持可移植，但取得真实环境证据前不作发布承诺。

## 安装与维护

- `npm install -g @zhixing/cli` 不安装 Node，不修改 PATH、npm/pnpm 配置、全局环境变量或系统 `node.exe`。
- 知行公开包没有安装生命周期脚本；首次运行 `zz` 才可在既有交互与权限边界内创建配置、身份和托管服务。
- 同版修复或前向升级先运行 `zz stop --maintenance`，再 npm 安装并运行新 `zz`；新 CLI 复用现有 reconcile 更新托管 definition。
- 用户在上述流程外移动或删除 Node 时，旧 definition 可能无法启动；新 CLI/doctor 必须识别漂移并给出修复行动，不伪称进程启动前可以自愈。
- `zz app remove` 只准备卸载并保护 `ZHIXING_HOME`；实际包删除由 `npm uninstall -g @zhixing/cli` 完成。

## 构建与原生 helper

- TypeScript target 与 `@types/node` 决定编译边界，不等于运行时版本；升级开发 Node 后必须重新构建并取得受影响验证证据。
- pnpm 锁文件固定开发依赖解析，发布 tarball 由 packed manifest 的精确 registry 依赖与 CLI shrinkwrap 约束。
- Windows checkpoint child bridge 是随 `@zhixing/mesh` 发布的预构建 C# helper，不绑定 Node ABI；构建生成 OS/arch、包版本与 SHA-256 descriptor，打包检查和运行时首次 spawn 前复验 exact bytes。
- 公开包不得在安装时编译 native helper。未发布的 macOS/Linux helper 不构成当前门禁。

## 验收底线

- 不满足 Node 或平台边界时，CLI 在配置、身份、服务和 home 首效果前稳定拒绝。
- 安装失败不留下知行配置、身份或服务副作用；卸载包不删除用户数据。
- 托管定义与当前 Node/CLI 绝对入口全等；显式维护失败不产生双服务、假成功或丢失已接受工作。
- 单机、多设备协作、配对信任、备份恢复、安全停机和设备移除不依赖私有 Node、自有更新源或平台签名。
