# 认知域 05：安全模型 (Security Model)

> 理解智能体如何在强大能力与安全约束之间取得平衡

## 领域概述

智能体拥有读写文件、执行命令、访问网络等强大能力，安全模型决定了这些能力何时可用、需要什么级别的授权、以及如何防止误操作和恶意利用。

## 关键问题清单

| # | 问题 | 文件 | 状态 |
|---|------|------|------|
| 1 | 权限模型是怎样的？哪些操作需要用户审批？ | [q05](../../_private/questions/q05-tool-system-security.md) | ✅ 已研究 |
| 2 | 命令执行的沙箱是如何实现的？ | [q05](../../_private/questions/q05-tool-system-security.md) | ✅ 已研究 |
| 3 | 文件系统访问的安全策略是什么？ | [q05](../../_private/questions/q05-tool-system-security.md) | ✅ 已研究 |
| 4 | 敏感信息（密钥、凭证）如何管理？ | — | 🔲 待研究 |
| 5 | 用户审批流是如何嵌入工作流的？ | [q05](../../_private/questions/q05-tool-system-security.md) | ✅ 已研究 |

## 核心发现

### 两种安全哲学

- **OpenClaw — 信任用户 + 容器隔离**：容器是可选的（非默认）；非沙箱模式安全靠配置；工具级 allow/deny
- **Claude Code — 纵深防御 + 进程沙箱**：7 层权限管线；~7000 行 Bash AST 解析；bypass-immune 保护区；macOS seatbelt / Linux bubblewrap

### 共同模式

- fail-closed 默认值——未声明安全属性按最危险处理
- 受保护路径（`.git/` 等）不可绕过
- 工具结果大小必须限制

### 各自不足

- OpenClaw：非沙箱模式无安全保障；权限粒度不够
- Claude Code：~7000 行 Bash 安全代码维护成本极高；权限模式一刀切导致权限疲劳

## 知行设计决策

三个核心创新：
1. **能力安全模型**：比工具级 allow/deny 粒度更高，能力 = 动作类型 + 资源范围 + 约束
2. **隔离级别光谱**：6 级（trust→remote），工具代码与隔离无关
3. **渐进式信任**：per-operation, per-project，解决权限疲劳 vs 安全的矛盾

加上 bypass-immune 声明式保护规则（借鉴 Claude Code 但更系统化）。

详见 [ADR-004](../../design/architecture/decisions/004-tool-system-architecture.md) 和 [工具系统架构方案](../../_private/notes/tool-system-design.md)。

## 对应源码分析

- OpenClaw: `src/agents/sandbox/`, `src/agents/tool-policy-pipeline.ts`, `src/infra/exec-approvals.ts`
- Claude Code: 7 层权限管线, Bash AST (~7000 行), seatbelt/bubblewrap 沙箱
