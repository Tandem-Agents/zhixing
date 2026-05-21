# Transcript Schema 历史债务清理

> **状态**: 待起草决策(2026-05-21 备忘)
> **来源**: 外部架构审查发现 — ADR-CM-016 scope 扁平化(commit a2917df)后遗留的 4 项独立债务
> **不在范围**: 新对话自动命名(走 [staging.md](../staging.md))/ 其他 transcript 功能演进

## 事实层(grep 验证,2026-05-21)

### 债务 1:conversation-model.md L710 旧路径残留

[conversation-model.md L710](../specifications/conversation-model.md#L710):
```
Conversation 数据持久保留在 ~/.zhixing/projects/<id>/conversations/<convId>/transcript.jsonl
```

与 ADR-CM-016 / [conversation-scope-flattening.md](../specifications/conversation-scope-flattening.md) 矛盾。当前实际路径(grep 验证 [core/conversation/repository.ts:39-42](../../packages/core/src/conversation/repository.ts#L39)):
- user scope: `~/.zhixing/conversations/<convId>/`
- workscene scope: `~/.zhixing/workscenes/<sceneId>/conversations/<convId>/`

### 债务 2:`TranscriptHeader.projectPath` 死字段

[transcript/types.ts:24](../../packages/core/src/transcript/types.ts#L24) `projectPath: string` 字段定义。

全仓库 grep `.projectPath` 仅命中 2 处:
- [store.ts:79](../../packages/core/src/transcript/store.ts#L79) 构造时赋值
- [store.ts:139](../../packages/core/src/transcript/store.ts#L139) 写入 header

**生产代码零读取**,纯 write-only。

### 债务 3:`writeHeader` / `readHeader` 生产零调用

[transcript/serializer.ts:31](../../packages/core/src/transcript/serializer.ts#L31) `writeHeader` + [serializer.ts:142](../../packages/core/src/transcript/serializer.ts#L142) `readHeader` 定义。

全仓库 grep `writeHeader|readHeader` 仅 4 文件命中:
- `serializer.ts`(自身定义)
- `index.ts`(re-export)
- `__tests__/serializer.test.ts`(测试)
- `__tests__/normalize.test.ts`(测试)

**生产代码零调用**。可能是早期开发用 + 测试 fixture 用,现在被 `loadRecords` + `writeAtomic` 取代。

### 债务 4:已废弃 spec 处置方式不彻底

[session-persistence.md](../specifications/session-persistence.md) 顶部已有 3 段 deprecation 标注,但正文 §二 / §三 / §六 / §七 / §八 仍是过时设计内容(SHA-256 项目哈希 / `--continue/--resume/--name/--fork-session` / `SessionStore` 等)。

外部审查建议升级处置: 删正文 + 留 stub 指向 conversation-model.md §九。
当前处置: 保留正文 + 顶部 deprecation(与 [v2-redesign](../specifications/context-management-v2-redesign.md) / [phase2-complete-agent.md](../specifications/phase2-complete-agent.md) / [ADR-005](../architecture/decisions/005-cli-architecture.md) 同款"决策痕迹保留"模式)。

## 待决策点

1. **`TranscriptHeader.projectPath` 处置**:
   - A. 删除(更新 type / store / 测试 fixture / 文档,可能需要数据迁移)
   - B. 保留 + 文档化实际用途(turn 重放时的 cwd 还原?其他用途?)— 需找到/补一个真用例
2. **`writeHeader` / `readHeader` 处置**:
   - A. 删除函数 + 测试(改用 loadRecords / writeAtomic 等价路径)
   - B. 保留为公共 API(internal-only 项目,无外部消费者,公开 API 价值低)
3. **session-persistence.md 处置方式升级**:
   - A. 删正文,留 stub("本文档定义的持久化设计已整体迁移至 [conversation-model.md §九](...) — 设计历史决策痕迹见 git history")
   - B. 保留正文 + 顶部 deprecation(当前状态;与 v2-redesign / phase2 / ADR-005 同款)
   - 关键 trade-off:若选 A,**是否同步升级 v2-redesign / phase2 / ADR-005**(一致性原则)
4. **conversation-model.md L710 修正**:
   - 直接改路径到当前事实(user / workscene 双 scope),无 trade-off

## 不在范围

- 新对话自动命名(走当前 [staging.md](../staging.md))
- 其他 transcript schema 演进
- `ConversationScope` 三态→二态扁平化(已在 commit a2917df 完成)

## 后续动作

当前 [staging.md "新对话自动命名"](../staging.md) topic 实施完成后,启用本草稿决策 → 转为 staging topic 或直接修补(决定权由用户拍板)。
