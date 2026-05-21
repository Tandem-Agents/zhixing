# Conversation Scope 去 cwd 隔离（user-level 默认化）

> 触发于 2026-05-20：审视 conversation 持久化布局发现产品/实现错位。本 spec 承载完整设计与实施契约。
>
> 产品定位锚定：知行的核心产品哲学是「任意目录运行效果一致、对话跟着人走不跟着目录走」（[ADR-003 §workspace 是用户级偏好](../architecture/decisions/003-config-system.md#L62) 焊死）。本 spec 在 conversation 持久化层兑现这条不变量。

## 一句话

`ConversationScope` 从 `user | project | workscene` 三态收敛为 `user | workscene` 二态；cli/serve 入口构造 user scope；`getProjectId` 工具函数及其消费链一并删除——dead variant + dead function + 与产品哲学逆向的 cwd 自动隔离机制，本次一次性根除。

## 触发背景

### 事实层（grep 验证 2026-05-20）

1. `{ kind: "user" }` variant 自定义为 `ConversationScope` union 一员，但**生产代码无任何 caller 构造它**——只在 `core/conversation/__tests__/repository.test.ts` 与 `cli/runtime/__tests__/task-list-stores.test.ts` 的 fixture 里出现。设计预设留口子但实际从未启用——dead variant。
2. cli 启动（[`repl.ts:1108`](../../packages/cli/src/repl.ts#L1108)）与 serve 启动（[`serve/command.ts:179`](../../packages/cli/src/serve/command.ts#L179)）都按 `getProjectId(cwd)` 算 12 位 hex hash 构造 `project` scope，把每个 cwd 的对话隔离到 `~/.zhixing/projects/<projectId>/conversations/<convId>/`。
3. `scope.projectPath` 字段（同 union variant 的 string 字段）grep 全仓库**无任何 read**——是 dead field。
4. `getProjectId` 工具函数除 cli/serve 两处即将删除的 caller 外**无其他生产 caller**——是仅服务于 conversation scope 的孤立 utility。
5. 用户机器上 `~/.zhixing/projects/<projectId>/` 下**只有 `conversations/` 一个子目录**——没有其他项目级数据需要保留语义。

### 与产品哲学的错位

- 知行是个人 AI 助手，定位"跟着人走不跟着目录走"
- cwd 自动隔离 conversation 是 IDE 工具的思路（VSCode workspace 那种）
- 这条逆向机制让"用户切目录就看不到对话历史"——产品语义错位
- 同时 `project` 这个概念在知行产品中**不对应任何用户可感知抽象**——没有"项目"这个产品对象，hash 目录纯粹是实现技术冒充了产品概念

## 产品决策（已敲定，无需再对齐）

1. **conversation 默认走用户级**：用户在任意 cwd 起 cli 都看到同一坨对话历史
2. **推荐"一个对话够用"**：产品定位上引导用户主要使用 default 对话；多对话能力（`/new` / `/resume`）作为高阶兜底能力完整保留
3. **project scope 整段废除**：包括 union variant、cli/serve 构造点、`getProjectId` utility 及其所有引用
4. **workscene scope 不动**：那是用户**显式**创建的工作语境实体，与 cwd 自动隔离机制独立，不混淆

## 设计目标

- **接口面收敛**：`ConversationScope` 二态干净
- **路径源单一**：`conversationsDir(scope)` 成为唯一 scope→path dispatcher，cli/serve 等所有消费者复用，杜绝独立拼接
- **dead code 原地清理**：dead variant / dead field / dead utility 不留向后兼容 shim
- **零数据迁移**：知行未发布，旧用户磁盘上的 `~/.zhixing/projects/<hash>/conversations/` 留在原位即可（孤儿目录，无任何代码引用），用户可手动清理或忽略——新代码不写、不读、不感知

## 实施层次

### Layer 1 · 接口契约重设

[`packages/core/src/conversation/types.ts`](../../packages/core/src/conversation/types.ts) `ConversationScope` 收敛：

```ts
export type ConversationScope =
  | { kind: "user" }
  | { kind: "workscene"; sceneId: string };
```

破坏性内部 union 变更。下游 caller 仅 [`repository.ts conversationsDir`](../../packages/core/src/conversation/repository.ts#L32-L41) 一处 dispatcher + cli/serve 两处构造点 + 单测 fixture——影响面有限可控（见 Layer 4 完整清单）。

`scope.projectPath` 字段随 variant 一并消失（grep 验证 dead）。

### Layer 2 · Repository 简化 + 路径源 export

[`packages/core/src/conversation/repository.ts`](../../packages/core/src/conversation/repository.ts) 的 `conversationsDir` 改造：

1. **二分支收敛**：

```ts
export function conversationsDir(scope: ConversationScope): string {
  if (scope.kind === "workscene") return getWorkSceneConversationsRoot(scope.sceneId);
  return path.join(getZhixingHome(), "conversations");
}
```

2. **从 module-private 提升为 module-export**：当前 `conversationsDir` 是文件内部函数，cli 各处独立取路径（main startup 用 `path.join(...)`、workscene enter 直接调 `getWorkSceneConversationsRoot`），serve 也独立拼接。本次统一为 conversation 模块的**对外路径源 API**：cli 全部 conversation 路径取得（main startup + workscene enter）+ serve 都通过 `conversationsDir(scope)` 单一入口，与 TranscriptStore 共用同源结果。

   核心收益是**跨 scope 同构契约**——user 与 workscene 两态都走同一 dispatcher；同时 cli/repl.ts 不再直接 import `getWorkSceneConversationsRoot`，消除跨模块 internal path getter 依赖；未来增加 scope 时入口无需同步改动（单点扩展）。

   [`packages/core/src/conversation/index.ts`](../../packages/core/src/conversation/index.ts) 同步加 re-export。

### Layer 3 · cli/serve 入口改造

**改动总览**（cli 与 serve 改造结构对称——都做"删 `getProjectId` / 改 scope / 复用 `conversationsDir`"；TranscriptStore 第二参来源各自保留：cli=`process.cwd()`、serve=`workspace` 命令行参数，本次不动）：

| 改动项 | cli ([`repl.ts:1103-1112`](../../packages/cli/src/repl.ts#L1103-L1112)) | serve ([`serve/command.ts:178-181`](../../packages/cli/src/serve/command.ts#L178-L181)) |
|---|---|---|
| 删 `getProjectId(cwd)` 调用 | ✓ | ✓ |
| 删 `const projectId = ...` 局部 var | ✓ | ✓ |
| 改 scope 为 `{ kind: "user" }` | ✓ | ✓ |
| `convDir` 改为复用 `conversationsDir(scope)` | ✓ | ✓ |
| `getProjectId` import 删除 | ✓ | ✓ |

改造后的 cli 入口片段（serve 同款）：

```ts
const scope: ConversationScope = { kind: "user" };
const convRepo = new ConversationRepository(scope);
const convDir = conversationsDir(scope);    // 单一路径源
const store = new TranscriptStore(convDir);
```

**workscene enter 流程同步改造**：

- [`packages/cli/src/repl.ts:1389`](../../packages/cli/src/repl.ts#L1389) `getWorkSceneConversationsRoot(sceneId)` 改为 `conversationsDir({ kind: "workscene", sceneId })`，与 main startup 路径取得方式一致
- [`packages/cli/src/repl.ts:51`](../../packages/cli/src/repl.ts#L51) 顶部 `getWorkSceneConversationsRoot` import 同步删除——cli 不再跨 conversation 模块边界直接 import workscene 模块的 internal path getter

**`getProjectId` 函数本身一并删除**：

- [`packages/core/src/paths.ts`](../../packages/core/src/paths.ts#L44-L47) 删除 `getProjectId` 函数实现
- 同文件 line 7 模块头注释删除 `getProjectId()` 一行
- [`packages/core/src/transcript/__tests__/store.test.ts`](../../packages/core/src/transcript/__tests__/store.test.ts) 删除 "getProjectId" describe block（line 39-62，4 个 test case）+ 同步删除 line 7 的 `import { getProjectId } from "../../paths.js"`（describe 删后变 dead import）
- 全仓库再次 grep 验证零残留 import

理由：dead utility 不保留是"避免架构债务"原则的直接落实——未来若真需要 cwd hash（如 telemetry 匿名化），是另一个独立设计决策的产物，5 行代码重写不构成保留负担；保留 dead utility 等同于保留 dead API surface。

### Layer 4 · 测试改造

**全仓库 ConversationScope 影响清单**（grep 验证完整）：

| 文件 | 性质 | 改动 |
|---|---|---|
| [`core/conversation/types.ts`](../../packages/core/src/conversation/types.ts) | 类型定义 | 删 `project` variant（Layer 1） |
| [`core/conversation/repository.ts`](../../packages/core/src/conversation/repository.ts) | dispatcher | 二分支收敛 + 函数 export（Layer 2） |
| [`core/conversation/index.ts`](../../packages/core/src/conversation/index.ts) | re-export | 加 `conversationsDir` re-export |
| [`core/conversation/__tests__/repository.test.ts`](../../packages/core/src/conversation/__tests__/repository.test.ts) | 单测 | 删 `PROJECT_SCOPE` fixture（line ~34-37）+ 删所有 project scope 相关 test case；`USER_SCOPE` 从"dead variant 覆盖"升格为主路径覆盖 |
| [`cli/src/repl.ts`](../../packages/cli/src/repl.ts) | 生产 caller | Layer 3 改造（两处：main startup 路径取得 + workscene enter 路径取得） |
| [`cli/src/serve/command.ts`](../../packages/cli/src/serve/command.ts) | 生产 caller | Layer 3 改造 |
| [`cli/runtime/__tests__/task-list-stores.test.ts`](../../packages/cli/src/runtime/__tests__/task-list-stores.test.ts) | 单测 | `USER_SCOPE` fixture 已用，**无需改动**；运行验证通过即可 |

**`getProjectId` 影响清单**（grep 验证完整）：

| 文件 | 改动 |
|---|---|
| [`core/paths.ts`](../../packages/core/src/paths.ts) | 删函数实现 + 模块头注释 |
| [`core/transcript/__tests__/store.test.ts`](../../packages/core/src/transcript/__tests__/store.test.ts) | 删 `getProjectId` describe block（line 39-62，4 个 test case）+ 同步删 line 7 的 `import { getProjectId }` |
| [`cli/src/repl.ts`](../../packages/cli/src/repl.ts) | 删 import + caller（Layer 3） |
| [`cli/src/serve/command.ts`](../../packages/cli/src/serve/command.ts) | 删 import + caller（Layer 3） |

### Layer 5 · spec 同步

[`specifications/conversation-model.md`](conversation-model.md) 当前 §3.1 `ConversationScope` 类型定义仍是 `user | project` 两态，与实际代码的 `user | project | workscene` 三态存在**预先存在的 spec/code 漂移**（workscene 子系统已落地但 conversation-model.md 未同步）。本次借改写之机一并消除漂移：

- 删 `{ kind: "project"; projectId; projectPath }` variant 段落（line ~172）
- 补 `{ kind: "workscene"; sceneId: string }` variant —— **同步既有事实**，承认 workscene 已是 ConversationScope 合法 variant；workscene 子系统设计权威在其专属 spec，本处只承载 variant 类型契约本身，不展开 workscene 设计
- 删「用户在编程项目中需要项目隔离的对话」理由段（line ~1465）
- 加段落明示「conversation 跟着用户走、不绑 cwd」与 [ADR-003](../architecture/decisions/003-config-system.md#L62) 对齐
- 加 `conversationsDir` 作为对外路径源 API 的契约说明

最终 conversation-model.md `ConversationScope` 与代码同步到 `user | workscene` 二态。

## 关键 trade-offs（已决策）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 旧数据 `~/.zhixing/projects/` 迁移 | **不做** | 知行未发布无外部用户；本仓库开发者机器上的旧目录是孤儿磁盘垃圾，无任何代码引用，可手动清或忽略；零迁移即零失败 UX 设计负担 |
| `getProjectId` utility 保留 vs 删 | **删** | 保留 dead utility 即保留 dead API surface；"未来可能用"是 YAGNI 反面；真要 cwd 匿名化是另一独立设计决策、5 行代码重写不构成保留负担 |
| `conversationsDir` 函数 export | **export** | 跨 scope 同构契约：user 与 workscene 两态都通过同一 dispatcher 取路径，cli/serve 单点接入；未来加 scope 时入口零改动 |
| `transcript header.projectPath` 字段命运 | **已清理** | 后续 transcript schema 清理 spec 中实施完成,字段与 TranscriptStore 第二参一并删除 |
| 重命名 `kind: "user"` 为其他名 | **不重命名** | 二态语义下 user 含义清晰，重命名是无收益改动 |

## 不在范围

以下条目存在但本次不动，独立评估：

- **`workscene` scope 子树**：独立产品概念，不混在本次清理
- **conversation `delete()` 走 trash 的 dead 入口**：除 enter workmode fail-back undo 那一处外无 caller、且 trash 清理器为 vapor commitment——是另一条独立 dead path 清理，不在本次范围

## 实施清单

按依赖顺序：

1. **Layer 1 + Layer 2**：core 包内 types.ts + repository.ts + index.ts 改造（接口面收敛 + 函数 export）
2. **Layer 4 core 部分**：删 `core/conversation/__tests__/repository.test.ts` 的 PROJECT_SCOPE 相关 case
3. **Layer 3**：cli/serve 入口改造 + cli workscene enter 流程同步改造（含 `getProjectId` 与 `getWorkSceneConversationsRoot` import 清理）
4. **Layer 3 follow-up**：core/paths.ts 删 `getProjectId` + transcript 单测删对应 describe block
5. **Layer 5**：conversation-model.md spec 同步
6. **验证**：
   - core 包测试零回归
   - cli 包测试零回归
   - `pnpm -F @zhixing/core build` + `pnpm -F @zhixing/cli build` 类型零错误
   - 手动验证：清空 `~/.zhixing/conversations/` 后 cli 启动正常创建 default conversation；切换 cwd 启动看到同一坨对话历史

## 验收

- `ConversationScope` 二态，TS 编译期无 `project` 字面量遗留
- `getProjectId` 函数 + import + 单测三处零残留（grep 验证）
- `~/.zhixing/projects/` 不再被任何生产代码引用（grep `"projects"` 在 packages/ 下零业务命中）
- cli/serve 启动后 conversation 落地到 `~/.zhixing/conversations/<convId>/`
- 既有 user scope 测试覆盖升格为主路径覆盖（不再标注 "dead variant"）

## 后续可独立评估项

不阻塞本次实施，作为路线图项独立评估：

- conversation `delete()` 的 dead 入口清理（含 trash 路径）
- 多对话能力的产品 UX 收敛（既然推荐"一个对话够用"，`/resume` 列表的展示策略是否需要简化）
