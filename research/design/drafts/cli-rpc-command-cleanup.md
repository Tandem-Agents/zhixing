# `zz rpc` 外部指令清理临时文档

> 临时文档：只用于清理 `zz rpc` 外部指令期间同步事实、需求和改造计划。清理完成并沉淀到正式规范、测试或代码后删除本文。

## 总结论

`RPC` 能力本身是系统协议能力；`zz rpc` 是当前把这套协议暴露到命令行的调试客户端。

按当前产品原则，普通用户不应通过 `zz rpc ...` 使用知行功能。外部 `zz` 指令应尽可能少，只保留必要、基础、明确的入口；业务功能应优先放进交互模式或正式接入面。未来自有移动端 / 桌面端 / Web App 如果需要连接知行核心，也应直接走协议、API 或 SDK，而不是 shell out 执行 `zz rpc`。

因此，`zz rpc` 不应作为 0.1 用户外部命令存在。最优方案不是隐藏它，而是从生产态 `zz` 命令树彻底移除。经清理前核查，CLI RPC 客户端层没有真实生产调用者，因此随命令一起删除；RPC 协议能力保留在 server / client 协议层。

## 清理前现状

### 清理前 CLI 入口

`packages/cli/package.json` 当前把两个 bin 指向同一个构建入口：

- `zz` -> `./dist/index.js`
- `zhixing` -> `./dist/index.js`

`packages/cli/src/index.ts` 当前注册的外部命令包括：

- `zz`
- `zz status`
- `zz stop`
- `zz rpc [method] [args...]`
- `zz serve`
- `zz serve logs`
- 隐藏兼容入口：`zz serve status`
- 隐藏兼容入口：`zz serve stop`

其中 `zz`、`zz status`、`zz stop` 是已确认需要保留的基础外部入口。`zz rpc` 当前仍是可见顶层命令。

### 清理前核查事实

清理前代码已经具备移除 `zz rpc` 的基础：

- `packages/cli/src/rpc/command.ts` 已独立导出 `runRpcCommand()`。
- `packages/cli/src/index.ts` 的 Commander 注册只是调用 `runRpcCommand()`，不是 RPC 能力本身。
- `packages/cli/src/rpc/__tests__/command.test.ts` 已直接测试 `runRpcCommand()`，不需要通过 `zz rpc` 子进程。
- 当前未发现测试通过子进程调用 `zz rpc` 或 `zhixing rpc`。
- 当前用户文档清理面主要是 `packages/cli/README.md` 和 0.1 发布追踪里的 CLI 清单；正式规格中对 RPC 协议的引用不等同于用户 `zz rpc` 指令，不应一刀切删除。
- 同时，`packages/cli/src/rpc/*` 除 `index.ts` 的用户命令注册和自身单测外，没有真实生产使用者。保留它会把调试命令残留成半死代码，因此清理时应整体删除 CLI RPC 客户端层。

### 清理前 `zz rpc` 能做什么

`zz rpc` 是一个本地 JSON-RPC 命令行客户端：

1. 自动发现本机知行 server。
2. 读取本地 server token。
3. 建立 RPC 连接并认证。
4. 调用指定 RPC method。
5. 打印返回值、流式输出或通知。

当前支持的典型形式：

- `zz rpc health`
- `zz rpc session.send "你好"`
- `zz rpc session.send --text="你好"`
- `zz rpc schedule.list`
- `zz rpc schedule.create --json '{...}'`
- `zz rpc --watch`
- `zz rpc health --raw`

`packages/cli/src/rpc/args.ts` 还支持通用参数解析：

- `--json <json>`
- `--json=<json>`
- `--raw`
- `--watch`
- `--key=value`
- `--key value`
- 部分 method 的位置参数快捷方式

这意味着 `zz rpc` 不是一个小的用户命令，而是把一组协议方法和任意参数通道直接暴露到了外部 CLI。

## RPC 的定义

`RPC` 全称是 `Remote Procedure Call`，中文通常叫“远程过程调用”。

在知行里，更准确的定义是：

> RPC 是接入面或客户端调用知行本地核心服务能力的一种协议方式。客户端发送 method 和 params，服务端执行对应能力并返回结果、事件或错误。

例如未来自有移动端 App 发消息，本质上可能会调用类似：

