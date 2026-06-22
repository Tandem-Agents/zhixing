# CLI 多行粘贴问题临时追踪

> 临时文档：只用于本轮 CLI 多行粘贴问题排查与修复追踪。全部问题解决并沉淀后删除本文，不作为长期规格维护。

## 处理流程与判断标准

本节适用于本文所有问题。每个问题都按同一流程推进，避免“看到一个代码现象就局部修补”。

### 处理流程

1. **事实审核**：先确认问题是否真实。必须给出代码路径、状态转移顺序、最小复现或测试证据；不能只凭推测定性。
2. **需求还原**：把代码现象翻译成用户真实需求。重点回答：用户要完成什么、为什么这个问题破坏了任务、哪些接入面或未来形态会受影响。
3. **目标效果定义**：先定义理想产品行为，再决定实现。目标效果要能被用户直觉理解，也要能被测试锁住。
4. **架构判断**：检查方案是否符合“多个接入面、唯一核心”的产品形态；是否把 UI 表示、输入语义、agent 输入、历史复用这几层分清。
5. **修复与验证**：先补能失败的测试，再修实现。验证至少覆盖主路径、边界路径、回归路径。
6. **沉淀或删除**：全部问题解决后，长期原则沉淀到正式规格或代码注释；本文删除。

### 顶层判断标准

- **产品标准**：粘贴是用户把一段完整材料交给 agent，不是把一串 UI 字符交给系统。系统必须保护用户意图，不让内部占位符泄漏成用户消息。占位符只属于提交前的输入态。
- **直觉标准**：用户不需要理解 PasteRegistry、token、history 或 terminal mode。长粘贴首次进入输入区时折叠，是为了更安静、更可控；一旦发送成为历史消息，用户看到的应是刚交给 agent 的原文。
- **架构标准**：占位符是 UI 表示，原文是语义内容。两者可以分离，但 canonicalize 边界必须清楚：离开输入态成为已发送消息时，写入 scrollback 和 agent 入口的都应是 canonical 文本。
- **智能体标准**：agent 收到的必须是用户想交付的原始材料，而不是 `[Pasted #N ...]` 这种 UI handle。否则就是静默污染上下文，危害比显式报错更大。
- **材料标准**：文本粘贴折叠是输入区降噪，不等同于真正的用户材料输入能力。未来文件、图片、音视频、网页快照、富文本等材料必须作为结构化输入进入核心，CLI 的缩略信息只是接入面展示，不能把文件路径、base64 或 UI token 伪装成用户正文。
- **输入 handle 标准**：输入态所有 handle（文本粘贴 token、图片 / 文件 chip、未来音频 / 视频 / 网页快照 chip）必须共用同一套原子编辑、原子渲染、宽度预算和提交转换规则。不能让同一类“用户材料占位”在某些路径是整体、某些路径被字符级切碎。
- **保真标准**：trim 只能服务空输入判断、命令识别等控制流。一旦内容被判定为用户正文，CLI 不能裁剪用户材料；代码、patch、YAML、日志等首尾空白都可能有语义。
- **长期标准**：方案不能只修当前终端和当前输入框。它要经得起原生 scrollback 不可重绘、多个接入面扩展、未来材料类型扩展的考验。
- **可验证标准**：每个重要不变量都必须有测试。尤其是“输入态首次长粘贴显示 token，二次粘贴显示原文”“提交后 scrollback / agent 均为原文”“token 不泄漏成历史区消息”。

### 当前需求边界澄清

- 输入区行为：首次长粘贴显示缩略 token；在已有粘贴态再次粘贴显示原文。这是既有功能，也是当前需求。第 1 个问题不改变这个目标，但如果实现里已有 bug，仍必须记录、审核和修复。
- 历史区行为：发送出去后成为 scrollback 里的用户历史消息，应直接显示原文；不需要、也无法做后续展开。第 1 个问题的主线是解决历史区原文显示。
- 术语边界：本文说“历史区”特指 CLI scrollback 区域；`↑` 浏览的输入历史是另一件事，不能和历史区显示问题混在一起。

### 每个问题的记录格式

每个问题至少记录：

- **审核结论**：真实 / 不真实 / 需要更多观测。
- **事实证据**：代码位置、执行顺序、复现结果。
- **背后需求**：产品本质需求，而不是实现愿望。
- **目标效果**：用户可感知行为 + 架构不变量。
- **验收标准**：需要补的测试或手动验证。

## 背景

知行支持多个接入面、唯一核心。CLI 是其中一个接入面，目前多行内容粘贴功能已实现附件化：长粘贴在输入态折叠为 `[Pasted #N +M lines · size]` 占位符，原文暂存在 `PasteRegistry`。新的目标语义是：占位符只用于提交前的输入区显示；提交后写入 scrollback 的历史区消息和发送给 agent 的内容都应是原文。

本次只读排查涉及的关键文件：

- `packages/cli/src/paste-detector.ts`
- `packages/cli/src/paste-registry.ts`
- `packages/cli/src/paste-expand.ts`
- `packages/cli/src/paste-atomic.ts`
- `packages/cli/src/typeahead-input.ts`
- `packages/cli/src/repl.ts`
- `research/design/problems/multiline-paste-attachment.md`

## 当前发现

### 1. 长粘贴提交后历史区显示占位符而非原文

**状态**：已修复，已测试，已构建

**现象**：长粘贴折叠为占位符后提交，当前实现会把含 `[Pasted #N ...]` 的 raw draft 写入 scrollback。结果是历史区消息显示 token，而不是用户粘贴并发送的原文。

**审核结论**：问题真实，且由当前代码顺序必然触发，不是低概率边界。旧判断里“让 history 保留 token 并继续可 expand”的方向不符合最新需求，也不符合 CLI 屏幕渲染约束；正确方向是历史区直接写原文。输入区“首次粘贴缩略、二次粘贴原文”是目标行为，本问题不能改坏它；若该目标行为自身存在实现 bug，需另行记录并处理。

**事实证据**：

- `typeahead-input.ts` 的 `submit()` 先用 `expandPastes(rawDraft, registry)` 得到 `expanded`，这说明原文在提交时已经可得。
- 同一个 `submit()` 随后调用 `echoSubmittedDraft(rawDraft)`，把 raw draft 写入 scrollback。
- `buildHistoryEchoLines(rawDraft)` 对 raw draft 做 wrap 后写入历史区，因此占位符会按字面进入 scrollback。
- `research/internals/screen-rendering/overview.md` 明确当前 main buffer 使用终端原生 scrollback，已绘历史不可接管 / 重绘。因此不能依赖“之后再展开 scrollback 中的 token”。

**影响**：占位符这个 UI handle 泄漏成了用户可见历史消息。用户发送的是一段原文材料，但历史区记录的是内部缩略 token，既不忠实，也无法在已绘 scrollback 中补救。

**关联问题**：同一条 `submit()` 路径还暴露出 `↑` 输入历史里的 token 生命周期问题。它不是本文所说的“历史区显示”问题，因为输入历史仍属于输入态复用；但它会影响长粘贴再次提交是否可靠，已单独列为第 3 个问题跟踪。

**背后需求**：

- 用户首次粘贴长内容时，输入区需要缩略显示，避免把 chrome 顶乱、把编辑态变成不可控的大段文本；用户再次粘贴时显示原文，是既有输入区行为和当前需求。
- 用户发送之后，这段内容成为历史消息，也就是进入 scrollback。此时它必须直接显示原文，因为 scrollback 不是应用状态树，不能也不应该再做“展开操作”。
- 长粘贴的价值不是创建一个长期附件引用，而是在提交前给输入区降噪；提交边界之后，原文才是唯一长期语义。
- 对 agent 和用户历史区来说，原文才是用户真实交付的材料；token 只是提交前的输入区辅助显示。

**目标效果**：

- 首次长粘贴：输入区显示紧凑 token。
- 再次粘贴：输入区显示原文，保持既有功能，不因本问题调整。
- 提交给 agent：发送原文。
- 提交之后：scrollback 里的用户历史消息直接显示原文，不显示 token，也不依赖后续展开。
- 本问题不改变输入区粘贴折叠 / 二次粘贴展示原文的策略，但修复完成后必须验证该策略仍正常。

**架构判断**：

- 当前 bug 的根因是 raw token 被写进了不该出现 token 的层：scrollback 历史区。
- 正确不变量应是：token 是输入态 UI 表示；canonical 文本是提交态语义内容。写入历史区之前必须完成 raw draft -> canonical text 的一次性转换。
- main buffer 的 scrollback 是终端原生历史，应用无法接管和重绘。因此写入 scrollback 的内容必须已经是最终形态，不能是等待未来展开的中间表示。
- `PasteRegistry` 应保持为输入态临时存储，不反向承担历史区消息的数据完整性。提交后的消息完整性由 canonical 文本承担。
- 未来如果出现更多附件类型，也要先区分“临时输入 affordance”和“可持久历史 artifact”。不能把只有当前输入态可解释的 handle 写入长期历史。

