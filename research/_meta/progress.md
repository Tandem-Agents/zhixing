# 研究进度追踪 (Progress Tracker)

> 追踪各认知域的研究状态，确保系统性覆盖

## 总览

| 认知域 | 状态 | 问题数 | 已完成 | 关键阻塞 |
|--------|------|--------|--------|----------|
| 01-核心循环 | 🔶 进行中 | 4 | 3 | q04 已完成；Outbox 顺序层已实现至 Phase 3 |
| 02-工具系统 | ✅ 基本完成 | 1 | 1 | q05(工具安全) 已完成 |
| 03-上下文管理 | ✅ 基本完成 | 4 | 4 | 源码分析 + 设计方案已完成 |
| 04-提示工程 | 🔲 待开始 | 0 | 0 | — |
| 05-安全模型 | 🔶 进行中 | 1 | 0 | q06(安全系统深度调研) 待审阅 |
| 06-插件架构 | 🔲 待开始 | 0 | 0 | — |
| 07-会话与记忆 | ✅ 基本完成 | 2 | 2 | 源码分析 + 设计方案 + M1-M6 实现已完成 |
| 08-交互界面 | ✅ 基本完成 | 1 | 1 | q06(CLI 架构) 已完成 |
| 09-协议与通信 | 🔲 待开始 | 0 | 0 | — |
| 10-部署与配置 | ✅ 基本完成 | 2 | 2 | q03(Provider) + q04(配置系统) 已完成 |

**状态图例**: 🔲 待开始 | 🔶 进行中 | ✅ 基本完成 | 🔁 持续更新

## 源码分析进度

| 目标系统 | 架构概述 | Agent Loop | Provider 层 | 配置系统 | 设计模式 | 容错韧性 | 上下文管理 | 会话持久化 | Skills/记忆 | 消息网关 | 安全系统 |
|----------|---------|-----------|-------------|---------|---------|---------|-----------|-----------|------------|-----------|----------|
| OpenClaw | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | ✅ |
| Claude Code | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | ✅ |
| Hermes Agent | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🔲 | ✅ | ✅ | ✅ |

## 设计产出进度

| 产出物 | 状态 | 依赖的认知域 |
|--------|------|-------------|
| 设计原则 | 🔲 待开始 | 需多个域的洞察积累 |
| 架构概述 | ✅ v0.9 已发布 | 01, 07, 10 |
| ADR-001 Monorepo 结构 | ✅ 已完成 | 全局 |
| ADR-002 Provider 架构 | ✅ 已完成 | 01, 10 |
| ADR-003 配置系统 | ✅ 已完成 | 10 |
| ADR-004 工具系统架构 | ✅ 已完成 | 02, 05 |
| ADR-006 安全系统架构 | ✅ 已完成 | 05 |
| 安全系统方案 | ✅ 已完成 | 05 |
| ADR-005 CLI 架构 | ✅ 已完成 | 08 |
| ADR-007 消息 Outbox 与因果排序 | ✅ 已完成 | 01, 07, 09 |
| 消息 Outbox 方案 | ✅ 已完成 | 01, 07, 09 |
| Phase 2 完整智能体方案 | ✅ 已完成 | 01, 02 |
| 容错引擎方案 | ✅ 已完成 | 01 |
| 上下文引擎方案 | ✅ 已完成 | 03 |
| L3 LLM 摘要压缩方案 | ✅ 已完成 | 03 |
| 会话持久化方案 | ✅ 已完成 | 07 |
| 记忆系统方案 | ✅ 已完成 | 07 |
| 技能进化系统方案 | ✅ 已完成 | 07 |
| 差异化策略 | 🔲 待开始 | 竞品分析 + 认知研究 |

## 实现进度

