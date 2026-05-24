# ADR-003: 配置系统

> **状态**: 接受 | **日期**: 2026-04-07
>
> **更新 (2026-05-24)**: 下文"3 层配置级联"中的 **cwd 绑定项目层**（`<project>/zhixing.config.jsonc`）
> 已废弃并从代码移除。知行是个人助手——运行地址与效果无关，配置不应随启动目录漂移。
> 该层是早期 cwd-project 设计的遗留（对话持久化等早已转用户级 / 工作场景级），无人创建、
> 无文档、违反"运行地址无关"不变量。现配置为**单一来源**：用户全局 `~/.zhixing/config.jsonc`
> （`ZHIXING_CONFIG_PATH` 可覆盖路径）。未来若需"工作场景级配置覆盖"，将绑定工作场景（用户级、
> 按 sceneId），仍与 cwd 无关。工作区解析的 cwd 兜底（无任何 workspace 配置时回退当前目录）
> 是独立的最后兜底，不在此次移除范围。

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

### 配置 Schema

```typescript
interface ZhixingConfig {
  defaultProvider?: string;
  defaultModel?: string;
  providers?: Record<string, ProviderConfig>;
  agent?: AgentConfig;          // displayName 等
  workspace?: WorkspaceConfig;  // 工作区配置
}

interface WorkspaceConfig {
  /**
   * 工作区根目录——智能体在此范围内的文件操作被视为低影响。
   * 这是用户级偏好（知行是个人助手，不只是开发工具），主要在全局配置中设定。
   * 全局配置：必须是绝对路径。
   * 目录级配置：可用相对路径（相对于配置文件所在目录），面向开发者的可选覆盖。
   */
  root: string;
  /** 工作区内仍需保护的路径（追加到内置保护路径） */
  protectedPaths?: string[];
}
```

### 关键设计点

1. **首次运行自动生成**全局配置模板（`~/.zhixing/config.json`）
2. **字段级 deep merge**，不是文件级替换
3. **环境变量永远最高优先**
4. **`ZHIXING_CONFIG_PATH`** 环境变量可覆盖全局配置路径
5. **缺失文件 = 跳过**，不报错
6. **项目配置放根目录** `zhixing.config.json`，可见可发现
7. **workspace 是用户级偏好**：主要在全局配置中设定（知行是个人助手，workspace 跟着人走不跟着目录走）。目录级配置可选覆盖，面向开发者
8. **workspace 优先级**：`CLI --workspace` > 目录级配置 > 全局配置（主路径） > `cwd` 兜底。配置文件中设定的工作区不会被运行位置覆盖
9. **workspace.root 路径解析**：全局配置必须是绝对路径；目录级配置可用相对路径（相对于配置文件所在目录）

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
- `workspace` 字段为安全系统（ADR-006）提供配置驱动的工作区确定机制，取代硬编码 `process.cwd()`。详见 [安全系统设计方案 §3.4](../../specifications/security-system.md)

## 引用

- [OpenClaw 配置系统分析](../../../source-analysis/openclaw/architecture-overview.md#9-配置系统)
- [Claude Code 配置系统分析](../../../source-analysis/claude-code/architecture-overview.md#7-配置系统--多层级-settings)
- [q04-配置系统](../../../_private/questions/q04-config-system.md)