**倾向修复方向**：在 `submit()` 内显式区分 `rawDraft` 和 `canonicalDraft`。`rawDraft` 保留给提交前输入显示和必要的命令别名判断；`canonicalDraft = expandPastes(rawDraft, registry)` 用于发送给 dispatcher / agent，并用于写入 scrollback history echo。不要借这个问题改动 `finalizePaste()` 的首次 / 二次粘贴展示策略；但如果后续审核确认该策略的实现不可靠，应作为独立问题修复。

**验收标准**：

- 长粘贴 -> 当前输入区：首次显示 `[Pasted #N ...]` token。
- 已有粘贴态再次粘贴：输入区显示原文，保持既有行为。
- submit：返回给上层的是 expanded 原文。
- submit：scrollback 中的 history echo 显示原文，不显示 token。
- submit 后不需要、也无法对 scrollback 中的历史消息做展开操作。
- 补 `typeahead-input.test.ts` 集成测试，而不是只补 paste 子模块单测。

**修复记录**：

- `typeahead-input.ts` 的 `submit()` 明确区分输入态 `rawDraft` 与提交态 `canonicalDraft`。
- `canonicalDraft = expandPastes(rawDraft, registry)` 同时用于 agent / dispatcher 输入和 scrollback history echo。
- `rawDraft` 仍保留给输入态显示与命令别名 guard，不改动首次 / 二次粘贴展示策略。
- 新增 `typeahead-input.test.ts` 集成测试，覆盖“输入区折叠 token，提交后历史区写原文，不写 token”。

### 2. 同一次长粘贴拆批时可能被误判为二次粘贴

**状态**：已修复，已测试，已构建

**现象**：输入区已有 paste token 时，用户主动第二次粘贴应显示原文，这是既有功能和当前需求。当前风险在于：同一次真实粘贴如果被底层拆成多个 paste batch，后续 batch 会被误判成“用户主动第二次粘贴”，触发删除旧 token + 插入后半段原文，导致前半段内容丢失。

**事实依据**：

- `finalizePaste()` 中 `shouldFold = registry && shouldFoldPaste(content) && bufferWasClean`。
- 已有 token 被 `removeAllPasteTokens()` 删除后，`bufferWasClean=false`。
- `wrapKeypressHandler()` 的当前边界是“同一 macrotask 内同步多 keypress = 一次 paste”；它不理解 bracketed paste 的开始 / 结束边界，也不跨 data chunk 合并。
- `stdin-ownership.ts` 明确 `readline.emitKeypressEvents(stdin)` 保留 data -> keypress 解码器；paste detector 消费的是 keypress 事件，因此仍受底层 data chunk 边界影响。
- 本轮内联验证：Node `readline.emitKeypressEvents` 会把 bracketed paste markers 暴露为 `key.name = "paste-start"` / `"paste-end"`，因此 detector 层可以直接识别协议边界，不需要下探到 data 字节层。
- 本轮内联验证：用 `readline.emitKeypressEvents` 对同一输入分两次 `stdin.write("abcd")` / `stdin.write("efgh")`，detector 产生两次 `onPaste("abcd")` / `onPaste("efgh")`。
- 本轮内联验证：主动二次粘贴 A 后再粘贴 B，当前行为正确，最终提交 B 原文，registry 从 1 清到 0。
- 本轮内联验证：模拟同一长粘贴拆成两批，第一批折叠成 token，第二批触发删除旧 token 并插入第二批原文，最终提交只包含第二批，第一批丢失。
- `paste-atomic.ts` 顶部注释写“再次粘贴时旧占位符自动 expand 为原内容”，但实际 `removeAllPasteTokens()` 是删除旧 token、保留非 token 文本；实现与落地设计一致，顶部注释需要修正，避免误导后续维护。

**审核结论**：

- “用户主动第二次粘贴显示原文”不是 bug，是正确需求。
- “同一次粘贴被拆成多个 paste batch 后丢前半段内容”是真实实现缺陷；它在拆批输入条件下确定触发。
- 这个问题的根因不在 `finalizePaste()` 的二次粘贴产品策略，而在 paste detector 没有可靠表达“一次粘贴会话”的边界。

**背后需求**：

- 用户主动第二次粘贴时，意图通常是替换输入态附件；显示原文能让用户直接看见新内容，避免多个大型 token 叠在输入区。
- 同一次粘贴无论底层被拆成多少 data chunk，都必须作为一个完整材料进入输入区；系统不能因为传输分片改变用户意图。
- paste detector 的职责是识别“粘贴事件边界”，InputController 的职责是决定“这次粘贴在当前输入态如何呈现”。两层不能混在一起。

**目标效果**：

- 主动第一次长粘贴：输入区显示 token。
- 主动第二次粘贴：输入区显示第二次粘贴的原文，旧 token 被替换 / 清理。
- 同一次真实粘贴即使跨多个 data chunk / keypress batch，InputController 也只收到一次完整 paste content，不丢前半段。
- 粘贴 detector 在支持 bracketed paste markers 的终端上以协议 start/end 作为权威边界。
- 不支持 markers 的终端走 fallback 合并策略，尽可能把相邻 paste chunks 合成一次 paste；单字符打字不能引入可感知延迟。
- registry 不残留被替换的旧 token；输入区不出现 token + 大段原文混乱共存。

**最优解决方案**：

- 在 `paste-detector.ts` 内升级为“paste 会话 detector”，而不是在 `typeahead-input.ts` 里补救拆批。
- 第一优先级：识别 `key.name = "paste-start"` / `"paste-end"`。收到 start marker 后进入 bracketed paste session，跨 macrotask / data chunk 累积内容；收到 end marker 后一次性 `onPaste(fullContent)`。本项目已经启用 bracketed paste mode，当前只是没有利用 markers 做边界。
- 第二优先级：保留无 marker fallback。fallback 仍用同步多 keypress 识别 paste，但对 paste batch 使用短 idle 合并窗口；单 keypress 仍走 microtask flush，避免普通打字延迟。多个相邻 paste chunks 在 idle 窗口内合并为一次 `onPaste`。
- `finalizePaste()` 继续保持产品语义：buffer 干净且内容达阈值时折叠；已有 token 时主动二次粘贴显示原文并清理旧 token。它不承担底层 paste 会话边界识别。
- 修正 `paste-atomic.ts` 顶部注释，把“自动 expand 为原内容”改为“删除旧 token，插入新粘贴内容”，和实现及产品语义对齐。

**架构判断**：

- detector 层负责输入事件分组，InputController 层负责输入态呈现，PasteRegistry 层只负责 token -> content 映射；这是最干净的职责边界。
- 方案兼容多个接入面：其他 raw-mode 组件仍复用同一个 detector 能力，不需要各自实现粘贴会话合并。
- 方案经得起未来附件扩展：无论将来 token 代表纯文本、文件片段还是其他输入附件，事件边界都应先在 detector 层确定。
- 不建议在 `finalizePaste()` 中按时间猜测“这是拆批还是用户第二次粘贴”；那会把终端事件分组问题污染到产品呈现层，形成架构债务。

**验收标准**：

- 主动第一次长粘贴显示 token。
- 主动第二次粘贴显示原文，提交后只发送第二次粘贴内容。
- bracketed paste start/content/end 即使跨多个 data writes，也只触发一次 `onPaste(fullContent)`。
- 无 marker fallback 下，短间隔相邻 paste chunks 合并为一次 paste；普通单字符输入不被延迟成可感知卡顿。
- 模拟拆批长粘贴时，最终提交内容包含所有 batch，不丢前半段。
- `paste-detector.test.ts` 和 `typeahead-input.test.ts` 都要补集成测试；不是只测纯函数。

**修复记录**：

- `paste-detector.ts` 从 microtask batcher 升级为 paste session detector，对上层输出“完整粘贴事件”。
- 支持 `paste-start` / `paste-end` bracketed markers，跨 keypress batch 累积内容，结束时一次性触发 `onPaste(fullContent)`。
- 无 marker fallback 保留同步多 keypress 识别，并通过短 idle 窗口合并相邻 paste chunks；单 keypress 仍走 microtask 路径。
- `finalizePaste()` 的产品语义保持不变：首次长粘贴折叠；已有 token 时主动二次粘贴显示原文并替换旧 token。
- `paste-atomic.ts` 顶部注释已修正为“旧 token 被移除，新粘贴按当前产品语义替换”，避免后续维护误解。
- 新增 detector 与 typeahead 集成测试，覆盖 bracketed 拆批、fallback 拆批、paste 后单键顺序、拆批长粘贴不丢前半段、主动二次粘贴仍显示原文。

### 3. `↑` 输入历史复用时 token 可能失活

**状态**：已修复，已测试，已构建

**现象**：长粘贴首次提交后，`InputBuffer.commit()` 会把提交前的 raw draft 推入 in-memory 输入历史。若 raw draft 含 `[Pasted #N ...]`，用户按 `↑` 找回时恢复的是 token。与此同时，`submit()` 后 `syncBroker()` 会按当前空 buffer 调用 `registry.cleanup(...)`，把对应 paste entry 清掉。再次提交时，这个 token 无法 expand，会作为字面文本进入 agent 和 scrollback。

**与第 1 个问题的区别**：