| 模块 | 包 | 状态 | 验证方式 |
|------|-----|------|---------|
| EventBus | `@zhixing/core` | ✅ 已完成 | 单元测试通过 |
| 核心类型 | `@zhixing/core` | ✅ 已完成 | tsc 编译通过 |
| Agent Loop | `@zhixing/core` | ✅ 已完成 | 单元测试通过（751 行测试） |
| MockLLMProvider | `@zhixing/core` | ✅ 已完成 | Agent Loop 测试中验证 |
| Provider 层 | `@zhixing/providers` | ✅ 已完成 | 单元测试 + 集成测试通过 |
| 配置系统 | `@zhixing/providers` | ✅ 已完成 | 单元测试通过 |
| Read/Write/Bash 工具 | `@zhixing/tools-builtin` | ✅ 已完成 | 单元测试通过 |
| Edit 工具 | `@zhixing/tools-builtin` | ✅ 已完成 | 355 行测试通过 |
| Glob 工具 | `@zhixing/tools-builtin` | ✅ 已完成 | 233 行测试通过 |
| Grep 工具 | `@zhixing/tools-builtin` | ✅ 已完成 | 单元测试通过 |
| CLI (REPL + 单次模式) | `@zhixing/cli` | ✅ 已完成 | 端到端验证 |
| 容错引擎 | `@zhixing/core` | ✅ 已完成 | 单元测试通过（重试 + 熔断器 + 错误分类） |
| Token 估算器 | `@zhixing/core` | ✅ 已完成 | 37 个单元测试通过（CJK/emoji/校准） |
| 上下文预算 | `@zhixing/core` | ✅ 已完成 | 20 个单元测试通过（百分比三级阈值） |
| L1: ToolResult 截断 | `@zhixing/core` | ✅ 已完成 | 13 个单元测试通过（按轮次年龄截断） |
| L2: 消息丢弃 | `@zhixing/core` | ✅ 已完成 | 9 个单元测试通过（首条+近N轮） |
| 上下文引擎 | `@zhixing/core` | ✅ 已完成 | 10 个集成测试通过（引擎+策略编排+事件） |
| Agent Loop 集成 | `@zhixing/core` | ✅ 已完成 | contextManager hook（~10 行改动） |
| 会话持久化 | `@zhixing/core` | ✅ 已完成 | 34 个单元测试通过（JSONL 序列化 + SessionStore CRUD） |
| L3: LLM 摘要压缩 | `@zhixing/core` | ✅ 已完成 | 29 个测试通过（7 段模板 + 校验 + CircuitBreaker） |
| CLI 上下文可视化 | `@zhixing/cli` | ✅ 已完成 | 预算状态 + 压缩过程渲染 |
| CLI 对话管理 | `@zhixing/cli` | ✅ 已完成 | /new + /resume（列+切统一入口）+ /name + /clear + REPL 启动 auto-resume |
| Frontmatter 解析器 | `@zhixing/core` | ✅ 已完成 | 16 个单元测试通过（parse+stringify+roundtrip） |
| Profile Loader (M1) | `@zhixing/core` | ✅ 已完成 | 9 个测试通过（加载+格式化+容错） |
| MemoryStore (M2) | `@zhixing/core` | ✅ 已完成 | 15 个测试通过（CRUD+搜索+分类） |
| Memory 工具 | `@zhixing/tools-builtin` | ✅ 已完成 | 4 个集成测试通过（save/list/search/delete） |
| PeopleStore (M3) | `@zhixing/core` | ✅ 已完成 | 15 个测试通过（CRUD+人名匹配+关系词映射） |
| SkillsStore (M4a) | `@zhixing/core` | ✅ 已完成 | 16 个测试通过（CRUD+Trigger+使用追踪+领域索引） |
| Skill Security (M4b) | `@zhixing/core` | ✅ 已完成 | 24 个测试通过（威胁扫描+block/warn+集成） |
| Skill Governance (M4c) | `@zhixing/core` | ✅ 已完成 | 12 个测试通过（版本追踪+归档/恢复+状态检测） |
| Memory Retriever | `@zhixing/core` | ✅ 已完成 | 3 个测试通过（技能+人物检索+使用记录） |
| JournalStore (M6) | `@zhixing/core` | ✅ 已完成 | 14 个测试通过（追加/扫描/生命周期/凝练） |
| Memory Flush (L1.5) | `@zhixing/core` | ✅ 已完成 | 13 个测试通过（提取+分流+Journal 追加+降级） |
| CLI 记忆集成 | `@zhixing/cli` | ✅ 已完成 | enrichContext+反思提示+/me/skills/people/journal |
| /skills audit | `@zhixing/cli` | ✅ 已完成 | 健康报告+archive/restore/delete 子命令 |
| 系统提示（技能进化） | `@zhixing/cli` | ✅ 已完成 | Skill Evolution 指导段+5 个测试通过 |
| Flush 管线集成 | `@zhixing/cli` | ✅ 已完成 | MemoryFlushStrategy 注入策略链（priority=3） |
| 效果推断 (M7a) | `@zhixing/core` | ✅ 已完成 | 19 个测试通过（否定检测+推断+持久化） |
| 检索优先级排序 (M7b) | `@zhixing/core` | ✅ 已完成 | 23 个测试通过（精确度×效果×新鲜度多维排序） |
| CLI Stale 提醒 (M7c) | `@zhixing/cli` | ✅ 已完成 | 启动时 stale+needs-update 检测 |
| Outbox Phase 1 顺序层 | `@zhixing/core` + `server` | ✅ 已完成 | 93 个 delivery 测试通过（per-target FIFO + Registry + Pipeline→Outbox→adapter 打通） |
| Outbox Phase 2 Tool Commitment | `core` + `server` + `tools-builtin` + `cli` | ✅ 已完成 | COMMITMENT_SIGNAL 信号 + commitToUser 绑定 + schedule 工具 commit-on-create + 系统提示抑制段 |
| Outbox Phase 3 Turn Slot 因果锁 | `core` + `server` + `tools-builtin` | ✅ 已完成 | 28 个 outbox slot 测试 + ScheduledTask.createdInTurn → OutboxEntry.afterSlot 数据链 + InboundRouter openSlot/fillSlot/abandonSlot 生命周期 |

