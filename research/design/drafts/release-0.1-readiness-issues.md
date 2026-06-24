# 0.1 产品发布准备临时追踪

> 临时文档：只用于本轮 0.1 发布前产品发布门禁、工程问题与发布链路缺口的排查收口。全部阻断问题解决并沉淀到正式发布清单、自动化 smoke、发布说明或长期规格后删除本文，不作为长期规格维护。

## 文档定义与目标

本文判断的是**知行是否已经具备作为 0.1 产品发布的完整闭环**，不是只判断“已有功能是否不报错”。

工程门禁通过是发布的必要条件，但不是充分条件。0.1 发布判断必须同时覆盖：

- **获取与安装**：用户如何获得产品，是否有清晰、方便、可重复的安装路径。
- **首次启动与基础使用**：用户安装后如何启动知行，如何完成最小可用闭环。
- **配置与凭据**：用户如何配置模型、密钥、工作目录和本机运行环境。
- **更新、回滚与卸载**：系统如何升级，升级失败如何恢复，用户如何清理或重置。
- **诊断与支持**：出问题时如何查看状态、日志和版本信息，如何给维护者提供可用现场。
- **平台与安全边界**：支持哪些平台，哪些能力是本机私有能力，哪些入口不应暴露给普通用户。
- **文档与发布说明**：用户首次接触产品时看到的 README、CLI help、发布说明必须反映当前真实系统。

因此，本文记录的问题不只包括测试红灯和运行时报错，也包括发布链路缺口、用户获取 / 更新路径缺失、产品入口不清、生命周期治理不足、文档与真实产品不一致等会影响 0.1 发布质量的问题。

本文的目标是形成一个可执行的 0.1 发布判断：哪些问题必须在发布前解决，哪些问题可以作为发布后规划，哪些历史问题已经复验不再阻断。

## 处理流程与判断标准

本节适用于本文所有问题。每个问题都按同一流程推进，避免把发布判断变成“感觉差不多了”。

### 处理流程

1. **事实审核**：先确认问题是否真实。必须给出命令、输出、代码路径或最小复现证据；不能只凭印象定性。
2. **发布影响判断**：把技术现象或产品缺口翻译成 0.1 用户会遇到的真实风险。重点回答：是否影响获取、安装、启动、配置、升级、卸载、基础命令、核心工具、诊断支持、文档入口或协议边界。
3. **目标效果定义**：先定义 0.1 应达到的可交付行为，再决定修复方向。目标效果必须能被自动测试或明确的 smoke 流程验证。
4. **根因定位**：先建立可观测性，再定位。不要靠“猜一个地方改一下，然后让用户试”推进发布。
5. **修复与验证**：优先补能复现失败的测试或脚本，再修实现。修完必须重新跑对应门禁。
6. **沉淀或删除**：全部问题解决后，把长期发布标准沉淀到正式清单、自动化 smoke 或 CI；本文删除。

### 顶层判断标准

- **产品闭环标准**：0.1 发布不是“现有功能没有报错”，而是用户能从获取产品开始，完成安装、配置、首次启动、基础使用、诊断、更新和卸载 / 重置的完整闭环；任何缺口都应作为发布问题评估。
- **门禁标准**：`pnpm build`、`pnpm lint`、`pnpm -r exec tsc --noEmit`、`pnpm test` 必须全绿。
- **核心-接入面标准**：知行是一个核心 + 多个接入面。核心功能、工具契约、会话事实和权限语义必须独立于 CLI、飞书、RPC 或未来 App 的展示方式；接入面只负责采集输入、投影事实、承载交互，不能反向定义核心行为。
- **CLI 标准**：以当前构建产物暴露的真实入口为准。纳入 0.1 smoke 的 CLI 命令必须有明确预期，并按预期返回、启动或退出。
- **用户标准**：0.1 用户从“如何获取产品”开始，应能找到清晰路径完成安装、自发现、最小 smoke、更新和诊断；不能第一步就遇到不存在的参数、挂起的基础命令、缺失的安装 / 更新说明，或红色测试所代表的基础工具缺陷。
- **依据标准**：本文发布判断只以代码、构建产物、自动化测试和可观测 smoke 为依据。README、设计稿、历史文档都可能滞后，不能反向定义发布标准；文档不一致只作为独立问题记录。
- **可重复标准**：发布结论必须来自可重复命令，而不是一次人工观察。flaky 测试即使偶尔能过，也应视为发布风险。
- **跨平台标准**：当前已在 Windows 环境暴露路径格式、进程清理和 CLI 启动问题；0.1 至少要把 Windows 作为明确支持或明确限制的平台处理。

### 当前需求边界澄清

- 本文讨论的是“是否可以发布 0.1”的产品发布准备问题，不只讨论已有功能是否报错，也不讨论 0.1 之后的产品愿景扩展。
- 如果目标是公开 / 给外部用户试用的 `0.1.0`，本文红灯问题均应视为阻断。
- 如果目标只是内部里程碑 tag，也至少应修复测试红灯，并固化 / 通过 0.1 CLI smoke 清单，否则后续验证会被旧问题污染。
- 本文不直接修改代码，只记录发布前需要收口的问题、证据和验收标准。

### 每个问题的记录格式

每个问题至少记录：

- **状态**：待处理 / 定位中 / 已修复 / 已验证 / 非阻断但需记录。
- **审核结论**：真实 / 不真实 / 需要更多观测。
- **事实证据**：命令、输出摘要、代码路径或复现结果。
- **发布影响**：对 0.1 用户或维护者的实际影响。
- **目标效果**：修复后应呈现的行为。
- **验收标准**：需要补的测试、命令或手动 smoke。

## 背景

知行的长期架构是**一个核心 + 多个接入面**。核心是智能体事实与能力的单一来源；CLI、飞书、RPC、未来 Web / App 都只是接入面。发布判断和问题修复必须保护这条边界：核心工具能力不能为某个接入面的展示习惯、历史 README 或临时命令形态牺牲契约一致性。

本文最初从工程门禁红灯开始建立，但当前发布判断已经扩展为产品发布闭环审查。后续新增问题不要求先出现测试失败；只要它会阻断用户获取、安装、启动、配置、更新、诊断或理解当前产品，就应进入本文评估。

当前工程门禁最新复核项：

- `pnpm lint`
- `pnpm -r exec tsc --noEmit`
- `pnpm test`
- `pnpm build`
- CLI smoke：`--version`、`--help`、`status --help`、`stop --help`、隐藏过渡入口的 `serve --help` / `serve logs --help`
- 打包 smoke：`@zhixing/cli` tarball 中 `workspace:*` 依赖会转换为 `0.1.0`

当前仍需从产品发布闭环继续审查的方向：

- 用户如何方便、清晰地获得和安装 0.1。
- 用户如何更新、回滚、卸载或重置知行。
- 根 README、发布说明和长期文档是否能承接真实用户的首次接触。
- 临时发布追踪信息最终应沉淀到正式发布清单、自动化 smoke 或删除。

本轮重点涉及的文件 / 目录：

- `packages/tools-builtin/src/__tests__/grep.test.ts`
- `packages/tools-builtin/src/grep.ts`
- `packages/tools-builtin/src/web-fetch/__tests__/internal.test.ts`
- `packages/tools-builtin/src/web-fetch/internal.ts`
- `packages/cli/src/index.ts`
- `packages/cli/README.md`
- `packages/*/package.json`
- `README.md`

## 当前发现

### 1. `grep` 有两套搜索执行器，但核心工具输出没有统一契约

**状态**：已完成，已验证，不再阻断 0.1

**当前结论**：问题真实，修复已落地。`grep` 已从“双搜索执行器、双输出契约”收敛为“核心定义搜索语义，ripgrep / Node 只是搜索执行器，统一产出 `GrepSearchResult`，再由核心格式化为 `ToolResult.content` 和 `ToolResult.presentation`”。本问题不再阻断 0.1。

**落地结果**：

- `grep` 核心拆分为 query / plan / line-regexp / text / path / candidate-files / collector / search executor / formatter，工具入口不再直接消费搜索执行器的人类可读输出。
- `ripgrep` 和 `Node` 搜索执行器都产出同一个 `GrepSearchResult`；`formatGrepToolResult()` 是唯一 LLM-facing 文本格式化器。
- `ToolResult.presentation.kind === "grep-results"` 已作为结构化投影通道，与 file-diff presentation 同构；接入面不需要解析 `content`。
- `line-regexp` 成为 0.1 核心搜索语义：逐行、Unicode scalar 匹配单位、ASCII `\w` / `\d` / `\s` / `\b` / `\B`、显式 ASCII 大小写不敏感；高级方言不由执行器静默带入。
- 行模型、编码、路径、排序、截断、二进制跳过、默认忽略目录、glob 语义都已进入核心契约和测试覆盖。
- `maxScannedFiles` 已从 `GrepQuery` 移入运行时 `GrepSearchOptions`，作为 Node 执行器保护策略，不再让 ripgrep 被错误判出局。
- 文件候选发现统一由 `listGrepCandidateFiles()` 定义；Node 直接消费，ripgrep 消费同一候选集合并分批把显式路径交给 `rg`，避免两套 glob 语义漂移。
- 工作区内合法的 `..foo.ts` 等路径已用统一路径归属判断处理，不会再被误判为工作区外路径。

