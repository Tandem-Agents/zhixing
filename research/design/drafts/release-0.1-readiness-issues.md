# 0.1 发布问题临时追踪

> 临时文档：只用于本轮 0.1 发布前问题排查与收口追踪。全部阻断问题解决并沉淀到正式发布清单、自动化 smoke 或问题清单后删除本文，不作为长期规格维护。

## 处理流程与判断标准

本节适用于本文所有问题。每个问题都按同一流程推进，避免把发布判断变成“感觉差不多了”。

### 处理流程

1. **事实审核**：先确认问题是否真实。必须给出命令、输出、代码路径或最小复现证据；不能只凭印象定性。
2. **发布影响判断**：把技术现象翻译成 0.1 用户会遇到的真实风险。重点回答：是否影响安装、启动、基础命令、核心工具或协议边界。
3. **目标效果定义**：先定义 0.1 应达到的可交付行为，再决定修复方向。目标效果必须能被自动测试或明确的 smoke 流程验证。
4. **根因定位**：先建立可观测性，再定位。不要靠“猜一个地方改一下，然后让用户试”推进发布。
5. **修复与验证**：优先补能复现失败的测试或脚本，再修实现。修完必须重新跑对应门禁。
6. **沉淀或删除**：全部问题解决后，把长期发布标准沉淀到正式清单、自动化 smoke 或 CI；本文删除。

### 顶层判断标准

- **门禁标准**：`pnpm build`、`pnpm lint`、`pnpm -r exec tsc --noEmit`、`pnpm test` 必须全绿。
- **核心-接入面标准**：知行是一个核心 + 多个接入面。核心功能、工具契约、会话事实和权限语义必须独立于 CLI、飞书、RPC 或未来 App 的展示方式；接入面只负责采集输入、投影事实、承载交互，不能反向定义核心行为。
- **CLI 标准**：以当前构建产物暴露的真实入口为准。纳入 0.1 smoke 的 CLI 命令必须有明确预期，并按预期返回、启动或退出。
- **用户标准**：0.1 用户从安装后的二进制入口出发，应能完成自发现和最小 smoke；不能第一步就遇到不存在的参数、挂起的基础命令、或红色测试所代表的基础工具缺陷。
- **依据标准**：本文发布判断只以代码、构建产物、自动化测试和可观测 smoke 为依据。README、设计稿、历史文档都可能滞后，不能反向定义发布标准；文档不一致只作为独立问题记录。
- **可重复标准**：发布结论必须来自可重复命令，而不是一次人工观察。flaky 测试即使偶尔能过，也应视为发布风险。
- **跨平台标准**：当前已在 Windows 环境暴露路径格式、进程清理和 CLI 启动问题；0.1 至少要把 Windows 作为明确支持或明确限制的平台处理。

### 当前需求边界澄清

- 本文讨论的是“是否可以发布 0.1”的阻断问题，不讨论 0.1 之后的产品愿景扩展。
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

本轮发布判断基于一次只读检查和门禁命令执行。仓库当前位于 `develop`，检查后工作区保持干净。

已经通过的门禁：

- `pnpm -r exec tsc --noEmit`
- `pnpm lint`
- `pnpm build`

已经暴露问题的门禁 / smoke：

- `pnpm test`
- `node packages\cli\dist\index.js --help`
- `node packages\cli\dist\index.js serve --help`
- `node packages\cli\dist\index.js --version`

本轮重点涉及的文件：

- `packages/tools-builtin/src/__tests__/grep.test.ts`
- `packages/tools-builtin/src/grep.ts`
- `packages/tools-builtin/src/web-fetch/__tests__/internal.test.ts`
- `packages/tools-builtin/src/web-fetch/internal.ts`
- `packages/cli/src/index.ts`
- `packages/cli/README.md`
- `README.md`

## 当前发现

### 1. `grep` 有两套搜索执行器，但核心工具输出没有统一契约

**状态**：已定位，待方案落地

**现象**：全量执行 `pnpm test` 时，递归测试在 `@zhixing/tools-builtin` 失败退出。单独执行 `pnpm --filter @zhixing/tools-builtin exec vitest run src/__tests__/grep.test.ts --reporter=verbose` 仍稳定失败 2 个用例。

**审核结论**：问题真实，是 0.1 发布阻断。它不是两个断言偶然写窄，而是核心 `grep` 工具缺少统一输出契约：ripgrep 路径直接返回人类可读 stdout，Node fallback 路径返回另一套自定义格式。当前红灯只是最先暴露的两个症状。

**事实证据**：