## 里程碑

- [x] **M1**: 完成核心循环 + 工具系统的基本认知 → 理解智能体最小运行原理 ✅ 2026-04-06
- [ ] **M2**: 完成全部 10 个认知域的基本认知 → 整体架构认知建立
- [x] **M3**: 完成设计原则 + 架构概述 → 可以开始技术选型 ✅ 2026-04-06（v0.2）
- [x] **M4**: 完成首批 ADR → 可以开始项目搭建 ✅ 2026-04-06（ADR-001）
- [x] **M5**: EventBus + 核心类型 + Agent Loop MVP 完成 ✅ 2026-04-06
- [x] **M6**: Provider 层调研 + 设计完成 ✅ 2026-04-07（ADR-002）
- [x] **M7**: Provider 层实现 + 真实 AI 对话验证 ✅ 2026-04-07（硅基流动 + MiniMax-M2.5）
- [x] **M8**: 配置系统调研 + 设计完成 ✅ 2026-04-07（ADR-003）
- [x] **M9**: 配置系统实现 ✅ 2026-04-07
- [x] **M10**: Phase 2A 完成（Edit + Glob + Grep + CLI 集成）✅ 2026-04-08
- [x] **M11**: 容错引擎方案设计完成 ✅ 2026-04-08
- [x] **M12**: 容错引擎实现 → 指数退避 + 熔断器 + withRetry + 错误分类 ✅ 2026-04-08
- [x] **M13**: 上下文管理调研 + 方案设计 → Token 估算 + 3 层压缩策略 ✅ 2026-04-08
- [x] **M14**: Token 估算器实现 → CJK 感知 + 自适应校准 ✅ 2026-04-08
- [x] **M15**: 上下文预算 + L1/L2 压缩策略 + 引擎 + Agent Loop 集成 ✅ 2026-04-08
- [x] **M16**: 对话持久化实现 → JSONL + TranscriptStore + ConversationRepository + REPL 启动 auto-resume ✅ 2026-04-09
- [x] **M17**: L3 LLM 摘要压缩 → 7 段模板 + 校验 + CircuitBreaker ✅ 2026-04-09
- [x] **M18**: CLI 上下文状态集成 → 预算显示 + 压缩过程可视化 ✅ 2026-04-09
- [x] **M19**: Hermes Agent 源码分析 → 核心循环 + Skills 进化 + 分层记忆 + 消息网关 ✅ 2026-04-10
- [x] **M20**: 技能进化系统设计 → 四阶段生命周期 + 反思提议 + 使用追踪 + 治理 ✅ 2026-04-10
- [x] **M21**: 记忆系统全实现 → M1-M6 全部通过（139 个测试）+ Memory 工具 + CLI 集成 ✅ 2026-04-10
- [x] **M22**: /skills audit + Memory Flush (L1.5) → 治理闭环 + 压缩时自动提取记忆 ✅ 2026-04-10
- [x] **M23**: M7 效果反馈闭环 → 效果推断 + 检索优先级排序 + CLI stale 提醒（210 个测试通过） ✅ 2026-04-10
- [x] **M24**: 安全系统深度调研 → 三系统（OpenClaw/Hermes/Claude Code）安全架构交叉对比 + 源码分析 ✅ 2026-04-12
- [x] **M25**: Serve 模式健壮性 Step 16a-d + 16g-h → 飞书定时任务 E2E 打通（origin capture + 时间注入 + scheduler snapshot + 最小间隔保护 + delivery flush） ✅ 2026-04-20
- [x] **M26**: Step 16e Ephemeral Execution → 定时任务 runAgentTurn 绕过 ConversationManager，bare runtime → run → dispose，磁盘零痕迹（飞书 E2E 验证无 conv_xxx 新增） ✅ 2026-04-21
- [x] **M27**: 消息 Outbox 设计完成 → Step 16 E2E 暴露多生产者顺序倒转，产出规格 [message-outbox.md](../design/specifications/message-outbox.md) + [ADR-007](../design/architecture/decisions/007-message-outbox.md)；跨模块影响文档同步更新（conversation-model TurnId、ADR-004 ToolContext 扩展、persistent-service §4.7 Pipeline/Outbox 职责切分） ✅ 2026-04-21
- [x] **M28**: Outbox Phase 1 顺序层实现 → `@zhixing/core/delivery/outbox.ts` + `outbox-registry.ts`（per-target FIFO + adapter 超时兜底 + INV-1/5/6/7），DeliveryPipeline → OutboxSender → Outbox → adapter 整链打通；InboundRouter LLM 回复改走 Outbox；93 个 delivery 测试通过 ✅ 2026-04-21（commit 4a45a26）
- [x] **M29**: Outbox Phase 2 Tool-authored Commitment → ToolExecutionContext 增 `commitToUser` / `emissionTarget` / `turnId`，ToolResult 增 `committedToUser`；COMMITMENT_SIGNAL 常量写入 tool_result content（避免 ToolResultBlock 构造时 committedToUser 字段被丢）；schedule 工具 create 成功 → commit 短文本；系统提示 commitment 抑制段；AgentLoop 自动注入 toolName；9 个 schedule 工具测试通过 ✅ 2026-04-21（commit 8dc310b）
- [x] **M30**: Outbox Phase 3 Turn Slot 因果锁 → Outbox slot 状态机（openSlot/fillSlot/abandonSlot + TTL + drain promise/resolver 挂起避免 CPU 死循环 + logger safeLog 防 re-kick 无限循环 + fillSlot 未知/终态 slot 的 degrade-post 兜底）；ScheduledTask.createdInTurn → DeliverySource.scheduler.createdInTurn → OutboxEntry.afterSlot 数据链（outbox-sender.deriveAfterSlot 单点映射）；schedule 工具捕获 ctx.turnId；InboundRouter runChannelTurn 接入 openSlot/fillSlot/abandonSlot 生命周期；全量回归 2204 测试通过、6 包 build success ✅ 2026-04-21
- [x] **M31**: Phase 2 commitment 机制架构演化 → 飞书手动测试暴露"commitment + LLM 叙述"双重反馈冗余问题（3 条变 2 条）。分析后决策：Phase 3 已结构性保证顺序，Phase 2 commitment 失去核心价值 → schedule 工具不再主动调 `commitToUser`；`commitToUser`/`COMMITMENT_SIGNAL` API 保留作为"工具可选增强"；schedule.test.ts 删 4 条冗余测试 + 加 1 条"架构回归"测试；ADR-007 / message-outbox.md 加"Phase 2 演化"章节。用户收到 2 条消息（LLM 回复 + task fire），语义无冗余 ✅ 2026-04-21
- [x] **M32**: Delivery Pipeline Faithful Delivery 契约 → 飞书手动测试暴露 task fire 静默被吞：DedupFilter 默认启用（24h 窗口，按 content 去重），两个独立 task 巧合生成相同文本时第二条被 drop。分析后决策：内容去重是业务策略不是交付基础设施的职责，应在对应层各自处理（防 LLM 复读→Agent Loop；防重复 fire→Scheduler；防 channel 合并→Adapter）。删除 `DedupFilter` / `DeliveryFilter` / `FilterVerdict` + pipeline 的 filter 链；新增 "faithful delivery" 回归测试；顺带修复 pipeline.start() 的 fire-and-forget recovery flush 竞态（依赖 flushTimer 恢复）。persistent-service.md + implementation-roadmap.md 同步更新。回归 2201 测试通过、6 包 build success ✅ 2026-04-21
- [x] **M33**: Delivery Pipeline 生命周期契约收敛 → M32 审查发现三个架构债务一起修：(1) start() 移除 recovery flush 导致 crash 恢复延迟 0-30s，改为 awaited recovery flush，start 返回即"就绪 + 可恢复 work 已处理"；(2) 未 start 就 enqueue 会覆盖磁盘持久化数据（preexisting bug），加三态生命周期 state=unstarted/running/stopped + fail-fast 校验；(3) flush() 并发 caller 第二个立即 return 是 false positive（preexisting），改 singleflight 模式并发共享同一 drain promise。pipeline.ts 顶部加三契约文档段。净新增 9 条测试（lifecycle × 6 + recovery-defer × 1 + singleflight × 2）。全量回归 2210 测试通过、6 包 build success ✅ 2026-04-21
- [x] **M37**: OpenClaw / Hermes skill 子系统深读（为知行 skill 模块铺事实地基，"只分析不设计"）。产出 [openclaw/skill-system.md](../source-analysis/openclaw/skill-system.md)、[hermes-agent/skill-system.md](../source-analysis/hermes-agent/skill-system.md) 两篇实现级深读 + [skill-system-comparison.md](../source-analysis/skill-system-comparison.md) 横向对比，全部 file:line 落地，承重结论人工 verify。**核心结论**：(1) 进上下文三家趋同——仅索引(name+description[+location])进 system 稳定前缀 + 渐进披露(read 工具 / `skill_view`)按需读全文 + 显式缓存(openclaw session 快照 / hermes 进程内 LRU + mtime/size 磁盘快照)，回答了"skill 清单 vs prompt cache"悬案:内容不变则前缀缓存命中、改/装技能才失效;openclaw 注释自述与 Claude Agent Skills 格式逐字节对齐。(2) 真正分歧在进化与信任:OpenClaw 静态库无自主进化、信任靠安装期扫描(clawhub 默认 scan:false、仅 critical 阻断);Hermes 三层进化(后台复盘 fork iters≥10/白名单 memory+skills/复用父 prompt cache + 使用遥测状态机 + 7 天自治 curator)，靠 write-origin provenance 信任边界(只动 agent-created、bundled/hub/pinned off-limits)，且自建技能默认不扫。下一步:进入知行 skill 模块设计 ✅ 2026-05-25
- [x] **M36**: openclaw / hermes 本地源码升级后版本对照重核（openclaw `2026.4.27`→`2026.5.25`；hermes `0.11.0`→`0.14.0`；claude-code 未动）。两篇架构总览逐条对照新源码重核行号/路径/计数并就地更新，承重新结论人工 verify 通过。**重大结构变化**：(1) hermes 旧"单体巨型 `run_agent.py` 13441 行"已不成立——拆解为 `AIAgent` 薄 forwarder + `agent/` ~70 子模块，`run_agent.py` 仅 4410 行、主循环迁至 `agent/conversation_loop.py:644`；新增自治 Curator(0.12)/provider 与 gateway 插件化(0.13)/Kanban(0.13)/LSP 写后诊断(0.14)/Codex app-server runtime(0.14)/`hermes proxy`(0.14);并纠正"python 升 3.13"为仍 `>=3.11`（3.13 仅类型检查器目标）。(2) openclaw pi-* 依赖改 scope `@mariozechner`→`@earendil-works@0.75.4`；Google transport 转 provider 插件；owner-only 工具门禁移除；`runAgentHarnessAttemptWithFallback`→`runAgentHarnessAttempt`；`agent-paths.ts` 删除；行号/行数全面漂移已更新。README 索引同步 ✅ 2026-05-25
- [x] **M35**: 三家架构总览基于当前真实源码重核（openclaw/hermes/claude-code 各一篇「架构与方案设计总览」，源码 `_refs/`，每条论断落到真实文件/行号，承重事实人工抽查 verify）。关键纠正：(1) claude-code 旧文是社区博客转述的 v2.1.88 叙述，本地三件套实为**早期 CLI（deobf package.json v0.1.0 / claude-3-opus / 正则黑名单 / 单层配置 / 无工具循环）+ reverse 抓的较新对话版**，旧文「~1730 行 query()/4 层压缩/14 步管线/~4000 行 Bash AST/五层 settings」本地一律无法证实，已逐条标注；reverse 改用模型真实收到的 prompt/schema 为据。(2) openclaw 网关纠正为 `ws`+`node:http`（非 express/hono），运行时为「三层回退 + 可插拔 harness」（非双层）。(3) hermes 旧 README `run_agent.py ~9,200 行`订正为 13441 行。三篇连同 README 索引/本表已更新；旧分专题文档保留不动 ✅ 2026-05-25
- [x] **M34**: Pipeline 加固（R1/R2/R3） → M33 架构审查找到 3 个 polish 级 robustness 改进一起修：(R1) start() 的 recovery flush 遇 IO 错软降级（warn log 不抛），flushTimer 兜底重试；(R2) stop() 改为优雅关停——state=stopped → clearInterval → await activeFlush → save queue 的 4 步顺序，消除"关停时后台 send 泄漏"；(R3) flushTimer callback 开头加 `state !== "running"` 防御性 check，避免 race 边界的 Auto-flush error 噪音日志。新增 2 条测试（R1 soft-fail + R2 graceful shutdown）。全量回归 2212 测试通过、6 包 build success。**并同步记录 3 个 pre-existing 并发边缘**（KL-1 queue.save race / KL-2 start-stop timer 泄漏 / KL-3 同根）到 [persistent-service.md §4.7 Known Limitations](../design/specifications/persistent-service.md#known-limitations--并发边缘2026-04-21-记录未修)，建议单独工单处理不与本次耦合 ✅ 2026-04-21

---

> 每次研究完成后更新此文件，保持进度可见。
