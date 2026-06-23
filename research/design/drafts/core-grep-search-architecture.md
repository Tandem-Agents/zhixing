# grep 核心搜索能力架构设计

> 本文定义知行核心层的 grep 搜索能力。它是核心工具架构文档，不是 CLI 展示文档，也不是临时修复记录。

## 核心判断

`grep` 是知行核心层的代码搜索能力，不属于任何单一接入面。

知行的产品架构是**一个核心 + 多个接入面**：CLI、飞书、RPC、未来 Web / App 都只是接入面。搜索能力必须在核心层形成稳定契约，接入面只能消费和投影结果，不能反向定义搜索语义。

最优架构不是“只有一种搜索实现”，也不是“多个实现各自返回结果”。最优架构是：

```text
一个核心 grep 能力
  ├─ Query + File Candidate Policy：定义搜索语义
  ├─ ripgrep 搜索执行器：高性能搜索实现
  └─ Node 搜索执行器：可移植搜索实现
      ↓
统一核心搜索语义
      ↓
统一核心工具结果：LLM-facing content + access-surface presentation
      ↓
CLI / 飞书 / RPC / App 各自投影
```

一句话：**双执行器是对的，双契约是错的。**

命名说明：本文把 ripgrep / Node 称为“搜索执行器”，含义是核心 `grep` 内部用于执行搜索的实现适配层；它不是服务端，也不是 CLI、飞书、RPC 或未来 App 这类接入面。

## 产品原则

- **核心唯一**：`grep` 的搜索语义由核心定义，不由 CLI、飞书、RPC 或未来 App 定义。
- **执行器可替换**：ripgrep 和 Node 都只是搜索执行器实现；执行器可以变化，核心契约不能漂移。
- **接入面只投影**：接入面可以把结果显示成终端文本、飞书卡片、RPC JSON 或未来 UI 卡片，但不能各自修补搜索语义。
- **性能与可用性兼得**：ripgrep 提供大仓库搜索性能，Node fallback 保证没有外部命令时仍可用。
- **路径可继续操作**：搜索结果里的路径必须适合后续核心工具调用，例如 `read` / `edit` / `write`。
- **跨平台一致**：Windows、macOS、Linux 上的路径、排序、统计、忽略规则和输出结构应保持同一核心契约。
- **资格先于执行**：搜索执行器只有在能满足本次查询的核心语义时才可执行；不能先跑出结果再让调用方猜它是否可信。
- **双通道结果**：`ToolResult.content` 服务 LLM，`ToolResult.presentation` 服务接入面富展示。接入面不得解析 `content` 来重建搜索事实。

## 核心能力边界

`grep` 的核心职责：

- 接收搜索请求。
- 在工作区或指定路径中搜索文本。
- 返回可被 agent 理解、可被后续工具引用的搜索结果。
- 统一处理路径、匹配行、上下文、文件数、匹配数、排序、截断和错误语义。
- 生成给 LLM 的文本结果，并同时暴露给接入面投影的结构化结果。

`grep` 不负责：

- CLI 卡片样式。
- 飞书 markdown 样式。
- RPC 客户端自己的 UI 表现。
- 某个接入面的宽度、颜色、折叠、交互展开。

这些都属于接入面投影。

## 搜索语义裁决

0.1 默认 `grep` 契约是**逐行核心搜索**。

这不是完整 ripgrep 语义，也不是完整 JavaScript RegExp 语义，而是一个可携带、可 fallback、可跨平台验证的核心子集：

- 搜索单位是行。
- `matchedLineCount` 表示匹配行数，不表示正则出现次数。
- 上下文行围绕匹配行展开。
- 默认不支持跨行匹配。
- 默认不承诺 lookaround、backreference、PCRE2 等高级语法。
- 高级搜索能力必须通过显式 `regexDialect` / capability 扩展进入，不能由某个搜索执行器静默带入。

这条裁决让核心语义独立于具体搜索执行器。ripgrep 是高性能搜索执行器，Node 是可移植搜索执行器；二者都不能单独成为产品语义的所有者。

