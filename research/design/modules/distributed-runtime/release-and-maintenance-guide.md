# 知行安装、维护与发布

> 当前唯一正式交付路径：用户 Node + npm 全局包 + 显式维护。当前支持 Windows 10/11 x64 与 Node `>=24.0.0`。

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

它构建并 pack 全部公开包，在隔离临时根中以本轮 tarball 验证 manifest、精确依赖、CLI、runtime subpath 与 Windows helper，不写 npm registry。真实发布只能在用户另行授权后运行 `pnpm package:publish -- --confirm-publish`：命令先只读核验 npm 身份、二次验证、scope 与包权限，再按依赖拓扑使用候选 tag；只有全部版本、integrity、CLI shrinkwrap 和候选安装全等时才移动 `@zhixing/cli` 的 `latest`。仓库不保存 token，不建设 CI、自有更新源、签名 manifest、原生安装器或平台签名公证。
