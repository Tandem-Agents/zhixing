# 知行安装、维护与发布

> 唯一交付路径：用户 Node + npm 全局包 + 显式维护。跨平台目标与尚未完成的验证见[运行时边界](node-runtime-boundaries.md)；macOS/Linux 验收通过前不得宣告跨平台发布。

## 安装与首次运行

```text
npm install -g zhixing
zz
```

首次运行才在既有交互与权限边界内创建配置、设备身份和托管服务。npm 安装本身不下载额外程序、不注册服务、不写 `ZHIXING_HOME`，也不修改 Node、npm、PATH 或系统权限。全局目录不可写时，应使用 Node 官方的用户级安装方式修复环境；不得使用 `sudo npm`、放宽系统目录权限或修改知行以外的 npm 配置。

## 同版修复与前向升级

```text
zz stop --maintenance
npm install -g zhixing@<当前明确版本>
zz
```

安装最新版本时把第二行改为 `npm install -g zhixing@latest`。maintenance 只关闭本次 exact 托管定义的未来启动并安全停止；失败会补偿本操作造成的状态变化。成功后保持停用，运行新 `zz` 才更新定义并恢复托管。知行不后台检查、下载、替换或回滚程序；已经运行新版本后不提供降级行动。

## 诊断与停用

`zz doctor` 只读检查本机配置、秘密存储、托管服务、备份配置和已建立连接的兼容状态，每次只给一个安全行动，不联网、不写状态、不输出秘密或内部路径。

卸载应用而保留全部用户数据：

```text
zz app remove
npm uninstall -g zhixing
```

第一步只安全停止并注销未来托管启动；成功固定表示“程序尚未卸载”。`ZHIXING_HOME`、设备身份、信任、配置、对话和工作均保留。永久移除设备及本机数据只能通过独立的 `zz device remove --permanent` 强确认流程。

## 发布者合同

本地先运行：

```text
pnpm package:check
```

它构建并 pack 全部公开包，在隔离临时根中以本轮 tarball 验证 manifest、精确依赖、CLI、runtime subpath、当前平台 helper 和卸载数据保护，不写 npm registry。该命令只证明当前主机的安装闭包。

跨平台构建使用手动触发的 `.github/workflows/platform-delivery.yml`：分别构建五个目标 mesh helper 和终端 U/R/native/parser 资产，汇集到 `packages/mesh/build/prebuilt/` 与 `packages/terminal-ui/dist/`，CLI 构建将完整终端资产带入发行包。以同一候选 tarball 集合在各目标运行定向测试与 `pnpm package:check -- --skip-build --all-targets --tarballs <候选目录>`。Linux 产物使用 Ubuntu 22.04（glibc 2.35）基线。工作流不发布，也不代替真实桌面密钥环、托管服务及设备旅程验收；macOS/Linux 这些证据目前仍待补齐。

### 发布前提

发布前须取得同一代码版本的全目标成功记录，并保留该次运行产出的两样东西：

- `npm-candidate-<sha>` tarball 集合；
- `package:check` 输出的 tarball 指纹。

真实发布须经用户另行授权后才能执行，分两步。每一步都要同时满足：

- 命令带 `--confirm-publish`；
- 本次运行环境设置 `ZHIXING_ALLOW_NPM_PUBLISH=1`。

所有 npm 读写都显式指向官方 registry（包括 `@zhixing-ai` scope），不受本机 npmrc 中镜像配置的影响。

```text
pnpm package:publish -- candidate --tarballs <npm-candidate 目录> --tarball-sha256 <tarball 指纹> --confirm-publish
pnpm package:publish -- promote --accepted-integrity <验收通过的 CLI integrity> --confirm-publish
```

### 第一步：candidate

`candidate` 只上传候选，全程不写 `latest`：

- **输入：** 只接受指纹一致的完整候选集合，不在本机重新打包。
- **上传：** 先核验 npm 身份、二次验证、scope 与包权限，再按依赖拓扑用候选 tag 上传原件。
- **CLI 包：** 只在同一原件末尾追加 `npm-shrinkwrap.json`，用来锁定本次各包的精确版本与 integrity，其中所有地址都指向官方 registry。上传后按 registry 上的实际字节核对，原有条目必须逐字节不变。
- **中断后续传：** 已上传的版本按 registry 现有内容接续；遇到 integrity 冲突即停止，不覆盖已发布内容。
- **核验：** 从官方 registry 安装，核验依赖闭包，并运行 `--version` 和 `--help`。
- **`latest` 保护：** 上传期间，任何包的 `latest` 发生变化或指向本候选，都按异常处理，本步失败。
- **输出：** 候选身份、验收用的安装命令，以及下一步的推广命令。

### 第二步：promote

`promote` 只推广正式版本，预发布版本保持非默认。推广前依次满足以下条件，才移动 `zhixing` 的 `latest`：

1. registry 上 CLI 的 integrity 等于验收记录中的值；
2. 重新从官方 registry 安装，核验依赖闭包通过。

移动后回读确认结果；若该版本已经是 `latest`，不重复写入。

仓库不保存 token，不建设自有更新源、签名 manifest、原生安装器或平台签名公证。

本轮终端迁移的本机交付验证使用最终候选、隔离 prefix/home 和 Node 24.0.0，检查两个 bin、默认界面、退出及卸载数据保护。缺少其他物理环境不阻塞本轮开发验收；远程 CI 和实际 npm 发布另按授权执行。
