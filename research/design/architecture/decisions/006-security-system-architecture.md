# ADR-006: 安全系统架构

> **状态**: 接受 | **日期**: 2026-04-12

## 背景

安全系统是智能体最关键的子系统之一。智能体拥有读写文件、执行命令、访问网络的能力，安全系统决定了这些能力何时可用、如何约束、以及出问题时的最后防线。

深度调研了 OpenClaw、Hermes、Claude Code 三个系统的安全架构后（见 [q06-安全系统深度调研](../../../_private/questions/q06-security-system-deep-dive.md)），我们发现：

- **OpenClaw**：Docker/SSH 可插拔沙箱设计优雅但可选，非沙箱模式无安全保障；权限仅到工具级 allow/deny
- **Hermes**：Tirith 外部扫描器有创新但 `fail_open` 默认放行；非交互路径和容器环境完全跳过安全检查
- **Claude Code**：8 层纵深防御最完整，但 ~7000 行 Bash 安全代码维护成本极高；Auto 分类器每次工具调用加一次推理；5 种权限模式之间跳跃大

三者都未真正解决 **安全与体验的根本矛盾**——太严则权限疲劳、太松则安全失效。

## 决策

安全系统围绕三条原则设计：**操作按影响范围分类**、**每条放行追溯到用户选择**、**全平台行为一致**。由五个组件构成：策略引擎、操作分类、权限系统、执行守卫、安全仪表盘。OS 加固作为静默的额外纵深，不影响用户行为。知行是**个人助手**，安全系统是**域无关**的基础设施——它不知道"消息"或"日程"是什么，通过工具的边界声明自动覆盖任何业务场景。

### 决策 1：声明式策略引擎（替代命令式安全代码）

安全规则是数据而非代码。

```typescript
interface SecurityRule {
  id: string;
  match: MatchSpec;
  action: 'block' | 'confirm' | 'audit';
  bypassImmune: boolean;
  message: string;
}

type MatchSpec =
  | { type: 'command_pattern'; pattern: string }
  | { type: 'path_scope'; paths: string[]; access: 'read' | 'write' }
  | { type: 'env_var'; names: string[] }
  | { type: 'composite'; operator: 'and' | 'or' | 'not'; rules: MatchSpec[] };
```

新增安全规则 = 添加 JSON 数据条目，不改代码。规则可版本化、可共享、可热加载。

**Phase 2 实现。** MVP 使用硬编码的内置规则集。

### 决策 2：威胁边界模型（替代工具级 allow/deny）

保护的是**资源**，而非限制工具。工具声明它会跨越哪些边界，已有的边界保护自动生效。威胁边界是工具的**安全元数据**，不是流程中的独立检查点——分类器读取这些声明做影响判断。

```typescript
// 工具声明边界跨越
const bashToolBoundaries: BoundaryCrossing[] = [
  { boundaryType: 'process',    access: 'exec',  dynamic: true },
  { boundaryType: 'filesystem', access: 'write', dynamic: true },
  { boundaryType: 'network',    access: 'egress', dynamic: true },
];
```

`bypassImmune` 确保核心保护（如 SSH 密钥、.git 目录）永远不可被任何配置覆盖。MCP 工具来自第三方，其声明可能不诚实——首次注册需用户审查确认，Phase 3 加运行时边界审计。未声明边界的工具默认 `critical`。

**Phase 2 实现。** MVP 使用 ADR-004 定义的基本能力检查。

### 决策 3：操作影响分类 + 显式权限规则（替代离散权限模式）

**操作分类**是最核心的安全概念：按影响范围分为四级——observe（只读）/ internal（仅本地）/ external（影响外部）/ critical（不可逆/高危）。分类通过三个区域判断：工作区内（文件操作 internal）、工作区外（文件操作 external）、外部系统（通过工具的边界声明确定影响等级）。只有文件系统和 Shell 需要专用的上下文分类器，所有其他工具（消息、日程、支付等）通过**边界影响分类器**统一处理——安全系统不包含任何业务领域分类器。

**权限规则**是用户在确认对话框中做出的明确选择，不是系统自动累积的分数。

```
智能体想要执行: npm install express
[y] 允许这一次
[a] 始终允许 "npm install *"（本项目）
[s] 本次会话内允许 "npm *"
[n] 拒绝
```

**智能建议**：当同一模式被手动确认多次（阈值与风险等级关联：低风险 3 次、中风险 5 次、高风险 10 次、critical 永不），系统建议创建持久规则——但绝不自动创建。权限规则支持三个 scope：session（会话）、workspace（工作区）、global（全局跨工作区）。

**为什么不用浮点信任分数**：
- 用户不理解 "0.65 分" 是什么意思
- 系统自己决定何时自动批准，用户失去掌控感
- 出了安全事故无法审计（"信任分达到 0.85 所以自动放行了"）
- 信任粒度不清（按操作？按目标？按模式？）

**Phase 2 实现。** MVP 使用简单的 confirm/skip 二元模型。

### 决策 4：执行守卫 + 静默 OS 加固（替代平台依赖型沙箱）

执行守卫是应用层代码，全平台行为一致，只处理通用安全威胁：

```
所有工具执行通过执行守卫：
  环境净化 → 路径验证 → 命令改写 → 输出限制 → 超时保护
```

业务领域的安全约束（消息频率限制、收件人验证）是工具自身的职责，不在安全系统中。

OS 加固（Seatbelt / bubblewrap）是可选的额外纵深，静默生效，不影响用户行为：

```
macOS: Seatbelt    → 静默增强
Linux: bubblewrap  → 静默增强
Windows: 无可用沙箱 → 不影响安全保证
```