**当前验证**：

- `pnpm --filter @zhixing/tools-builtin exec tsc --noEmit`：通过。
- `pnpm --filter @zhixing/tools-builtin test -- src/__tests__/grep-core.test.ts src/__tests__/grep-executors.test.ts src/__tests__/grep.test.ts`：通过，52 个 grep 相关测试通过。
- `pnpm --filter @zhixing/tools-builtin test`：通过，283 个 tools-builtin 测试通过。
- `pnpm --filter @zhixing/tools-builtin build`：通过。
- 当前验证环境中，`where rg` 与 Node `spawn("rg", ["--version"])` 均可找到 `rg`；ripgrep native 路径已在该环境被实际执行验证。

**发布前环境检查**：CI / 发布环境仍需保证 Node 进程能 `spawn("rg", ["--version"])`。如果环境缺失 `rg`，系统会可用地回落 Node 执行器，但 ripgrep native 分支不会在该环境被验证；这属于发布环境 checklist，不是 grep 代码架构遗留。

**修复前现象**：全量执行 `pnpm test` 时，递归测试在 `@zhixing/tools-builtin` 失败退出。单独执行 `pnpm --filter @zhixing/tools-builtin exec vitest run src/__tests__/grep.test.ts --reporter=verbose` 仍稳定失败 2 个用例。

**修复前审核结论**：问题真实，是 0.1 发布阻断。它不是两个断言偶然写窄，而是核心 `grep` 工具缺少统一输出契约：ripgrep 路径直接返回人类可读 stdout，Node fallback 路径返回另一套自定义格式。当前红灯只是最先暴露的两个症状。

**修复前事实证据**：

- `pnpm test` 退出码为 1；`@zhixing/tools-builtin` 为 2 个测试文件失败、17 个测试文件通过；3 个测试失败、247 个测试通过。
- `grep.test.ts` 单独重跑结果：19 个测试中 17 个通过、2 个失败。
- 当前环境 `rg --version` 为 ripgrep 15.1.0。
- 稳定失败集中在 `packages/tools-builtin/src/__tests__/grep.test.ts`：
  - “排除 node_modules”期望输出包含 `src/app.ts`，实际收到 `C:\Users\...\src\app.ts:1:findThis`。
  - “处理多文件匹配”期望输出包含 `3 files`，实际收到多行 raw ripgrep 输出和 `--` 分隔符。
- `packages/tools-builtin/src/grep.ts` 中 `tryRipgrep()` 使用 `execFile("rg", args)` 后直接把 stdout 交给 `formatOutput()`；content mode 的 `formatOutput()` 基本原样返回 stdout。
- 同一 fixture 下，正常 ripgrep 路径输出绝对 Windows 路径和 raw `rg` 分隔符；强制 `rg` 不可用后，Node fallback 输出 `Found 3 matches in 3 files:`、`── src/app.ts ──`、`> 1|...` 这种自定义格式。
- `rg --json -C2` 已验证可提供结构化事件：`begin`、`match`、`context`、`end`、`summary`，不需要解析 raw 文本 stdout。

**修复前问题全貌**：

- **核心能力边界不清**：`grep` 属于核心工具能力，不属于 CLI 展示层。CLI、飞书、RPC 或未来 App 消费到的都应该是同一份核心工具结果，而不是各接入面再去理解 ripgrep stdout。
- **路径契约不一致**：`resolveToolPath()` 先把搜索路径解析成绝对路径，`tryRipgrep()` 再把绝对路径传给 `rg`；`rg` 因而在目录搜索时输出绝对路径和 Windows 反斜杠。Node fallback 在目录搜索时输出相对路径并替换为 `/`。
- **搜索根语义不一致**：Node fallback 的相对路径基于 `searchPath`，不是稳定基于 `context.workingDirectory`。例如 `path: "src"` 时 fallback 显示 `app.ts`，这对后续 `read/edit` 并不如 `src/app.ts` 稳定。
- **单文件搜索不一致**：`rg --no-heading --line-number` 在搜索单个文件时可能省略文件名，只输出 `2:match`；fallback 会输出文件 header。agent 后续引用文件位置时会受到影响。
- **摘要契约不一致**：fallback 总是添加 `Found N matches in M files:`；ripgrep content mode 没有摘要，files/count mode 只有局部包装。
- **上下文渲染不一致**：ripgrep content mode 使用 `file-line-context`、`file:line:match`、`--`；fallback 使用文件块 header、`> line|match` 和普通上下文行。
- **输出模式不一致**：files/count/content 三种模式在 header、路径格式、排序和截断策略上都不统一；测试目前只撞到 content mode 的两个点。
- **glob 能力不一致**：ripgrep 接收完整 `--glob` 语义；Node fallback 的 `parseGlobExtensions()` 只支持扩展名子集。现在测试覆盖的是简单扩展名，所以没有暴露。
- **忽略规则不一致**：ripgrep 路径依赖 `rg` 自身规则和 `--glob !dir`；fallback 只按目录名跳过固定噪音目录。`.gitignore` 语义没有被统一测试锁住。
- **正则方言边界不明确**：input schema 写的是 JavaScript regex syntax，当前代码也先用 `new RegExp(pattern)` 校验；但 ripgrep 默认执行的是 Rust regex。搜索执行器差异不只影响输出格式，也可能影响某些 pattern 的匹配语义。
- **编码与 Unicode 语义未钉死**：Node fallback 当前直接 `fs.readFile(path, "utf-8")`，ripgrep 会处理带 BOM 的 UTF-16 等文本；`\w`、`\b`、ignore-case、星体字符上的 `.` / Unicode 字面量量词等语义在 JS regex 与 Rust regex 之间也会分叉。
- **行模型未钉死**：CRLF / LF / CR 的行边界、尾部 `\r` 是否剥离、`^` / `$` 锚定对象、超长单行如何裁剪都未定义。Windows CRLF 文件和 minified / base64 单行会让两个搜索执行器继续漂移，并污染 `content` 与 `presentation`。
- **排序不一致**：ripgrep 返回顺序和 fallback 递归顺序不被统一归一化；多文件输出可能跨平台、跨文件系统漂移。
- **截断策略不一致**：ripgrep 由 `execFile` 的 `maxBuffer` 和 `formatOutput()` 截断控制；fallback 只在 content mode 内用 `totalOutputChars` 控制，files/count 路径没有同等模型。

**修复前根因**：

- 当前 `grep` 实现把“搜索执行器”和“结果渲染”混在一起：`tryRipgrep()` 和 `nodeGrep()` 都直接返回 `ToolResult`。
- 两个搜索执行器没有共同的中间结果模型，因此无法统一路径、匹配数、文件数、上下文行、排序、截断和输出模式。
- `formatOutput(stdout, ...)` 只是 raw stdout 包装器，不是语义渲染器。给它补 header 或替换反斜杠只能修当前断言，不能解决 files/count、单文件、glob、排序、行模型、编码、Unicode、`.gitignore` 等同源漂移。
- 测试实际锁住的是“知行 grep 工具应该给 agent 的稳定语义输出”，但实现暴露的是“某个搜索执行器当次的人类可读输出”。这是架构边界错误，不是测试问题。
- 更上层看，这是核心能力与搜索执行器实现、接入面投影之间的边界没有立住：搜索执行器输出被当成核心工具输出，未来任何接入面都会继承这份漂移。

**背后需求**：

- `grep` 是核心层的代码搜索基础能力。agent 和所有接入面需要的是稳定、可引用、跨平台一致的搜索结果，不是 ripgrep CLI 文本。
- 搜索执行器可以替换，契约不能漂移。ripgrep 应该是高性能搜索执行器，不应该成为用户可见输出格式的所有者。
- 路径必须服务后续核心工具调用：工作区内文件应稳定显示为相对 `context.workingDirectory` 的 `/` 分隔路径；工作区外绝对路径必须显式保留，不能伪装成相对路径。
- 接入面可以把核心结果投影成终端卡片、飞书卡片或 RPC JSON，但不能各自修补 / 重解释核心工具的搜索语义。
- 长期架构详见 [grep 核心搜索能力架构设计](core-grep-search-architecture.md)。

**目标效果**：

