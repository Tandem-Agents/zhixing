# grep 搜索架构

## 目标与取舍

grep 为智能体提供稳定、可继续用于 read/edit 等工具的文本搜索结果；搜索语义不属于 CLI 或任何单一接入面。这里的“核心”指共同工具能力，不表示实现必须放进 `@zhixing/core` 包。

**执行器可以替换，搜索契约不能漂移。** ripgrep 与 Node 不能各自决定路径、正则、统计和输出格式；修补某一种执行器的文本输出无法解决这类差异。共同搜索计划、结果模型与格式化器负责语义，执行器负责执行，接入面只负责展示。

ripgrep 路径旨在兼顾搜索性能，Node 路径保证缺少外部命令时仍可用；执行器名称与诊断信息不是用户必须理解的产品概念。性能目标不等于已证明当前路径总比 Node 更快。

## 当前责任链

`createGrepTool → GrepQuery → createGrepSearchPlan → 执行器资格判断与搜索 → GrepSearchResult → formatGrepToolResult`

- 工具入口规范化输入；计划负责路径检查和 `line-regexp` 编译，执行器不直接消费原始输入。
- 目录候选统一由 `listGrepCandidateFiles()` 产生，避免两个执行器使用不同 glob 与忽略规则。单文件路径直接进入搜索。
- 默认先选 ripgrep，资格检查目前只检查 `rg --version` 是否成功；不可用才选择 Node。选中后的执行结果直接返回，执行失败不会再静默换执行器。
- Node 直接将候选文件交给共享 `GrepResultCollector`。
- ripgrep 将共同候选按路径参数分批交给 `rg --json --no-ignore --hidden --crlf --max-count 1`，从 match 事件取得文件路径；随后仍由共享收集器读取文件、解码、匹配并收集上下文，不直接采用 rg 的匹配行或统计作为最终搜索事实。
- 收集器统一生成文件、匹配行、上下文、截断元数据和诊断；格式化器统一生成模型文本及结构化展示数据。执行器不返回自定格式的 `ToolResult`。

资格判断的设计要求是“被选中的执行器满足本次查询契约”，不是“命令执行成功就意味着语义正确”。当前 ripgrep 的筛选与共享匹配必须共同接受合同测试，不能把共用收集器当作筛选不会漏项的证明。

## 搜索合同

| 边界 | 有效语义 |
|---|---|
| 输入与模式 | 必填非空 `pattern`；`path` 默认工作目录；`glob` 过滤目录候选；`output_mode` 为 `content/files/count`，默认 content，减少后续读取步骤 |
| 上下文 | `context_lines` 默认 2，有限数值取整并限制在 0～10；不是独立的 before/after 参数 |
| 统计 | `matchedLineCount` 是匹配行数，不是正则出现次数；`matchedFileCount` 是有命中文件数；截断时只表示已收集部分 |
| 行 | CRLF、LF、CR 都是逻辑行终止符，不进入匹配或展示文本；末尾终止符不生成额外空行，连续终止符之间保留真实空行 |
| 正则 | 只接受核心编译的逐行 `line-regexp`，不是完整 JavaScript 或 ripgrep 方言；Unicode scalar 匹配，不做 Unicode normalization |
| 支持子集 | 字面量、点、行首尾、分组、选择、常用量词、字符类；`\w/\d/\s` 与 `\b/\B` 按 ASCII 语义编译 |
| 大小写 | 默认 sensitive；显式 `ascii-insensitive` 由编译器展开，不依赖 JS `/i` 或 rg `-i` |
| 不支持 | lookaround、backreference、Unicode property、inline flags、Unicode/locale ignore-case、smart-case、跨行与 PCRE2；不得由执行器静默引入 |
| 路径 | 工作区内相对 `workingDirectory`，而非相对搜索子目录；工作区外保留规范化绝对路径，统一 `/`。单文件也保留路径，合法 `..foo` 不误判为越界 |
| 候选 | 目录搜索包含隐藏项，排除 `.git`、依赖、构建产物及缓存等固定目录；支持 `*.ts`、`*.{ts,tsx}`、`src/**/*.ts` 等 glob；不读取 `.gitignore` |
| 显式路径 | 显式单文件不经过目录 glob/忽略筛选；显式目录仍按该目录下的候选策略遍历，不能描述成全面绕过忽略规则 |
| 编码目标 | UTF-8、UTF-8 BOM、UTF-16LE BOM、UTF-16BE BOM；其他编码不属于支持合同；二进制应跳过而非伪造文本命中 |
| 顺序 | 已收集文件按 POSIX `displayPath` 的 Unicode code point 顺序排序，同文件按行号排序；截断前的候选遍历未统一排序，不能据此承诺跨执行器截断子集完全相同 |