**关键设计**：没有补偿机制。所有平台上相同的规则、相同的确认、相同的体验。OS 加固有没有都不改变安全行为，因为执行守卫本身已经覆盖了智能体场景下 95%+ 的真实威胁。

**Phase 1 实现执行守卫。Phase 3 加 OS 加固和 Docker 容器。**

### 决策 5：安全可观测性

三个竞品都没有面向用户的安全仪表盘。知行的安全系统是完全可观测的。

```
/security              安全状态概览
/trust list            查看权限规则
/security audit        安全决策审计日志
```

所有安全决策通过 EventBus 发射结构化事件，CLI / Web / API 均可消费。

**Phase 2 实现。** MVP 通过 EventBus 发射基本安全事件。

## 依据

### 为什么声明式策略引擎

- Claude Code 7000 行命令式 Bash 安全代码是维护噩梦，每个新攻击向量 = 新代码
- 声明式规则可以由社区贡献，类似 ESLint/Semgrep 生态
- 规则是数据，可以热加载、版本管理、A/B 测试

### 为什么威胁边界模型

- 工具级 allow/deny 无法表达"这个工具可以读 src/ 但不能读 .env"
- 新增 MCP 工具如果没有预设 allow/deny，默认行为未定义
- 边界模型让保护与工具解耦——不管什么工具访问 .git/，都拦截

### 为什么操作影响分类而非项目边界

- 知行是个人助手，不只是编码工具。编码时有"工作区"概念，发微信时没有
- 影响范围分类（observe/internal/external/critical）适用于所有场景
- 安全系统是域无关的基础设施——不包含业务领域分类器（MessagingClassifier、CalendarClassifier），因为"发送消息"是业务行为不是操作类型
- 只有文件系统和 Shell 需要上下文分类器（影响取决于路径/命令），其他工具通过边界声明分类
- 新增任何业务工具只需声明边界跨越，零安全代码变更

### 为什么显式规则而非信任分数

- Claude Code 5 种权限模式跳跃大，用户在"频繁弹窗"和"YOLO"之间没有中间态
- Hermes 永久白名单是静态的，一旦授权永不过期
- 显式规则给用户掌控感：每条规则都是自己创建的，可见、可审计、可撤销
- 智能建议在重复确认时减少疲劳，但决策权始终在用户手中

### 为什么不做补偿机制

- 在智能体场景下，执行守卫（应用层）已覆盖绝大多数真实威胁
- OS 沙箱防护的是"恶意子进程绕过应用层直接系统调用"——这在智能体日常使用中极少发生
- 补偿机制增加了系统复杂度，制造了平台间的行为差异，违背"平台无关"原则
- 更简单的设计 = 更稳定的设计

### 为什么 Shell 分类器需要管道/重定向检测

- `startsWith` 前缀匹配极其危险——`echo "malicious" > /etc/passwd` 以 `echo` 开头会被误判为 `observe`
- Shell 分类器在安全命令匹配前必须先检测管道、重定向、链式操作符
- 安全命令列表使用精确可执行文件名匹配，不再用前缀匹配

### 为什么路径判断必须做 realpath 解析

- 工作区内的 symlink 可指向 `~/.ssh/id_rsa`，不解析则 symlink 路径会被误判为 `internal`
- `FileSystemClassifier` 和 `PathGuard` 都必须在判断前对路径做 `realpath` 解析
- 这是 Phase 1 的基础能力，不可延后

### 为什么安全可观测性

- 安全系统越不透明，用户越不信任，越倾向关闭它
- 三个竞品都没有安全仪表盘——明确的差异化机会
- EventBus 是知行的一等公民基础设施，安全事件自然融入

## 替代方案

### A: 照搬 Claude Code 8 层纵深防御

- 优势：最完整的已验证方案
- 劣势：7000 行 Bash 安全、需要 GrowthBook 服务端、Auto 模式每次工具调用一次推理
- 未采用原因：工程量与我们的阶段不匹配；命令式安全代码不可持续

### B: 照搬 OpenClaw 容器优先

- 优势：物理隔离最彻底
- 劣势：强依赖 Docker；非沙箱模式无保障
- 未采用原因：不是所有用户都有 Docker

### C: Hermes 模式——外部扫描器 + 审批

- 优势：简单、可插拔
- 劣势：`fail_open` 默认、非交互路径无保护
- 未采用原因：安全基线太低，不适合产品级要求

### D: 浮点信任分数渐进累积

- 优势：理论上越用越顺畅
- 劣势：用户不理解分数含义、信任粒度定义模糊、系统自动决定何时放行导致失控感
- 未采用原因：显式规则更简单、更可控、更可审计

## 影响

- **Phase 1 影响最小**：策略引擎内置规则集 + 执行守卫基本检查 + 路径 realpath 解析
- **Phase 2 加入核心安全**：威胁边界 + 操作分类器（上下文分类器 + 边界影响分类器）+ 权限系统 + 安全事件
- **Phase 3 完整隔离**：OS 加固 + Docker 容器 + 社区规则集 + 外部扫描器 + 远程规则更新 + MCP 运行时边界审计
- **约束**：所有安全组件必须是中间件形态，不允许写入工具代码内部

## 相关决策

- 依赖：[ADR-004 工具系统架构](004-tool-system-architecture.md)（工具执行管线是安全检查的宿主）
- 被依赖：未来的 MCP 安全策略、插件安全审计

## 引用

- [安全系统详细设计方案](../../specifications/security-system.md)
- [q06-安全系统深度调研](../../../_private/questions/q06-security-system-deep-dive.md)
- [OpenClaw 安全系统源码分析](../../../source-analysis/openclaw/security-system.md)
- [Hermes 安全系统源码分析](../../../source-analysis/hermes-agent/security-system.md)
- [Claude Code 安全系统源码分析](../../../source-analysis/claude-code/security-system.md)