- 所有搜索执行器先产出同一个 `GrepSearchResult` 结构，再由核心格式化器生成 LLM-facing `ToolResult.content`。
- `GrepSearchResult` 同时作为 `ToolResult.presentation.kind === "grep-results"` 的结构化搜索事实，供接入面投影。
- 工作区内路径统一为相对 `context.workingDirectory` 的 POSIX 风格路径，例如 `src/app.ts`。
- content/files/count 三种模式共享同一套匹配行 / 文件统计，不因搜索执行器不同改变 header、路径或排序。
- 单文件、子目录、工作区根、绝对路径搜索都有明确显示规则。
- 0.1 默认语义是核心定义的 `line-regexp`；pattern 先由核心校验 / 编译，再交给搜索执行器，高级正则方言必须显式启用，不能由搜索执行器静默带入。
- 0.1 纳入 ASCII 语义的 `\b` / `\B` 和显式 ASCII 大小写不敏感，满足 agent 高频代码搜索需求；Unicode / locale word-boundary、Unicode case folding、smart-case 不纳入 0.1。
- 0.1 编码语义明确为 UTF-8、带 UTF-8 BOM 的 UTF-8、带 BOM 的 UTF-16LE / UTF-16BE；其他编码不纳入契约，不能产生合同外命中。
- 0.1 匹配单位明确为 Unicode scalar value；Node 搜索执行器必须用 `u` flag 对齐 ripgrep 的码点语义。
- 0.1 行模型明确为 CRLF / LF / CR 归一后的逻辑行；匹配文本、上下文、`content` 和 `presentation` 都不携带行终止符。
- 超长行受 `maxLineChars` 行级预算控制，返回统一的行级截断元数据，不把完整巨型行灌进结果。
- 多文件输出按 `displayPath` 的 POSIX 字符串字典序排序，不能依赖 ripgrep 输出顺序或 Node 目录遍历顺序。
- `glob`、默认忽略目录、hidden 搜索、二进制跳过、采集期截断策略都有测试锁住；0.1 明确不承诺 `.gitignore`，避免搜索执行器隐式漂移。
- `pnpm test` 不再因 grep 工具搜索执行器差异红灯。

**唯一推荐方案**：

1. **建立语义模型**：新增内部类型，例如 `GrepQuery`、`GrepSearchResult`、`GrepFileResult`、`GrepMatch`、`GrepContextLine`、`GrepLineText`。模型中保留 regex dialect、case sensitivity、encoding policy、absolute path、display path、line number、match text、context lines、行级截断元数据、matchedFileCount、matchedLineCount、truncated、diagnostics 信息。
2. **建立核心 `line-regexp` 编译器**：用户 pattern 不直接交给 JS / ripgrep。核心先校验并编译为执行器可用 pattern；0.1 支持逐行、Unicode scalar value 匹配单位、默认大小写敏感、显式 ASCII 大小写不敏感、ASCII 语义的 `\w` / `\d` / `\s` / `\b` / `\B` 快捷写法和常见正则结构，不支持 lookaround、backreference、Unicode / locale word-boundary、Unicode property、inline flags、Unicode / locale ignore-case、smart-case、dotall / multiline。LLM-facing 输入暴露 `case_sensitivity`，可接受 `sensitive` 与 `ascii-insensitive`。ASCII 大小写不敏感由核心编译器展开字面量和 ASCII 范围，不能依赖 ripgrep `-i` 或 JavaScript `/i`。Node 搜索执行器用 JavaScript `u` flag 编译核心 pattern。
3. **拆分搜索执行器与资格判断**：`runRipgrep(query)` 和 `runNodeGrep(query)` 不直接返回 `ToolResult`，不做最终字符串格式化；执行前必须有显式 `qualify()`，不可用、能力不支持、编码不支持、预算不支持都用明确原因表达，不能用 `null` 混在一起。
4. **ripgrep 改用结构化输出**：ripgrep 搜索执行器使用 `rg --json` 读取 `begin/match/context/end/summary` 事件构建模型，禁止解析或透传 raw human stdout。实现时使用 `spawn` 流式读取，避免 `execFile` 大 stdout buffer 和后续截断策略打架。
5. **统一路径策略**：新增 `toDisplayPath(absPath, workingDirectory)`。工作区内路径统一 `path.relative(workingDirectory, absPath).replace(/\\/g, "/")`；工作区外路径用规范化绝对路径并替换为 `/`。不要再以 `searchPath` 作为显示相对根。
6. **双通道输出**：`formatGrepToolResult(result, outputMode)` 生成 LLM-facing `content`；`ToolResult.presentation.kind === "grep-results"` 承载投影安全的结构化搜索事实。presentation 不直接暴露内部 `absolutePath`，接入面不解析 `content`。
7. **统一搜索策略**：glob、默认忽略、hidden 搜索、行模型、编码识别、二进制跳过、排序和采集期截断都成为 `GrepQuery` / 搜索执行器的显式契约。多文件按 `displayPath` 的 POSIX 字符串字典序排序。行终止符统一归一，超长行用 `maxLineChars` 行级预算裁剪。0.1 不承诺 `.gitignore`，ripgrep 搜索执行器不得静默使用自带 ignore 语义造成搜索执行器漂移。搜索执行器不能满足契约时，必须降级到能满足契约的搜索执行器或返回明确错误，不能静默输出另一套语义。
8. **测试按契约重建**：测试不再只断言某几个 substring；要覆盖搜索执行器满足同一核心契约、能力差异显式 fallback / 报错、路径、header、文件数、匹配行数、单文件搜索、子目录搜索、glob、忽略目录、hidden 文件、编码、files/count/content 和 `grep-results` presentation。

**明确不采用**：