## 架构分层

### 1. Query 层

核心先把用户输入规整成 `GrepQuery`。

建议字段：

- `pattern`
- `regexDialect`
- `caseSensitivity`
- `encodingPolicy`
- `capabilities`
- `workingDirectory`
- `searchPath`
- `glob`
- `outputMode`
- `contextLines`
- `ignoreRules`
- `maxResultChars`
- `maxLineChars`

`GrepQuery` 是核心搜索语义的入口。所有搜索执行器都接收同一个 query，不直接消费用户原始 input。

默认 `regexDialect` 为 `line-regexp`，含义是核心定义、核心校验 / 编译的逐行正则搜索。未来可以新增 `ripgrep`、`pcre2`、`multiline` 等方言，但必须显式进入 schema 和测试。

0.1 `caseSensitivity` 只有两个值：

- `sensitive`：默认值，大小写敏感。
- `ascii-insensitive`：显式启用，只做 ASCII 大小写折叠。

`smart-case` 不纳入 0.1，未来若需要必须作为显式能力进入 schema 和测试。

LLM-facing 工具输入应暴露 `case_sensitivity` 字段，并规范化为内部 `caseSensitivity`。0.1 可接受值与内部枚举一致：`sensitive`、`ascii-insensitive`。

### 2. File Candidate Policy 层

核心必须先定义“哪些文件属于本次搜索范围”。

这层负责：

- 解析 `searchPath`。
- 判断搜索根。
- 应用默认忽略目录。
- 按当前版本契约应用项目 ignore 规则。
- 应用用户传入的 `glob`。
- 处理显式路径和默认搜索的差异。
- 决定隐藏文件、二进制文件、超大文件的策略。

原则：

- 默认搜索应避开依赖、构建产物和缓存，减少噪音。
- 用户显式指定某个文件或目录时，显式意图优先，但仍要遵守安全边界和二进制保护。
- `grep` 与 `glob` 的文件发现语义应尽量同源；不能让用户看到的文件集合和可搜索文件集合长期分裂。

搜索执行器可以自己实现这层策略，也可以消费核心预处理后的候选集合；但无论采用哪种实现方式，输出结果必须符合这一层定义。

### 3. 搜索执行器层

搜索执行器只负责执行搜索，不负责最终输出格式。执行器不能用 `null` 表达不可用、能力不支持或执行失败；这些状态必须显式建模，否则会重新引入静默 fallback。

建议接口：

```ts
type GrepExecutorQualification =
  | {
      executable: true;
      capabilityMode: "native" | "fallback" | "degraded";
      notes?: string[];
    }
  | {
      executable: false;
      reason:
        | "unavailable"
        | "unsupported-regex"
        | "unsupported-file-policy"
        | "unsupported-encoding"
        | "unsupported-budget";
      notes?: string[];
    };

type GrepSearchExecution =
  | { ok: true; result: GrepSearchResult }
  | { ok: false; error: GrepSearchError };

type GrepSearchError =
  | { code: "invalid-pattern"; message: string }
  | { code: "path-not-found"; path: string; message: string }
  | { code: "executor-unavailable"; message: string; notes?: string[] }
  | { code: "unsupported-query"; reason: GrepExecutorQualification["reason"]; message: string; notes?: string[] }
  | { code: "timeout"; message: string; elapsedMs?: number }
  | { code: "aborted"; message: string }
  | { code: "internal-error"; message: string };

interface GrepSearchExecutor {
  name: "ripgrep" | "node";
  qualify(query: GrepQuery): Promise<GrepExecutorQualification>;
  search(query: GrepQuery): Promise<GrepSearchExecution>;
}
```

ripgrep 搜索执行器：

- 用于高性能搜索。
- 优先使用结构化输出，例如 `rg --json`。
- 读取 `begin` / `match` / `context` / `end` / `summary` 事件构建核心结果。
- 不透传 ripgrep 的人类可读 stdout。
- 只有当本次 query 可被 ripgrep 按核心语义执行时才启用。

Node 搜索执行器：