- 第 1 个问题是 scrollback 历史区显示问题：发送后已经画出去的用户消息必须直接显示原文。
- 本问题是输入历史复用问题：`↑` 恢复的是可编辑输入态，仍有“显示 token 还是显示原文”的产品选择空间。
- 两者共用 `submit()` 附近代码路径，但用户语义不同，应该分开判断和修复，避免把历史区与输入历史混为一谈。

**事实依据**：

- `InputBuffer.commit()` 当前保存的是 `this.draft`，即提交前 raw draft。
- `historyPrev()` 直接把 history entry 还原到当前输入 buffer。
- `submit()` 中 `syncBroker()` 在 `buffer.commit()` 后执行，此时当前 buffer 已空；registry cleanup 只看当前 buffer 中仍存在的 token id。
- `expandPastes()` 对 unknown id 采用字面 fallback，不会报错，因此死 token 会静默变成普通文本。
- 本轮 TSX 最小观测确认：长粘贴 token 首次提交前可 expand；`buffer.commit()` + `registry.cleanup(extractAliveIds(buffer.draft))` 后 registry size 变 0；`historyPrev()` 恢复同一个 token 后再次 `expandPastes()` 得到的仍是 token 字面量。
- 本轮 TSX 最小观测确认：未提交的 token draft 在浏览历史时会被 `InputBuffer` 存入 `savedDraft`；`historyPrev()` 后 cleanup 看不到 `savedDraft` 里的 token，registry size 变 0；`historyNext()` 恢复 saved draft 后同样只能 expand 出 token 字面量。
- `repl.ts` 当前注释写“commit 后 buffer.draft 含占位符进 history ring buffer；用户按 ↑ 浏览历史时占位符仍可 expand”，与实际代码路径不一致，修复时需要同步修正注释。

**审核结论**：

- 问题真实，且不是低概率边界：只要提交后的 raw history entry 含 token，提交后的 cleanup 就会清掉 registry entry。
- 影响不止“提交后按 `↑`”：历史浏览态的 `savedDraft` 也是可恢复输入草稿，当前 cleanup 同样看不到。
- 这是输入态引用生命周期问题，不是 paste token 格式问题，也不是 scrollback 展示问题。

**背后需求**：

- `↑` 输入历史不是历史区展示，而是用户复用上一条输入意图的入口。复用时应保留输入区可控性，长粘贴仍显示紧凑 token。
- 长粘贴 token 如果继续出现在输入态，就必须保持引用完整性；否则 token 这种降噪设计会退化成隐蔽的数据丢失。
- 用户不应被要求理解 registry 生命周期，也不应承担“这个 token 现在是否还活着”的判断成本。
- 任何“可被恢复到输入区”的 draft 都是输入态语义的一部分；只看当前 draft 会把历史浏览这种正常交互误判成 orphan。

**目标效果**：

- 长粘贴提交后，`↑` 恢复上一条输入时仍显示 token，不把大段内容重新铺满输入区。
- `↑` 恢复后再次提交，agent 收到原文，scrollback history echo 显示原文，不显示 token。
- 用户在有未提交 token draft 时浏览历史，再按 `↓` 回到原 draft，token 仍能 expand。
- 输入历史 ring buffer 淘汰旧 entry 后，对应 registry entry 可以被 GC；session 退出时 registry 随 REPL scope 释放。
- 损坏的 token 字符串仍按现有语义处理：不 match regex 的内容不保活，也不强行恢复。

**最优解决方案**：

- 保留输入历史中的 token 表示，不改为保存 canonical 原文。原因：`↑` 是输入复用入口，长粘贴继续折叠才符合“输入区降噪、可控”的产品本质。
- 把 registry cleanup 的 alive 范围从“当前 buffer draft”提升为“所有可恢复输入 draft”：当前 draft、history entries、以及历史浏览态的 saved draft。
- 在 `InputBuffer` 暴露只读的稳定槽位查询，例如 `getRestorableDraftSlots()`，返回所有未来可能回到输入区的 draft key + 文本。该 API 保持通用文本语义，不引入 PasteRegistry 依赖。
- 在 paste 层新增增量引用索引，例如 `PasteReferenceIndex`，按槽位 key 缓存 token id，只对新增或内容变化的槽位重新解析。
- `syncBroker()` 调用增量索引得到 alive ids 后再 `registry.cleanup(aliveIds)`。这样 commit 后 raw token history entry 能保活；history limit shift 后旧 entry 不再出现在 restorable slots，entry 会自然 GC；普通打字热路径不会重复扫描所有历史大文本。
- 保持 `submit()` 的 canonical 边界不变：发送给 agent 和 scrollback 的仍是 `expandPastes(rawDraft, registry)`；输入历史保存 raw draft，是输入态表示，不是长期消息存储。

**不采用的方案**：

- 不采用“输入历史保存原文”：虽然实现简单，但会让 `↑` 恢复长粘贴时把大段文本重新撑满输入区，破坏多行粘贴附件化的核心体验。
- 不采用“registry 全 session 永不 cleanup”：能绕过死 token，但会让大粘贴内容无界保留，绕开 history limit 的内存边界。
- 不采用“在 `submit()` 后特殊保留刚提交 token”：只能修提交后 `↑`，修不了 `savedDraft`；并且会把生命周期补丁散在提交路径，形成架构债务。

**架构判断**：

- 最优边界是：`InputBuffer` 只声明哪些 draft 可被恢复；paste 层只从 draft 集合中提取 token id；`PasteRegistry` 只按 alive id 做存储 GC；`InputController` 负责把三者接起来。
- 这不会把 paste 业务污染进 `InputBuffer`，也不会让 `PasteRegistry` 理解 history index / savedDraft 细节。
- 这个问题不受 scrollback 不可重绘限制约束，因为输入历史是应用内存状态，不是终端已绘历史。
- 方案和“多个接入面、唯一核心”契合：CLI 输入历史是接入面内输入 affordance，不应该进入 core；agent / core 仍只接收 canonical 原文。
- 未来如果粘贴从纯文本扩展为更通用的输入附件，同样需要“可恢复输入草稿引用集合”这个生命周期边界，因此该方案不会导致未来返工。

**验收标准**：

- 长粘贴提交后，registry 不因 buffer 清空而清掉仍在输入历史里的 token entry。
- 按 `↑` 恢复上一条输入时，输入区显示 token；再次提交时 agent 收到原文，不收到死 token。
- 再次提交后 scrollback history echo 仍显示原文，不显示 token。
- 有未提交 token draft 时按 `↑` 浏览历史，再按 `↓` 回到 saved draft，token 仍能 expand。
- historyLimit 淘汰含 token 的旧 entry 后，对应 registry entry 会被 cleanup。
- 用户删除 / 破坏当前 token 时，如果该 token 不再存在于任何可恢复 draft，registry entry 会被 cleanup。
- 补 `input-buffer.test.ts` 覆盖 restorable draft slots 查询；补 paste 索引单测覆盖增量解析、多槽位聚合和槽位消失；补 `typeahead-input.test.ts` 集成测试覆盖 `↑` 再提交与 `savedDraft` 恢复。

**修复记录**：

- `InputBuffer` 新增 `getRestorableDraftSlots()`，只暴露当前 draft、输入历史和历史浏览前草稿这些可恢复槽位，不引入 paste 依赖。
- `paste-expand.ts` 新增 `PasteReferenceIndex`，按稳定槽位 key 缓存 token id，只重新解析新增或内容变化的槽位。
- `InputController.syncBroker()` 改为通过增量索引获得 alive ids 后清理 `PasteRegistry`，提交后的输入历史 token 与历史浏览前草稿 token 都能保活；history limit 淘汰后旧 token 会自然 GC。
- 普通输入热路径不再重复扫描全部历史大文本；未变化的历史槽位复用索引缓存。
- `repl.ts` 修正 paste registry 生命周期注释，说明保活依据是可恢复输入草稿集合。
- 新增 `input-buffer.test.ts`、`paste-expand.test.ts`、`typeahead-input.test.ts` 覆盖 `↑` 再提交、`savedDraft` 恢复、history limit 淘汰和多 draft alive id 聚合。

### 4. submit 对展开文本 trim，粘贴原文不完全保真

**状态**：已修复，已测试，已构建

**现象**：长粘贴原文如果有首尾空白、末尾空行、顶层缩进，当前提交链路会把 agent 入口文本裁剪。scrollback history echo 已经使用未裁剪的 `canonicalDraft`，所以用户可见历史区可能是保真的；真正被破坏的是送给上层 / agent 的语义正文。

**事实依据**：

