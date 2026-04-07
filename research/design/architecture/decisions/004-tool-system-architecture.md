# ADR-004: 工具系统架构

> **状态**: 接受 | **日期**: 2026-04-07

## 背景

工具是智能体的核心能力——没有工具，Agent 只是一个聊天封装。调研了 OpenClaw 和 Claude Code 的工具系统后（见 [q05-工具系统安全](../../../_private/questions/q05-tool-system-security.md)），发现两者分别有明显的局限性：

- **OpenClaw**：容器隔离方案重度依赖 Docker，非沙箱模式下安全靠配置；权限是工具级 allow/deny，粒度不够
- **Claude Code**：~7000 行 Bash AST 防御工程量极大，权限模式是一刀切（default/auto），无容器选项

两者都没有解决好 "安全与体验的动态平衡" 问题。

## 决策

工具系统采用三个核心设计：**能力安全模型**、**隔离级别光谱**、**渐进式信任**。渐进实现，MVP 只做最小安全基线。

### 决策 1：能力授权，而非工具授权

不问"能不能用 Bash"，问"有没有 `process.exec` 能力、范围是什么"。

- 工具声明所需能力（`capabilities: Capability[]`）
- 运行时 `SecurityContext` 定义已授权能力集
- 能力有范围限定（`fs.read:./src/**`）
- 子 Agent 自动继承父级能力的子集，零配置

**Phase 2 实现。** MVP 阶段工具直接执行，不做能力检查。`ToolDefinition` 接口添加可选的 `capabilities?` 字段，旧工具通过 `isReadOnly` 等属性自动推断。

### 决策 2：隔离级别光谱

六个级别，从完全信任到完全隔离：

```
L0 trust     → 直接执行（开发调试）
L1 confirm   → 危险操作用户确认（默认）
L2 analyze   → 命令分析 + 确认
L3 process   → 进程级沙箱
L4 container → Docker 容器
L5 remote    → 远程执行
```

关键约束：**工具实现不感知隔离级别。** 隔离是执行管线的外部包装，不是工具代码的责任。

**Phase 3 实现完整光谱。** MVP 固定为 L1（通过 EventBus 通知调用，不阻塞）。

### 决策 3：渐进式信任

信任按 `操作 × 项目` 维度递增，不是一刀切的模式选择。

- 首次操作需确认，多次安全执行后自动批准
- 不同项目独立的信任状态
- Bypass-immune 操作永远不自动批准（`.git/` 写入、项目外操作、特权命令等）

**Phase 2 实现。** MVP 阶段不做信任管理。

### 决策 4：工具执行管线

五阶段中间件管线：验证 → 授权 → 守卫 → 执行 → 处理。

**渐进实现：**
- Phase 1（MVP）：Schema 验证 + 直接执行 + 结果截断
- Phase 2：+ 能力检查 + bypass-immune + 用户确认
- Phase 3：+ 命令分析 + 隔离环境 + 审计日志

### 决策 5：协议/实现分离

工具 = 协议（输入输出契约）+ 实现（具体执行逻辑）。同一协议可有本地/容器/远程/MCP 多种实现。

内置工具、插件工具、MCP 工具、动态工具统一注册到 `ToolRegistry`。

### 决策 6：结果大小管理

从 Phase 1 开始实施 `maxResultChars` 截断，防止单次工具调用撑爆上下文窗口。

## 理由

### 为什么能力模型而非 allow/deny

- 粒度更高：同一工具在不同上下文获得不同权限
- 可组合：能力集合支持交集、子集运算，子 Agent 权限自动收窄
- 面向未来：MCP 工具、动态工具同样需要精细权限控制

### 为什么隔离光谱而非二选一

- 跨平台：Docker 不是所有平台都有，进程沙箱各 OS 不同
- 适应性：不同用户、不同场景需要不同安全级别
- 解耦：工具代码不需要为每个隔离级别写单独实现（OpenClaw 的 `createSandboxedReadTool` 模式不可取）

### 为什么渐进信任而非静态模式

- 权限疲劳是真实的用户痛点——Claude Code 用户常抱怨频繁弹窗
- 一刀切 auto 模式又过于危险
- per-operation, per-project 的信任是最自然的平衡点

## 替代方案

### A: 照搬 Claude Code 的纵深防御

- 优势：已验证有效
- 劣势：~7000 行 Bash 安全代码是巨大负担；权限模式不够灵活
- 未采用原因：工程量与我们的阶段不匹配，且有更好的抽象

### B: 照搬 OpenClaw 的容器隔离

- 优势：物理隔离最强
- 劣势：强依赖 Docker；非沙箱模式无安全保障
- 未采用原因：不是所有场景都能用容器，需要更通用的方案

### C: 不做安全，交给用户自己负责

- 优势：最简单
- 劣势：不负责任；无法构建用户信任
- 未采用原因：安全是产品级智能体的基本要求

## 影响

- **Phase 1 影响最小**：现有 `ToolDefinition` 接口不需修改，直接实现 3 个内置工具
- **Phase 2 向后兼容**：`capabilities?` 是可选字段，旧工具自动推断
- **长期收益**：统一的安全模型覆盖所有工具来源和执行环境

## 引用

- [q05-工具系统安全](../../../_private/questions/q05-tool-system-security.md)
- [工具系统架构方案](../../../_private/notes/tool-system-design.md)
- OpenClaw: `src/agents/pi-tools.ts`, `src/agents/sandbox/`
- Claude Code: `checkPermissionsAndCallTool()`, Bash AST parser