- 用于可移植 fallback。
- 在没有 ripgrep 或 ripgrep 不能满足核心契约时接管。
- 输出同一个 `GrepSearchResult`。

执行器选择规则：

1. 先构造 `GrepQuery`。
2. 由核心校验 / 编译 `line-regexp`，形成可执行的核心搜索计划。
3. 判断 ripgrep 是否可用。
4. 调用 ripgrep 搜索执行器的 `qualify()`，判断它是否能满足本次 query 的正则语义、文件候选语义、编码 / 二进制策略和输出完整性要求。
5. 满足则用 ripgrep 搜索执行器。
6. 不满足则调用 Node 搜索执行器的 `qualify()`。
7. Node 满足则用 Node 搜索执行器。
8. 两个搜索执行器都不能满足时，返回明确错误。

这里的关键不是“两执行器在所有能力上完全相同”，而是“被选中的搜索执行器必须满足本次 query 的核心契约”。能力差异必须在 capability check 中显式处理，不能靠测试碰运气。

### 4. Core Result 层

所有搜索执行器必须产出同一种核心结果。

建议结构：

```ts
interface GrepSearchResult {
  query: GrepQuery;
  files: GrepFileResult[];
  matchedFileCount: number;
  matchedLineCount: number;
  truncated: boolean;
  diagnostics: GrepDiagnostics;
}

interface GrepFileResult {
  absolutePath: string;
  displayPath: string;
  matches: GrepMatch[];
}

interface GrepMatch {
  line: number;
  text: GrepLineText;
  contextBefore: GrepContextLine[];
  contextAfter: GrepContextLine[];
}

interface GrepContextLine {
  line: number;
  text: GrepLineText;
}

interface GrepLineText {
  text: string;
  truncated: boolean;
  omittedScalars?: number;
}

interface GrepDiagnostics {
  executor: "ripgrep" | "node";
  capabilityMode: "native" | "fallback" | "degraded";
  scannedFileCount?: number;
  elapsedMs?: number;
  notes?: string[];
}
```

这层是核心契约。agent、测试、接入面投影都应围绕这层稳定。

`diagnostics` 只用于观测和调试，不参与用户语义。接入面默认不应把 executor 当作产品概念展示给用户。

`capabilityMode: "degraded"` 只能表示执行路径、性能、观测信息或非语义能力降级，不能表示搜索语义降级。只要返回 `GrepSearchResult`，结果就必须满足同一核心契约。

命名纪律：

- `matchedFileCount` 是有命中文件数。
- `matchedLineCount` 是匹配行数。
- 不使用含糊的 `totalMatches` 命名，避免误解为正则出现次数。

### Presentation Artifact

`GrepSearchResult` 不应只是格式化器内部的一次性私有对象。核心应把它作为结构化 presentation artifact 暴露给接入面，和现有 `file-diff` presentation 同构。

建议扩展：

```ts
export type ToolPresentationArtifact =
  | FileDiffPresentationArtifact
  | GrepResultsPresentationArtifact;

interface GrepResultsPresentationArtifact {
  kind: "grep-results";
  query: GrepQuerySummary;
  files: GrepPresentationFile[];
  matchedFileCount: number;
  matchedLineCount: number;
  truncated: boolean;
  diagnostics: GrepDiagnostics;
}

interface GrepPresentationFile {
  displayPath: string;
  matches: GrepMatch[];
}
```

原则：

- `ToolResult.content` 进入 LLM 上下文。
- `ToolResult.presentation.kind === "grep-results"` 进入接入面投影。
- transcript / LLM tool result 仍只保存 `content` / `isError`，不把 presentation 写入长期对话内容。
- presentation 暴露的是投影安全结构，不直接暴露内部 `absolutePath`。工作区内文件只暴露相对 `displayPath`；工作区外文件按路径语义显式暴露规范化绝对 `displayPath`。
- 接入面若要文件列表、折叠块、可点击路径，必须消费 `presentation`，不能解析 `content`。

### 5. Core Formatter 层