- 不只在 `formatOutput()` 里给 ripgrep content mode 加 `Found ...` header。
- 不只把 `\` 替换成 `/`。
- 不把测试改成接受绝对路径。
- 不为了让测试过而强制禁用 ripgrep。
- 不解析 ripgrep 的人类可读 stdout；那会继续绑定 `rg` 展示格式，留下后续架构债。
- 不把修复放到 CLI 或某个接入面的展示层；核心工具契约必须先正确，接入面只投影。

**验收标准**：

- `pnpm --filter @zhixing/tools-builtin exec vitest run src/__tests__/grep.test.ts` 通过。
- 新增搜索执行器契约测试：同一 fixture 在 `rg` 可用和强制 fallback 条件下，被选中的搜索执行器满足核心契约；不要求所有搜索执行器在所有 query 上完全相等。
- 新增路径契约测试：工作区根、`path: "src"`、`path: "src/app.ts"`、绝对路径输入在 Windows 下均输出预期 display path。
- 新增语义契约测试：多文件匹配显示文件数和匹配行数；node_modules 被排除；glob 过滤一致；单文件搜索仍包含可引用文件路径。
- 新增无匹配契约测试：无匹配返回成功空结果和无匹配提示，不设置 `isError`。
- 新增 presentation 测试：`ToolResult.presentation.kind === "grep-results"` 承载投影安全的结构化搜索事实，不直接暴露内部 `absolutePath`。
- 新增 `.gitignore` 裁决测试：0.1 不承诺 `.gitignore`，并验证 ripgrep 不因自带 ignore 行为和 Node 搜索执行器漂移。
- 新增正则方言测试：`line-regexp` 的支持子集由核心编译器锁住；超出逐行核心搜索兼容子集的 pattern 不能静默交给 ripgrep，必须 fallback 或返回明确错误。
- 新增编码契约测试：UTF-8、UTF-8 BOM、UTF-16LE BOM、UTF-16BE BOM fixture 在被选中的搜索执行器下结果符合核心契约；不支持编码不能产生合同外命中。
- 新增行模型测试：CRLF / LF / CR 文件中 `foo$` 都匹配逻辑行 `foo`；`match.text`、上下文、`content`、`presentation` 不携带行终止符。
- 新增超长行测试：命中过长逻辑行时返回行级截断元数据和统一截断文案，不把完整超长行放入 `content` 或 `presentation`。
- 新增 Unicode / 大小写测试：默认大小写敏感；显式 ASCII-insensitive 只折叠 `A-Z` / `a-z`，不做 Unicode / locale case folding；`\w` / `\d` / `\s` / `\b` / `\B` 按核心定义的 ASCII 语义执行；`.`、Unicode 字面量和量词在星体字符 fixture 上按 Unicode scalar value 匹配；Unicode / locale word-boundary、Unicode ignore-case、smart-case 等未支持能力返回明确错误或不具备 ripgrep 执行资格。
- 新增排序契约测试：多文件结果按 `displayPath` 的 POSIX 字符串字典序排列，不随 ripgrep 输出顺序、Node 遍历顺序或平台文件系统漂移。
- 新增采集期截断测试：达到预算时停止继续采集并返回 `truncated: true`。
- `pnpm test` 通过。

### 2. `web-fetch` markdown 转换测试在全量测试中出现超时

**状态**：已验证，当前不可复现，不再阻断 0.1

**当前结论**：旧现象在当前代码和当前环境下不可复现。`web-fetch` 的 HTML markdown 转换没有发现稳定实现缺陷，也没有发现需要架构调整的证据。本问题从 0.1 阻断项降级为“历史测试风险已复验”。

**问题全貌**：

- 触发路径只有 `processContent()` 的 HTML + `format: "markdown"` 分支：先解码 body，再动态 `import("turndown")`，实例化 `TurndownService` 后转换 markdown。
- `text/plain`、`application/json`、HTML + `format: "text"` 都不触发 `turndown` 动态加载。
- `packages/tools-builtin/src/web-fetch/internal.ts` 和 `packages/tools-builtin/src/web-fetch/__tests__/internal.test.ts` 自加入后没有相关修改；当前没有“已通过代码修复消除超时”的事实。
- `packages/tools-builtin/src/web-fetch/__tests__/web-fetch.test.ts` mock 的是 `@zhixing/network`，没有 mock `turndown`、全局 timer 或 `processContent()` 所在模块。
- 当前重复运行未复现超时，说明旧记录不能继续作为稳定发布阻断证据。

**当前事实证据**：

- 连续 5 次执行 `pnpm --filter @zhixing/tools-builtin exec vitest run src/web-fetch/__tests__/internal.test.ts --reporter=dot`：全部通过；该文件 28 个测试均通过。
- 5 次运行中，Vitest 报告的该文件 `tests` 阶段分别约为 844ms、360ms、328ms、324ms、618ms，均未接近默认 5000ms 单测超时。
- `processContent()` 微基准：首次 HTML markdown 转换约 478.94ms，后续调用约 8.54ms 至 60.21ms。
- 与历史上较重的 grep / bash 测试同跑：`pnpm --filter @zhixing/tools-builtin exec vitest run src/web-fetch/__tests__/internal.test.ts src/__tests__/grep.test.ts src/__tests__/bash.test.ts --reporter=dot` 通过。
- 根级 `pnpm test`：通过。

**根因判断**：

- 没有证据支持这是 `web-fetch` 的稳定业务代码缺陷。
- 当前最佳判断：旧超时是一次全量门禁中的瞬时测试环境 / 资源竞争现象，叠加当时其他红灯导致文档保留为定位中；后续缺少连续复验，才让它继续停留在阻断问题列表。
- 不应为了一个当前不可复现、微基准远低于 timeout 的历史现象去改产品代码、缓存策略或测试 timeout；那会制造不必要的架构债和错误归因。

**发布影响**：

- 当前不再阻断 0.1。
- 若未来再次复现，需要按“测试运行时风险”处理，而不是直接假定 `turndown` 或 `web_fetch` 实现有问题。

**背后需求**：

- HTML -> markdown 的转换应稳定、可预测，测试不应受其他测试文件并发影响。
- 发布判断必须来自可重复命令；历史单次失败不能长期代表当前状态。

**目标效果**：

- `processContent()` 的 HTML markdown 路径在单文件、同包全量、根级全量测试中均稳定通过。
- 若未来失败，失败报告必须能区分：动态 import 慢、Vitest worker 资源竞争、全局 mock / timer 污染，还是真实转换逻辑错误。

**最优解决方案**：

- 当前不改业务代码，不增加模块级 `TurndownService` 缓存，不盲目调大测试 timeout。
- 将本问题标记为已复验、非阻断；继续由 0.1 发布最低清单中的 `pnpm test` 覆盖。
- 如果再次出现超时，先补观测：记录 `import("turndown")` 耗时、转换耗时、Vitest worker 并发、同跑测试文件，再基于证据决定是否需要缓存 Turndown 初始化或调整测试隔离。

**验收标准**：

- 连续多次执行 `packages/tools-builtin/src/web-fetch/__tests__/internal.test.ts` 通过。
- `pnpm --filter @zhixing/tools-builtin test` 通过。
- 根级 `pnpm test` 通过。
- 不因本历史问题修改 `web-fetch` 产品代码或测试 timeout，除非拿到新的可复现证据。

### 3. 0.1 CLI 必需命令清单尚未从系统事实中固化

**状态**：已确认当前真实指令，待固化 0.1 smoke 清单

**现象**：0.1 到底必须保证哪些 CLI 命令可用，不能由滞后 README 反推；必须从当前代码入口、构建产物和产品边界确认。

**事实来源**：

- `packages/cli/package.json` 的 `bin` 明确把 `zz` 和 `zhixing` 都指向 `./dist/index.js`；本文下列 `zz` 均指这个同一 CLI 入口。
- 当前外部 CLI 命令注册集中在 `packages/cli/src/index.ts`；未发现其它 Commander 顶层命令注册点。
- 已用源码入口和构建产物 help / version 路径交叉验证可见命令；未把 README 作为事实来源。

**CLI 外部命令面原则**：

- `zz` 外部命令是一个接入面，不是系统功能的默认承载层。
- 能放进交互模式的用户功能，原则上不新增外部 `zz <command>`。
- 外部命令只保留必要、基础、离开交互模式后仍必须可用的控制入口。
- 历史或隐藏兼容入口只能作为系统事实记录，不能自动上升为 0.1 用户标准。
- 0.1 smoke 清单必须区分“当前实现存在”和“产品必须保留”；不能因为历史入口存在，就把它固化为长期用户承诺。

**当前用户可见的外部 `zz` 命令**：

- `zz`：进入交互 REPL。
- `zz status`：查看知行运行状态。
- `zz stop`：停止知行。

**当前真实存在但隐藏 / 过渡中的入口**：

- `zz serve`：内部宿主启动路径；默认 help 不展示，不纳入 0.1 用户 smoke 清单。
- `zz serve logs`：当前仍可调用的后台宿主日志查看入口；默认顶层 help 不展示，后续应收口到更清晰的诊断入口。

**当前真实存在的 `zz --...` / option 形态**：

- 全局：`zz --help` / `zz -h`。
- 全局：`zz --version` / `zz -V`。
- 全局隐藏诊断入口：`zz --log`。
- `zz status --help` / `zz status -h`。
- `zz stop --help` / `zz stop -h`。
- 隐藏 / 过渡入口：`zz serve --help` / `zz serve -h`。
- 隐藏 / 过渡入口：`zz serve logs --help` / `zz serve logs -h`。
- 隐藏 / 过渡入口：`zz serve logs --tail`。
- 隐藏 / 过渡入口：`zz serve logs --lines <n>`，`n` 必须是 1 到 5000 的整数。

**边界说明**：

- `zz`、`zz serve`、`zz serve logs --tail` 是长运行语义，后续 smoke 不能按“必须立即退出”的基础命令处理。
- `zz serve status` / `zz serve stop` 已从外部命令面清理；运行控制只保留 `zz status` / `zz stop`。
- `zz serve --port` / `zz serve --host` 已从外部命令面清理；端口和监听地址不作为 0.1 用户 CLI 参数承诺。
- 未发现已实现的外部 `zz logs`、`zz config`、`zz mcp`、`zz task` 等顶层 shell 命令。
- REPL 内部 `/help`、`/new` 等斜杠命令属于交互接入面内部命令，不纳入本问题的外部 `zz` 命令清单。

**产品裁决**：

- `zz serve` 的本质是系统内部宿主启动机制，不是 0.1 用户产品动作。
- 0.1 用户外部入口应围绕“打开知行、查看状态、停止知行、诊断问题”设计，而不是围绕“管理服务进程”设计。
- `serve`、daemon、host、port、listen 这些运行时概念不应成为普通用户心智。
- 因此，`zz serve` 不纳入 0.1 用户可见命令和 smoke 清单；实现上可以作为内部启动路径保留，但应从默认 help 中隐藏。
- `zz serve logs` 当前仍是真实日志查看入口；长期上它也不应绑定在 `serve` 用户心智下，后续应收口到更清晰的诊断入口。

**`--` 形态裁决**：

- 保留 `--help` / `-h`、`--version` / `-V`；它们是 CLI 自发现和发布诊断的底线。
- 保留 `zz --log` 能力，但从默认 help 中隐藏；它是支持人员引导用户复现问题的诊断开关，不是普通用户产品动作。
- 保留日志查看的 `--tail` 与 `--lines <n>`；它们是日志读取器的自然控制项。
- 清理 `zz serve --port <port>`；端口按 `ZHIXING_HOME` 派生是单 owner 仲裁的一部分，手动覆盖可能让同一 home 出现多个 owner。
- 清理 `zz serve --host <host>`；网络监听暴露是安全级产品能力，不能通过普通 CLI flag 裸露给用户。未来远程 / 移动端访问应走专门的配对、授权和网络安全模型。

**已执行清理**：

- `zz --log` 默认 help 展示已隐藏，能力保留。
- `zz serve` 默认 help 展示已隐藏，不纳入 0.1 用户 smoke 清单；内部自动拉起仍可走 `serve` 路径。
- 用户外部面的 `zz serve --port` / `zz serve --host` 已移除；内部 `ServeOptions.port` / `ServeOptions.host` 能力保留，供测试或未来受控入口使用。
- `zz serve logs --lines <n>` 已增加输入治理：`n` 必须是 1 到 5000 的整数。

**后续收口**：

- 暂时保留 `zz serve logs` 的可调用能力和 `--tail` / `--lines`，但不把 `serve` 命名空间作为长期用户诊断入口；后续若新增更清晰入口，应迁移过去。
- 基于清理后的真实 CLI 面固化 0.1 smoke 清单。

**下一步**：

- 从上述真实指令中确定 0.1 必保 smoke 清单。
- 为每个纳入 smoke 的命令明确预期输出、退出条件和是否允许长运行。
- 后续 README 只能对齐这份清单，不能反向定义它。

### 4. CLI 元信息命令启动路径过重

**状态**：已处理。

**现状**：CLI 元信息路径已改成轻量命令面层。当前构建产物的 `--help` / `--version` / `serve --help` 均能在 1 秒内输出并退出。

**事实证据**：

- 修复前：`node packages\cli\dist\index.js --version` / `--help` / `serve --help` 约 2.4 到 4.0 秒返回。
- 修复后：
  - `node packages\cli\dist\index.js --version`：退出码 0，约 0.33 到 0.46 秒返回。
  - `node packages\cli\dist\index.js --help`：退出码 0，约 0.33 到 0.44 秒返回。
  - `node packages\cli\dist\index.js serve --help`：退出码 0，约 0.36 到 0.41 秒返回。
- 构建产物主入口 `packages/cli/dist/index.js` 已从约 698KB 降到约 8KB；REPL、server、status、logs 等运行模块进入 lazy chunks。

**根因（已确认）**：

- `packages/cli/src/index.ts` 在解析 `--help` / `--version` 前静态加载了 REPL、server、startup、status / stop / logs、日志治理等运行模块。
- `--help` / `--version` 本质只需要命令定义、隐藏状态、参数 schema 和版本号；不需要加载 REPL、启动检查、server 宿主或日志巡检。
- 在当前单文件 bundle 模式下，动态 import 仍能把模块体求值延后到首次 import；不需要先引入 code-splitting。真正要避免的是元信息路径上残留任何指向重运行模块的静态 import。
- parse 前执行的 `pruneAllLogs()` 也不应落在纯元信息路径上；日志治理应在真正进入运行命令前触发。

**背后需求**：

- CLI 元信息命令是用户自发现和诊断入口，应轻量、确定、快速返回。
- help / version 路径不能启动长生命周期服务、连接 provider、初始化 REPL、执行启动检查或等待外部资源。
- `serve --help` 只展示隐藏宿主入口的帮助，不进入 server 启动路径。

**已实施方案**：

- 把 CLI 入口拆成轻量命令面层：只注册命令、help、version、隐藏状态和参数 schema。
- 各 command action 内部再按需动态加载真实执行模块：REPL、serve、status、stop、logs。
- 将日志治理从全局 parse 前执行改为运行命令前执行；help / version 路径不触发 `pruneAllLogs()`。
- 将 `serve logs --lines` 的轻量校验常量 / parser 与日志读取实现解耦，避免为了 help 加载日志和 server 依赖。
- 硬纪律：元信息路径的静态 import 图必须只包含轻量命令面依赖；不能为复用常量、错误渲染或诊断逻辑静态拉入 core、server、REPL、startup、logs 等运行模块。任何一个漏掉的静态 import 都会让 bundle 回到急切求值。

**效果**：

- `zz --help` / `zz --version` / `zz serve --help` 可在 1 秒内输出并退出。
- 元信息命令不触发 REPL、server、startup check、provider 初始化或日志巡检。
- `zz`、`zz status`、`zz stop`、`zz serve`、`zz serve logs` 的原有行为保持不变。

**验收结果**：

- `pnpm --filter @zhixing/cli exec tsc -p tsconfig.json --noEmit`：通过。
- `pnpm --filter @zhixing/cli exec vitest run src/__tests__/entry-import-graph.test.ts src/__tests__/command-gate.test.ts src/serve/__tests__/logs.test.ts`：通过，15 个测试通过。
- `pnpm cli:build`：通过，构建产物已生成 lazy chunks。
- `pnpm --filter @zhixing/cli test`：通过，140 个文件、2147 个测试通过。
- 构建产物 smoke：`--version`、`--help`、`serve --help`、`status --help`、`stop --help`、`serve logs --help` 均退出码 0 且 1 秒内返回。
- 静态 import 图守卫：`src/__tests__/entry-import-graph.test.ts` 已锁定 `index.ts` 的运行时静态 import 白名单，防止 REPL、server、startup、logs、core 等重模块重新进入元信息路径。
- 构建产物 smoke：`serve logs --lines 0` 返回非法参数错误；`serve --port 19000` 返回 unknown option，外部命令面清理未回退。

**边界记录**：

- 当前守卫是源码级、深度 1 的静态 import 图约束，覆盖 `index.ts` 直接静态拉入重运行模块这一主要回归风险。
- 它不等价于深度无关的运行时求值证明；若未来轻量白名单模块自身引入重依赖，仍需代码审查或运行时探针发现。
- 当前白名单模块保持零依赖或极轻依赖，风险可接受；如未来需要更强保证，可补充 `--version` 运行时探针，断言重运行模块未被求值。

### 5. Bash timeout / abort 后未可靠清理命令进程树

**状态**：已处理，已验证，不再阻断 0.1

**修复前现象**：`@zhixing/tools-builtin` 的 bash 测试用例本身全绿，但 timeout / abort 相关用例结束后，Windows 上仍有 `PING.EXE` 子进程残留，导致 `createTempDir()` 删除测试工作目录时出现 `EBUSY`。Windows 把问题显形为目录锁；根因是 bash 工具没有拥有整棵命令进程树的生命周期，POSIX 下也存在同类孤儿化风险。

**审核结论**：问题真实，且不是测试基础设施问题。`EBUSY` 只是外显症状，真实问题是 bash 工具在报告 timeout / abort 后，没有保证被启动的命令进程树已经停止。当前实现已改为由 bash 工具拥有 shell 根进程，并在 timeout / abort / 输出超限返回前等待进程树清理完成。

**修复前事实证据**：

- `pnpm --filter @zhixing/tools-builtin exec vitest run src/__tests__/bash.test.ts --reporter=verbose`：退出码 0，14 个测试通过。
- 同次输出中，timeout / abort 相关用例出现 4 条 `[test-utils] 清理临时目录失败 ... EBUSY ...`。
- 测试结束后，系统仍可观察到 4 个 `PING.EXE` 进程，启动时间与上述 timeout / abort 用例一致。
- `packages/tools-builtin/src/__tests__/bash.test.ts` 在 Windows 下使用 `ping -n 100 127.0.0.1` 模拟长运行命令，并把 `createTempDir("bash")` 目录作为命令工作目录。
- `packages/tools-builtin/src/bash.ts` 使用 `child_process.exec()`。真实进程树是 shell 子进程启动实际命令子进程；当前 timeout / abort 不能可靠终止整棵进程树。
- `packages/core/src/interrupt/graceful-kill.ts` 的 POSIX 分支优先 `process.kill(-pid, signal)` 杀进程组，但前提是 child 是独立进程组根；当前 bash 用 `exec()` 且未 detached，进程组 kill 不能覆盖 shell 派生出的孙进程。
- `gracefulKill()` 的 Windows 分支当前只对直接 child 调 `kill()`，等价于 TerminateProcess 直接 shell child，不覆盖孙进程。

**补充探针**：

- `exec("ping -n 100 127.0.0.1", { timeout: 500 })` 触发回调时，直接 child shell 已被 Node 标记为 killed，但 `PING.EXE` 仍存活，`ParentProcessId` 仍指向原 shell PID；此时删除 cwd 稳定报 `EBUSY`。
- 手动用 `spawn("cmd.exe", ["/d", "/s", "/c", "ping -n 100 127.0.0.1"])` 启动同一命令，不交给 Node 内置 timeout；在根 shell PID 仍存活时执行 `taskkill /PID <pid> /T /F`，`PING.EXE` 被清理，cwd 可删除。
- 结论：Windows 上必须在 shell 根进程仍可作为树根时杀整棵进程树；等 `exec` 内置 timeout / maxBuffer 先杀掉 shell 后再补救，已经错过可靠树清理窗口。

**落地结果**：

- `@zhixing/tools-builtin` 的 bash 执行内核已从 `exec()` 切换为显式 `spawn(command, { shell: true })`。
- POSIX 下 bash shell 以 detached 方式启动，使 `gracefulKill()` 的进程组终止语义真正覆盖子孙进程；Windows 下保留 shell 根 PID，交给 `taskkill /T /F` 清理常规父子进程树。
- timeout / abort / 输出超限统一走同一个生命周期控制器：先 `await gracefulKill(child)`，再返回 timeout / abort / output-limit 结果。
- stdout / stderr 改为流式收集，并由 bash runner 统一执行输出字节预算，避免 `exec()` 的 `maxBuffer` 隐式 kill 路径再次绕开进程树清理。
- `@zhixing/core` 的 `gracefulKill()` Windows 分支已优先使用 `taskkill.exe /PID <pid> /T /F`，失败时再降级为直接 child kill；POSIX 分支继续使用进程组 SIGTERM 到 SIGKILL 的升级链。
- bash 测试已增加 timeout / abort / 输出超限后的工作目录释放断言，以及引号、空格参数、管道、重定向、环境变量展开和嵌套引号等 shell 解析 parity 覆盖。

**根因**：

- `exec()` 启动 shell 但不让调用方建立可治理的进程树边界。timeout 只保证直接 child 被处理，不等价于“整棵命令进程树已停止”。
- `exec()` 还隐藏了其它会主动 kill 直接 child 的路径，例如 `maxBuffer` 超限；这些路径同样可能留下 shell 派生出的孙进程。
- abort 路径中 `void gracefulKill(child)` 后立即返回，工具调用结果先于子进程清理完成。
- 当前 `gracefulKill()` 在 Windows 上只杀直接 child；在 POSIX 上虽已有进程组 kill 逻辑，但 bash 未用 detached 进程组启动，导致该能力无法真正生效。
- 因此工具层已经返回 “timed out” / “aborted”，但实际命令仍可能在后台运行并持有 cwd、文件句柄或继续产生副作用。

**问题全貌**：

- 这不是 `createTempDir()` 删除策略的问题；临时目录清理只是最早可见的观测点。
- 这也不是 bash 测试“用了 ping”导致的测试偶然性；任何通过 shell 再派生出的长运行进程都可能留下同类残留。
- Windows 因 cwd 锁让问题稳定暴露为 `EBUSY`；POSIX 通常不锁 cwd，泄漏更隐蔽，但“工具返回后孙进程仍运行”的语义风险相同。
- 当前 bash 工具用 `exec()` 同时承担三件事：shell 启动、输出缓存、timeout kill。它适合短命令便利封装，不适合作为可中止、可治理、跨平台的 agent 工具执行内核。
- 只修 abort 路径不够；timeout 和输出超限也必须由同一个进程生命周期控制器管理，否则仍会留下另一条泄漏路径。

**修复前发布影响**：

- 这是核心 bash 工具的生命周期语义问题，不只是测试 warning。
- 0.1 用户或智能体看到 bash 已 timeout / abort 后，命令可能仍在后台继续运行，带来资源泄漏、目录锁、后续命令污染和潜在副作用。
- Windows 是当前发布验证明确暴露问题的平台；POSIX 下同根因可能表现为孤儿进程而不是目录锁。只要 0.1 发布 bash 工具，本问题应视为阻断。

**背后需求**：

- bash 工具必须拥有它启动的进程生命周期。
- timeout / abort 不是“返回一个错误字符串”就结束，而是必须让外部命令进入可证明的停止状态。
- 测试临时目录清理应作为进程生命周期的观测点，而不是用 test-utils 重试或吞 warning 掩盖真实泄漏。

**目标效果**：

- bash 工具在 timeout / abort 返回前，已经完成对子进程树的清理，至少不留下仍运行的命令进程。
- Windows 下 timeout / abort 用例不再残留 `PING.EXE`，测试临时目录可正常删除，不出现 `EBUSY`。
- 正常命令、失败命令、stdout / stderr 捕获、退出码和 shell 解析语义保持不变。

**已采用修复方案**：

- 不通过增加 test-utils 删除重试、延迟清理或静默忽略 warning 来解决。
- 不继续使用 `exec()` 的内置 timeout / `maxBuffer` 作为控制机制；这些机制只能杀直接 child，不能表达“命令进程树已停止”。
- 把 bash 执行内核改为显式 shell runner：
  - Windows：`spawn(command, { shell: true })`，保留 shell 根 PID。
  - POSIX：`spawn(command, { shell: true, detached: true })`，让 shell 成为独立进程组根。
  - stdout / stderr 改为流式收集并由 runner 自己执行输出字节预算；超限时走同一套进程树终止路径。
- 增强核心 `gracefulKill()` 为真正的进程树终止 helper：
  - Windows：优先用系统 `taskkill /PID <pid> /T /F` 终止根进程及其子孙，再等待 root child 退出；`taskkill` 失败时写入诊断日志并降级为 direct child kill，目标已退出类情况不得破坏“中断 helper 永不 reject”的核心契约。
  - POSIX：沿用进程组 SIGTERM → grace → SIGKILL 语义；调用方必须用 detached root 保证 `process.kill(-pid, signal)` 能覆盖子孙进程。
- bash timeout / abort / 输出超限统一由 shell runner 自己触发，先调用并等待 `gracefulKill()`，再返回 timeout / abort / output-limit 结果；避免“工具已返回但命令仍运行”的双事实。
- abort 响应目标从“立即返回但后台清理”调整为“有界等待进程树清理后返回”。Windows `taskkill /T /F` 通常是亚秒级；POSIX 最坏受 grace 窗口约束。外部命令工具的正确性应优先于虚假的即时返回。

**最优方案边界**：

- 进程树终止能力属于核心中断原语，应沉淀在 `@zhixing/core` 的 `gracefulKill()`，避免未来新的外部进程工具各自实现一套 Windows / POSIX 分支。
- shell 命令的启动、输出流收集、timeout、abort、输出预算属于 bash 工具执行内核，应放在 `@zhixing/tools-builtin` 内部，不把 shell 细节泄漏到 core。
- 不引入原生依赖或 Windows Job Object 绑定；0.1 采用 Node 标准库 + Windows 系统自带 `taskkill`，实现可部署、可测试、可维护的进程树治理。
- 不把 `taskkill` 失败静默伪装成成功：`gracefulKill()` 保持永不 reject 的中断原语契约，但 Windows tree-kill 真失败必须进入诊断路径，并清楚降级为 direct child kill；它不等同于 Job Object 级完整隔离。
- `taskkill /T /F` 覆盖常规父子进程树，但不是 Windows 上对自守护 / 杀前已重父化 / 杀后再 fork 进程的完备隔离。0.1 明确选择它作为无原生依赖的现实治理方案；若未来需要对抗性或自守护进程隔离，再升级到 Job Object 级能力。
- 从 `exec(command)` 切到显式 spawn shell runner 时必须保持 shell 解析语义。Windows `cmd.exe` 对 `/d /s /c`、整串命令引号、`windowsVerbatimArguments`、管道、重定向、`%VAR%` 展开和嵌套引号很敏感；POSIX `/bin/sh -c` 也要保持旧语义。生命周期治理不能以破坏用户命令解释为代价。

**验证结果**：

- `pnpm --filter @zhixing/core exec tsc -p tsconfig.json --noEmit` 通过。
- `pnpm --filter @zhixing/tools-builtin exec tsc -p tsconfig.json --noEmit` 通过。
- `pnpm --filter @zhixing/core exec vitest run src/interrupt/__tests__/graceful-kill.test.ts --reporter=verbose` 通过。
- `pnpm --filter @zhixing/tools-builtin exec vitest run src/__tests__/bash.test.ts src/web-fetch/__tests__/internal.test.ts --reporter=verbose` 通过。
- `pnpm --filter @zhixing/core test` 通过。
- `pnpm --filter @zhixing/tools-builtin test` 通过。
- 修复后残留进程检查未发现由 bash timeout / abort / 输出超限测试启动的 `PING.EXE` 或长跑 `node.exe`。
- `pnpm --filter @zhixing/tools-builtin build` 通过。
- `pnpm build` 通过。

**验收标准**：

- 连续多次运行 `packages/tools-builtin/src/__tests__/bash.test.ts`，测试通过且 stderr 不再出现临时目录 `EBUSY` 清理失败。
- timeout / abort 用例结束后，系统中不残留由测试启动的 `PING.EXE`。
- 新增或加强测试锁住 timeout / abort / 输出超限后进程树被清理的契约。
- 新增 shell 解析 parity 测试，覆盖引号、空格参数、管道、重定向、环境变量展开和嵌套命令等常见 shell 语义；Windows 与 POSIX 都要覆盖各自平台路径，确保从 `exec()` 切到显式 shell runner 不改变用户命令行为。
- 新增 `gracefulKill()` 单元测试覆盖 Windows tree-kill 分支和 fallback 降级路径；POSIX 进程组语义由既有单元测试和 bash detached 调用路径共同锁定。
- `pnpm --filter @zhixing/tools-builtin test` 通过；`gracefulKill()` 属于共享核心原语，修复收尾需跑受影响的 core 测试和全量构建，确认无构建回归。

## 产品发布闭环新增问题

本节记录按“0.1 产品发布准备”新目标重新审查后暴露的问题。它们不一定表现为测试红灯，但会直接影响用户能否获取、安装、更新、卸载、理解和诊断知行。

### A. 获取与安装路径未定义

**状态**：待处理（方案已认可，实现待排期）。

**方案评审**：✅ 可执行、已认可（2026-06-24 审查）。北极星=官方安装器（当前 Node + `.js` 地基可达，不需先做 SEA）；0.1 用户主路径=官方一键安装脚本（Windows 先行，自带 / 下载私有 Node 22）；npm 仅作实现底座与高级入口，不作小白用户主叙事；SEA 列为待 `self-exec` Level-2 的可选体积优化，Docker / Web 托管不做。产品目标、渐进路线与验收已收敛，进入实现排期。

**审核结论**：问题真实。若 0.1 面向外部用户公开发布，这是地基级阻断。核心不是代码不能打包，而是尚未形成面向小白用户的官方获取入口；npm 发布链路只是实现底座，不是用户主路径。

**事实证据**：

- `npm view @zhixing/cli version --json`：404。
- `npm view @zhixing/core version --json`：404。
- `npm view zhixing version --json`：404。
- `npm whoami` / `pnpm whoami`：均返回 `ENEEDAUTH`，当前机器未登录 npm registry。
- `npm config get registry` / `pnpm config get registry`：当前指向 `https://registry.npmmirror.com/`，不是 npmjs 官方 registry。
- 根 `package.json` 只有开发脚本，没有 release / publish / install smoke 脚本。
- 根 README 未说明面向用户的安装方式。
- `pnpm -r publish --dry-run --access public --no-git-checks` 可以产出 9 个 `0.1.0` 包；说明当前包元数据具备发布形态。
- `@zhixing/cli` 打包后，`workspace:*` 依赖会转换为 `0.1.0`，不是原样带着 workspace 协议发布。
- 在临时目录把 9 个本地 tgz 一起安装后，`@zhixing/cli` 的 `--version`、`--help`、`status` 可以运行；说明发布物技术上可安装，缺口在正式分发路径和发布流程。

