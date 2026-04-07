# ADR-003: 配置系统

> **状态**: 接受 | **日期**: 2026-04-07

## 背景

知行需要一个配置系统来管理 Provider 选择、模型默认值、API Key 等设置。当前模型名和 Provider ID 硬编码在 playground 和测试代码中。

调研了 OpenClaw 和 Claude Code 的配置系统设计：

- **OpenClaw**: 单一配置文件 `~/.openclaw/openclaw.json`，无项目级配置自动发现，通过 `$include` 实现模块化，`OPENCLAW_CONFIG_PATH` 环境变量可移动
- **Claude Code**: 5 层级联（Managed → CLI → Local → Project → User），项目共享 + 个人覆盖分离，`/config` + `/status` 交互式配置管理

## 决策

采用 **3 层配置级联** 设计：

```
环境变量 > 项目配置 > 用户全局配置
```

### 配置文件

| 位置 | 用途 | 提交 Git |
|------|------|---------|
| `~/.zhixing/config.json` | 全局默认、API Keys | — |
| `<project>/zhixing.config.json` | 项目级 provider/model | ✓ |
| `<project>/.zhixing/config.local.json` | 个人覆盖（未来） | ✗ |

### 关键设计点

1. **首次运行自动生成**全局配置模板（`~/.zhixing/config.json`）
2. **字段级 deep merge**，不是文件级替换
3. **环境变量永远最高优先**
4. **`ZHIXING_CONFIG_PATH`** 环境变量可覆盖全局配置路径
5. **缺失文件 = 跳过**，不报错
6. **项目配置放根目录** `zhixing.config.json`，可见可发现

## 理由

### 为什么 3 层而不是 1 层（OpenClaw）或 5 层（Claude Code）

- 1 层不够：无法区分项目级和全局默认。不同项目用不同模型是常见需求
- 5 层过多：Managed 层是企业噪音；CLI 参数层由调用方自行处理，不属于配置系统

### 为什么项目配置放根目录而不是 `.zhixing/` 隐藏目录

- 对标 `tsconfig.json`、`eslint.config.js` 等——项目根目录一眼可见
- 降低发现成本，新成员不需要知道隐藏目录的存在
- Claude Code 的 `.claude/settings.json` 隐藏在子目录中，易被忽略

### 为什么自动生成而不是手动创建

- OpenClaw 和 Claude Code 都要求用户手动运行命令或创建文件
- 自动生成模板降低了入门门槛——用户看到模板就知道能改什么
- 模板包含注释说明，比空配置更友好

## 替代方案

1. **只用环境变量**：太简陋，无法持久化复杂配置
2. **复刻 Claude Code 5 层**：对个人部署产品过度设计
3. **复刻 OpenClaw 单文件 + $include**：无项目级支持，多项目切换不便

## 影响

- 新增 `loadConfig()` 函数和配置合并逻辑
- playground 和测试代码消除硬编码 provider/model
- 用户首次使用时自动获得配置模板，无需阅读文档即可上手
- 未来的 CLI 命令可直接读取配置系统

## 引用

- [OpenClaw 配置系统分析](../../../source-analysis/openclaw/architecture-overview.md#9-配置系统)
- [Claude Code 配置系统分析](../../../source-analysis/claude-code/architecture-overview.md#7-配置系统--多层级-settings)
- [q04-配置系统](../../../_private/questions/q04-config-system.md)