核心工具需要给 agent 一个默认文本结果，因此需要一个核心格式化器：

```ts
formatGrepToolResult(result: GrepSearchResult, outputMode: OutputMode): ToolResult
```

它负责：

- `content` / `files` / `count` 三种 output mode。
- header。
- 文件块顺序。
- 行号格式。
- 上下文行格式。
- 截断提示。
- 无匹配提示。
- 错误提示。

只有这一层可以生成 `ToolResult.content`。搜索执行器不允许自己拼最终文本。

`ToolResult.content` 是 LLM-facing 文本契约，不是接入面富展示的数据源。`grep` 的结构化搜索事实必须通过 `ToolResult.presentation.kind === "grep-results"` 暴露。即便 0.1 暂时没有专门渲染 grep 卡片，也要先把通道立住，避免未来接入面被迫解析文本。

### 6. Access Surface Projection 层

接入面消费核心文本结果和 / 或 `grep-results` presentation 后，再做外观投影。

示例：

- CLI：渲染终端卡片、摘要行、颜色。
- 飞书：转成卡片或 markdown。
- RPC：返回结构化 JSON 或文本。
- App：显示可点击文件列表。

接入面可以改变展示形态，不能改变搜索事实。

接入面投影规则：

- 简单接入面可以只显示 `content`。
- 富接入面必须使用 `presentation`。
- 任何接入面都不允许解析 `content` 来恢复文件列表、匹配块或统计信息。

## 路径语义

路径显示规则必须由核心统一定义。

- 工作区内文件：显示为相对 `workingDirectory` 的 POSIX 风格路径，例如 `src/app.ts`。
- 工作区外文件：显示规范化绝对路径，并统一使用 `/`。
- `path: "src"` 搜索时，结果仍以工作区为根显示，例如 `src/app.ts`，而不是 `app.ts`。
- 单文件搜索也必须保留可引用文件路径，不能只返回裸行号。

路径的目标不是复刻某个搜索执行器输出，而是服务 agent 后续继续调用 `read` / `edit` 等工具。

## 行模型

`line-regexp` 的“行”必须由核心统一定义，不能继承 JS、Node 文件读取或 ripgrep 的隐式行为。

0.1 行裁决：

- 逻辑行终止符是 `\r\n`、`\n`、`\r`。
- 行终止符不属于被匹配文本，也不进入 `match.text`、context line、`content` 或 `presentation`。
- 文件末尾单个行终止符不产生额外的合成空行；连续行终止符之间的空行是真实空行。
- `^` 和 `$` 只锚定归一后的逻辑行文本。
- CRLF 文件中的 `foo$` 必须匹配逻辑行文本 `foo`，不能被尾部 `\r` 影响。
- ripgrep 搜索执行器必须使用可对齐这套行语义的参数和事件后处理；无法保证时不具备执行资格。
- Node 搜索执行器必须在解码后按同一套逻辑行规则切分，不能简单 `split("\n")` 后把尾部 `\r` 留在行内。

超长行裁决：

- `maxLineChars` 是单个匹配行 / 上下文行的展示预算，默认值应由 grep 工具常量定义。
- `maxLineChars` 按 Unicode scalar value 计数。
- 搜索可以命中过长逻辑行，但进入 `GrepSearchResult` 的行文本必须被裁剪为受预算约束的 `GrepLineText`。
- 被裁剪的行必须设置 `truncated: true` 和 `omittedScalars`；核心格式化器负责用统一文案展示截断标记。
- 搜索执行器不得把完整超长行塞进 `ToolResult.content` 或 `ToolResult.presentation`。
- 如果某个执行器不能在采集期安全地限制超长行文本，它不具备执行资格，或必须返回明确的截断 / 错误结果，不能静默输出另一套规则。

## 正则语义

0.1 阶段默认使用 `line-regexp` 语义。

这意味着：