**架构与分发裁决**：

- 当前并不是“`workspace:*` 原样发布导致 npm 必然装不上”。真实情况是：如果所有运行时包都按 `0.1.0` 发布到同一个 registry，`@zhixing/cli` 可以解析这些依赖。
- 但如果只发布 CLI、未发布 8 个运行时依赖包，或发布到了错误 registry，外部用户仍然装不上。
- “带私有 Node 的一键脚本 / 原生安装包”不会破坏当前架构。只要运行形态仍是私有 `node` 执行知行 `.js` 入口，`argv[1]` 仍指向 `.js`，daemon 自重入和本机完整能力都能保留。
- 真正会卡住现有 `self-exec` 约束的是 SEA 单文件二进制：JS 被编进 exe 后没有普通 `.js` 入口。SEA 是未来下载体积优化，不是小白获取路径的必要条件。
- npm 只作为版本、依赖解析和发布物供应的底座；小白用户路径必须包装为“安装知行”的入口。
- 源码安装只服务开发者贡献和内部调试；winget / Scoop / Homebrew 以后作为官方安装包的发现渠道，不作为 0.1 构建主目标。

**发布影响**：

- 外部用户现在没有一条可重复、可信、方便的获取 / 安装路径；“npm 全局安装”对小白用户仍然暴露 Node / npm / registry / PATH。
- 维护者也没有一条可复用的发布命令链；发布依赖人工记忆 registry、登录状态、包顺序和 smoke。
- “代码已经能跑”不能替代“产品已经能被用户拿到”。

