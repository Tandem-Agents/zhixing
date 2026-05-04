# 草稿路线图 (Drafts Roadmap)

> 子模块级动态草稿的索引 + 维护规则。模块级设计走 `specifications/`；本文件承载比模块级更小、用完即弃的工作。

## 原则

本文档的维护规则。**原则稳定**；下方"当前草稿"区随起草生灭重写。

- **适用范围**：**小于模块级**的草稿——单工具、单 CLI flag、单协议字段、轻量 UX 调整等。模块级设计走 `specifications/*-execution.md` + 9 轮架构审查，**不放本文**。
- **草稿目的**：动手前**把关键决策定下来**。通常 1 页 markdown，5–10 个决策点 + 实施清单，~30 分钟写完。
- **草稿位置**：`research/design/drafts/<topic>.md` 单文件；本文件只是索引 + 状态。
- **生命周期**：
  1. **起草**：决策清单 + 实施清单
  2. **讨论**：决策落定
  3. **实施**：按清单做
  4. **合并**：决策内容并入对应模块级 spec（避免权威分散）
  5. **移除**：本文件列表删除该条目（草稿文件本身可保留为执行归档，但**不再是其他文档的引用源**）
- **条目格式**：草稿链接 + 状态 + 一行摘要 + 目标合并到（模块级 spec 路径）
- **状态标记**：起草中 / 讨论中 / 实施中 / 待合并（已合并即移除）
- **不放本文**（边界守卫）：
  - 模块级架构设计 → `specifications/`
  - 决策推演 / ADR → 对应 spec 的 ADR 段
  - 已合并草稿的内容 → 模块级 spec
  - 版本演化记录 → 原地改，不追加
- **何时升级为模块级 spec**：决策点 >10 个 / 涉及多模块协同 / 需要 ADR 长期留档 → 转为 `*-execution.md`，走完整审查流程

---

## 当前草稿

| 草稿 | 状态 | 摘要 | 目标合并到 |
|------|------|------|-----------|
| [首次配置·连接测试（被动）](drafts/onboarding-connection-test.md) | 待起草 | 配置编辑器提供用户主动触发的 API Key 连接测试，避免首次错误推迟到 REPL | [specifications/credentials-and-onboarding.md](specifications/credentials-and-onboarding.md) |

## 已升级到正式 spec

| 原草稿 | 目标 spec |
|------|-----------|
| WebFetch 工具（含网络出口与文本净化基础设施） | [specifications/network-egress.md](specifications/network-egress.md) + [specifications/tools-builtin.md](specifications/tools-builtin.md) |
| 网络代理支持（@zhixing/network proxy） | [specifications/network-egress.md §十三](specifications/network-egress.md) |