- pattern 在每一行内匹配。
- count 统计匹配行，不统计正则出现次数。
- 不支持跨行匹配。
- 不把完整 JavaScript RegExp 或完整 ripgrep regex 直接作为默认契约。
- 默认大小写敏感。
- 显式 `caseSensitivity: "ascii-insensitive"` 时，只做 ASCII 大小写折叠，不做 Unicode / locale case folding。
- 匹配单位是 Unicode scalar value，不是 UTF-16 code unit。
- Unicode 字面量按解码后的文本做精确匹配，不做 Unicode normalization，不做 locale-aware case folding。
- Node 搜索执行器可以作为默认语义的保守实现。
- ripgrep 搜索执行器只有在 pattern 属于可证明兼容的子集时才启用。

未来如果要支持 JavaScript 完整 RegExp、ripgrep、PCRE2、multiline 等高级方言，应显式扩展 `regexDialect`，不能让搜索执行器差异静默影响结果。

`line-regexp` 不是“把用户 pattern 原样交给 JS / ripgrep”。核心必须先校验并编译 pattern，再交给搜索执行器。

0.1 支持的正则子集：

- 字面量字符，包括 Unicode 字面量。
- `.`、`^`、`$`。
- 分组、选择和常见量词：`(...)`、`|`、`?`、`*`、`+`、`{m,n}`。
- 字符类和 ASCII 范围，例如 `[A-Za-z0-9_]`。
- `\w`、`\d`、`\s` 作为核心定义的 ASCII 语义快捷写法，编译时分别归一为显式 ASCII 字符类。
- `\b`、`\B` 作为核心定义的 ASCII 词边界，词字符集合为 `[A-Za-z0-9_]`。
- 转义后的正则元字符，例如 `\.`、`\(`。

0.1 不支持的正则能力：

- lookaround。
- backreference。
- Unicode / locale word-boundary。
- Unicode property escape。
- inline flags。
- Unicode / locale ignore-case。
- smart-case。
- dotall / multiline。

实现纪律：

- ripgrep 搜索执行器必须有“语义资格判断”。
- 能证明属于安全兼容子集的 pattern 才交给 ripgrep。
- 无法证明兼容时走 Node 搜索执行器。
- ASCII 大小写不敏感必须由核心编译器把字面量和 ASCII 范围展开成显式字符类；不能依赖 ripgrep `-i`、smart-case 或 JavaScript `/i`。
- ASCII `\b` / `\B` 必须由核心编译器对齐到同一套 `[A-Za-z0-9_]` 词字符边界语义。
- 不允许出现“ripgrep 成功返回，所以结果就是正确语义”的隐式假设。
- 不允许仅用 `new RegExp(pattern)` 校验后就默认交给 ripgrep。

## 编码、Unicode 与大小写语义

0.1 编码裁决：

- 核心支持 UTF-8、带 UTF-8 BOM 的 UTF-8、带 BOM 的 UTF-16LE、带 BOM 的 UTF-16BE。
- 不带 BOM 的 UTF-16、GBK、Latin-1 等编码不纳入 0.1 契约；搜索执行器不得在这些文件上返回合同外命中。
- 二进制文件跳过，不作为搜索失败。
- 编码识别属于核心搜索语义。搜索执行器可以自行实现，但结果必须符合这套合同。

ripgrep 搜索执行器纪律：

- 必须使用 `--json` 输出结构化事件。
- 不启用 PCRE2、多行、ignore-case、smart-case 或任何会改变 `line-regexp` 语义的执行器能力。
- 必须禁用自带 ignore 语义，并显式对齐核心候选文件策略。
- 若当前 ripgrep 调用无法保证编码、Unicode 或文件候选策略与核心契约一致，则本次 query 不具备 ripgrep 执行资格，必须走 Node 搜索执行器或返回明确错误。

Node 搜索执行器纪律：

- 不能直接 `fs.readFile(path, "utf-8")` 后假定所有文本都是 UTF-8。
- 必须按核心编码策略读取 Buffer、识别 BOM、解码文本；无法识别的编码按 unsupported text 处理。
- 必须使用核心编译后的 `line-regexp`，并用 JavaScript `u` flag 编译，保证 `.`、Unicode 字面量与量词按 Unicode scalar value 匹配；不能把用户 pattern 当完整 JavaScript RegExp 解释。