- `typeahead-input.ts` 的 `submit()` 先得到 `canonicalDraft = expandPastes(rawDraft, registry)`，随后调用 `normalizeLeadingSlashAliasInExpanded(canonicalDraft.trim(), rawDraft.trim())` 生成提交给上层的 `text`。
- 同一个 `submit()` 现在调用 `echoSubmittedText(canonicalDraft)`，history echo 使用的是未 `trim()` 的 canonical 文本；因此第 4 个问题不是 scrollback 显示问题，而是 agent payload 保真问题。
- `repl.ts` typeahead 路径收到 `{ kind: "text", text }` 后，后续仍执行 `let resolvedInput = input.trim()`，再 `controller.sendTurn(resolvedInput)`。所以即使只修 `submit()`，真正发给 agent 前仍会被裁剪。
- legacy `rl.question()` 路径先用 `input.trim()` 判断空输入和 slash command；这属于控制流判断。但后续统一 `resolvedInput = input.trim()` 会继续裁剪非命令用户正文。
- `CommandDispatcher.parseCommandInvocation()` 对命令调用使用 `trimStart()`，并对命令参数 `rest` 做 trim；slash command 是控制语言，继续保持现有 trim 语义是合理的。
- `normalizeLeadingSlashAliasInExpanded()` 当前注释写调用方传入已 trim 字符串；修复时需要把它的定位明确为“命令控制字符串规范化”，不能让它承担正文 payload 保真。
- 本轮最小观测确认：粘贴 `"  indented\n  child\nline3\nline4\n\n"` 时，输入区折叠为 token；scrollback 渲染包含前导缩进和末尾空行；但 `InputController` 提交给上层的 text 变成 `"indented\n  child\nline3\nline4"`。

**审核结论**：

- 问题真实，而且比原记录更深：不是单个 `submit()` 局部 trim，而是 typeahead submit 与 REPL sendTurn 之间缺少“控制流文本”和“用户正文 payload”的稳定边界。
- 影响对象是所有非命令用户正文，长粘贴最容易暴露；普通自然语言通常无感，但代码、YAML、Python、patch、日志、Markdown fenced 内容可能被改语义。
- 第 1 个问题已解决 scrollback token 泄漏；第 4 个问题要解决 agent payload 保真。两者共享 canonicalDraft，但验收点不同。

**影响**：普通自然语言影响较小；代码、YAML、Python、patch、日志等粘贴内容可能因为首尾空白被改变语义。

**背后需求**：

- 用户粘贴的是一段完整材料，不是“去掉首尾空白后的自然语言句子”。对于智能体来说，材料边界本身就是上下文。
- CLI 可以为了识别空输入、slash command、中文输入法 slash alias 使用 trim；但这些是控制流需求，不应污染正文 payload。
- 命令和正文必须分层：slash command 是 CLI 控制语言，继续用 trimmed command text；普通 text 是用户交给 agent 的材料，必须保留 canonical 原文。
- `@file:` 替换是正文增强，不是正文规范化；它应在原 payload 上替换引用，并保留引用周围的用户文本和空白。

**目标效果**：

- 长粘贴原文包含前导空格、末尾换行、末尾空行时，输入区仍可折叠，scrollback 显示 canonical 原文，agent 收到的 text 也保持 canonical 原文。
- 非命令正文只要 `canonicalDraft.trim()` 非空，就按原 canonical 文本发送；trim 只用于判断“这是不是空输入”。
- 空输入或纯空白输入仍按空输入处理，不产生 agent turn，也不写入有意义的 history echo。
- `/help`、`  /help`、`、help` 等命令路径保持现有行为：命令识别和分派使用 trimmed / alias-normalized control text。
- 折叠 paste 内容即使以 `/` 或 `、` 开头，也不能被误判成命令；命令判断仍以 rawDraft 的首位语义为 guard。
- `@file:` 解析在未裁剪 payload 上执行；没有 `@file:` 时正文完全原样穿透，有 `@file:` 时只替换引用片段，保留周围空白。

**最优解决方案**：

- 在 `typeahead-input.ts` 的 `submit()` 内显式拆出两类文本：
  - `canonicalDraft`：展开 paste 后的正文 payload，必须保真。
  - `rawControlText = rawDraft.trim()` / `canonicalControlText = canonicalDraft.trim()`：只用于空输入判断、slash command 识别和 alias 规范化。
- `submit()` 的分流顺序应是：先算 canonicalDraft；用 `canonicalControlText` 判断是否为空；空则清空输入并返回空提交，不写正文 echo；非空再用 `normalizeLeadingSlashAliasInExpanded(canonicalControlText, rawControlText)` 得到 `commandText`。
- `commandText.startsWith("/")` 时走 dispatcher，继续发送 commandText，保持命令路径既有 trim 语义。
- 非命令路径 `fireSubmit({ kind: "text", text: canonicalDraft })`，history echo 也继续使用 canonicalDraft；不要把 trimmed 文本作为用户正文。
- 在 `repl.ts` 去掉普通正文发送前的统一 `input.trim()`。改为：用 `input.trim()` 只做空输入 guard；真正的 `resolvedInput` 初值必须是 `input` 原文；`resolveFileRefs(resolvedInput, ...)` 在原文上替换；最后 `sendTurn(resolvedInput)`。
- legacy 路径保留 `trimmed` 作为空输入和命令判断；非命令正文同样交给后续原文 payload 流程，避免 typeahead / legacy 两条接入路径语义分裂。
- 不引入“paste 专用保真开关”。一旦内容进入 text payload，是否来自 paste 不重要；正文保真是 CLI 接入面向唯一核心提交 user message 的通用契约。

**不采用的方案**：

- 不只修 `typeahead-input.ts`：REPL 后续 `input.trim()` 仍会裁剪 agent payload，属于半修。
- 不只对 paste token 做特殊判断：二次粘贴显示原文、小粘贴、普通手输缩进代码都会绕过 token；特殊判断会制造行为分裂。
- 不把所有路径都完全禁止 trim：命令识别、空输入判断、命令参数解析需要 trim；关键是把 trim 限定在控制流层。
- 不把保真责任下推给 core：core 应接收已经确定的用户消息，CLI 接入面不能把被裁剪的材料交给唯一核心后再期待核心恢复。

**架构判断**：

- 最优边界是：输入态 raw draft 可以有 UI token；提交态 canonicalDraft 是正文事实；control text 是 CLI 命令语言；agent payload 是用户材料。四者不能混用。
- 这个方案和“多个接入面、唯一核心”契合：保真发生在 CLI 接入面提交 user message 之前，core 不需要理解 CLI token、slash alias 或 readline 行为。
- 未来扩展文件片段、图片说明、结构化附件时，仍然需要同样的“payload 不被控制流规范化污染”的边界，因此方案不会导致返工。
- scrollback 不可重绘约束仍成立：history echo 必须一次性写 canonical 文本；agent payload 同样必须在提交边界一次性确定。

**验收标准**：

- 折叠长粘贴包含前导空格和末尾空行时，`InputController` 的 text result 等于完整 canonical 原文。
- 同一用例的 scrollback history echo 继续显示原文，不显示 token。
- REPL 发送到 `controller.sendTurn()` 的正文不再被统一 `trim()` 裁剪；需要有覆盖 REPL payload 准备逻辑的测试或抽出的纯函数测试。
- `/help`、前导空白后的 `/help`、中文顿号 alias 命令仍按命令分派。
- paste 原文以 `/` 或 `、` 开头但 rawDraft 首位是 paste token 时，仍作为 text payload，不误触发命令。
- `@file:` 替换保留引用周围的首尾空白；没有 `@file:` 的 text payload 原样穿透。
- 空输入 / 纯空白输入仍不会发起 agent turn。

**修复记录**：

- `typeahead-input.ts` 的 `submit()` 拆分 `canonicalDraft`、`canonicalControlText`、`rawControlText` 与 `commandText`。
- 命令是否分派由 raw 控制文本决定；折叠 paste 原文即使以 `/` 或 `、` 开头，也不会被误判为 slash command。
- 普通正文路径返回未裁剪的 `canonicalDraft`，history echo 继续使用同一份 canonical 文本。
- 空输入 / 纯空白输入改为清空输入态后返回空提交，不写正文 echo，也不进入输入历史。
- `repl.ts` 发送前改用 `prepareUserTurnInput()`，trim 只做空输入 guard；真正送 `sendTurn()` 的正文保留原 payload。
- 新增 `user-turn-input.ts` 作为 REPL payload 准备边界，`@file:` 只替换引用片段并保留周围空白。
- 更新 `leading-slash-alias.ts` 注释，明确 alias 规范化只服务控制流，不裁剪正文 payload。
- 新增 / 更新测试覆盖：普通正文首尾空白保真、纯空白输入、长粘贴首尾空白保真、paste 以 `/` / `、` 开头不误触发命令、前导空白 slash 与顿号 alias 命令仍可分派、REPL payload 准备与 `@file:` 周围空白保真。

### 5. 用户材料输入尚未一等化，CLI 图片 / 文件粘贴只是首批场景

**状态**：已实现第一批结构化材料输入；本轮补齐共享模型能力预检、图文顺序保真、MIME 文件头嗅探、材料读错恢复、server 输入契约，已完成定向测试、受影响包全量测试、lint 与全量构建。重新从头复查后发现 CLI 材料 chip 渲染原子性遗漏，现已补修并完成 CLI 定向测试、CLI 全量测试与 CLI 构建。

**降级路径释义**：