- `pnpm test` 退出码为 1；`@zhixing/tools-builtin` 为 2 个测试文件失败、17 个测试文件通过；3 个测试失败、247 个测试通过。
- `grep.test.ts` 单独重跑结果：19 个测试中 17 个通过、2 个失败。
- 当前环境 `rg --version` 为 ripgrep 15.1.0。
- 稳定失败集中在 `packages/tools-builtin/src/__tests__/grep.test.ts`：
  - “排除 node_modules”期望输出包含 `src/app.ts`，实际收到 `C:\Users\...\src\app.ts:1:findThis`。
  - “处理多文件匹配”期望输出包含 `3 files`，实际收到多行 raw ripgrep 输出和 `--` 分隔符。
- `packages/tools-builtin/src/grep.ts` 中 `tryRipgrep()` 使用 `execFile("rg", args)` 后直接把 stdout 交给 `formatOutput()`；content mode 的 `formatOutput()` 基本原样返回 stdout。
- 同一 fixture 下，正常 ripgrep 路径输出绝对 Windows 路径和 raw `rg` 分隔符；强制 `rg` 不可用后，Node fallback 输出 `Found 3 matches in 3 files:`、`── src/app.ts ──`、`> 1|...` 这种自定义格式。
- `rg --json -C2` 已验证可提供结构化事件：`begin`、`match`、`context`、`end`、`summary`，不需要解析 raw 文本 stdout。

**问题全貌**：

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

**根因**：

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

**状态**：定位中

**现象**：全量执行 `pnpm test` 时，`packages/tools-builtin/src/web-fetch/__tests__/internal.test.ts` 中 “HTML markdown 模式: 用 turndown 转 markdown” 超过 5000ms 超时。

**审核结论**：问题需要更多观测，但按发布标准应视为风险。它单独运行能过，说明可能是并发、动态 import、资源竞争或测试隔离问题。

**事实证据**：

- `pnpm test` 全量运行中该用例超时失败。
- 单独执行 `pnpm --filter @zhixing/tools-builtin exec vitest run src/web-fetch/__tests__/internal.test.ts` 时，该文件 28 个测试通过，用时约 285ms。
- 相关实现位于 `packages/tools-builtin/src/web-fetch/internal.ts`，markdown 模式会动态加载 `turndown`。

**发布影响**：

- 0.1 的发布门禁不能依赖“单独跑能过”。全量测试 flaky 会让后续发布、回归和协作成本变高。
- `web_fetch` 是网络工具能力，属于用户会直接感知的内置能力。

**背后需求**：

- HTML -> markdown 的转换应稳定、可预测，测试不应受其他测试文件并发影响。
- 如果依赖动态 import 或较重初始化，应有缓存、超时预算或测试隔离策略。

**目标效果**：

- 全量 `pnpm test` 中该测试稳定通过。
- 单独运行和递归运行行为一致。

**倾向排查方向**：

- 用 `vitest --runInBand` 或限定 worker 数对比，确认是否为并发触发。
- 给 `processContent()` 的 turndown 初始化加观测或缓存验证，确认是否有首次加载阻塞。
- 检查同包其他测试是否 mock / 污染全局 fetch、DOM、module cache 或 timers。

**验收标准**：

- 连续多次执行 `pnpm --filter @zhixing/tools-builtin test` 通过。
- 全仓 `pnpm test` 通过。
- 如果最终判定为测试预算不足，需要用明确证据调整 timeout，而不是盲目加大。

### 3. 0.1 CLI 必需命令清单尚未从系统事实中固化

**状态**：待处理

**现象**：当前已经用 help / version / serve help 做了初步 smoke，但 0.1 到底必须保证哪些 CLI 命令可用，还没有形成一份独立于 README 的权威清单。

**审核结论**：问题真实。系统需要哪些命令，不能由滞后文档反推；必须由 0.1 产品边界、当前代码入口、构建产物和最小用户路径共同定义。

**事实证据**：

- 当前 `packages/cli/src/index.ts` 暴露了顶层命令、`status`、`stop`、`rpc`、`serve` 以及部分隐藏的 `serve` 子命令。
- 本轮只验证了 dist 入口的 `--help`、`--version`、`serve --help`，尚未形成完整 smoke 矩阵。
- `packages/cli/README.md` 中存在未实现参数，说明不能用 README 作为命令清单来源。

**发布影响**：

- 没有权威 smoke 清单时，发布判断容易摇摆：可能漏掉真正关键的命令，也可能被历史文档里的规划命令误导。
- 后续修复 CLI 超时时，需要知道哪些命令属于 0.1 必保路径，哪些只是文档债务或未来能力。