```json
{
  "method": "session.send",
  "params": {
    "text": "帮我总结今天的任务"
  }
}
```

但移动端 App 不应该执行：

```bash
zz rpc session.send --text "帮我总结今天的任务"
```

前者是协议 / API 调用；后者是命令行调试客户端。两者不是同一个产品入口。

## RPC 是给谁用的

### 应该服务的对象

RPC 协议能力可以服务：

- 自有移动端 App。
- 自有桌面端 App。
- 自有 Web App。
- 可信自动化客户端。
- 内部开发、测试、诊断工具。
- 未来正式 SDK。

这些使用者应该直接连接知行服务协议，或通过正式 API / SDK 使用。

### 不应该服务的对象

`zz rpc` 外部指令不应该作为普通用户入口。

普通用户不应该理解：

- JSON-RPC 是什么。
- `method` 是什么。
- `session.send`、`schedule.create` 等协议方法是什么。
- token、server 发现、watch 通知、raw JSON 输出这些协议细节。

普通用户要完成工作，应通过：

- `zz` 交互模式。
- 飞书等正式接入面。
- 未来自有 App。
- 未来其它经过产品设计的入口。

## 为什么要从用户外部命令中去掉 `zz rpc`

### 1. 它暴露的是协议层，不是产品功能层

`zz rpc` 让用户直接面对内部 method 和 params。这个抽象层级太低，不符合知行的产品入口设计。

用户需要的是“发消息、查看任务、管理设置、继续会话”等产品动作，不是手动拼 RPC method。

### 2. 它扩大了外部 CLI 面积

我们的 CLI 原则是：外部 `zz` 指令尽可能少。功能优先进入交互模式或正式接入面；外部只保留必要基础入口。

`zz rpc` 一旦作为顶层可见命令存在，就等于把大量协议能力都放进了外部 CLI 面。后续每个 RPC method 的变化都会牵扯用户命令兼容性和文档预期。

### 3. 它会误导未来 App 接入方式

未来自有 App 可能需要 RPC 协议能力，但不需要 `zz rpc` 指令。

如果保留 `zz rpc` 作为显性入口，容易让实现和文档误以为“App 也可以通过 CLI 指令调用核心”。这是错误方向：App 应直接走协议 / API / SDK，不应依赖 shell 命令。

### 4. 它会把内部协议稳定性错误地变成用户承诺

`zz rpc` 当前允许用户调用具体 method，并支持任意 `--key=value` 参数。只要它暴露给用户，method 名、参数形态、输出格式都会被用户视为稳定承诺。

但这些本应属于内部协议或客户端 SDK 契约，需要按接入面架构单独设计，而不是被 CLI 调试入口提前锁死。

### 5. 它增加安全和诊断心智负担

`zz rpc` 涉及 server 发现、token、认证、watch 通知、raw JSON 等底层概念。这些概念对开发者有用，对普通用户是噪音，也会增加误用风险。

### 6. 它不符合 0.1 的最小可信入口

0.1 外部 CLI 应先保证：

- `zz` 能进入交互模式。
- `zz status` 能查看状态。
- `zz stop` 能停止服务。
- 必要的 help / version 行为清晰可靠。

`zz rpc` 不属于这个最小闭环。

## 改造目标

改造后的目标状态：

- 用户可见的外部 `zz` 命令面保持极小。
- `zz rpc` 不存在于生产态 `zz` 命令树中。
- `zz rpc` 不出现在用户 help、用户文档、用户 smoke 清单里。
- 普通用户功能进入交互模式或正式接入面。
- RPC 协议能力仍作为系统内部能力存在，但与用户 CLI 指令解耦。
- CLI RPC 客户端层没有真实生产使用者时，应随 `zz rpc` 命令一起删除。
- 未来自有 App 通过正式协议 / API / SDK 接入，不依赖 CLI。
- 清理过程不破坏现有核心服务、飞书等接入面和内部测试能力。

## 改造计划

### 1. 先完成分类决策

把当前 CLI 命令分为三类：

- 用户外部基础入口：`zz`、`zz status`、`zz stop`。
- 长运行 / 服务入口：例如 `zz serve`，需要单独判断是内部宿主入口还是用户可见入口。
- 内部开发 / 诊断入口：`zz rpc`。