- “legacy readline 降级路径”不是指图片 / 文件被降级，而是指 CLI 无法使用 typeahead chrome，或显式设置 `ZHIXING_INPUT_TYPEAHEAD=legacy/off` 时，REPL 退回 `rl.question()` 的低能力文本输入路径。
- 该路径不经过 `InputController`、`paste-detector`、`PasteRegistry`、`finalizePaste()`，所以没有当前文本长粘贴的折叠 / token / expand 能力。
- 它是能力边界，不是第 5 个问题的主需求。第 5 个问题的主需求是：用户能把本轮要交给 agent 的材料加入输入，包括文本、图片、文件，以及未来音频、视频、网页快照、富文本等。

**审核结论**：

- 原记录里的 legacy 现象真实，但范围过窄。它只说明备用输入路径没有文本粘贴附件化能力，不能覆盖用户现在表达的“粘贴文件 / 图片”需求。
- 当前 CLI 的粘贴能力实际是文本能力：终端 keypress / bracketed paste 给到的是文本内容，`PasteRegistry` 存储的是 `string`，`expandPastes()` 返回的是 `string`。
- 系统不是完全没有图片类型：核心 `ContentBlock` 已有 `ImageBlock`，Anthropic 适配器能把 base64 图片块转成厂商协议。修复前 CLI / RPC / channel 的发起 turn 入口仍以 `text: string` 为主，不会从用户输入构造图片或文件附件消息；第一批落地后 CLI / RPC / server 已能传递结构化 `UserTurnInput`，图片可投影为 `ImageBlock`。
- `@file:` 当前是正文增强：提交前把文件内容读成文本并替换进 prompt。它不是文件附件语义，也不适合承载图片 / 二进制文件。
- 通道层类型里有 `mediaUrls` / outbound `media` 字段，但 `InboundRouter` 当前仍把 `msg.text` 作为 turn 文本送入核心，没有把入站媒体转成 agent 输入附件。
- 用户提出的问题属实，但最优解不能是“图片一套、文件一套、未来音频再补一套”。正确方向是建立一套通用用户材料能力，再用类型化 handler 处理不同材料。
- 本轮复审补充确认：图片输入能力必须归 core/runtime 统一 preflight，不能写死在 CLI。CLI、飞书、未来 App 都只是材料采集 adapter；是否能发送图片由当前模型输入能力决定。
- 重新从头复查确认：第一批材料输入的“编辑原子性”已经接入，但“渲染原子性”没有接入同一套规则。材料 chip 仍可能在输入区 / 历史区被字符级软换行切碎，这是第 5 个问题的真实遗漏子问题。

**事实依据**：

- `packages/cli/src/paste-registry.ts`：`PasteEntry.content` 是 `string`，token 格式服务文本长粘贴。
- `packages/cli/src/paste-detector.ts`：`onPaste(content: string)` 只输出文本内容。
- `packages/cli/src/paste-expand.ts`：`expandPastes(draft, registry)` 产物是 `string`。
- `packages/cli/src/repl.ts`：主路径把 `PasteRegistry` 注入 `InputController`；legacy 分支直接 `rl.question()`。
- `packages/cli/src/runtime/conversation-controller.ts`：`sendTurn(text: string)` 只发送文本。
- `packages/server/src/rpc/methods/session.ts`：`session.send` 校验 `params.text` 为非空字符串，并通过 `runManagedTurn(..., text, ...)` 执行。
- `packages/server/src/runtime/run-turn.ts`：修复前 `runTurnWithCommit(..., text, ...)` 用 `userMessage(text)` 构造本轮用户消息；第一批落地后改为 `UserTurnInputLike` 并用 `userMessageFromTurnInput()` 投影。
- `packages/core/src/types/messages.ts`：内部消息类型已有 `ImageBlock`，但 `userMessage(text)` 只创建文本块。
- `packages/providers/src/adapters/anthropic-messages.ts`：base64 image block 可转 Anthropic image；URL 图片会降级为文本描述。
- `packages/providers/src/adapters/openai-compatible.ts`：修复前 user 消息转换只提取 text / tool_result，image block 不会成为 OpenAI 兼容协议内容；第一批落地后支持 `image_url`，本轮补修后保留 text / image 的原始顺序。
- `research/design/problems/multiline-paste-attachment.md` 的旧边界明确把“粘贴图片 / 二进制附件”排除在文本粘贴方案之外；现在用户需求已经把它提升为独立问题。
- `packages/cli/src/paste-atomic.ts`：`findTokenCharRanges()` 已同时识别 `PASTE_TOKEN_PATTERN` 和 `MATERIAL_TOKEN_PATTERN`，说明材料 chip 在编辑层应被视为原子输入单元。
- `packages/cli/src/typeahead-input.ts`：`computeRender()` 调 `layoutInputBuffer(..., PASTE_TOKEN_PATTERN, ...)`，`buildHistoryEchoLines()` 调 `wrapToWidth(text, echoBudget, PASTE_TOKEN_PATTERN)`，渲染层仍只把文本 paste token 视作原子区域。
- 内联验证结果：同一长图片 chip 用 `PASTE_TOKEN_PATTERN` 渲染会被切成 `"[Image #1 · very-long-screen"` / `"shot-name..."` / `"KB]"` 多段；用 `MATERIAL_TOKEN_PATTERN` 才能整体换行。文本 paste token 在当前路径下不会被切碎。
- `packages/cli/src/input-box.ts`：共享输入框原语也只把 `PASTE_TOKEN_PATTERN` 传给 `layoutInputBuffer()`。当前 inline rename / new 不会产生材料 chip，但这说明“输入 handle 原子规则”还没有抽成共享能力。
- `packages/cli/src/repl.ts`：`DefaultTypeaheadBroker` 的 `wordTerminators` 只注入 `PASTE_TOKEN_PATTERN`。material chip 没有成为 typeahead 触发器的 word boundary；这会让渲染、编辑、补全三层对同一 handle 的理解不一致。
- 进一步内联验证：如果仅把 material chip 当成 atomic 区域，超长 chip 会整体换到新行，再被 `renderChrome()` 的 `clampLine()` 截断为 `[Image #1 · extremely-long-screen…`。这比字符级切碎好，但仍不是完整产品解：chip 文案本身需要可视宽度预算。

**背后需求**：

- 用户真正想做的是“把材料交给智能体”，不是“把某个文件名、base64、路径或占位符塞进 prompt”。材料可以是文字、截图、设计稿、日志文件、PDF、网页、音频、视频，也可以是未来的新类型。
- 输入区的产品价值是让材料可控：用户能看到本轮附了什么、能删除、能继续输入文字、能在提交前确认。CLI 不应因为材料很大或不可打印，就把输入区变成噪音墙。
- agent 入口的价值是让材料真实：图片就是图片，文本就是文本，文件就是有 MIME / 来源 / 元数据的文件；不能把 UI 缩略信息当成用户正文，也不能让 provider 自己猜路径。
- 多接入面的本质要求是“采集不同，语义相同”。CLI、飞书、未来桌面端、浏览器端可以有不同的采集方式，但提交到唯一核心时必须是同一种用户材料模型。
- 对未来仍然好的产品，不应把“粘贴图片”做成一个孤岛功能。用户长期会期待“这一轮可以带材料”，而不是记住每种材料有不同入口、不同历史行为、不同失败方式。

**顶层产品判断**：

- 交互对象不是“附件文件”，而是“本轮材料”。附件只是材料的一种来源形态。
- 输入区展示不是材料本体，只是 handle / chip。它必须简短、可信、可删除；提交后不能变成 prompt 字面量。
- 支持范围必须诚实：系统可以接收某类材料，不等于当前 provider 一定能理解它。发送前必须做 capability preflight，失败要在本地明确说明。
- 能力判断必须在共享运行路径发生：core 根据当前模型输入能力检查消息，orchestrator 从 provider catalog 和用户 `modelInputCapabilities` 覆盖注入能力；provider adapter 只负责把已验证的输入编码成厂商协议。
- 最好的默认体验是“少打扰但不隐瞒”：能发送就发送；不能发送就告诉用户为什么，给出可执行替代，例如换模型、转文本、换解析器或移除附件。

**目标效果**：

- 文本长粘贴保持当前目标：首次显示 `[Pasted #N ...]`，再次粘贴显示原文，提交给 agent / scrollback 的是 canonical 文本。
- 图片作为材料进入 CLI 输入区后显示图片 chip，例如 `[Image #1 · screenshot.png · 1280x720 · 340KB]`；提交时变成 image part，不变成文本说明。
- 普通文件作为材料进入 CLI 输入区后显示文件 chip，例如 `[File #2 · report.pdf · 2.1MB]`；第一批只消费安全范围内的文本文件，非文本文件明确报不支持，不把文件名或路径伪装成 prompt。
- 文本文件可以在安全范围内解析成 text part，同时保留文件来源摘要；二进制文件不能被静默读成乱码。
- 材料 chip 在输入区与历史区都应作为一个不可切碎的 handle 呈现；长文件名或长摘要应在生成 chip 时按可视宽度预算压缩，而不是在渲染时被普通字符级 wrap 切碎。
- history / scrollback 显示稳定摘要，例如用户文字加附件摘要；不依赖后续展开，也不把本地绝对路径裸露为长期语义。
- 未来新增音频、视频、网页快照、富文本时，只新增采集 adapter / 类型 handler / provider encoder，不改动核心输入协议和 CLI 基础生命周期。

