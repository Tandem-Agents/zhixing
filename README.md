# 知行 (Zhixing)

> 知而后行，行而后知 —— 一个为真实工作场景构建的个人智能体

## 项目简介

知行是一个独立部署的个人 AI 智能体，运行在你自己的设备上，遵循你自己的规则。

它不是一个聊天机器人，而是一个能真正执行任务的助手——读写文件、运行命令、搜索信息、管理工作流——在你的完全掌控之下。


## 设计理念

- **本地优先** — 数据和执行都在你的设备上，隐私由你掌控
- **能力与安全的平衡** — 强大的默认能力，明确的安全边界
- **渐进式实现** — 每一步都是独立且可验证的
- **开放扩展** — 核心精简，能力通过插件无限扩展

## 安装与使用

当前正式支持 Windows 10/11 x64 与 Node `>=24.0.0`：

```text
npm install -g @zhixing/cli
zz
```

同版修复或前向升级先运行 `zz stop --maintenance`，再安装明确版本或 `@latest`，最后运行新 `zz` 恢复托管。停用并卸载程序时先运行 `zz app remove`，确认安全停止后再运行 `npm uninstall -g @zhixing/cli`；用户数据保留在 `ZHIXING_HOME`。知行不后台替换程序，不提供已运行新版本后的降级，不修改用户的 Node、npm 或 PATH。

全局目录不可写时，请用 Node 官方的用户级安装方式修复环境；不要使用 `sudo npm`、放宽系统目录权限或修改知行以外的 npm 配置。完整维护合同见[安装、维护与发布](./research/design/modules/distributed-runtime/release-and-maintenance-guide.md)。

## 仓库结构

```
zhixing/
└── research/          # 认知研究与设计体系（当前活跃）
    ├── insights/      #   按认知域组织的 Q&A 研究
    ├── source-analysis/ # 源码深度解析
    ├── landscape/     #   竞品图谱
    ├── design/        #   架构设计与决策
    ├── _templates/    #   文档模板
    └── _meta/         #   术语表、进度追踪
```

## 许可证

[MIT](./LICENSE)