本文件当前只处理 `zz rpc`。

### 2. 从生产态 `zz` 命令树移除 `rpc`

唯一方案：

- 从 `packages/cli/src/index.ts` 的用户可见 Commander 树中移除 `rpc` 顶层命令。
- 同步清掉 `index.ts` 中只服务 `rpc` 命令注册的导入和帮助分支，避免留下未用代码。
- `zz --help` 不再展示 `rpc`。
- `zz rpc <method>` 实际不可调用，应按未知命令处理。
- 0.1 CLI smoke 清单不再纳入 `zz rpc`。
- 用户文档不再展示 `zz rpc` 作为使用方式。

明确不采用：

- 不使用 Commander `hidden: true`。隐藏只是不出现在 help，命令仍然可调用，仍会形成事实上的兼容承诺。
- 不用环境变量或 dev build 在同一个生产入口重新打开 `zz rpc`。这会制造双态命令面，后续更难判断用户承诺。
- 不新增一次性的 dev script 来复刻 `zz rpc`。清理前的 `runRpcCommand()` 只是 CLI 调试客户端代码，不是协议能力本身；本次已随 `zz rpc` 一起删除。

内部诊断能力的保留方式：

- RPC 协议测试继续测试 server / client / methods。
- CLI RPC 客户端层没有真实生产使用者，随 `zz rpc` 命令删除。
- 需要人工诊断时，优先补专门的开发工具或测试夹具；该工具必须与生产 `zz` 命令面分离，不能重新暴露为用户 CLI。

实现时必须额外验证：

- 仅删除 `.command("rpc ...")` 注册不一定足够。`program` 当前有默认 `.action()` 进入 REPL；删掉 `rpc` 后，`zz rpc health` 可能被 Commander 判为多余位置参数，也可能在某些配置下误入默认交互模式。
- 清理必须实测 `zz rpc <method>` 和 `zhixing rpc <method>` 的真实落点，确保它们返回清晰的未知命令或等价错误，不能进入 REPL。
- 如默认 Commander 行为不够清晰，需增加统一的未知命令处理或严格参数处理。这个兜底机制应服务整个生产 `zz` 命令面，后续 `serve` 等外部命令收口也能复用，不能为 `rpc` 做一次性 hack。
- 顶层命令守门不能维护独立硬编码白名单，应从 Commander 已注册命令树派生允许集合。这样新增、删除或重命名顶层命令时只有一个事实源，避免后续命令被守门误拒。
- `zz rpc <method>` 返回未知命令的行为必须有自动化回归覆盖，不能只依赖人工 smoke。

### 2.1 审查 `packages/cli/src/rpc/*` 的真实职责

删除生产态 `zz rpc` 命令后，不能自动默认整套 CLI RPC 客户端代码都应该保留。

需要基于事实判断：

- 如果 `runRpcCommand()` 和 `packages/cli/src/rpc/*` 短期仍有明确内部诊断 / 测试职责，则保留，但文案和命名要从“`zhixing rpc` 用户命令”转为内部 RPC client 语义，避免再次被理解为用户外部入口。
- 如果它们没有真实内部使用者，只剩历史命令残留，则应连同 CLI RPC 客户端代码一起删除，只保留协议层 client / server / methods 测试。
- 本次核查结果属于后一种：`packages/cli/src/rpc/*` 没有真实生产调用者，已随 `zz rpc` 命令一起删除。

这一步不是为了追求更大改动，而是避免只删 Commander 注册后留下半死不活的 CLI RPC 客户端，形成新的架构债。

### 3. 保留协议能力，但重命名产品边界

需要在代码和文档里区分：

- RPC protocol / JSON-RPC client：系统协议能力。
- `zz rpc`：命令行调试客户端。
- App / SDK：未来正式客户端接入方式。

未来自有 App 的方向应是正式 API / SDK，而不是 CLI wrapper。

### 4. 清理测试与 smoke

清理前事实：

- 已有 `runRpcCommand()` 直接测试，不经过 `zz rpc` 子进程。
- 当前未发现测试通过子进程调用 `zz rpc` 或 `zhixing rpc`。
- RPC 协议层测试与 `zz rpc` 外部命令解耦。

后续清理规则：

