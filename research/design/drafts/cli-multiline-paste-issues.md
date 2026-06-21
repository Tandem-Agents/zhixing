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

**状态**：待审核 / 待定产品目标

**现象**：长粘贴首次提交后，`InputBuffer.commit()` 会把提交前的 raw draft 推入 in-memory 输入历史。若 raw draft 含 `[Pasted #N ...]`，用户按 `↑` 找回时恢复的是 token。与此同时，`submit()` 后 `syncBroker()` 会按当前空 buffer 调用 `registry.cleanup(...)`，可能把对应 paste entry 清掉。再次提交时，这个 token 可能无法 expand，只会作为字面文本进入 agent 或历史区。

**与第 1 个问题的区别**：

- 第 1 个问题是 scrollback 历史区显示问题：发送后已经画出去的用户消息必须直接显示原文。
- 本问题是输入历史复用问题：`↑` 恢复的是可编辑输入态，仍有“显示 token 还是显示原文”的产品选择空间。
- 两者共用 `submit()` 附近代码路径，但用户语义不同，应该分开判断和修复，避免把历史区与输入历史混为一谈。

**事实依据**：

- `InputBuffer.commit()` 当前保存的是 `this.draft`，即提交前 raw draft。
- `historyPrev()` 直接把 history entry 还原到当前输入 buffer。
- `submit()` 中 `syncBroker()` 在 `buffer.commit()` 后执行，此时当前 buffer 已空；registry cleanup 只看当前 buffer 中仍存在的 token id。
- `expandPastes()` 对 unknown id 采用字面 fallback，不会报错，因此死 token 会静默变成普通文本。

**背后需求**：

- `↑` 输入历史不是历史区展示，而是用户复用上一条输入意图的入口。复用时可以为了输入区可控而显示 token，也可以显示原文，但再次提交必须等价于重新提交原文。
- 长粘贴 token 如果继续出现在输入态，就必须保持引用完整性；否则 token 这种降噪设计会退化成隐蔽的数据丢失。
- 用户不应被要求理解 registry 生命周期，也不应承担“这个 token 现在是否还活着”的判断成本。

**待定产品目标**：

- 方案 A：输入历史保存 token，`↑` 恢复时仍显示缩略；registry 生命周期必须覆盖输入历史中的 token，直到 history entry 被淘汰或 token 被编辑破坏。
- 方案 B：输入历史保存原文，`↑` 恢复时显示原文；实现简单且不依赖 registry，但可能让长文本重新撑满输入区。
- 当前倾向：先审核真实行为与体验代价，再定方案。无论选 A 还是 B，硬性目标都是再次提交不能把 `[Pasted #N ...]` 字面发给 agent。

**架构判断**：

- 如果保留 token 作为输入历史显示，就必须把 registry cleanup 从“只看当前 buffer”提升到“看当前 buffer + 输入历史可达 token”。这属于输入态引用生命周期管理。
- 如果输入历史保存原文，则 `PasteRegistry` 可以继续只服务当前输入态；代价是 `↑` 恢复长文本时不再折叠。
- 这个问题不受 scrollback 不可重绘限制约束，因为输入历史是应用内存状态，不是终端已绘历史。

**验收标准**：

- 长粘贴提交后，按 `↑` 恢复上一条输入，再次提交时 agent 收到原文，不收到死 token。
- 再次提交后 scrollback history echo 仍显示原文，不显示 token。
- 选定方案后补充 UI 验收：`↑` 恢复时显示 token 或显示原文必须与产品目标一致。
- 补 `typeahead-input.test.ts` 集成测试覆盖完整生命周期。

### 4. submit 对展开文本 trim，粘贴原文不完全保真

**状态**：待决策

**现象**：`submit()` 对 `expanded.trim()` 后再发送。长粘贴原文如果有首尾空白、末尾空行、顶层缩进，提交给 agent 时会被裁剪。

**事实依据**：

- `typeahead-input.ts` 中 `const text = normalizeLeadingSlashAliasInExpanded(expanded.trim(), rawDraft.trim())`。

**影响**：普通自然语言影响较小；代码、YAML、Python、patch、日志等粘贴内容可能因为首尾空白被改变语义。

**倾向修复方向**：区分“是否空输入 / 是否命令”的判断与“发送正文”。可以用 trim 只做控制流判断，真正 text 保留 expanded 原文；命令路径另行保持现有 trim 语义。

**需要补测试**：粘贴包含前导空格和末尾换行的内容，提交给 text 路径时保持原文。

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

- 粘贴相关 183 个测试全绿。
- 但上述“raw token 被写入 scrollback 历史区”和“输入历史 token 生命周期”的跨模块问题未被测试捕获。

**影响**：paste 子模块各自正确，但跨模块生命周期 bug 漏检。

**倾向修复方向**：在 `typeahead-input.test.ts` 新增集成测试：

- 长 paste 折叠为 token，submit 返回 expanded text。
- submit 后 scrollback history echo 显示原文，不显示 token。
- submit 后 `↑` 恢复并再次 submit，agent / scrollback 仍得到原文，不泄漏死 token。
- 二次长 paste 显示原文，保持既有输入区行为。
- paste 内容首尾空白保真（若第 4 项决策为保真）。

## 已验证

运行命令：

```bash
pnpm --filter @zhixing/cli exec vitest run src/__tests__/paste-detector.test.ts src/__tests__/paste-registry.test.ts src/__tests__/paste-expand.test.ts src/__tests__/paste-atomic.test.ts src/__tests__/input-layout.test.ts src/__tests__/typeahead-input.test.ts
```

结果：6 个测试文件、183 个测试通过。
