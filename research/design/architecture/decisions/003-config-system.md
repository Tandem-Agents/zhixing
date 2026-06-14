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

采用 **用户全局配置单一来源** 设计：

```
用户全局配置（ZHIXING_CONFIG_PATH 可覆盖文件路径）
```

### 配置文件

| 位置 | 用途 | 提交 Git |
|------|------|---------|
| `~/.zhixing/config.jsonc` | LLM 角色、消息通道启用列表、workspace、agent / intent / network 等决策层偏好 | — |

### 配置 Schema

```typescript
interface ZhixingConfig {
  llm?: Record<string, { provider: string; model: string }>;
  agent?: AgentConfig;          // displayName 等
  workspace?: WorkspaceConfig;  // 工作区配置
}

interface WorkspaceConfig {
  /**
   * 工作区根目录——智能体在此范围内的文件操作被视为低影响。
   * 这是用户级偏好（知行是个人助手，不只是开发工具），主要在全局配置中设定。
   * 必须使用绝对路径；这是安全信任边界，不能随启动 cwd 改变。
   */
  root: string;
  /** 工作区内仍需保护的路径（追加到内置保护路径） */
  protectedPaths?: string[];
}
```

### 关键设计点

1. **首次运行自动生成**全局配置模板（`~/.zhixing/config.jsonc`）
2. **字段级 deep merge**，不是文件级替换
3. **环境变量永远最高优先**
4. **`ZHIXING_CONFIG_PATH`** 环境变量可覆盖全局配置路径
5. **缺失文件 = 跳过**，不报错
6. **配置单一来源**：用户全局配置 `~/.zhixing/config.jsonc`，不读取 cwd 项目配置
7. **workspace 是用户级偏好**：在全局配置中设定（知行是个人助手，workspace 跟着人走不跟着目录走）
8. **workspace 优先级**：运行时内部显式覆盖（如工作场景 workdir） > 全局配置（主路径） > `cwd` 兜底。用户启动命令不提供工作区参数双轨入口
9. **workspace.root 路径解析**：全局配置必须使用绝对路径；运行时内部覆盖可用相对路径并由调用方上下文解析

## 理由

### 为什么单一来源而不是多层级联

- 知行是个人助手，运行地址与效果应一致；cwd 项目层会让启动目录隐式改变系统行为
- 工作场景需要差异化时应绑定 sceneId，而不是读取某个随机 cwd 下的配置文件
- 凭证与偏好都保持用户级边界，避免项目目录把个人配置泄漏到 git

### 为什么自动生成而不是手动创建

- OpenClaw 和 Claude Code 都要求用户手动运行命令或创建文件
- 自动生成模板降低了入门门槛——用户看到模板就知道能改什么
- 模板包含注释说明，比空配置更友好

## 替代方案

1. **只用环境变量**：太简陋，无法持久化复杂配置
2. **复刻 Claude Code 5 层**：对个人部署产品过度设计
3. **复刻 OpenClaw 单文件 + $include**：模块化能力暂不需要，先保持单一事实源

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