**背后需求**：

- 0.1 CLI 命令清单应该从“用户完成最小闭环需要什么”出发，而不是从历史 README 示例出发。
- 每个纳入 smoke 的命令都要有理由、预期行为和验证方式。

**目标效果**：

- 形成一份 0.1 CLI smoke 清单，明确命令、预期输出 / 退出条件、是否允许启动长期服务。
- help / version / status / serve / rpc 等命令是否纳入 0.1 必保范围，有明确判断依据。
- 后续 README 只能对齐这份清单，不能反向定义它。

**验收标准**：

- 本文或正式发布清单中出现“0.1 CLI smoke 清单”，且每个命令都有预期结果。
- smoke 清单来源标明为当前代码入口、构建产物和产品边界，而不是 README。
- 所有纳入清单的命令都能被脚本或手动命令重复验证。

### 4. CLI 构建产物的 help / version 命令超时

**状态**：待处理

**现象**：构建成功后，直接执行 CLI dist 入口的基础 help / version 命令没有及时返回。

**审核结论**：问题真实，且大概率是 0.1 发布阻断。help / version 通常属于 CLI 自发现入口；最终是否作为阻断，以问题 3 中固化的 0.1 CLI smoke 清单为准。

**事实证据**：

- `pnpm build` 成功。
- 以下命令均在约 13 秒内未返回，被执行超时中断：
  - `node packages\cli\dist\index.js --help`
  - `node packages\cli\dist\index.js serve --help`
  - `node packages\cli\dist\index.js --version`

**发布影响**：

- 用户安装后第一反应通常是运行 `--help` 或 `--version`。这些命令挂起会直接破坏 0.1 的可信度。
- 测试、诊断脚本和人工排查都依赖 help / version 是低成本命令。

**背后需求**：

- CLI 的元信息命令应只解析参数并输出，不应启动长生命周期服务、连接 provider、初始化交互 REPL 或等待外部资源。
- `serve --help` 应显示子命令帮助后立即退出，不应进入 server 启动路径。

**目标效果**：

- `zz --help` 和 `node packages\cli\dist\index.js --help` 在 1 秒内输出帮助并退出。
- `zz --version` 和 dist 入口 `--version` 在 1 秒内输出版本并退出。
- `zz serve --help` 只输出 serve 帮助，不启动后台服务。

**倾向排查方向**：

- 检查 `packages/cli/src/index.ts` 中 program 初始化是否在 parse 前执行了长期副作用。
- 检查默认 action、host ensure、stdin/raw mode、server lifecycle 是否被 help / version 路径提前触发。
- 给 CLI 增加最小 smoke 测试，确保 help / version 不回归。

**验收标准**：

- `node packages\cli\dist\index.js --help` 退出码为 0，快速返回。
- `node packages\cli\dist\index.js --version` 退出码为 0，快速返回。
- `node packages\cli\dist\index.js serve --help` 退出码为 0，快速返回。
- 如果项目发布入口是 `zz`，还需要验证 `zz --help`、`zz --version`、`zz serve --help`。

### 5. CLI 文档与当前入口不一致，不能作为发布判断依据

**状态**：待处理

**现象**：`packages/cli/README.md` 中的示例和当前 `packages/cli/src/index.ts` 的 Commander 配置不一致。

**审核结论**：问题真实。README 不能作为判断 CLI 应支持哪些命令的依据；真实标准必须来自当前代码、构建产物和 smoke 验证。若 0.1 面向外部用户发布，文档与实际入口不一致需要单独收口。

**事实证据**：

- README 写到“单次 `zhixing -p "prompt"`”。
- README 示例包含 `zhixing -p ...`、`--provider openai`。
- README 示例包含 `zhixing serve -m claude-3-5-sonnet`、`zhixing serve -w /path/to/workspace`。
- 当前 `packages/cli/src/index.ts` 可见的顶层 option / command 包括：
  - `--log`
  - `status`
  - `stop`
  - `rpc [method] [args...]`
  - `serve`
  - `serve --port`
  - `serve --host`
  - 隐藏的 `serve stop`、`serve status`、`serve logs`
- 当前入口未看到 `-p`、`--prompt`、`--provider`、`serve -m`、`serve -w`。

**发布影响**：

- 如果用户照滞后的 README 操作，可能立即失败或进入非预期路径。
- 如果维护者用 README 反推发布标准，会把历史设想误当成当前系统能力，污染 0.1 判断。

**背后需求**：