**目标效果**：

- 北极星是官方原生安装包：用户下载、双击、即可使用；桌面 / 开始菜单 / 命令行都能进入知行；用户不需要知道 Node、npm、pnpm 或 monorepo。
- 0.1 用户主路径是官方一键安装入口，Windows 先行 PowerShell。目标态是脚本安装私有 Node 22 与知行发布物，创建 `zz` / `zhixing` shim，并完成安装后 smoke。
- npm 发布链路先打通，作为一键脚本和后续安装器的实现底座。
- 根 README 和发布说明围绕用户安装入口书写；npm / 源码安装仅作为高级 / 开发者路径。

**唯一推荐方案**：

- **先打通发布底座**：发布所有非 private 的 `@zhixing/*` 运行时包到目标 registry，显式设置 registry，增加 dry-run、publish 和安装后 smoke，不依赖维护者机器全局配置。
- **再提供 0.1 用户入口**：Windows PowerShell 一键安装脚本下载私有 Node 22 与知行发布物到用户私有目录，创建 `zz` / `zhixing` shim。脚本背后可以使用 npm 包或 release tarball，但用户不需要知道 npm。
- **保留高级 / 贡献路径**：npm 全局安装只给开发者 / 高级用户；源码安装只给贡献者。
- **延后非关键路径**：原生安装包作为北极星后续推进；SEA 单文件、Docker、Web 托管不作为 0.1 主路径。SEA 是体积优化，Docker / Web 托管削弱本机个人智能体的文件、命令和长期状态能力。