## 忽略与过滤语义

核心需要统一定义：

- 默认忽略目录，例如 `node_modules`、`.git`、`dist`、`build`、`coverage` 等。
- `glob` 过滤语义。
- 项目 ignore 规则是否生效。
- 隐藏文件是否搜索。
- 二进制文件如何跳过。

这些都是核心搜索语义，不是搜索执行器自由发挥。

如果某个搜索执行器不能满足核心语义，应 fallback 或返回明确错误，不能输出另一套规则下的结果。

0.1 裁决：

- 默认忽略目录必须一致。
- 默认搜索 hidden 文件 / 目录，但仍排除 `.git`、依赖、构建产物、缓存等默认噪音目录。
- `glob` 语义应与 `glob` 工具同源；0.1 至少支持 `*.ts`、`*.{ts,tsx}`、`src/**/*.ts` 这类常用模式。未支持的 glob 形态返回明确错误或走能支持的搜索执行器。
- `.gitignore` 不纳入 0.1 核心契约。
- ripgrep 搜索执行器在 0.1 下不得静默使用 ripgrep 自带的 `.gitignore` / 全局 ignore 语义，避免和 Node 搜索执行器漂移。
- 长期若要支持 `.gitignore`，必须先建立共享 File Candidate Policy：由核心解析 ignore 规则或定义可验证的执行器能力声明，而不是让每个搜索执行器自由发挥。

长期方向是 `grep` 与 `glob` 共用文件候选策略，避免“能 glob 到但 grep 不搜 / grep 搜到但 glob 看不到”的产品分裂。`.gitignore` 属于这个长期共享策略的一部分，而不是 0.1 的隐式搜索执行器行为。

## 排序与截断

排序和截断也属于核心契约。

- 文件顺序必须稳定。
- 多文件结果按 `displayPath` 字典序升序排列；比较基于 POSIX 风格路径字符串的 Unicode code point 顺序。
- 同文件内匹配按行号升序。
- 多文件结果在不同平台上不应因文件系统遍历顺序漂移。
- 截断策略由核心统一控制。
- 截断提示必须告诉 agent 结果是不完整的。
- 单行宽度必须受 `maxLineChars` 控制，不能让一个超长逻辑行撑爆 `content` 或 `presentation`。

截断必须发生在采集期，而不是格式化期事后裁剪。

- 搜索执行器构建 `GrepSearchResult` 时就必须遵守预算。
- 达到预算后停止继续采集，设置 `truncated: true`。
- 行文本达到 `maxLineChars` 时裁剪该行并设置行级截断元数据；这不同于整个结果集的 `truncated: true`。
- ripgrep 搜索执行器使用 `spawn` 流式读取结构化输出，不依赖 `execFile` 的 `maxBuffer` 作为控制机制。
- Node 搜索执行器在遍历和读取过程中检查预算，不能先把所有匹配放进内存。
- `maxResultChars` 是文本预算；实现还需要文件数、匹配行数或扫描文件数预算，防止结构化结果无限增长。

## 执行与取消

搜索可能运行在大仓库或慢磁盘上，因此执行策略也是核心契约的一部分。

- 所有搜索执行器必须支持超时。
- 所有搜索执行器必须响应 `ToolExecutionContext.abortSignal`。
- 外部子进程必须能被可靠终止。
- Node 搜索执行器必须有最大扫描文件数或等价保护。
- 超时、取消和截断要有不同语义，不能混成同一种失败。

## 错误语义

结果和错误应区分：

- 无匹配。
- pattern 不合法。
- 路径不存在。
- 搜索执行器不可用。
- 搜索执行器不支持当前查询语义。
- 搜索超时。
- 用户取消。
- 输出被截断。

这些错误必须是核心工具语义，不能泄漏某个搜索执行器的原始错误文本作为唯一解释。

无匹配不是工具错误：搜索执行应返回 `ok: true`、`files: []`、`matchedFileCount: 0`、`matchedLineCount: 0` 的成功结果，由核心格式化器生成无匹配提示。