**最优架构方案**：

- 建立一套通用用户材料模型，而不是为图片、文件、音频分别铺平行链路。核心概念分四层：
  - `InputDraftItem`：接入面输入态对象，负责 chip / token / 光标 / 删除等 UI 行为，只存在于 CLI 等接入面。
  - `UserMaterialRef`：材料的稳定引用，包含 `id`、`kind`、`mimeType`、`name`、`size`、`hash`、`source`、`metadata`、`storageRef`。
  - `UserInputPart`：提交到 server / core 的语义输入，按顺序表达用户正文和材料引用。
  - `ProviderInputPart`：provider 适配层按模型能力把 `UserInputPart` 编码为厂商格式。
- 建立 `MaterialStore`，由 server / runtime 所在侧管理材料生命周期。它负责复制或缓存本地文件、去重、大小限制、MIME sniff、图片尺寸、hash、来源记录、清理策略。第一批暂由 CLI 在提交时读取本地文件并转成 `UserTurnInput`，长期不能停留在 CLI 私有存储。
- 建立 `MaterialHandlerRegistry`，按 `kind + mimeType` 选择类型化处理器。通用框架处理生命周期，handler 处理专业能力：
  - `text`：编码识别、大小限制、保真正文。
  - `image`：尺寸、MIME、必要时转 base64 image block。
  - `file`：文件摘要、文本提取或 provider 文件能力门控。
  - `audio` / `video`：时长、格式、转写或多模态能力门控。
  - `webpage`：URL、HTML、正文提取、截图。
  - `rich_text`：结构保留或转 markdown。
- 将 CLI 的 `PasteRegistry` 演进为 `InputMaterialRegistry`。文本长粘贴仍可作为 text material 的特殊展示；图片 / 文件 chip 与文本 paste token 共用同一套原子删除、history 保活、submit 转换机制。
- 把“输入态 handle 原子规则”提升为 CLI 输入层共享原语，而不是让 caller 分别传 `PASTE_TOKEN_PATTERN` 或 `MATERIAL_TOKEN_PATTERN`。`layoutInputBuffer()`、`wrapToWidth()`、`paste-atomic.ts` 应使用同一份 token/chip 识别规则。
- chip 文案生成必须有可视宽度预算：材料名称过长时在 chip 内部压缩摘要，保证 chip 作为原子单元时不会撑破输入框或历史回显。渲染层负责整体换行 / 截断兜底，不负责理解材料字段。
- 扩展 turn 入口：`conversation.send(text: string)` 不应继续作为长期唯一入口。应新增或演进为 `conversation.send(input: UserTurnInput)`，其中包含 `parts: UserInputPart[]` 和必要的 turn metadata。旧 text API 可作为兼容 wrapper。
- 核心消息层应吸收结构化材料，而不是只靠 `userMessage(text)`。已有 `ImageBlock` 可以承接图片第一阶段；文件类需要新增 `FileBlock` / `AttachmentBlock` 或在 `UserInputPart` 到 `Message.content` 之间做明确投影。
- core/runtime 层必须有 capability preflight：先判断当前模型是否支持 image / file / audio 等 part，再决定继续发送、解析转换、请求用户确认或明确失败。能力判断来自 provider model catalog 与用户覆盖，但执行点归共享核心路径，不回流到 CLI 写死。
- 采集 adapter 与材料模型解耦。CLI 首批可靠入口应优先支持路径粘贴 / 拖拽路径 / `/attach path`；直接从系统剪贴板拿图片 bytes 可以作为后续原生 adapter。飞书等通道的 `mediaUrls` 也应进入同一材料模型。
- legacy readline 保持低能力文本兜底，不复制 rich input 系统。若需要附件能力，应走显式命令或非交互参数，并最终仍提交 `UserTurnInput`，而不是在 legacy 中另建一套 chip 状态机。

**第一批能力边界**：

- 应支持的首批材料类型：文本长粘贴、常见图片、普通本地文件。
- 常见图片优先支持 `image/png`、`image/jpeg`、`image/gif`、`image/webp`。这些能与现有 `ImageBlock` 对齐，并已具备 Anthropic 与 OpenAI 兼容适配器编码路径；实际发送仍由 core 的模型能力预检决定。
- 普通本地文件第一版分两类：可安全识别为文本的文件可提取为 text part；非文本文件进入输入区 chip，但提交时在没有 provider 文件能力 / 解析器前明确提示不支持。
- PDF / Office 不应假装“普通文件都支持理解”。除非接入解析器或 provider 文件能力，否则只能显示为已附加但当前模型不可消费。
- 终端原生“直接粘贴图片二进制”不是第一版可靠承诺；路径粘贴、拖拽路径、`/attach path` 是 CLI 更稳的产品入口。

**不采用的方案**：

- 不为图片、文件、音频各自写一条从 CLI 到 provider 的专用通道。那会让未来每多一种材料就多一套生命周期和测试矩阵。
- 不把图片 / 文件内容 base64 后塞进普通文本 prompt。那会污染上下文、浪费 token，也让 provider 能力判断失效。
- 不把文件路径 token 当成附件能力。路径只是本机线索，不是 agent 可消费的材料；跨接入面、跨设备、持久化恢复都不可靠。
- 不只在 CLI 的 `PasteRegistry` 里加二进制字段。材料语义必须穿过 server、core、provider、history；停在 CLI 会再次形成 UI handle 泄漏。
- 不在 legacy `rl.question()` 中重建一套并行附件交互。legacy 应是低能力兜底，不是第二个复杂输入系统。
- 不静默降级为“把图片名告诉模型”。降级可以存在，但必须是用户可理解、可测试、不会伪装成功的路径。

**架构判断**：

- 这是顶层架构，不是局部修补：接入面负责采集和输入区呈现；`MaterialStore` 负责材料生命周期；core 负责结构化用户消息；provider 负责按能力序列化。这与“多个接入面、唯一核心”一致。
- 这个方案经得起时间检验：今天接图片和文件，明天接音频、视频、网页、富文本，只扩展 handler 和 provider encoder，不重写 turn 入口和 CLI 输入生命周期。
- 这个方案也符合智能体本质：agent 的输入不再是被 UI token 污染的字符串，而是用户意图中的材料序列。它能让模型能力、工具解析、上下文预算、安全确认都在正确层级发生。
- 产品直觉上成立：用户看到的是“我给这一轮附了这些材料”，而不是“我往命令行塞了一串可疑占位符”。这是长期可理解的心智模型。

**验收标准**：

- 需求层：明确区分“材料输入模型”“CLI 采集方式”“provider 消费能力”“legacy 文本兜底”四件事。
- CLI 主路径：文本 paste、图片、文件都能成为输入态 chip / token；删除、光标跨越、history 保活、submit 转换保持同一生命周期。
- CLI 渲染层：文本 paste token、图片 chip、文件 chip 都必须在输入区和历史区按同一原子规则换行，不被字符级切碎；超长文件名以预算内摘要显示。
- 核心入口：提交产物能表达有序的 `text + material parts`，不是单个字符串。
- 存储层：材料有稳定 id、MIME、大小、hash、来源、清理策略；CLI 不持有真实 bytes。
- provider：至少一个支持图片的 provider 能收到真实 image part；不支持附件的 provider 在发送前明确失败或给出明确转换选择。
- 文件：文本文件可安全提取；非文本文件在没有 provider / handler 支持时明确提示，不静默塞 prompt。
- history / scrollback：显示人类可读摘要，不依赖已绘历史的后续展开，不泄漏内部 token。
- legacy：低能力路径行为明确；不支持 rich attachment 时有可理解提示或显式替代入口。
- 安全：覆盖大小限制、MIME 判断、workspace 外文件、路径不存在、二进制不可读、用户取消确认等边界。
- 测试：新增 CLI 输入态测试、material registry 测试、store 测试、RPC / server 输入模型测试、core message 构造测试、provider 能力门控测试、通道媒体归一测试。

**本轮落地边界**：

- 先落结构化 turn 竖切：`UserTurnInput` 从 CLI 经 RPC / server 进入 core，再由 provider 适配器编码，旧 `text: string` 保持兼容 wrapper。
- CLI 主路径支持“粘贴本地路径”作为第一批材料采集入口；常见图片显示 `[Image #N ...]` chip，文本文件显示 `[File #N ...]` chip。
- 图片提交时读取为 `ImageBlock`，Anthropic 走已有 base64 image 能力，OpenAI 兼容适配器新增 `image_url` data URL 编码。
- 文本类文件在大小限制内提取为 text part，并带 `<file path="...">` 包裹；二进制 / PDF 等当前不可消费文件在本地明确失败，不伪装成 prompt 或文件名。
- 材料 token 与文本 paste token 共用原子编辑、输入历史保活和提交态转换生命周期；submit 前是输入区 chip，submit 后是结构化用户输入。
- 本轮不承诺终端直接粘贴图片二进制、系统剪贴板文件对象、PDF / Office 解析、音频 / 视频 / 网页快照。它们应沿同一 `UserTurnInput` / handler / provider 能力模型扩展。
- 长期 `MaterialStore`、hash 去重、跨接入面持久材料引用仍是下一层基础设施；本轮没有把文件路径或 base64 塞进普通正文来制造未来返工。