- 如果测试目标是 RPC 协议本身，应测试 RPC client / server / methods。
- 如果测试目标是用户 CLI，不能再期待 `zz rpc` 存在。
- 0.1 smoke 只保留用户外部基础入口。

### 5. 清理文档

需要同步清理：

- 0.1 发布追踪中的 CLI 命令清单。
- CLI README 中的 `rpc` 用户入口描述。
- 根 README 或发布说明中若出现 `zz rpc` / `zhixing rpc` 用户示例，必须删除或改为协议 / 开发者说明。
- 其它把 `zz rpc` 当成用户功能入口的文档。

如果仍需记录 RPC 协议，应放到系统协议 / 开发者文档，而不是用户 CLI 使用文档。历史规格里描述 RPC 协议或旧阶段验证命令的内容，不等同于 0.1 用户 CLI 承诺；清理时要区分“协议概念”与“用户 `zz rpc` 指令”。

### 6. 验收标准

清理完成后至少满足：

- `zz --help` 不展示 `rpc`。
- `zz rpc <method>` 和 `zhixing rpc <method>` 不可调用，返回未知命令或等价错误。
- `zz rpc <method>` 和 `zhixing rpc <method>` 不会进入 REPL、不会启动服务、不会连接 RPC server。
- 用户 CLI smoke 清单不包含 `zz rpc`。
- 用户文档不把 `zz rpc` 作为功能入口。
- RPC 协议相关测试仍通过。
- 已审查 `packages/cli/src/rpc/*`：保留则有明确内部职责并去除用户命令文案；无职责则删除。本次结果为删除。
- 删除后生产代码没有 `runRpcCommand()`、`parseRpcArgs()`、`packages/cli/src/rpc/*` 的残留引用。
- 核心服务、交互模式、状态查看、停止服务不受影响。
- 未来 App 接入方向被描述为协议 / API / SDK，而不是 `zz rpc` CLI。

## 本次执行结果

- `packages/cli/src/index.ts` 已移除 `rpc` 顶层命令注册，并加入统一顶层未知命令守门。
- 顶层未知命令守门已抽成纯规则模块，允许集合从 Commander 注册树派生，避免和命令注册形成双事实源。
- `packages/cli/src/rpc/*` 和对应测试已删除，因为没有真实生产调用者。
- `packages/cli/README.md` 已删除 `zhixing rpc` 用户模式、示例和故障排查入口。
- 0.1 发布追踪已把 `zz rpc` 从用户外部命令清单中移除，并记录它只作为清理前事实存在。
- 协议层 `@zhixing/server` 的 RPC 能力未删除；只把注释里的旧 `zhixing rpc` 用户入口表述改为本地协议客户端。

已验证：

- `pnpm --filter @zhixing/cli exec tsc --noEmit`：通过。
- `pnpm --filter @zhixing/cli exec vitest run src/__tests__/command-gate.test.ts src/__tests__/no-direct-console.test.ts --reporter=dot`：通过。
- `pnpm --filter @zhixing/cli exec vitest run src/__tests__/no-direct-console.test.ts --reporter=dot`：通过。
- `pnpm --filter @zhixing/cli test -- --reporter=dot`：通过。
- `pnpm cli:build`：通过。
- `node packages/cli/dist/index.js --help`：不展示 `rpc`。
- `node packages/cli/dist/index.js rpc health`：返回 `error: unknown command 'rpc'`，退出码 1。
- `pnpm --filter @zhixing/cli exec zz rpc health`：返回未知命令，退出码 1。
- `pnpm --filter @zhixing/cli exec zhixing rpc health`：返回未知命令，退出码 1。
- `pnpm lint`：通过。
- `git diff --check`：通过，只有 LF/CRLF 提示。

清理结论：`zz rpc` 已从生产态用户 CLI 面移除，CLI RPC 调试客户端层已删除，RPC 协议能力仍保留在 server / client 协议层。

## 待后续确认的问题

- `zz serve` 是否应作为用户可见外部命令保留，还是也应内部化为宿主启动入口。
- `zz --version` 是否作为 0.1 用户基础入口保留。
- `zz --help` 中应该展示哪些用户外部入口，避免内部命令污染用户心智。

这些问题和 `zz rpc` 同属 CLI 外部命令面收口，但不要混在同一个改动里处理。
