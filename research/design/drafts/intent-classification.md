# 意图分类与产品语义二分

## 一、问题

通道（飞书等异步 IM）入站消息需要在多个语义层做分类决策——同一文本在不同上下文有不同含义。最初系统里**两套机制的词集分配不清**导致用户体验问题：

- 用户在 in-flight turn 时回复「停」，没有触发中止，被当对话回复处理
- 「取消」/「stop」/「cancel」字面是控制命令，却被划在 confirmation 拒绝路径

根因：`stop` / `cancel` / `停` / `取消` 这四个**字面就是控制命令**的词，原先放在 confirmation 的 `DENY_KEYWORDS` 里——这是历史遗留，跟字面语义错位。

## 二、产品语义二分

```
                  inbound message (任意文本)
                          │
                          ▼
              ┌─────────────────────────┐
              │  用户意图是叫停整个 turn?  │
              └────┬───────────────┬────┘
                   │ 是             │ 否
                   ▼                ▼
            ┌──────────┐    ┌────────────────┐
            │  CANCEL  │    │  当前是否在等   │
            │ (turn 级) │    │  用户授权工具?  │
            └────┬─────┘    └─┬──────────┬───┘
                 │             │ 是       │ 否
                 │             ▼          ▼
                 │      ┌──────────┐  ┌──────┐
                 │      │ APPROVE  │  │ 当对话 │
                 │      │  / DENY  │  │ 输入 │
                 │      │(tool 级) │  │      │
                 │      └────┬─────┘  └──────┘
                 │           │
                 ▼           ▼
        整个 turn abort   仅这一次工具调用 allow/deny
        agent 完全停下     agent 继续推理（换工具/直接答）
        反馈"已停止处理。"  反馈"❌ 已拒绝：<工具名>"
```

### 2.1 两个集合的语义边界

| 集合 | 字面语义 | 程序语义 | 关键词性质 |
|---|---|---|---|
| **CANCEL** | 控制命令 | turn 级中止（破坏性，不可逆） | "停" / "stop" / "取消" / "cancel" / "中止" / "打住" |
| **DENY** | 否定表态 | tool-call 级拒绝（局部，可恢复） | "不" / "不要" / "拒绝" / "算了" / "no" / "reject" |

**判断口诀**：
- 字面是"叫某事停"——归 CANCEL
- 字面是"对某事说不"——归 DENY

### 2.2 不冲突，是嵌套层级

`InboundRouter` 处理顺序：

1. **IntentClassifier** — 控制意图前置识别（最高优先级）
2. **ConfirmationHub** — pending-aware 拦截（中间层）
3. **ConversationManager.enqueue** — 当对话回复处理（最内层）

CANCEL 命中即 return，不再走 DENY 路径。同一文本不会触发多个层。

### 2.3 字面互斥不变量

`cancel ∩ (approve ∪ deny) = ∅` 由 `IntentClassifier` 启动期 `assertDisjoint` 强制保证——冲突时启动 fail-fast，优于在生产产生歧义。

## 三、设计哲学：宁可漏不可误

CANCEL 集合的设计准则是**保守缩小**，不是广覆盖。

**代价不对称**：
- 误触代价：整个 turn 被 abort，用户失去**全部进度**——破坏性、不可逆
- 漏触代价：用户重发一个词——麻烦但**可恢复**

破坏性操作永远应保守。误触一次的代价远大于漏掉一两个长尾词的代价。

**入选标准**：单词/短语**单独成消息**时几乎只能是"叫停整个 turn"的意图。

**精确匹配的安全边际**：
- "打断一下" ≠ "打断"（精确字面）—— 用户在长串/连续语境下输入不会误触
- "我想中止订阅" ≠ "中止" —— 含关键词的对话内容不会误触

但仍排除：
- 单独成消息有歧义的词（"够了" / "行了" / "好了"）
- 上下文强相关的长句（"别写了" / "别答了" 在 agent 不在做对应事时语义错位）
- "暂停"——语义错（暂时停可恢复，非 cancel）

## 四、最终词集

### CANCEL（叫停整个 turn）

```
显式控制命令：    /cancel  /stop  /abort
英文控制词：      stop  cancel
中文核心控制词：  停  停止  停下  停一下  中止  中断  终止  取消  打住
```

### DENY（拒绝当前 confirmation）