**修复记录**：

- core 新增 `UserTurnInput` / `UserInputPart`，当前支持 text 与 image，并提供运行时非空校验和 user message 投影。
- server 的 `session.send` 接受 `input`，同时保留旧 `text`；RPC 边界拒绝空结构化输入，也拒绝 `text` 与 `input` 同时出现的二义性请求。
- CLI 新增 `InputMaterialRegistry`、材料路径识别与提交解析；图片 / 文本文件通过同一材料 token 生命周期进入 turn。
- `typeahead-input.ts` 在粘贴路径时生成材料 chip；`paste-atomic.ts` 将材料 token 视作原子输入单元。
- `prepareUserTurnInput()` 成为 REPL 到 core 的用户输入准备边界，统一处理 `@file:`、材料 token、错误收集和正文保真。
- RPC conversation facade / controller 接受 `string | UserTurnInput`，让旧文本入口和新结构化入口并存但不分叉语义。
- OpenAI 兼容 provider 新增 image block 编码；已有 Anthropic image block 路径继续复用。
- 新增 / 更新测试覆盖 core 输入投影与校验、CLI 材料 ingest / resolve / typeahead、server structured turn、RPC 空 input 拒绝、OpenAI image 编码。

**本轮复审修复记录**：

- core 新增 `ModelInputCapabilities`、能力解析和 `validateMessagesAgainstInputCapabilities()`；`agent-loop` 在调用 provider 前统一拒绝当前模型不支持的图片输入。
- orchestrator 从当前 provider 的 model catalog 与 `credentials.providers.<id>.modelInputCapabilities` 解析能力，并注入 core；自定义视觉模型可通过用户配置声明 `{ images: true }`。
- OpenAI 兼容 adapter 保留用户消息中 text / image block 的原始顺序，不再把所有文本提前、所有图片后置。
- CLI 材料路径识别改为读取有上限的文件头做 MIME sniff；图片扩展名不能绕过魔数识别，图片尺寸读取不再全量读文件。
- CLI 材料提交解析改为重新 stat 并可恢复处理读错；文件被删除、权限变化或体积变化时返回本轮输入错误，不抛出打断 REPL。
- server `projectSessionTurn()` 内部类型收紧为 text / input 二选一，避免调用方漏传时静默创建空 turn。
- server public RPC `session.send` 边界同步收紧为 text / input 二选一；同时传两者直接返回 `INVALID_PARAMS`，避免多接入面客户端传错时静默丢弃其中一个输入源。

**重新从头复查追加遗漏：材料 chip 渲染原子性**

- **审核结论**：问题真实，属于第 5 个问题的遗漏子问题；它不推翻结构化材料输入架构，但说明 CLI 输入面的 handle 抽象还没有完整贯穿渲染层。
- **完整事实链**：
  - 材料路径粘贴由 `materialTokensFromPastedPaths()` 解析成本地材料，`InputMaterialRegistry.format()` 写入 `[Image #N · ...]` / `[File #N · ...]` chip。
  - 提交前，`resolveInputMaterials()` 只依赖 chip 中的 id 查 registry；chip 详情文字是输入区展示，不是材料语义来源。
  - 编辑层已将 `PASTE_TOKEN_PATTERN` 与 `MATERIAL_TOKEN_PATTERN` 都纳入 `findTokenCharRanges()`，所以 Backspace / 左右移动等操作已经把材料 chip 视作原子单元。
  - 渲染层仍只传 `PASTE_TOKEN_PATTERN`：输入区 `layoutInputBuffer()`、历史区 `wrapToWidth()`、共享 `input-box.ts` 都没有使用 material token 规则。
  - 补全层也仍只把 paste token 注入 `wordTerminators`；material chip 没有成为 typeahead token 边界。
  - 只加 material regex 仍不够：超长 chip 会整体换行后被 `renderChrome()` 截断，说明 token 原子化和 chip 文案预算必须一起设计。
- **背后需求**：用户看到的 chip 是“本轮材料”的可信 handle。它必须像一个整体一样可见、可删、可跨越、可作为词边界；不能在窄终端里变成几段内部字符串，也不能让不同输入子系统各自理解它。
- **目标效果**：
  - 图片 / 文件 chip 与文本 paste token 在输入区、历史区、输入历史恢复态都保持同一原子渲染语义。
  - chip 是可读摘要，不是完整文件路径或完整元数据 dump。长名称要在 chip 内部预算化压缩，优先保留类型、id、可识别文件名、图片尺寸 / 文件大小等关键信息。
  - typeahead 反向扫描不能跨过 chip；chip 后紧接 `/`、`@` 等触发字符时，chip 应与 paste token 一样被视作 word boundary。
  - 提交解析仍以 registry id 为准，不能让显示摘要变成语义来源。
- **不采用的方案**：
  - 不在 `typeahead-input.ts` 两个调用点临时拼 `PASTE_TOKEN_PATTERN | MATERIAL_TOKEN_PATTERN`。这会漏掉 `input-box.ts`、typeahead word terminators 和未来新 chip 类型。
  - 不让材料 chip 继续字符级 wrap 来保留更多详情。那破坏“handle 是整体”的产品心智。
  - 不把完整本地路径、base64 或超长 metadata 塞进 chip。chip 是确认 handle，不是材料本体。
  - 不把材料 chip 渲染规则下沉到 core。core 只需要结构化材料语义；CLI chip 是接入面展示。
- **最优方案**：
  - 新建 CLI 输入 handle 单一规则模块，例如 `input-handle-tokens.ts`，集中导出 `INPUT_HANDLE_TOKEN_PATTERNS`，当前包含文本 paste token 与 material chip；未来音频 / 视频 / 网页快照只在这里注册新 pattern。
  - 让 `paste-atomic.ts`、`typeahead-input.ts` 输入区 layout、history echo、`input-box.ts`、REPL broker `wordTerminators` 全部消费同一份 handle token patterns。这样编辑、渲染、补全三层共用一个事实源。
  - 将 `layoutInputBuffer()` 与 `wrapToWidth()` 的 atomic 参数从单个 `RegExp` 扩展为 `RegExp | readonly RegExp[]`，保留现有调用兼容，同时让多类 handle 不需要合成脆弱的大 union regex。
  - 给 `InputMaterialRegistry.format()` / 材料 chip formatter 增加可视宽度预算能力。预算化规则按字段优先级压缩：保留 label + id；名称做中间省略并尽量保留扩展名；图片尺寸和大小在空间不足时按优先级保留 / 省略；最终 token 仍匹配 `MATERIAL_TOKEN_PATTERN`，解析只取 id。
  - `InputController.finalizePaste()` 在生成材料 chip 时传入当前输入区可用预算；极窄终端下 `renderChrome()` 继续作为最后防线截断，但正常宽度下 chip 自身应已稳定可读。
- **修复记录**：
  - 新增 `input-handle-tokens.ts` 作为 CLI 输入 handle token 单一入口，当前统一注册文本 paste token 与 material chip。
  - 新增 `tui/atomic-regions.ts`，让布局、换行、编辑层复用同一套多 pattern atomic range 收集逻辑，并避免全局 regex `lastIndex` 污染。
  - `layoutInputBuffer()` 与 `wrapToWidth()` 扩展为支持 `RegExp | readonly RegExp[]`，输入区、历史回显、共享输入框原语全部改用 `INPUT_HANDLE_TOKEN_PATTERNS`。
  - REPL `DefaultTypeaheadBroker.wordTerminators` 改用 `INPUT_HANDLE_TOKEN_PATTERNS`，material chip 后紧接 `/`、`@` 等触发字符时与 paste token 一样是词边界。
  - `InputMaterialRegistry.format()` 增加宽度预算；长文件名中间省略并尽量保留扩展名，图片尺寸 / 大小按空间保留；`InputController.finalizePaste()` 按当前输入区宽度生成 chip，并给软件光标预留一列。
  - `resolveInputMaterials()` / `extractAliveMaterialIds()` 改用 fresh material token regex，避免全局 `MATERIAL_TOKEN_PATTERN.lastIndex` 影响材料解析。
  - 复审补修：core typeahead `wordTerminators` 扫描、CLI paste expand / alive id 提取全部改用 fresh regex scanner，避免共享全局 token regex 的 `lastIndex` 污染导致 token/chip 边界漏识别。
- **测试策略**：
  - `input-layout.test.ts`：同一 draft 内 paste token + image chip + file chip 都整体换行，不被字符级切碎。
  - `line-width.test.ts`：`wrapToWidth()` 支持多个 atomic patterns，并对 hard newline 保持现有行为。
  - `typeahead-input.test.ts`：粘贴长文件名图片路径后输入区和 scrollback 中 chip 不被切碎，提交后仍解析为 image part。
  - `trigger-matcher` / broker 相关测试：material chip 作为 word terminator，chip 后紧接 `/cmd` 或 `@file` 时触发边界语义与 paste token 一致。
  - `input-material.test.ts`：材料 chip formatter 对长文件名做预算化摘要，仍能被 `MATERIAL_TOKEN_PATTERN` 匹配，并且 `resolveInputMaterials()` 仍按 id 得到正确材料。