**验收标准**：

- 目标 registry 上能解析所有运行时 `@zhixing/*@0.1.0` 包，发布链路有可重复 dry-run 与安装后 smoke。
- 0.1 官方用户安装入口已确定。完整目标态的一键脚本必须自带 / 下载私有 Node 22，不要求用户先安装 Node。
- 如果 0.1 首版脚本只做到“检测 Node，缺失时引导用户安装”，必须在发布文档中标记为过渡半成品，不能宣称已满足“小白无需知道 Node”的目标；紧接着的下一步必须是脚本自带运行时。
- 干净环境执行官方安装入口后，`zz --version` 输出 `0.1.0`，`zz --help` 正常返回，`zz status` 能给出 stopped / running / stale 等状态。
- 发布文档明确区分：小白用户入口、一键脚本背后的实现机制、高级 npm 入口、源码贡献路径；不能把 npm 写成小白用户主入口。

### B. 更新、回滚、卸载与重置缺失

**状态**：待处理（方案已认可，实现待排期）。

**方案评审**：✅ 可执行、已认可（2026-06-24 审查）。B 镜像 A——安装入口统一管装/更新/回滚/卸载/重置；骨架=版本化目录 + 固定 shim + `current` 指针（Windows 用 junction / `current.txt`，不用 symlink）；更新=装新目录→`zz stop` 旧 daemon→切 `current`→smoke→失败回滚，且 smoke 前数据零破坏、旧版本目录留到其 daemon 停；卸载交外部安装入口（Windows 删不掉运行中程序）、默认只删程序、删凭据二次确认；重置分运行态/配置/凭据/workspace 四级；0.1 不做 `zz update`/`zz uninstall` 核心命令，版本化目录骨架 0.1 建立、自动回滚能做就做、否则文档化回滚作过渡半成品。进入实现排期。

**审核结论**：问题真实。B 与 A 是同一条产品线：谁负责安装，谁就负责更新、回滚和卸载。若 0.1 面向外部用户公开发布，这是产品生命周期阻断；若内部 tag，也应至少记录可执行的手动路径，避免维护者误删或漏删用户状态。

**事实证据**：

- 未发现 `zz update`、`zz upgrade`、`zz uninstall`、`zz reset`、`zz doctor` 等外部命令。
- `zz stop` 存在，可停止后台宿主。
- 当前持久状态包括 `config.jsonc`、`credentials.json`、`logs/server/`、`server.pid`、`server.port`、`server.token`、server state / ready marker、conversation / task / memory 等用户数据。
- CLI README 有故障排查，但没有正式的更新、回滚、卸载、重置说明。

**架构裁决**：

- 更新 / 卸载由外部安装入口拥有，不做成 `zz update` / `zz uninstall`。Windows 下运行中的程序不能可靠删除自己的 Node / 程序目录，卸载必须由安装它的入口在程序外执行。
- `zz reset` 可以作为数据级命令：它不删除程序文件，只在先 `zz stop` 后清理运行状态、配置或用户数据。
- 生命周期状态分三层：程序层、用户数据层、凭据层。程序可替换；用户数据默认不可动；`credentials.json` 永远单独说明、单独确认。
- B 的更新校验依赖 A 的分发源：npm 天生有 integrity；若走 release host，则必须发布 manifest 与 hash。

**发布影响**：

- 用户安装后不知道如何升级到下一个版本。
- 更新失败时没有回滚策略，可能留下旧 daemon、旧配置、旧 token 或旧状态文件。
- 用户想卸载或重置时，不知道哪些是程序文件、哪些是用户数据、哪些是凭据，容易误删或遗留敏感信息。
- 如果更新直接覆盖当前程序目录，正在运行的 daemon 可能仍持有旧版本文件；失败回滚也会变得脆弱。

**目标效果**：

- 北极星是官方安装器接管完整生命周期：安装、检查更新、自动更新、回滚、卸载、重置。
- 0.1 一键安装入口同时成为生命周期入口：首次运行安装，再次运行更新，卸载由同一入口或配套卸载脚本执行。
- 更新骨架采用版本化安装目录 + 固定 shim + `current` 指针：新版本装到独立目录，shim 不变，切 `current` 完成升级；回滚就是切回上一版本。
- Windows 上 `current` 不依赖普通 symlink；优先用 junction 或 shim 读取 `current.txt`，避免管理员权限 / 开发者模式要求。
- 重置分级：运行态、配置、凭据、workspace。凭据和 workspace 永远显式确认，workspace 不默认删除。

**唯一推荐方案**：

- **安装布局**：`versions/<version>/` 存放知行应用与私有 Node，固定 `zz` / `zhixing` shim 读取 `current` 指向的版本目录启动。至少保留当前版本和上一个版本。
- **更新流程**：读取 manifest → 校验版本与 hash / integrity → 下载并安装到新版本目录 → `zz stop` 停旧 daemon → 切 `current` → 运行 smoke → smoke 失败则切回旧版本。
- **数据零破坏不变量**：smoke 通过前只改程序目录和 `current` 指针，不能就地迁移或改写 `config.jsonc`、`credentials.json`、会话、任务、记忆或 state schema。任何数据迁移必须可备份可逆，或推迟到 smoke 通过后。
- **旧版本目录不早删**：旧 daemon 确认停止前不得删除它启动时所在的具体版本目录；旧目录默认保留作回滚。
- **卸载流程**：外部安装入口先 `zz stop`，再删除程序层、私有 Node、shim、PATH / 快捷方式；默认保留 `ZHIXING_HOME` 与用户数据；删除凭据必须二次确认。
- **重置流程**：`zz reset` 作为数据级命令，先停 daemon，再按用户选择清理运行残留、重建配置、删除用户数据、删除凭据；不负责卸载程序。
- **0.1 可接受底线**：版本化目录骨架应在 0.1 建立；自动回滚能做就做。若来不及自动回滚，至少提供 smoke 失败后的明确回滚命令 / 切指针步骤，并标记为过渡半成品。

