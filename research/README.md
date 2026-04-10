# 知行研究体系 (Zhixing Research System)

> 认知工程系统 —— 从疑问到研究、从研究到洞察、从洞察到设计决策

## 体系定位

本体系服务于「知行」项目的前期认知构建阶段，目标是在动手实现之前，系统性地理解独立部署智能体（如 OpenClaw、Claude Code）的架构本质、设计模式与技术细节，并逐步凝练出我们自己的架构设计。

## 模块导航


| 模块       | 路径                                       | 职责                                            |
| -------- | ---------------------------------------- | --------------------------------------------- |
| **认知研究** | `[insights/](./insights/)`               | 按认知域组织的 Q&A 研究，从源码和公开资料中提取真实有效的认知             |
| **源码解析** | `[source-analysis/](./source-analysis/)` | 对 OpenClaw、Claude Code、Hermes Agent 等系统的深度源码分析，作为认知研究的事实基础 |
| **竞品图谱** | `[landscape/](./landscape/)`             | 同类产品的系统化对比分析，识别差异化机会                          |
| **设计中心** | `[design/](./design/)`                   | 从认知研究中凝练的设计原则、架构决策、功能规格                       |
| **模板系统** | `[_templates/](./_templates/)`           | 文档模板，确保研究产出的质量一致性                             |
| **元信息**  | `[_meta/](./_meta/)`                     | 术语表、信息源索引、研究进度追踪                              |


## 认知构建工作流

```
提问 ──→ 研究 ──→ 审阅 ──→ 提炼 ──→ 设计
 │        │        │        │        │
 记录到    AI 查资料  你确认     脱敏通用化  更新
_private/ + 分析源码  研究结论   → insights/ design/
```

### 具体步骤

1. **提出问题** — 在 `_private/questions/` 中创建草稿文件，记录原始问题（不公开）
2. **交叉研究** — 搜索公开资料 + 深入 OpenClaw 源码 + Claude Code 公开架构分析，研究发现写回同一草稿文件
3. **⚠️ 审阅确认（门禁）** — 你审阅研究结论，质疑、补充或确认。**未经此步确认，不得进入下一步**
4. **提炼公开** — 经你确认后，将研究成果脱敏、通用化，提炼到 `insights/` 对应文件
5. **反馈到设计** — 当洞察足以支撑某个设计决策时，写入 `design/`
6. **持续迭代** — 新的认知可能推翻或修正已有结论，持续演进

> **注意**：`source-analysis/` 是客观的源码事实记录，可随研究过程同步更新，不受审阅门禁约束。

## 设计原则

- **可追溯性** — 每个设计决策都能追溯到具体的认知研究
- **渐进式发现** — README → Overview → Detail → Deep Dive，按需深入
- **关注点分离** — 研究、源码分析、设计、竞品各自独立
- **模板驱动** — 统一的文档模板确保质量一致性
- **演进式架构** — 设计文档随认知深化而演进，不是一次性产物
- **双源验证** — 每个问题至少交叉参考两个独立信息源

## 信息源

- **OpenClaw 源码** — [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)
- **Claude Code 架构** — 基于公开的架构分析和社区整理
- **Hermes Agent 源码** — [github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) — Nous Research 的自主进化型开源智能体
- **公开资料** — 官方文档、技术博客、论文、社区讨论

## 与实现的关系

本体系的产出直接服务于未来的代码实现：

- `design/principles.md` → 编码时的设计准则
- `design/architecture/overview.md` → 项目脚手架的蓝图
- `design/architecture/decisions/` → 技术选型的依据
- `design/specifications/` → 功能实现的规格说明
- `design/differentiators.md` → 确保我们不是"又一个克隆"