- **验收标准**：补 CLI layout / width / typeahead / material 单测与集成测试，覆盖长图片 chip、长文件 chip、文本 paste token 同时存在时的输入区、history echo、typeahead 边界和提交解析；断言 chip 不被字符级切碎，超长名称预算化显示，最终 payload 仍是结构化材料。

### 6. 缺少端到端粘贴生命周期测试

**状态**：已补充端到端覆盖，已完成定向验证。

**现象**：原先单测覆盖了 detector / registry / expand / atomic / layout，也覆盖普通 typeahead 输入，但缺少带 `PasteRegistry` 的完整 InputController 流程覆盖。

**事实依据**：

- 粘贴 / 输入生命周期相关 234 个测试全绿。
- 但上述“raw token 被写入 scrollback 历史区”和“输入历史 token 生命周期”的跨模块问题未被测试捕获。

**影响**：paste 子模块各自正确，但跨模块生命周期 bug 漏检。

**修复记录**：在 `typeahead-input.test.ts` 新增 / 补齐集成测试：

- 长 paste 折叠为 token，submit 返回 expanded text。
- submit 后 scrollback history echo 显示原文，不显示 token。
- submit 后 `↑` 恢复并再次 submit，agent / scrollback 仍得到原文，不泄漏死 token。
- 二次长 paste 显示原文，保持既有输入区行为。
- paste 内容首尾空白在 InputController text result 与 REPL sendTurn payload 中都保真。
- 最新补充覆盖：折叠长粘贴提交结果再经过 `prepareUserTurnInput()`，最终 `UserTurnInput` 仍为原文 text part，确保 REPL 到 agent 的 payload 准备边界不重新引入 token 或裁剪空白。

### 7. Delete 键没有接入 token 原子编辑契约

**状态**：已确认真实，待修复。

**现象**：设计与纯函数都声明 token 支持 `backspace / delete / left / right` 原子操作，但主输入控制器只接入了 backspace、left、right，没有接入物理 Delete 键。结果是 cursor 位于 token/chip 起始处时，Delete 键不能按契约整段删除右侧 token/chip。

**审核结论**：问题真实，且是独立于第 5 个问题的小型输入编辑契约遗漏。它不属于材料核心模型，也不是 Ctrl+D 候选删除协议问题；这里说的是键盘上的物理 Delete 键。

**事实依据**：

- `research/design/problems/multiline-paste-attachment.md` 明确写 typeahead-input 的 keypress 处理应在 `backspace` / `delete` / `left` / `right` 分支内先 try atomic。
- `packages/cli/src/paste-atomic.ts` 的 `AtomicEditKind` 包含 `"delete"`，`tryAtomicEdit()` 已实现 cursor 紧贴 token 起始时整段删除。
- `packages/cli/src/input-buffer.ts` 有 `deleteForward()`，说明普通字符的向前删除能力存在。
- `packages/cli/src/typeahead-input.ts` 当前只在 `backspace` / `left` / `right` 分支调用 `tryAtomicKeypress()`；没有 `key.name === "delete"` 分支。
- `Ctrl+D` 已被产品设计释放给候选删除协议，并明确不再承担 `deleteForward` 语义；这不影响物理 Delete 键应该作为普通编辑键工作。

**背后需求**：token/chip 是输入态材料 handle。用户无论从左侧 Delete 还是从右侧 Backspace 删除它，都应得到同一个“整段删除”的结果；否则输入区编辑心智不完整。

**目标效果**：

- cursor 在 token/chip 起始处按 Delete：整段删除 token/chip。
- cursor 在 token/chip 内部按 Delete：整段删除 token/chip，并把 cursor 放到删除点。
- cursor 不命中 token/chip 时按 Delete：普通向前删一个字符。
- Ctrl+D 行为不变：继续只服务 typeahead 候选删除协议，不恢复 EOF / deleteForward 语义。

**最优方案**：在 `InputController.handleKeypress()` 增加物理 Delete 键分支，先调用 `tryAtomicKeypress("delete")`，不命中时走 `buffer.deleteForward()`，随后 `syncBroker()`。保持 Ctrl+D 分支不动，避免候选删除协议和文本编辑键混淆。

**验收标准**：

- typeahead 集成测试覆盖文本 paste token 与 material chip 的 Delete 整段删除。
- 普通文本 Delete 仍向前删除一个字符。
- Ctrl+D 现有候选删除 / no-op 测试保持不变。

## 已验证

第 1-4 个问题验证命令：

```bash
pnpm --filter @zhixing/cli exec vitest run src/__tests__/input-buffer.test.ts src/__tests__/paste-detector.test.ts src/__tests__/paste-registry.test.ts src/__tests__/paste-expand.test.ts src/__tests__/paste-atomic.test.ts src/__tests__/input-layout.test.ts src/__tests__/typeahead-input.test.ts src/__tests__/user-turn-input.test.ts src/runtime/__tests__/leading-slash-alias.test.ts
```

结果：9 个测试文件、234 个测试通过。

第 5 个问题定向验证命令：

```bash
pnpm --filter @zhixing/core exec tsc --noEmit && pnpm --filter @zhixing/core exec vitest run src/types/user-input.test.ts src/loop/__tests__/agent-loop.test.ts && pnpm --filter @zhixing/core build
pnpm --filter @zhixing/cli exec vitest run src/__tests__/input-material.test.ts src/__tests__/user-turn-input.test.ts src/__tests__/typeahead-input.test.ts
pnpm --filter @zhixing/server exec tsc --noEmit && pnpm --filter @zhixing/server exec vitest run src/rpc/__tests__/session-turn-stream.test.ts src/runtime/__tests__/run-turn.test.ts src/__tests__/session-rpc.test.ts
pnpm --filter @zhixing/providers exec tsc --noEmit && pnpm --filter @zhixing/providers exec vitest run src/__tests__/openai-compatible.test.ts src/__tests__/resolve.test.ts src/__tests__/llm-roles.test.ts
pnpm --filter @zhixing/providers build && pnpm --filter @zhixing/orchestrator exec tsc --noEmit
```

结果：全部通过。

第 5 个问题补充修复定向验证命令：

```bash
pnpm --filter @zhixing/cli exec tsc --noEmit
pnpm --filter @zhixing/cli exec vitest run src/__tests__/input-layout.test.ts src/tui/__tests__/line-width.test.ts src/__tests__/input-material.test.ts src/__tests__/typeahead-input.test.ts
pnpm --filter @zhixing/cli exec vitest run src/__tests__/paste-atomic.test.ts src/__tests__/input-box.test.ts
```

结果：CLI 类型检查通过；6 个测试文件、210 个测试通过。

第 5 个问题补充修复收尾验证命令：

```bash
pnpm --filter @zhixing/cli test
pnpm cli:build
```

结果：CLI 140 个测试文件、2092 个测试通过；CLI 构建成功。

第 5 个问题补充复审修复定向验证命令：

```bash
pnpm --filter @zhixing/core exec tsc --noEmit
pnpm --filter @zhixing/cli exec tsc --noEmit
pnpm --filter @zhixing/core exec vitest run src/typeahead/__tests__/trigger-matcher.test.ts
pnpm --filter @zhixing/cli exec vitest run src/__tests__/paste-expand.test.ts src/__tests__/typeahead-input.test.ts
```

结果：core / CLI 类型检查通过；3 个测试文件、101 个测试通过。

第 5 个问题补充复审修复收尾验证命令：

```bash
pnpm --filter @zhixing/core test
pnpm --filter @zhixing/cli test
pnpm build
```

结果：core 全量测试通过；CLI 全量测试通过；全量构建成功。

第 6 个问题定向验证命令：

```bash
pnpm --filter @zhixing/cli exec tsc --noEmit && pnpm --filter @zhixing/cli exec vitest run src/__tests__/typeahead-input.test.ts src/__tests__/user-turn-input.test.ts
```

结果：2 个测试文件、53 个测试通过。

受影响包全量验证命令：

```bash
pnpm --filter @zhixing/core test
pnpm --filter @zhixing/providers test
pnpm --filter @zhixing/server test
pnpm --filter @zhixing/cli test
```

结果：core 112 个测试文件、1984 个测试通过；providers 11 个测试文件通过、222 个测试通过、3 个跳过；server 30 个测试文件、568 个测试通过；CLI 140 个测试文件、2084 个测试通过。

本轮最终结果：core 112 个测试文件、1987 个测试通过；providers 11 个测试文件通过、1 个跳过、224 个测试通过、3 个跳过；server 30 个测试文件、569 个测试通过；CLI 140 个测试文件、2087 个测试通过。

格式与构建命令：

```bash
pnpm lint
pnpm build
```

结果：全仓 Biome 通过；全量构建成功。