**验收标准**：

- 一键安装入口支持安装、更新、卸载；或发布材料明确标记尚处过渡，并给出可执行手动路径。
- 更新在干净环境可完成：新版本安装到独立目录，`current` 切换后 `zz --version`、`zz --help`、`zz status` 通过。
- 更新失败时不会破坏用户数据；至少可手动切回上一版本，理想状态下自动回滚。
- 卸载默认只删程序层，不删 `ZHIXING_HOME`；删除 `credentials.json` 必须单独确认。
- `credentials.json` 创建和重写时应尽力设为仅当前用户可读写；POSIX 使用 `0600`，Windows 先依赖用户 profile ACL，后续如需更强隔离再做专门 ACL 设计。
- `zz reset` 或发布材料提供运行态 / 配置 / 凭据 / workspace 分级重置说明。
- 发布材料列出 `ZHIXING_HOME` 默认位置与覆盖方式，用户能知道状态落在哪里。

**必要发布说明**：

- `config.jsonc` 是配置决策文件，不存凭据；`credentials.json` 存 provider API key、channel secret 等真实凭据。
- 0.1 沿用既有设计：凭据保存在本机明文 `credentials.json`，不引入 OS keychain / 加密存储。
- 发布材料只需明确凭据文件路径、明文性质、不要提交 / 分享 / 同步，以及卸载 / 重置时删除凭据必须单独确认。
- 明文凭据文件必须有最低限度的本机私有性：创建 / 重写 `credentials.json` 时尽力收紧到当前用户可读写。

## 0.1 发布最低清单

发布前至少满足：

- `pnpm build` 通过。
- `pnpm lint` 通过。
- `pnpm -r exec tsc --noEmit` 通过。
- `pnpm test` 通过。
- CI / 发布环境中的 Node 进程能执行 `spawn("rg", ["--version"])`；否则必须明确记录 ripgrep native 路径未在该环境验证。
- 0.1 CLI smoke 清单已从当前入口和产品边界中固化。
- 纳入清单的 CLI 命令全部按预期通过。
- 官方获取 / 安装路径已裁定，并通过干净环境安装 smoke。
- 官方更新、回滚、卸载 / 重置路径已写入发布材料。
- 凭据文件位置、明文性质与删除方式已写入发布材料。
- `credentials.json` 创建 / 重写时已尽力设置为仅当前用户可读写。
- 支持平台与验证状态已写入发布材料。
- 最小诊断清单已写入发布材料。

## 已验证

### 2026-06-23

#### 修复前基线

- `pnpm -r exec tsc --noEmit`：通过。
- `pnpm lint`：通过。
- `pnpm build`：通过。
- `pnpm test`：失败，阻断点见本文问题 1 和问题 2。
- `pnpm --filter @zhixing/tools-builtin exec vitest run src/__tests__/grep.test.ts src/web-fetch/__tests__/internal.test.ts`：失败，`grep.test.ts` 稳定失败，`web-fetch/internal.test.ts` 单独通过。
- `pnpm --filter @zhixing/tools-builtin exec vitest run src/__tests__/grep.test.ts --reporter=verbose`：失败，19 个 grep 测试中 17 个通过、2 个稳定失败。
- `rg --version`：当前环境为 ripgrep 15.1.0。
- grep 探针：正常 ripgrep 路径输出绝对 Windows 路径和 raw `--` 分隔符；强制 `rg` 不可用后，Node fallback 输出 `Found N matches in M files` 与相对路径文件块，确认双搜索执行器输出契约不一致。
- `rg --json -C2` 探针：可获得 `begin`、`match`、`context`、`end`、`summary` 结构化事件，支持用结构化事件构建统一结果模型，替代 raw stdout 解析。
- `node packages\cli\dist\index.js --help`：超时。
- `node packages\cli\dist\index.js serve --help`：超时。
- `node packages\cli\dist\index.js --version`：超时。
- `git status --short --branch`：工作区干净。

#### 问题 1 修复后补充验证

- `pnpm --filter @zhixing/tools-builtin exec tsc --noEmit`：通过。
- `pnpm --filter @zhixing/tools-builtin test -- src/__tests__/grep-core.test.ts src/__tests__/grep-executors.test.ts src/__tests__/grep.test.ts`：通过，52 个 grep 相关测试通过。
- `pnpm --filter @zhixing/tools-builtin test`：通过，283 个 tools-builtin 测试通过。
- `pnpm --filter @zhixing/tools-builtin build`：通过。
- `where rg`：当前验证环境可找到 `rg.exe`。
- Node `spawn("rg", ["--version"])`：退出码 0，当前验证环境可实际验证 ripgrep native 路径。
- `git diff --check`：通过。

### 2026-06-24

#### CLI help / version 复测

- `node packages\cli\dist\index.js --version`：退出码 0，约 3.9 秒返回。
- `node packages\cli\dist\index.js --help`：退出码 0，约 3.0 秒返回。
- `node packages\cli\dist\index.js serve --help`：退出码 0，约 3.0 秒返回。
- 结论：历史“约 13 秒超时 / 挂起”不再复现；当前问题降级为 3 秒级启动延迟。

#### ripgrep native 路径复测

- 当前验证环境中，PowerShell `Get-Command rg` 可找到 Codex 环境提供的 `rg.exe`。
- Node `spawn("rg", ["--version"])`：退出码 0。
- `pnpm --filter @zhixing/tools-builtin exec vitest run src/__tests__/grep-executors.test.ts`：通过，11 个测试通过，包含 ripgrep 对齐契约测试。
- 结论：当前验证环境可实际覆盖 ripgrep native 路径；CI / 发布环境仍需独立保证 Node 进程可 `spawn("rg")`。

#### 问题 2 复验

- `pnpm --filter @zhixing/tools-builtin exec vitest run src/web-fetch/__tests__/internal.test.ts --reporter=dot` 连续 5 次：全部通过；该文件 28 个测试均通过。
- `processContent()` HTML markdown 微基准：首次转换约 478.94ms，后续调用约 8.54ms 至 60.21ms，未接近默认 5000ms 单测超时。
- `pnpm --filter @zhixing/tools-builtin exec vitest run src/web-fetch/__tests__/internal.test.ts src/__tests__/grep.test.ts src/__tests__/bash.test.ts --reporter=dot`：通过，68 个测试通过。
- `pnpm test`：通过。

---

## 最后处理：发布材料与入口文档

本节不属于上方工程问题序列。它承接的是 0.1 产品发布的最后一公里：用户第一次接触知行时，能否通过公开入口建立正确认知、获得产品、安装运行、诊断问题，并理解当前版本边界。

### 根 README 仍停留在研究期表述

**状态**：待处理。

**处理顺序**：放在工程门禁和产品发布闭环问题之后处理。它不能反向定义 0.1 能力，只能对齐已经确认的系统事实、安装路径、运行入口和发布边界。

**现象**：根 `README.md` 仍偏向项目早期说明，没有承载当前多包架构、安装方式、运行方式和 0.1 边界。

**审核结论**：问题真实。若 0.1 是公开发布，这是发布材料阻断；若只是内部 tag，可以降级为发布说明任务。

**事实证据**：

- 根 README 仍包含“代码将在研究阶段后逐步加入”等早期表述。
- 仓库实际已经包含 `core`、`orchestrator`、`cli`、`server`、`tools-builtin`、`providers`、`mcp`、`network` 等多个包。

**发布影响**：

- 外部用户进入仓库后无法从根 README 建立正确 mental model。
- 用户无法从首屏文档确认如何获取、安装、启动、更新或诊断当前 0.1 产品。
- 如果维护者把根 README 当作权威依据，会误判当前系统状态。

**背后需求**：

- 发布判断应先由当前系统事实生成，再决定 README 怎么更新。
- 根 README 可以承担发布材料角色，但不能反向决定 0.1 当前能力。
- 研究文档可以保留愿景，但发布入口要服务实际使用，并明确自己是否是当前版本说明。

**目标效果**：

- 根 README 简洁描述当前架构和 0.1 能力边界，并明确与研究愿景的关系。
- 获取、安装、更新、运行、诊断、构建、测试和 CLI 使用命令与真实入口一致。
- 发布材料包含平台支持表；0.1 若只完成 Windows 验证，就把 Windows 写为已验证平台，macOS / Linux 写为待验证或最佳努力。
- 发布材料包含最小诊断清单：`zz --version`、Node 版本、平台、`ZHIXING_HOME`、`zz status`、日志路径 / `zz serve logs`。
- `/doctor` 是后续高价值诊断增强，应优先作为交互模式内命令设计；0.1 不新增外部 `zz doctor`。
- 明确标注 0.1 的限制，避免把愿景当成已发布能力。

**验收标准**：

- 根 README 不再被本文用作发布标准来源。
- 新用户只读根 README 能找到当前获取、安装、更新、基础 CLI smoke 和诊断入口，且这些入口来自已验证清单。
- README / 发布说明包含平台支持表，每个平台都有“支持状态、验证命令、已知限制”。
- README / 发布说明包含最小诊断信息收集步骤。
- 根 README 不再包含与当前仓库状态明显冲突的研究期措辞。
