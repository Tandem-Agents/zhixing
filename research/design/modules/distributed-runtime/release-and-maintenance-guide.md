# 知行安装、维护与发布

> 唯一交付路径：用户 Node + npm 全局包 + 显式维护。跨平台目标与尚未完成的验证见[运行时边界](node-runtime-boundaries.md)；macOS/Linux 验收通过前不得宣告跨平台发布。

## 安装与首次运行

```text
npm install -g @zhixing/cli
zz
```

首次运行才在既有交互与权限边界内创建配置、设备身份和托管服务。npm 安装本身不下载额外程序、不注册服务、不写 `ZHIXING_HOME`，也不修改 Node、npm、PATH 或系统权限。全局目录不可写时，应使用 Node 官方的用户级安装方式修复环境；不得使用 `sudo npm`、放宽系统目录权限或修改知行以外的 npm 配置。

## 同版修复与前向升级

```text
zz stop --maintenance
npm install -g @zhixing/cli@<当前明确版本>
zz
```

安装最新版本时把第二行改为 `npm install -g @zhixing/cli@latest`。maintenance 只关闭本次 exact 托管定义的未来启动并安全停止；失败会补偿本操作造成的状态变化。成功后保持停用，运行新 `zz` 才更新定义并恢复托管。知行不后台检查、下载、替换或回滚程序；已经运行新版本后不提供降级行动。

## 诊断与停用

`zz doctor` 只读检查本机配置、秘密存储、托管服务、备份配置和已建立连接的兼容状态，每次只给一个安全行动，不联网、不写状态、不输出秘密或内部路径。

卸载应用而保留全部用户数据：

```text
zz app remove
npm uninstall -g @zhixing/cli
```

第一步只安全停止并注销未来托管启动；成功固定表示“程序尚未卸载”。`ZHIXING_HOME`、设备身份、信任、配置、对话和工作均保留。永久移除设备及本机数据只能通过独立的 `zz device remove --permanent` 强确认流程。

## 发布者合同

本地先运行：

```text
pnpm package:check
```

它构建并 pack 全部公开包，在隔离临时根中以本轮 tarball 验证 manifest、精确依赖、CLI、runtime subpath、当前平台 helper 和卸载数据保护，不写 npm registry。该命令只证明当前主机的安装闭包。

跨平台构建使用手动触发的 `.github/workflows/platform-delivery.yml`：分别构建五个目标 helper，汇集到 `packages/mesh/build/prebuilt/`，在各目标运行构建、定向测试及 `pnpm package:check -- --skip-build --all-targets`。Linux 产物使用 Ubuntu 22.04（glibc 2.35）基线。工作流不发布，也不代替真实桌面密钥环、托管服务及设备旅程验收；macOS/Linux 这些证据目前仍待补齐。

发布前须取得同一代码版本的全目标成功记录，并汇集对应 helper。真实发布只能在用户另行授权后运行 `pnpm package:publish -- --confirm-publish`：先以 `--all-targets` 拒绝缺失或错配的产物，再只读核验 npm 身份、二次验证、scope 与包权限，按依赖拓扑使用候选 tag；全部版本、integrity、CLI shrinkwrap 和候选安装全等后才移动 `@zhixing/cli` 的 `latest`。仓库不保存 token，不建设自有更新源、签名 manifest、原生安装器或平台签名公证。
