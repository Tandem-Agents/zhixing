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
| 6 | 三系统安全模块深度对比（含 Hermes + Claude Code 泄露源码） | [q06](../../_private/questions/q06-security-system-deep-dive.md) | 🔶 待审阅 |

## 核心发现

### 三种安全哲学

- **OpenClaw — 信任用户 + 容器隔离**：Docker/SSH 可插拔沙箱（非默认）；ExecSecurity×ExecAsk 矩阵 + ACP 工具分级；两阶段审批防竞态
- **Hermes — 上下文感知 + 外部扫描**：Tirith 外部扫描器 + 正则危险命令检测 + Smart(LLM) 审批；容器/非交互路径降级检查；`tirith_fail_open` 默认放行
- **Claude Code — 纵深防御 + OS 级沙箱**：8 层安全管线；2592 行 Bash AST 解析含 23 项编号检查；Seatbelt/bubblewrap OS 级沙箱；Auto 分类器(Sonnet 4.6)逐操作推理；服务端 Feature Flags 即时控制

### 共同模式

- fail-closed 默认值——未声明安全属性按最危险处理（Hermes 部分偏 fail-open）
- 受保护路径（`.git/` 等）不可绕过
- 工具结果大小必须限制
- 分层策略合并（多源规则按优先级合并）
- Break-Glass 机制（`dangerously*` 前缀 + 可观测性）
- 权限提示疲劳是共同挑战

### 各自不足

- OpenClaw：非沙箱模式安全保障有限；权限粒度仅到工具级；无服务端紧急控制
- Hermes：非交互路径无前置扫描；`tirith_fail_open: True`；容器后端完全跳检；Smart 审批有 LLM 误判风险
- Claude Code：~7000 行 Bash 安全代码维护成本极高；Auto 模式每次工具调用加一次推理（延迟+成本）；macOS 沙箱弱于 Linux；权限模式跳跃大

## 知行设计决策

三个核心创新：
1. **能力安全模型**：比工具级 allow/deny 粒度更高，能力 = 动作类型 + 资源范围 + 约束
2. **隔离级别光谱**：6 级（trust→remote），工具代码与隔离无关
3. **渐进式信任**：per-operation, per-project，解决权限疲劳 vs 安全的矛盾

加上 bypass-immune 声明式保护规则（借鉴 Claude Code 但更系统化）。

详见 [ADR-004](../../design/architecture/decisions/004-tool-system-architecture.md) 和 [工具系统架构方案](../../_private/notes/tool-system-design.md)。

## 对应源码分析

- [OpenClaw 安全系统](../../source-analysis/openclaw/security-system.md): `src/agents/sandbox/`, `src/security/`, `src/acp/`, `src/infra/exec-approvals.ts`
- [Hermes 安全系统](../../source-analysis/hermes-agent/security-system.md): `tools/approval.py`, `tools/tirith_security.py`, `tools/terminal_tool.py`, `tools/code_execution_tool.py`
- [Claude Code 安全系统](../../source-analysis/claude-code/security-system.md): 8 层权限管线, Bash AST (2592 行 / 23 项检查), Seatbelt/bubblewrap 沙箱, yoloClassifier.ts
- [综合深度调研](../../_private/questions/q06-security-system-deep-dive.md): 三系统交叉对比 + 知行设计启示
