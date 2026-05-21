# 会话持久化方案(归档 stub)

> **状态:已被归并(2026-05-21)**
>
> 本文档定义的 JSONL 持久化层已**完整归并**到 [`conversation-model.md`](./conversation-model.md) §九 "Transcript 持久化",作为单一事实源。原 §一-§八 正文(2026-04-09 起草的竞品对比 / 启动参数恢复模式 / SHA-256 项目哈希 / `SessionStore` 接口等过时设计内容)整段移除;设计演进的决策痕迹见 git history。
>
> 本文件保留为引用入口(避免外部链接 404),不再承载任何 active 规格。

## 当前权威 —— 按维度索引

| 维度 | 当前权威位置 |
|---|---|
| Transcript JSONL 行格式(Header / Turn / Compact) | [conversation-model.md §9.2](./conversation-model.md) |
| 文件路径(user / workscene 双 scope) | [conversation-model.md §9.1](./conversation-model.md) |
| Turn-complete 追加策略 + commitTurn 原子单一入口 | [conversation-model.md §9.5](./conversation-model.md) |
| 上下文压缩与段切换 | [context-management-v3-redesign.md](./context-management-v3-redesign.md) |
| CLI 启动 / 对话查看与切换 | [conversation-model.md §11.2](./conversation-model.md) — 启动统一 auto-resume + REPL 内 `/switch` / `/new` / `/name` |
| TranscriptStore 接口契约 | 代码层 `packages/core/src/transcript/` + ADR-CM-015 / ADR-CM-017 |