输出被截断也不是工具错误：预算触发时返回 partial result，并通过结果级 `truncated: true` 或行级 `GrepLineText.truncated` 明确表达。

执行器切换错误纪律：

- 搜索执行器不可用可以 fallback。
- 搜索执行器不满足 query 语义可以 fallback。
- 搜索执行器执行中出现语义外错误，不能静默 fallback 并返回另一套结果，除非能证明 fallback 后仍满足同一 query 契约且错误不影响搜索完整性。
- 因预算触发的截断不是搜索执行器失败，必须返回 partial result + `truncated: true`。

## 测试原则

测试要锁核心契约，而不是锁某个搜索执行器的人类可读输出。

必须覆盖：

- ripgrep 搜索执行器和 Node 搜索执行器在同一 fixture 下都满足核心契约。
- `content` / `files` / `count` 三种 output mode。
- `presentation.kind === "grep-results"` 的投影安全结构化结果，且不直接暴露内部 `absolutePath`。
- 工作区根、子目录、单文件、绝对路径。
- Windows 路径归一化。
- 默认忽略目录。
- hidden 文件 / 目录搜索。
- glob 过滤。
- 0.1 明确不承诺 `.gitignore`，并验证 ripgrep 不因自带 ignore 行为和 Node 搜索执行器漂移。
- 二进制文件跳过。
- UTF-8、UTF-8 BOM、UTF-16LE BOM、UTF-16BE BOM 编码契约。
- CRLF / LF / CR 行终止符归一，匹配文本与展示文本不含行终止符。
- 超长行裁剪和行级截断元数据。
- `line-regexp` 核心编译器：支持子集、拒绝子集、ASCII 语义的 `\w` / `\d` / `\s` / `\b` / `\B`。
- Unicode scalar value 匹配单位，覆盖 `.`、Unicode 字面量和量词在星体字符上的行为。
- 默认大小写敏感；显式 ASCII-insensitive 可用；smart-case 不被静默启用。
- 正则方言 fallback / 明确错误。
- 多文件按 `displayPath` 规范字典序排序，同文件匹配按行号排序。
- 截断提示。
- 采集期截断，不允许先构建无限结果再裁剪文本。
- abort / timeout 语义。

不变量应表述为：

- 同一 query 的被选中搜索执行器必须满足核心契约。
- 搜索执行器能力差异必须显式声明、显式 fallback 或显式报错。
- 不要求所有搜索执行器在所有可能 query 上输出完全相等。
- 不允许用 `null` 混合表达不可用、能力不支持和执行失败。

## 验收标准

- 核心只有一套 grep 契约。
- ripgrep 和 Node 都只是搜索执行器实现。
- 搜索执行器不直接返回最终文本。
- 搜索执行器有显式 `qualify()` 和结构化执行结果，不用 `null` 做语义分支。
- `ToolResult.content` 只由核心格式化器生成。
- `ToolResult.presentation.kind === "grep-results"` 承载投影安全的结构化搜索事实。
- 富展示走 `grep-results` artifact；接入面不解析核心文本来重建搜索事实。
- 默认搜索语义是核心定义并编译的 `line-regexp`；高级方言必须显式启用。
- UTF-8 / UTF-16 BOM、行模型、Unicode scalar value 匹配单位、ASCII 词边界、ASCII 大小写不敏感、hidden 文件、glob、排序与二进制跳过语义都有测试锁住。
- 截断发生在采集期。
- 接入面不修补搜索语义，只投影核心结果。
- `pnpm --filter @zhixing/tools-builtin exec vitest run src/__tests__/grep.test.ts` 通过。
- 全量 `pnpm test` 不再因 grep 搜索执行器差异失败。

## 实现执行计划

实现应拆成 4 个独立可提交单元。每个单元都应能单独说明架构层次和审查价值，不按“改了一半文件”切分。

### 1. 核心 presentation 契约

目标：先把结构化投影通道立住，让后续 grep 能把搜索事实交给接入面，而不是让接入面解析文本。