- 发布判断必须先从当前系统事实出发：源码入口、构建产物、命令输出、测试和 smoke。
- 文档更新是发布材料问题，不是定义系统能力的上游来源。
- 如果某些能力属于近未来规划，应进入 roadmap 或“暂未支持”段落，而不是作为当前能力示例。

**目标效果**：

- 本文和发布清单不再依赖 README 描述来定义 CLI 标准。
- 当前 CLI 到底需要哪些命令，由 0.1 产品边界、代码入口和 smoke 清单定义。
- README 如果保留命令示例，必须标注其状态，或改为当前构建产物可验证的命令。
- `sessionId` / `conversationId` 术语一致，不让 RPC 用户在 0.1 入口面混淆。

**倾向修复方向**：

- 先定义 0.1 的真实 CLI smoke 清单，再回头更新 README。
- 不为了匹配滞后文档而补大功能；除非该功能被重新确认为 0.1 必需能力。
- RPC 文档统一到当前真实协议；兼容 alias 可以说明，但主文档只保留一个主术语。

**验收标准**：

- 发布判断文档中不再出现“以 README 描述为准”的标准。
- 0.1 CLI smoke 清单由当前入口和产品边界直接定义。
- README 中仍保留的当前能力示例必须有对应 smoke 命令验证；未实现示例移入 roadmap 或删除。

### 6. 根 README 仍停留在研究期表述

**状态**：待处理

**现象**：根 `README.md` 仍偏向项目早期说明，没有承载当前多包架构、安装方式、运行方式和 0.1 边界。

**审核结论**：问题真实。若 0.1 是公开发布，这是阻断；若只是内部 tag，可以降级为发布说明任务。

**事实证据**：

- 根 README 仍包含“代码将在研究阶段后逐步加入”等早期表述。
- 仓库实际已经包含 `core`、`orchestrator`、`cli`、`server`、`tools-builtin`、`providers`、`mcp`、`network` 等多个包。

**发布影响**：

- 外部用户进入仓库后无法从根 README 建立正确 mental model。
- 如果维护者把根 README 当作权威依据，会误判当前系统状态。

**背后需求**：

- 发布判断应先由当前系统事实生成，再决定 README 怎么更新。
- 根 README 可以承担发布材料角色，但不能反向决定 0.1 当前能力。
- 研究文档可以保留愿景，但发布入口要服务实际使用，并明确自己是否是当前版本说明。

**目标效果**：

- 根 README 简洁描述当前架构和 0.1 能力边界，并明确与研究愿景的关系。
- 构建、测试、CLI 使用命令与真实入口一致。
- 明确标注 0.1 的限制，避免把愿景当成已发布能力。

**验收标准**：

- 根 README 不再被本文用作发布标准来源。
- 新用户只读根 README 能找到当前构建和基础 CLI smoke 的入口，且这些入口来自已验证清单。
- 根 README 不再包含与当前仓库状态明显冲突的研究期措辞。

### 7. Windows 测试清理出现 EBUSY 警告

**状态**：非阻断但需记录

**现象**：全量测试中 bash 相关测试文件通过，但 stderr 出现临时目录清理失败警告，错误形态为 Windows `EBUSY`。

**审核结论**：当前不是红灯，但代表测试隔离 / 进程清理风险。若频繁出现或导致 CI 红灯，应升级为阻断。

**事实证据**：

- `@zhixing/tools-builtin` 的 bash 测试通过。
- 测试输出出现 `[test-utils] 清理临时目录失败 ... EBUSY ...`。

**发布影响**：

- Windows 下仍可能有子进程或文件句柄未完全释放。
- 未来测试数量增多后，警告可能变成 flaky 失败或污染后续测试。

**背后需求**：

- 测试基础设施应可靠释放进程、stdio、文件句柄和临时目录。
- 失败时应留下足够诊断信息，而不是只在 teardown 暴露 EBUSY。

**目标效果**：

- 全量测试不出现 EBUSY 清理警告。
- 如果 Windows 平台存在不可避免延迟，应在 test-utils 中用受控重试和超时处理。

**验收标准**：

- 连续多次运行 bash 相关测试，不再出现临时目录清理失败警告。
- 若保留警告，必须有明确 issue 或注释说明原因、影响和后续处理条件。

## 0.1 发布最低清单

发布前至少满足：

- `pnpm build` 通过。
- `pnpm lint` 通过。
- `pnpm -r exec tsc --noEmit` 通过。
- `pnpm test` 通过。
- 0.1 CLI smoke 清单已从当前入口和产品边界中固化。
- 纳入清单的 CLI 命令全部按预期通过。

## 已验证

### 2026-06-23

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
