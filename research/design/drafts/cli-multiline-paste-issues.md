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
- **保真标准**：trim 只能服务空输入判断、命令识别等控制流。一旦内容被判定为用户正文，CLI 不能裁剪用户材料；代码、patch、YAML、日志等首尾空白都可能有语义。
- **长期标准**：方案不能只修当前终端和当前输入框。它要经得起原生 scrollback 不可重绘、多个接入面扩展、未来附件类型扩展的考验。
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

### 5. legacy readline 降级路径没有附件化粘贴能力

**状态**：待评估

**现象**：终端能力探测失败，或 `ZHIXING_INPUT_TYPEAHEAD=legacy/off` 时，REPL 走 `rl.question()`，不经过 paste-detector / PasteRegistry / finalizePaste。

**事实依据**：

- `repl.ts` 的 legacy 分支直接 `input = await rl.question(...)`。
- PasteRegistry 只注入到 `InputController` 主路径。

**影响**：在无 chrome / legacy 输入模式下，多行粘贴可能退回 readline 行编辑行为，不具备长粘贴折叠与占位符 expand 能力。

**倾向修复方向**：先确认 legacy 是否属于必须支持的产品路径。若需要支持，可考虑让 legacy 直接提示“不支持附件化粘贴，请使用支持 chrome 的终端”，或给 legacy 单独接入 bracketed paste / paste registry。

**需要补测试**：待决策后补。

### 6. 缺少端到端粘贴生命周期测试

**状态**：待补充

**现象**：现有单测覆盖了 detector / registry / expand / atomic / layout，也覆盖普通 typeahead 输入，但没有覆盖带 `PasteRegistry` 的完整 InputController 流程。

**事实依据**：

- 粘贴 / 输入生命周期相关 234 个测试全绿。
- 但上述“raw token 被写入 scrollback 历史区”和“输入历史 token 生命周期”的跨模块问题未被测试捕获。

**影响**：paste 子模块各自正确，但跨模块生命周期 bug 漏检。

**倾向修复方向**：在 `typeahead-input.test.ts` 新增集成测试：

- 长 paste 折叠为 token，submit 返回 expanded text。
- submit 后 scrollback history echo 显示原文，不显示 token。
- submit 后 `↑` 恢复并再次 submit，agent / scrollback 仍得到原文，不泄漏死 token。
- 二次长 paste 显示原文，保持既有输入区行为。
- paste 内容首尾空白在 InputController text result 与 REPL sendTurn payload 中都保真。

## 已验证

运行命令：

```bash
pnpm --filter @zhixing/cli exec vitest run src/__tests__/input-buffer.test.ts src/__tests__/paste-detector.test.ts src/__tests__/paste-registry.test.ts src/__tests__/paste-expand.test.ts src/__tests__/paste-atomic.test.ts src/__tests__/input-layout.test.ts src/__tests__/typeahead-input.test.ts src/__tests__/user-turn-input.test.ts src/runtime/__tests__/leading-slash-alias.test.ts
```

结果：9 个测试文件、234 个测试通过。

构建命令：

```bash
pnpm cli:build
```

结果：构建成功。