grep 与 glob 应避免文件发现语义分裂，但当前文档不预建共享平台，也不把未来 `.gitignore` 或高级正则扩展写成现有能力。

## 预算、失败与取消

工具默认：结果采集估算预算 30,000 字符、单行展示 500 Unicode scalars、200 个命中文件、1,000 个匹配行、上下文最多前后各 10 行、执行超时 30 秒。Node 另受 `GrepSearchOptions.maxScannedFiles = 10,000` 限制；它是运行保护，不是要求两个执行器扫描量相同的查询语义。

采集匹配时即执行结果预算，不先积累无限匹配再裁剪。行级裁剪保留 `truncated/omittedScalars`，与结果级 `truncated` 区分。估算预算不是最终格式化文本长度的精确保证。

- 无匹配为成功空结果，不是错误；预算触发返回部分结果，不是执行失败。
- 非法输入、非法正则、路径不存在、无可用执行器、超时和取消有各自错误分支；工具以 `isError` 返回错误文本。
- 搜索检查 abort/timeout；ripgrep 使用流式子进程读取并在取消、超时或结束清理时终止子进程。不能将部分结果、超时、取消混为同一终态。

## 文本与展示分离

`content` 服务模型；`presentation.kind = "grep-results"` 提供查询摘要、路径、匹配与统计，供富展示消费。简单接入面可以显示文本，富展示不应解析文本来重建搜索事实。

展示文件不直接暴露内部 `absolutePath` 字段；但工作区外的 `displayPath` 本身是绝对路径，因此这不是完整脱敏机制。模型上下文及对话消息记录不因富展示需求写入 presentation。

当前工具已经生成 artifact，但常规会话 RPC 流经 `stripPresentationFromAgentYield` 将其剥离，不能宣称 CLI、飞书等接入面已经获得 grep 富展示。此处与[编辑差异展示](../cli/edit-diff.md)共享传输边界，而非由 CLI 修补搜索语义。

## 已核实的实现边界

以下区别不能通过删改需求掩盖，也不在文档迁移中启动代码整改：

- 解码器无 BOM 时直接按 UTF-8 非严格解码，二进制判断只检查解码文本中的 NUL；尚不能保证所有合同外编码都被识别并拒绝。
- 收集器仍整份 `readFile` 并拆分逻辑行，行展示与结果预算不等于单文件读取内存上限，也不是每一步都可立即取消。
- 空结果格式化固定输出无匹配提示；若扫描预算已触发但尚未收集到命中，结果级截断仍在 artifact 中，却不会出现在该文本提示。有效要求仍是让模型知道结果不完整。
- 候选共享、统一格式化与已收集结果排序已经落地；它们不自动证明所有跨平台输入、ripgrep 预筛选及异常分支均符合合同。

## 实现与维护依据

- [工具入口](../../../packages/tools-builtin/src/grep.ts)：输入、默认值与调用链。
- [搜索选择](../../../packages/tools-builtin/src/grep/search.ts)、[搜索计划](../../../packages/tools-builtin/src/grep/plan.ts)：编译及执行器边界。
- [候选策略](../../../packages/tools-builtin/src/grep/candidate-files.ts)、[ripgrep 执行器](../../../packages/tools-builtin/src/grep/ripgrep-executor.ts)、[Node 执行器](../../../packages/tools-builtin/src/grep/node-executor.ts)。
- [收集器](../../../packages/tools-builtin/src/grep/collector.ts)、[文本语义](../../../packages/tools-builtin/src/grep/text.ts)、[正则编译](../../../packages/tools-builtin/src/grep/line-regexp.ts)、[格式化器](../../../packages/tools-builtin/src/grep/format.ts)。

回归应锁搜索合同而非 rg 人类可读输出：同一 fixture 检查两条执行路径、三种输出、路径/行/编码/正则/候选、预算及异常，并核对展示隔离。已有入口为 `grep-core.test.ts`、`grep-executors.test.ts`、`grep.test.ts`；验证 ripgrep 路径需确认测试进程实际可启动 rg，只有 fallback 通过不能替代该证据。历史绿灯不代表上述实现差异已经闭合。