范围：

- 扩展 `ToolPresentationArtifact`。
- 增加 `grep-results` presentation 类型。
- 导出必要类型。
- 补充 presentation 不进入 transcript / LLM tool result 的回归测试。

边界：

- 不改 grep 搜索行为。
- 不改 CLI 富渲染。
- 不引入搜索语义。

验证：

- `pnpm --filter @zhixing/core exec vitest run`
- 如触及导出链路，再跑相关依赖包类型检查。

### 2. grep 核心语义基础设施

目标：建立核心拥有的搜索语义模型，先把可验证契约做实，再接搜索执行器。

范围：

- 新增 `GrepQuery`、`GrepSearchResult`、`GrepFileResult`、`GrepMatch`、`GrepContextLine`、`GrepLineText`。
- 实现 `toDisplayPath()`。
- 实现文件排序规则：按 `displayPath` 的 POSIX 字符串字典序。
- 实现行模型：CRLF / LF / CR 归一、行终止符不进入结果、文件末尾终止符不合成空行。
- 实现 `maxLineChars` 行级裁剪与 `omittedScalars`。
- 实现编码解码：UTF-8、UTF-8 BOM、UTF-16LE BOM、UTF-16BE BOM。
- 实现 `line-regexp` 编译器：Unicode scalar value、ASCII `\w` / `\d` / `\s` / `\b` / `\B`、`caseSensitivity`。

边界：

- 不接 ripgrep。
- 不重写 `createGrepTool()` 主流程。
- 不把格式化文本作为测试核心。

验证：

- 新增语义单元测试，优先覆盖路径、排序、行模型、编码、正则子集、ASCII-insensitive、超长行。
- `pnpm --filter @zhixing/tools-builtin exec vitest run src/__tests__/grep*.test.ts`

### 3. 搜索执行器与统一格式化器

目标：把 Node 与 ripgrep 都降为搜索执行器，让它们只产出统一核心结果，再由核心格式化器生成文本结果。

范围：

- 实现 `GrepSearchExecutor`、`qualify()`、`GrepSearchExecution`、`GrepSearchError`。
- 实现 Node 搜索执行器。
- 实现 ripgrep 搜索执行器：使用 `spawn` + `rg --json`，不解析或透传人类可读 stdout。
- 实现执行器选择规则。
- 实现采集期预算：结果字符、文件数、匹配行数、扫描文件数、行宽。
- 实现 timeout / abort 处理。
- 实现 `formatGrepToolResult()`。

边界：

- 不让搜索执行器返回 `ToolResult`。
- 不用 `null` 表示不可用、能力不支持或执行失败。
- 不让 `degraded` 表示语义降级。

验证：

- Node 与 ripgrep 在同一 fixture 下满足核心契约。
- 覆盖 fallback、unsupported query、timeout / abort、无匹配成功空结果、截断结果。
- `pnpm --filter @zhixing/tools-builtin exec vitest run src/__tests__/grep*.test.ts`

### 4. 工具接入与契约测试重建

目标：把 `createGrepTool()` 切到新架构，重建测试，使测试锁核心契约而不是锁某个执行器的人类可读输出。

范围：

- `createGrepTool()` 使用 `GrepQuery`、执行器选择、统一格式化器和 `grep-results` presentation。
- LLM-facing 输入增加 `case_sensitivity`。
- 更新 / 重写 `grep.test.ts`。
- 增加 presentation、路径、编码、行模型、超长行、排序、大小写、词边界、glob、默认忽略、无匹配、fallback、files / count / content 测试。

边界：

- 不把修复放到 CLI 或接入面展示层。
- 不为了保留旧 substring 断言牺牲核心契约。
- 不扩大到 `.gitignore` 支持；0.1 明确不承诺。

验证：

- `pnpm --filter @zhixing/tools-builtin exec vitest run src/__tests__/grep.test.ts`
- `pnpm --filter @zhixing/tools-builtin exec vitest run`
- `pnpm build`
- 视耗时再跑 `pnpm test`。