```
英文：  n  no  nope  deny  reject
数字：  2
中文：  不  不行  不要  不用  拒绝  否
        不同意  不可以  不批准  不通过  不允许
口语：  算了  别  不了
```

### APPROVE（同意当前 confirmation）

```
英文：  y  yes  yep  yeah  yup  ok  okay  sure  approve
数字：  1
中文：  好  好的  好啊  行  行的  可以  同意  允许
        批准  通过  执行  继续  没问题  开始
口语：  干吧  去吧  做吧  来  来吧  嗯  嗯嗯
```

## 五、用户场景验证

| 场景 | 用户输入 | 路径 | 结果 |
|---|---|---|---|
| agent 弹 "rm -rf 是否允许" | "不" | DENY | 只拒绝这次删除，agent 改方案继续 |
| agent 弹 "rm -rf 是否允许" | "停" | CANCEL | 整个 turn 中止，"已停止处理。" |
| agent 弹 "rm -rf 是否允许" | "取消" | CANCEL | 整个 turn 中止，"已停止处理。" |
| agent 在写第 6 个文件 | "停" / "stop" / "取消" | CANCEL | 整个 turn 中止 |
| agent 完全空闲 | "停" | CANCEL → abort 0/0 | "当前没有正在处理的任务。" |
| agent 完全空闲 | "不要" | enqueue agent | 当对话回复，agent 给"不要什么呀？"之类 |
| confirmation pending + "stop" | "stop" | CANCEL（前置拦截） | 整个 turn 中止；pending confirmation 自然失效 |

## 六、扩展机制

### 6.1 用户配置追加

`ZhixingConfig.intent.cancelKeywords` 提供配置层扩展点。用户/团队的额外习惯词与 `DEFAULT_CANCEL_KEYWORDS` append 合并：

```json
{
  "intent": {
    "cancelKeywords": ["收手", "halt"]
  }
}
```

合并后通过同样的 `assertDisjoint` 校验——配错词跟 confirmation 集合冲突时启动 fail-fast。

### 6.2 全局 + 项目两级合并

- 全局配置（`~/.zhixing/config.json`）+ 项目配置（`zhixing.config.json`）的 `intent.cancelKeywords` 是 **append** 合并
- 用户在两层都配的词都生效，避免误删默认/全局值

## 七、修改范围

| 文件 | 改动 |
|---|---|
| `packages/server/src/intent/cancel-keywords.ts` | DEFAULT 集合扩到 14 词；顶部注释重写为"宁可漏不可误"哲学；说明产品语义二分边界 |
| `packages/server/src/confirmation/match.ts` | DENY 移除 `stop` / `cancel` / `停` / `取消`；顶部注释加产品语义二分说明 |
| `packages/server/src/intent/__tests__/intent-classifier.test.ts` | 测试覆盖新加词走 cancel；旧的"DENY 中含'停'/'取消'"测试整条删除（语义已改） |
| `packages/server/src/confirmation/__tests__/match.test.ts` | DENY 期望列表去掉 4 词；新增"控制命令型词走自由文本 deny"反向覆盖 |

## 八、不变量与回归保护

| 不变量 | 验证 |
|---|---|
| 字面互斥（cancel ∩ approve ∪ deny = ∅） | `intent-classifier.ts` `assertDisjoint` 启动期校验；测试断言所有 DEFAULT 词无冲突 |
| 精确匹配（无 substring 误触） | "我想中止订阅" → non-control |
| 末尾标点 trim | "停止。" / "停下！" → control |
| 大小写无关 | "/CANCEL" / "/STOP" → control |
| 控制命令型词在 confirmation 路径 | 走自由文本 deny（带 reason），不会丢失"用户拒绝"语义 |
| 生产路径下 IntentClassifier 优先级 | InboundRouter 在 confirmation 拦截**之前**调 IntentClassifier，不会走到 confirmation 自由文本 deny 路径 |

## 九、未来演进

- 添加更多 control intent 类型（如 `/help` / `/status`）：`ControlIntent` 已是判别联合，扩 kind 即可，不破坏现有 cancel 分支
- 卡片按钮取消：飞书卡片 callback 解析为同一 `ControlIntent.cancel`（matchedKeyword 字段标识来源），路由代码完全复用
- 远程意图识别（LLM 判定）：不引入——控制意图必须**确定性**，不能 model drift / 无意触发；关键词机制覆盖率以保守为本，比"全准确率"更重要
