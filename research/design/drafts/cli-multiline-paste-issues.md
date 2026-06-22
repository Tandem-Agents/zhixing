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
- **路径意图标准**：路径形态只是信号，不等同于用户授权读取本地文件。任何路径采集规则都必须同时保护两件事：失败不能删用户文本，成功不能静默把用户未明确交付的文件内容注入 agent 上下文。
- **输入 handle 标准**：输入态所有 handle（文本粘贴 token、图片 / 文件 chip、未来音频 / 视频 / 网页快照 chip）必须共用同一套原子编辑、原子渲染、宽度预算和提交转换规则。不能让同一类“用户材料占位”在某些路径是整体、某些路径被字符级切碎。
- **保真标准**：trim 只能服务空输入判断、命令识别等控制流。一旦内容被判定为用户正文，CLI 不能裁剪用户材料；代码、patch、YAML、日志等首尾空白都可能有语义。
- **失败语义标准**：只要系统已经判断用户在提交材料，部分失败必须显式反馈并保留可恢复输入，不能整批静默降级成普通文本，让用户误以为材料已经被接收。
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

**状态**：已修复，已测试，已构建。

**现象**：设计与纯函数都声明 token 支持 `backspace / delete / left / right` 原子操作，但主输入控制器只接入了 backspace、left、right，没有接入物理 Delete 键。结果是 cursor 位于 token/chip 起始处时，Delete 键不能按契约整段删除右侧 token/chip。

**审核结论**：问题真实，且是独立于第 5 个问题的 CLI 输入接入层漏接。它不属于核心材料模型，不属于 provider 能力问题，也不是 Ctrl+D 候选删除协议问题；这里说的是键盘上的物理 Delete 键。

**事实依据**：

- `research/design/problems/multiline-paste-attachment.md` 明确写 typeahead-input 的 keypress 处理应在 `backspace` / `delete` / `left` / `right` 分支内先 try atomic。
- `packages/cli/src/paste-atomic.ts` 的 `AtomicEditKind` 包含 `"delete"`，`tryAtomicEdit()` 已实现 cursor 紧贴 token 起始时整段删除。
- `packages/cli/src/input-buffer.ts` 有 `deleteForward()`，说明普通字符的向前删除能力存在。
- `packages/cli/src/typeahead-input.ts` 当前只在 `backspace` / `left` / `right` 分支调用 `tryAtomicKeypress()`；没有 `key.name === "delete"` 分支。
- `Ctrl+D` 已被产品设计释放给候选删除协议，并明确不再承担 `deleteForward` 语义；这不影响物理 Delete 键应该作为普通编辑键工作。
- `packages/cli/src/__tests__/paste-atomic.test.ts` 已覆盖 `tryAtomicEdit(..., "delete")` 的纯函数行为；缺口在 `packages/cli/src/__tests__/typeahead-input.test.ts` 没有物理 Delete 的集成覆盖。

**背后需求**：token/chip 是输入态材料 handle。用户无论从左侧 Delete 还是从右侧 Backspace 删除它，都应得到同一个“整段删除”的结果；否则输入区编辑心智不完整。

**范围判断**：

- 只修 CLI 输入接入层，不改 core、provider、server 或结构化材料协议。
- 不改 `PasteRegistry` / `InputMaterialRegistry` 的语义；Delete 删除的是输入区 handle，registry 清理仍由现有 `syncBroker()` 的 alive id 机制负责。
- 不改 `InputBuffer` 内部模型。它继续提供普通字符级 `deleteForward()`；atomic 语义仍在 `typeahead-input.ts` keypress 层拦截。
- 不恢复 Ctrl+D 的 EOF / deleteForward 语义。Ctrl+D 已是候选删除协议，物理 Delete 才是文本编辑键。

**目标效果**：

- cursor 在 token/chip 起始处按 Delete：整段删除 token/chip。
- cursor 在 token/chip 内部按 Delete：整段删除 token/chip，并把 cursor 放到删除点。
- cursor 不命中 token/chip 时按 Delete：普通向前删一个字符。
- Ctrl+D 行为不变：继续只服务 typeahead 候选删除协议，不恢复 EOF / deleteForward 语义。

**最优方案**：

- 在 `InputController.handleKeypress()` 增加 `key.name === "delete"` 分支，位置放在 backspace 之后、左右移动之前，归入编辑键处理区。
- 分支内先调用 `tryAtomicKeypress("delete")`；命中则整段删除输入 handle，不命中则调用 `buffer.deleteForward()` 做普通字符级向前删除。
- 删除后调用 `syncBroker()`，与 backspace / 插入字符保持一致，确保 broker 输入态、registry alive id 清理、底部提示和重绘都走同一条路径。
- 不新增新的抽象层，也不把 Delete 特判下沉到 `InputBuffer`。现有 `paste-atomic.ts` 已经是正确的输入 handle 原子编辑边界；本问题只需要把 key routing 补齐。

**产品 / 架构判断**：这是最优架构，不是补丁式妥协。输入 handle 的产品本质是“一个可操作的材料占位”，左侧 Delete 和右侧 Backspace 必须对称；而实现上把原子语义留在 CLI 输入控制器，既保护 core 的纯粹性，也避免污染普通字符 buffer。

**修复记录**：

- `InputController.handleKeypress()` 增加物理 Delete 键分支，先走 `tryAtomicKeypress("delete")`，未命中再走 `buffer.deleteForward()`，最后统一 `syncBroker()`。
- `typeahead-input.test.ts` 补充三条集成测试，覆盖文本 paste token 整段删除、材料 chip 整段删除、普通文本向前删除。
- Ctrl+D 分支保持不变，继续只服务候选删除协议。

**验收标准**：

- typeahead 集成测试覆盖文本 paste token 与 material chip 的 Delete 整段删除。
- 普通文本 Delete 仍向前删除一个字符。
- Ctrl+D 现有候选删除 / no-op 测试保持不变。
- `paste-atomic.test.ts` 现有纯函数 Delete 覆盖保持通过，作为底层契约回归。

**建议测试策略**：

- 在 `typeahead-input.test.ts` 增加物理 Delete 集成测试：
  - 长文本粘贴折叠为 `[Pasted #...]` 后，按 Home 再按 Delete，输入区 token 消失，提交结果为空文本。
  - 图片路径粘贴生成 `[Image #...]` chip 后，按 Home 再按 Delete，输入区 chip 消失，提交结果为空文本且不会解析出 image part。
  - 普通文本 `abc` 按 Home 再按 Delete，提交结果为 `bc`。
- 保留并运行现有 Ctrl+D no-op / 候选删除相关测试，证明物理 Delete 与 Ctrl+D 没有语义串线。

**验证命令**：

```bash
pnpm --filter @zhixing/cli exec tsc --noEmit && pnpm --filter @zhixing/cli exec vitest run src/__tests__/typeahead-input.test.ts src/__tests__/paste-atomic.test.ts src/__tests__/input-buffer.test.ts
pnpm --filter @zhixing/cli test
pnpm cli:build
```

结果：CLI 类型检查通过；定向 3 个测试文件、102 个测试通过；CLI 全量 140 个测试文件、2097 个测试通过；CLI 构建成功。

### 8. 材料 chip 会被后续任意粘贴静默替换

**状态**：已修复，已验证。

**现象**：用户先粘贴图片 / 文件路径生成材料 chip 后，再粘贴任意内容，旧材料 chip 会被 `finalizePaste()` 静默删除。文本长粘贴的“主动第二次粘贴替换旧 token”是既有需求；但材料 chip 是本轮输入材料，不应被普通后续粘贴隐式移除。

**审核结论**：问题真实，属于 CLI 输入组合策略错误。它不是核心材料解析能力缺失，也不是 Delete / Backspace 原子编辑问题；根因是 `finalizePaste()` 把“文本 paste token 的二次替换规则”错误套到了“材料 chip”上。

**事实依据**：

- `packages/cli/src/typeahead-input.ts` 的 `finalizePaste()` 会先尝试 `materialTokensFromPastedPaths()`，把本次粘贴的本地文件路径转成 material chip。
- 随后 `finalizePaste()` 调用 `removeAllInputTokens(this.buffer.draft, this.buffer.cursor)` 清理已有输入 handle。
- `removeAllInputTokens()` 使用 `INPUT_HANDLE_TOKEN_PATTERNS`，会同时匹配文本 paste token 和 material chip。
- 因此已有 `[Image #N ...]` / `[File #N ...]` 时，用户再粘贴普通提示词、另一张图、另一个文件，旧材料 chip 会在新内容插入前被删除。
- `packages/cli/src/input-material-resolve.ts` 的 `resolveInputMaterials()` 已经支持按输入顺序输出 text / image / file-derived text parts，核心 payload 形态不是瓶颈。
- 原多行粘贴设计中二次粘贴清理的是 `removeAllPasteTokens()`，目标是文本 paste token 的折叠占位；材料 chip 是后续新增的输入 handle，不应继承该替换规则。
- 现有测试覆盖了“主动第二次长文本粘贴替换旧 paste token”和 Delete 键删除 material chip；但没有覆盖“材料 chip 后继续粘贴文本 / 材料应保留已有材料”的组合输入场景。

**背后需求**：材料 chip 表达的是“本轮要一起交给 agent 的材料”。用户应该能先贴图，再追加提示词；也应该能连续贴多张图 / 多个文件。除非用户显式删除 chip，系统不应把已有材料从本轮输入里静默拿掉。

**目标效果**：

- 文本长粘贴 token 继续保持既有需求：已有文本 paste token 时，主动第二次长文本粘贴替换旧 token 并显示原文。
- 材料 chip 不参与“二次文本粘贴替换旧 token”规则。用户粘贴文本、图片路径、文件路径时，已有材料 chip 默认保留。
- 多个材料可以在同一轮输入里共存，并按输入顺序提交为结构化 `UserTurnInput.parts`。
- 用户仍可用 Backspace / Delete / 选区编辑等显式动作删除材料 chip；删除后 registry cleanup 回收材料。

**产品 / 架构判断**：

- 这是一个输入接入面的组合语义问题，不应把材料能力重新绑回 CLI，也不应改 core 的 `UserTurnInput` 结构。
- 文本 paste token 是“长文本显示压缩”，材料 chip 是“本轮输入材料引用”；二者都长得像输入 handle，但产品语义不同。
- 最优架构是保持通用 input handle 的原子编辑 / 渲染能力，同时把“二次粘贴自动替换”收窄为文本 paste token 的专属策略。
- 该方案经得起未来扩展：音频、视频、网页快照、富文本等未来材料都可以继续作为 material handle 参与组合，而不会被文本粘贴规则误删。

**最优方案**：

- `finalizePaste()` 保留“先识别本次粘贴是否为材料”的流程：本地图片 / 文件路径仍生成 material chip；普通文本仍按文本粘贴处理。
- 把粘贴前清理从 `removeAllInputTokens()` 改为 `removeAllPasteTokens()`：只移除已有文本 paste token，不移除 material chip。
- 用清晰变量表达“本次是否移除了旧文本 paste token”，不要再用容易误导的 `bufferWasClean` 表达全部输入 handle 状态。
- 折叠判断保持文本专属：只有本次不是材料、存在 paste registry、内容满足长粘贴阈值、且没有刚移除旧 paste token 时，才生成新的 paste token。
- 新 material chip 按当前 cursor 插入；已有材料 chip 保留，后续 `syncBroker()` 继续根据 draft 中活跃 token 回收 registry。
- 保持 `INPUT_HANDLE_TOKEN_PATTERNS` 的职责不变：它仍用于通用原子编辑、布局测宽、word boundary，不参与二次粘贴替换策略。
- 保留 `removeAllInputTokens()` 作为“显式清空全部输入 handle”的底层工具，不在普通粘贴路径使用。

**边界行为**：

- 已有 image chip 后粘贴普通文本：image chip 保留，文本插入当前 cursor，提交时形成有序 text + image parts。
- 已有 image chip 后再粘贴图片路径：两个 image chip 共存，提交时形成两个 image parts，顺序跟输入区一致。
- 已有 text paste token 后再次长文本粘贴：旧 paste token 被移除，第二次粘贴显示原文，既有需求不变。
- 已有 text paste token 后粘贴材料路径：旧 paste token 被移除，新 material chip 插入；这是文本 token 替换规则与材料插入规则的自然组合。
- 同时存在 text paste token 和 material chip 时再次粘贴：只移除 text paste token，material chip 保留。

**验收标准**：

- 已有 image chip 后粘贴普通文本：chip 保留，文本追加，最终 `prepareUserTurnInput()` 得到 text + image part。
- 已有 image chip 后再粘贴另一个图片路径：两个 chip 都保留，最终得到两个 image part，顺序正确。
- 已有文本 paste token 后再次长文本粘贴：继续按既有需求替换旧 token 并显示第二次粘贴原文。
- 显式 Delete / Backspace 删除 material chip 后，material registry 能正确 cleanup。

**建议测试策略**：

- 在 `typeahead-input.test.ts` 增加集成测试：image chip 后粘贴普通文本，draft / 提交结果都保留 chip 和文本，`prepareUserTurnInput()` 输出顺序正确。
- 在 `typeahead-input.test.ts` 增加集成测试：连续粘贴两个图片路径，输入区保留两个 chip，最终输出两个 image parts。
- 保留并强化现有二次长文本粘贴测试：证明 `removeAllPasteTokens()` 替代 `removeAllInputTokens()` 后，旧文本 paste token 仍被正确替换。
- 在 `paste-atomic.test.ts` 增加纯函数测试：`removeAllPasteTokens()` 删除文本 paste token 但保留 material chip，防止未来再次把两类 handle 混用。

**修复记录**：

- `InputController.finalizePaste()` 的粘贴前清理从 `removeAllInputTokens()` 收窄为 `removeAllPasteTokens()`，普通粘贴不再隐式删除 material chip。
- `finalizePaste()` 用 `removedPasteToken` 表达是否刚移除了旧文本 paste token，折叠决策仍只服务文本长粘贴。
- `paste-atomic.test.ts` 补充纯函数回归：删除文本 paste token 时保留材料 chip。
- `typeahead-input.test.ts` 补充两条集成回归：材料 chip 后粘贴普通文本、连续粘贴多个图片路径，均保留材料并按输入顺序提交。

**验证命令**：

```bash
pnpm --filter @zhixing/cli exec tsc --noEmit && pnpm --filter @zhixing/cli exec vitest run src/__tests__/paste-atomic.test.ts src/__tests__/typeahead-input.test.ts
pnpm --filter @zhixing/cli test
pnpm cli:build
```

结果：CLI 类型检查通过；定向 2 个测试文件、83 个测试通过；CLI 全量 140 个测试文件、2100 个测试通过；CLI 构建成功。

### 9. 材料解析失败前已写入 scrollback

**状态**：已修复，已验证。

**现象**：用户提交包含材料 chip 的输入后，`InputController.submit()` 会先把 raw / canonical 文本写入 CLI scrollback；随后 REPL 才调用 `prepareUserTurnInput()` 解析材料。如果材料解析失败，REPL 会提示错误并跳过 `sendTurn()`，但 scrollback 已经留下了一条看起来已发送的用户历史消息。

**审核结论**：问题真实，属于“输入提交显示边界”与“结构化 payload 准备边界”顺序不一致。文本长粘贴修复后，scrollback 已经使用 canonical 文本；但材料输入引入后，是否能发送必须先由 `prepareUserTurnInput()` 判定。由于 CLI scrollback 是终端原生历史，已写入内容不能可靠撤销，因此必须在写入前完成可发送性确认。

**事实依据**：

- `packages/cli/src/typeahead-input.ts` 的 `submit()` 对非空输入执行 `buffer.commit()`、`syncBroker()`、`echoSubmittedText(canonicalDraft)`，随后才 `fireSubmit({ kind: "text", text: canonicalDraft })`。
- `packages/cli/src/repl.ts` 在收到 `InputController.waitOnce()` 的 text result 后，才调用 `prepareUserTurnInput(input, { materialRegistry })`。
- `prepareUserTurnInput()` / `resolveInputMaterials()` 可能返回错误，例如：源文件消失、图片过大、非文本普通文件暂不支持。
- 当 `preparedInput.errors.length > 0` 时，REPL 打印警告并 `continue`，不会调用 `controller.sendTurn(preparedInput.input)`。
- 因此 scrollback 中可能存在一条用户消息 chip，但这条消息实际没有进入 agent，也不会进入核心对话事实。
- `research/internals/screen-rendering/overview.md` 明确当前 CLI 不维护已绘历史状态，滚进 terminal scrollback 的内容归终端管理，应用无法可靠读取、修改或搬回。
- 现有 `typeahead-input.test.ts` 覆盖成功提交时 history echo 显示 canonical 原文 / material chip，但没有覆盖材料解析失败时不应写入 scrollback。

**背后需求**：scrollback 是用户对“已经发送内容”的信任记录。只要某次输入没有成功被核心接收，就不能提前把它渲染成已发送历史消息；否则用户会误以为 agent 已经看到了材料。

**目标效果**：

- 对所有输入类型，scrollback 只记录已经通过提交准备、并已被核心接收的用户消息。
- 材料解析失败时，输入内容不应作为已发送历史消息写入 scrollback；用户应看到明确错误，原输入草稿仍留在输入区，便于删除、替换或补充材料。
- 文本长粘贴仍保持：提交后 scrollback 显示原文，不显示 paste token。
- 结构化材料成功时，scrollback 显示稳定的人类可读摘要，不泄漏本地路径，不依赖后续展开。
- 命令提交继续走本地命令路径；本问题只处理会进入 agent/core 的正文提交。

**产品 / 架构判断**：

- 最优产品语义是“核心已接收才进入历史”。失败的输入应留在 composer，而不是变成一条看似已发送的消息。
- 最优架构不是给 scrollback 做撤销，也不是让 REPL 复制 history echo 渲染；撤销违背终端原生 scrollback 的硬约束，复制渲染会制造第二套历史样式。
- 正确边界是：REPL 负责语义准备和是否可发送；InputController 负责输入 buffer、chrome 同步、输入历史和 scrollback echo 的唯一渲染。
- 该方案经得起未来材料扩展：图片、文件、音频、视频、网页快照等只要提交前准备可能失败，都走同一个提交事务，不为每种材料类型写特殊分支。

**最优方案**：

- 为 typeahead 正文提交建立“待确认提交”语义：按 Enter 后先生成 canonical text，但暂不 `buffer.commit()`、暂不 `echoSubmittedText()`、暂不清空输入区。
- `InputController` 向 REPL 交出一个待提交对象，包含 canonical text，并提供唯一的 `commit()` / `reject()` 完成入口：
  - `commit()` 由 `InputController` 内部执行 `buffer.commit()`、`syncBroker()`、`echoSubmittedText(canonicalText)`，然后本轮输入正式完成。
  - `reject()` 不写 scrollback、不写输入历史、不清空 buffer，只解除待提交状态并重绘输入区。
- REPL 收到待提交对象后调用 `prepareUserTurnInput()`：
  - 成功且无 errors：调用 `controller.beginTurn(preparedInput.input)`；宿主接受或本地 turn 首帧先到时再 `commit()`，随后等待 accepted turn 的 `outcome`。
  - 准备失败或发送被宿主拒绝：打印 warning / error，调用 `reject()`，继续等待用户编辑同一份草稿。
- `echoSubmittedText()` 继续留在 `InputController` 内，不下沉到 REPL；REPL 只决定“是否提交”，不复制历史回显样式。
- 命令提交可以保持当前路径：命令是本地控制流，`InputController` 已经持有 dispatcher 并能完整执行；正文提交才需要外部 payload 准备。
- 待提交期间应防止并发按键修改同一 buffer：可以短暂进入 pending 状态，忽略普通编辑键；成功 commit 或失败 reject 后恢复 active。这样避免异步材料读取期间用户继续输入造成 draft 与 canonical text 分叉。
- 不引入应用层 scrollback 状态，也不改 `ScreenController` 的历史模型；本问题通过提交时序解决，而不是扩大屏幕架构。

**边界行为**：

- 有效图片 / 文本文件材料提交：准备成功后输入区清空、scrollback 写入材料摘要、agent/core 收到结构化 `UserTurnInput.parts`。
- 非文本普通文件提交：准备失败，显示错误，不写 scrollback，不调用 `sendTurn()`，输入区保留原 chip。
- 图片源文件在提交前被删除：准备失败，显示错误，不写 scrollback，不调用 `sendTurn()`，输入区保留原 chip，用户可删除或重新粘贴。
- 宿主忙 / 宿主不可达导致发送未被接收：显示错误，不写 scrollback，输入区保留原草稿。
- loopback 下本地 turn 的 delta / complete 早于 send response：先提交用户消息，再渲染 assistant 输出。
- 文本长粘贴提交：准备成功后 scrollback 仍显示原文，不显示 `[Pasted #...]` token。
- 本地命令提交：继续由 command dispatcher 处理，不被材料准备事务阻塞。

**验收标准**：

- 粘贴 unsupported binary file 生成 file chip 后提交：显示错误，不调用 `sendTurn()`，scrollback 不出现该 chip / 用户历史消息。
- 粘贴图片后源文件在提交前消失：显示错误，不调用 `sendTurn()`，scrollback 不出现未发送消息，输入区仍保留 chip。
- 宿主返回 BUSY / 发送 RPC 失败：显示错误，scrollback 不出现未发送消息，输入区仍保留草稿。
- 本地 turn 通知早于 send response：用户消息仍先于 assistant 输出写入 scrollback。
- 粘贴有效图片 / 文本文件提交成功：scrollback 显示稳定摘要，agent/core 收到结构化 input。
- 文本长粘贴提交仍显示原文，不泄漏 paste token。

**建议测试策略**：

- 在 `typeahead-input.test.ts` 增加提交事务测试：正文 pending 时成功 `commit()` 才写 scrollback；`reject()` 不写 scrollback 且 draft 保留。
- 在 REPL 层或可注入 harness 中增加材料失败集成测试：unsupported binary file chip 提交后打印 warning，不调用 `sendTurn()`，scrollback 不出现该用户消息。
- 增加源文件消失测试：提交前删除图片源文件，验证错误提示、无 scrollback、draft/chip 保留、material registry 仍保活。
- 保留文本长粘贴成功提交测试，验证延迟 commit 后 history echo 仍显示 canonical 原文。
- 保留命令分发测试，证明正文提交事务不影响 `/help`、`/clear` 等本地命令路径。
- 在 `conversation-controller.test.ts` 增加 turn 接受边界测试：`beginTurn()` 只代表宿主已接收，`outcome` 仍等待 complete 落定。

**修复记录**：

- `InputController` 增加 `pending-text` 正文提交结果和 `textSubmitMode: "deferred"` 模式；正文按 Enter 后先进入待确认状态，不立刻清空输入区或写 scrollback。
- `pending-text.commit()` 由 `InputController` 内部统一执行 `buffer.commit()`、`syncBroker()`、`echoSubmittedText()`；`reject()` 不写历史、不清 buffer，只恢复输入区可编辑状态。
- `ConversationController` 增加 `beginTurn()`：宿主接受后返回 turnId 和 outcome waiter；并提供本地 turn accepted 回调，send response 或本地 delta / complete 先到都只触发一次；旧 `sendTurn()` 继续兼容并等待 outcome。
- REPL 持久 typeahead 输入区启用 deferred 模式：`prepareUserTurnInput()` 成功后先 `beginTurn()`，核心接收确认后再 `commit()`；材料解析失败或发送失败时打印 warning / error 并 `reject()`，不会产生假历史消息。
- 本地命令路径保持立即提交和分发，不经过正文材料准备事务。
- `readInputLine()` 单次 facade 对误传的 deferred 正文自动 commit 并返回旧的 text 结果，避免向单次调用方泄漏不可用的 pending 对象。
- `typeahead-input.test.ts` 补充 deferred 正文提交事务、材料失败 reject、命令路径不受影响、单次 facade 兼容性回归；`conversation-controller.test.ts` 补充 accepted turn 边界与本地首帧早于 send response 的竞态回归。

**验证命令**：

```bash
pnpm --filter @zhixing/cli exec tsc --noEmit && pnpm --filter @zhixing/cli exec vitest run src/runtime/__tests__/conversation-controller.test.ts src/__tests__/typeahead-input.test.ts src/__tests__/user-turn-input.test.ts src/__tests__/input-material.test.ts
pnpm --filter @zhixing/cli test
pnpm cli:build
```

结果：CLI 类型检查通过；定向 4 个测试文件、91 个测试通过；CLI 全量 140 个测试文件、2106 个测试通过；CLI 构建成功。

### 10. 批量材料路径部分失败时整批静默退化为普通文本

**状态**：已修复，已测试，已构建

**现象**：用户一次粘贴多行本地文件路径时，只要其中任意一行 `stat` 失败或不是普通文件，当前材料识别会返回 `null`。结果是本次粘贴不再被视为材料批次：有效路径不会生成材料 chip，错误路径没有提示；内容随后按普通文本粘贴逻辑插入或折叠为 `[Pasted #...]` 文本 token。

**审核结论**：问题真实，是第 5 个问题结构化材料输入的遗漏边界，不是第 8 个问题的重复。第 8 个问题解决的是“后续粘贴不应删除已有材料 chip”；本问题解决的是“同一次材料采集里部分成功 / 部分失败的语义与反馈”。问题根因不是 provider 能力，也不是提交阶段材料解析失败；根因是粘贴采集阶段用 `string | null` 把“不是材料”和“材料采集失败”混成了同一个返回值。

**事实证据**：

- `input-material-ingest.ts` 的 `parsePastedPaths(content)` 会把非空行都当作待解析路径候选；它只返回字符串数组，不携带“普通文本 / 明确路径 / 失败路径”的分类信息。
- `materialTokensFromPastedPaths()` 随后逐个 `resolvePastedPath()` + `fs.statSync()`；任一路径 `stat` 抛错，或 `stat.isFile()` 为 false，函数立即返回 `null`，之前已经成功解析的路径也不会注册。
- `readFileHeader()` 失败不会触发本问题：它会返回空 header，材料仍可能注册成普通文件，后续提交阶段由 `resolveInputMaterials()` 返回错误。这是另一条已具备可恢复错误的路径。
- `typeahead-input.ts` 的 `finalizePaste()` 把 `null` 理解成“不是材料粘贴”，于是继续走普通文本粘贴：短内容插入原文，长内容或多行内容可能折叠成文本 paste token。无论哪种，用户意图中的材料都没有进入 `InputMaterialRegistry`。
- 现有测试覆盖单个有效图片 / 文件路径、普通文本不误识别、提交时材料读错恢复、材料 chip 后续粘贴不丢失；没有覆盖“同一次粘贴里部分有效、部分无效”的材料采集场景。

**背后需求**：

- 用户粘贴路径，本质上是在把本地材料加入本轮输入；路径只是采集线索，不是要交给模型的正文。
- 一次粘贴可以天然是有序混排：若干材料路径、若干普通说明文字、若干失败路径。系统应该按用户粘贴顺序保留成功材料与说明文字，并显式报告失败材料。
- 一个路径错了不应让其他有效材料消失；同样，明确路径失败不应被静默塞进 prompt，让用户误以为文件已经被 agent 接收。无显式前缀的弱候选失败必须保留为普通文本，因为系统无法可靠判断它是路径错误还是用户正文。
- 失败必须可恢复：用户要知道哪一项没加上、为什么没加上，并能通过删除、修正或重新粘贴继续完成本轮输入。

**目标效果**：

- 多行全是有效材料路径：全部生成 material chip，按粘贴顺序进入输入区。
- 多行里部分路径有效、部分明确路径失败：有效项生成 material chip；明确失败项不生成材料、不作为普通正文插入，并通过清晰诊断告诉用户。无显式前缀的弱候选失败不诊断、不移除，原样保留为文本。
- 同一次粘贴里包含普通说明文字和有效路径：普通说明文字保留为 text，路径生成 material chip，整体顺序稳定。
- 全部都是明确路径但全部失败：输入区不新增伪材料，也不把失败路径静默插入正文；显示失败诊断，原有草稿保持可继续编辑。
- 多行并不表达材料路径集合，例如自然语言、代码块、日志：仍按文本粘贴处理，不弹材料错误。
- 材料失败反馈只属于接入面采集体验；提交到 core 的仍是结构化 `UserTurnInput.parts`，不把失败提示伪装成用户正文。

**架构判断**：

- 最优边界是把“材料采集”建模为可部分成功的 ingest 结果，而不是 `string | null` 的二元判断。`null` 只能表达“不是材料粘贴”，不能表达“材料粘贴失败”。
- CLI 负责从本机路径采集材料、生成 chip、展示采集失败；core 仍只接收已经成功准备好的结构化输入，不理解本地路径错误。
- `InputMaterialRegistry` 只登记成功材料；失败项不进 registry，避免后续 cleanup / resolve 把失败项伪装成可发送材料。
- 失败展示应通过接入面通知能力完成，例如 `InputController` 暴露材料采集诊断回调，REPL 用现有 writer / screen 打出非发送历史的 warning。不要把诊断文案塞进用户 draft。
- 该方案经得起未来扩展：音频、视频、网页快照、富文本等批量材料都可能部分失败，统一的“部分成功 + 结构化诊断”比每种材料单独打补丁更稳定。

**最优修复方向**：

- 将 `materialTokensFromPastedPaths()` 替换或升级为 `ingestPastedMaterials()`，返回判别联合，而不是 `string | null`：
  - `not-material`：整段粘贴不应按材料处理，调用方继续走普通文本粘贴 / 长粘贴折叠。
  - `ingested`：返回 `insertText` 与 `diagnostics`。`insertText` 只包含成功 material chip 与明确普通说明文字；`diagnostics` 记录失败路径、失败原因、原始行。
- 将路径识别拆成两层：
  - 行级规范化：处理 CRLF、首尾空白、整行引号、拖拽产生的多行路径。
  - 行级分类：已存在普通文件 -> material；明确路径形态但不存在 / 是目录 -> diagnostic；不像路径的行 -> text。
- 普通文本误判防线：
  - 如果没有任何 material，也没有明确路径形态失败项，则返回 `not-material`。
  - 如果至少有一个 material，则允许同批次中的普通说明文字作为 text 保留，并让明确路径失败项进入 diagnostics。
  - 如果全部行都是明确路径形态但全部失败，则返回 `ingested`，`insertText` 为空，diagnostics 告知未添加材料。
- `finalizePaste()` 消费新结果：
  - `not-material`：保持现有文本粘贴逻辑，包括二次长粘贴替换文本 token。
  - `ingested`：先按现有规则清理旧文本 paste token，保留已有 material chip；再插入 `insertText`；然后发送 diagnostics；不触发文本长粘贴折叠。
- 诊断展示走接入面通知，不进入用户正文。CLI 可在 scroll 区打印一条 warning，例如“未添加 1 个材料：./missing.png -> 文件不存在”，多项时做数量摘要并列出可读项；输入区只保留成功 chip 与用户原本的普通说明文字。
- 不新增“失败 material chip”作为第一选择。失败 chip 会引入新的原子编辑、提交阻断、history 保活和解析规则；当前问题只需要结构化诊断即可达到产品目标，避免制造新的 handle 债务。

**边界行为**：

- `a.png`、`b.jpg` 都有效：输入区出现两个 image chip。
- `a.png` 有效、`./missing.png` 不存在：输入区保留 `a.png` 的 image chip，`./missing.png` 不进入正文，CLI 提示该路径不存在。
- `a.png` 有效、`missing.png` 不存在：输入区保留 `a.png` 的 image chip，同时保留 `missing.png` 作为普通文本，不提示材料失败。
- `notes.txt` 有效、`folder/` 是目录：`notes.txt` 生成 file chip，目录项明确提示“不是普通文件”。
- `请看这张图\nshot.png\n谢谢`：说明文字保留为 text，`shot.png` 生成 image chip，顺序与粘贴一致。
- `./missing.png`、绝对路径或 UNC 路径单独粘贴且不存在：不插入正文，提示文件不存在；用户可修正后重新粘贴。
- `missing.png` 单独粘贴且不存在：按普通文本处理，因为它只是弱候选，不足以证明用户要添加材料。
- 粘贴代码 / 日志中包含类似路径的片段但整体不是路径集合：继续作为文本处理。
- Windows 带引号路径、空格路径、拖拽产生的多行路径仍应按现有路径解析规则进入同一批量流程。

**验收标准**：

- 补 `input-material.test.ts`：覆盖 `not-material`、全成功、部分成功、全部明确路径失败、材料 + 普通说明文字混排；断言部分失败不再整批 `null`，成功项已注册，失败项有结构化 diagnostic。
- 补 `typeahead-input.test.ts`：部分有效 / 部分强路径失败粘贴后，有效材料 chip 保留，强路径失败不出现在 draft，诊断回调可见，普通文本仍不误识别。
- 补弱候选回归：真实材料 + 缺失无前缀候选时，候选行保留为普通文本，不进 diagnostics。
- 补提交路径回归：部分失败后提交只包含成功材料与用户说明文字；失败诊断不会作为正文发送给 core，也不会写成用户已发送历史。
- 补全失败路径回归：单个明确不存在路径粘贴时不产生材料 chip、不写正文、给出诊断，原有草稿不被破坏。
- 保留第 8 个问题回归：后续任意粘贴仍不删除已有 material chip。

**修复记录**：

- `input-material-ingest.ts` 新增 `ingestPastedMaterials()`，把材料粘贴采集结果升级为 `not-material` / `ingested` 判别联合；`ingested` 同时返回 `insertText` 与结构化 `diagnostics`，旧的二值 token 返回接口已移除。
- 路径行处理拆成规范化、路径形态判断、文件 stat、材料注册四步；普通文本、URL、普通引用文本不会被误判为失败材料路径。
- 部分成功时只登记成功材料，失败项不进入 `InputMaterialRegistry`、不插入用户 draft；材料 + 普通说明文字按粘贴顺序保留。
- `InputController.finalizePaste()` 改为消费结构化 ingest 结果：材料批次不触发文本长粘贴折叠；已有材料 chip 继续保留；全失败且无可插入内容时不破坏已有草稿。
- `InputController` 增加材料采集诊断回调，REPL 将诊断显示为独立 warning，不把错误提示写进用户正文或已发送历史。
- `input-material.test.ts` 补充普通 URL、普通引用文本、部分失败、全部失败、目录失败、说明文字 + 材料混排测试；`typeahead-input.test.ts` 补充部分失败、全失败不污染草稿、说明文字 + 材料有序提交集成测试。

**验证命令**：

```bash
pnpm --filter @zhixing/cli exec tsc --noEmit && pnpm --filter @zhixing/cli exec vitest run src/__tests__/input-material.test.ts src/__tests__/typeahead-input.test.ts
pnpm --filter @zhixing/cli test
pnpm cli:build
```

结果：CLI 类型检查通过；定向 2 个测试文件、78 个测试通过；CLI 全量 140 个测试文件、2115 个测试通过；CLI 构建成功。

### 11. material chip 缺少来源边界，`@file` / 普通文本同形字符串会被当附件解析

**状态**：已修复，已测试，已构建

**现象**：用户输入、`@file:` 展开正文、日志或代码里只要出现 `[Image #N ...]` / `[File #N ...]` 这种与 material chip 同形的普通文本，并且当前 session 的 `InputMaterialRegistry` 中存在同 id 材料，提交准备链路就会把这段普通文本当作真实附件解析。`@file` 是最确定触发面：文件正文里出现 chip 字面量时，正文会被切成 `text + image + text`；若对应材料源文件不可读，还会错误阻断一次本应只是普通文本的提交。

**审核结论**：问题真实，根因是 material chip 的“显示字符串”和“语义引用”没有来源边界。它不是 `@file` 读取能力问题，也不是 material registry 生命周期问题；真正问题是 `prepareUserTurnInput()` 把 `@file` 展开后的整段字符串继续交给 `resolveInputMaterials()` 扫描，而 `resolveInputMaterials()` 只按 regex + id 解析，不知道 match 来自输入区真实 handle、用户手写普通文本，还是外部文件正文。

**事实证据**：

- `user-turn-input.ts` 中 `prepareUserTurnInput()` 当前顺序是：先调用 `resolveFileRefs()` 得到 `refResult.text`，再调用 `resolveInputMaterials(refResult.text, materialRegistry)`。
- `input-material-resolve.ts` 的 `resolveInputMaterials()` 在整段字符串上 `matchAll(createMaterialTokenPattern())`，只取 token id 查 registry；它没有来源信息，也不校验 token 里的 `Image` / `File` 标签是否与 registry entry 类型一致。
- 最小观测 1：registry 里有 id=1 的 image 时，直接提交普通文本 `[Image #1 · arbitrary literal]`，结果是 `image` part，而不是 text。
- 最小观测 2：提交普通文本 `[File #1 · arbitrary literal]`，即使 label 是 `File`，只要 registry 的 #1 是 image，结果仍是 `image` part。
- 最小观测 3：让 `resolveRefs` 返回 `<file>...\n[Image #1 · arbitrary literal]\n</file>`，结果变成 `text + image + text`；未知 id（如 `#999`）才会保留为普通 text。
- 现有 `user-turn-input.test.ts` 只覆盖普通正文、空白输入、`@file` 周围空白保真；`input-material.test.ts` 只覆盖真实 chip 解析，没有覆盖同形普通文本 / `@file` 展开文本不应二次解析的边界。

**背后需求**：

- material chip 是输入区 UI handle，不是用户正文语法。用户和文件内容里出现相同字面量时，默认必须按普通文本保真。
- 只有系统通过材料采集能力创建并留在当前输入语义中的 handle，才能转换为结构化材料 part。
- `@file` 是正文增强：它把文件正文作为 text 交给 agent。文件正文不能因为恰好长得像 CLI chip，就越权变成附件。
- 用户不需要理解 registry id、chip 格式或 session 生命周期。系统必须保护“UI 显示”和“语义输入”的边界。

**目标效果**：

- 输入区真实 material chip 提交后仍解析为结构化 `UserTurnInput.parts`。
- `@file` 展开的文件正文即使包含 `[Image #1 ...]` / `[File #1 ...]` 字面量，也保留在 text part 中，不变成材料、不触发材料读取错误。
- 普通手写 / 粘贴文本中的同形 chip 字面量不应因为 registry 中有同 id entry 就自动变成附件；至少不能让 `@file` 等系统生成的新 text 被二次扫描成附件。
- 同一条输入里同时有真实 material chip 与 `@file` 引用时，真实 chip 解析为 image / file 能力；`@file` 正文保持 text；顺序稳定。
- `PreparedUserTurnInput.text` 继续作为“文本投影”保留 `@file` 展开结果与 material chip 显示字符串；真正发送给 core 的是 `input.parts`。scrollback echo 仍由 deferred commit 写用户原始输入，不因本问题展开 `@file` 正文。

**架构判断**：

- 最优边界不是扩大 regex 黑名单，也不是在 `@file` 内容里转义 `[Image #...]`。这些都是文本补丁，会继续让未来音频、视频、网页快照等 handle 重复踩坑。
- 正确抽象是“来源感知的提交准备管线”：把原始输入先切成有来源的片段，再对不同来源执行不同转换。真实 handle 片段走材料解析；text 片段走 `@file` 展开；`@file` 生成的新 text 不再进入 material scanner。
- 当前 `InputBuffer` 仍是字符串模型，短期可以先在 `prepareUserTurnInput()` 内建立提交期 segment pipeline，解决 `@file` / 生成文本二次解析；长期最优形态是输入 composer 内部升级为 text segment + handle segment，这样手写同形 token 也天然只是 text，不再依赖显示字符串承担语义引用。
- 为避免未来返工，本轮修复应把 material 解析能力从“扫描整段字符串”收束为“解析已识别的 handle 片段”。即使暂时仍从原始 draft token 化出 handle 片段，也要让 API 形态朝结构化 composer 兼容。

**最优修复方向**：

- 在 `user-turn-input.ts` 引入提交期片段模型，例如：
  - `text`：来自用户原始文本或 `@file` 展开的文本。
  - `material-handle`：来自原始输入中识别出的 material chip 片段。
- `prepareUserTurnInput()` 改为来源感知流程：
  1. 在原始 input 上先按 material token 切分成有序片段，不对后续生成文本再次扫描 material token。
  2. 对 `text` 片段分别执行 `resolveFileRefs()`；累计 `resolvedFiles` / `errors`，并把展开后的内容作为 text part 候选。
  3. 对 `material-handle` 片段按 id 查 registry；未知 id 或类型标签不匹配时保留为 text，避免伪 token 越权解析。
  4. 对真实材料 entry 调用共享的 material resolve 能力，把 image 转成 image part，把文本文件转成带来源的 text part，把不可发送材料返回 errors。
  5. 最后合并相邻 text part，保持用户输入顺序。
- 重构 `input-material-resolve.ts`：保留“解析一段 draft 中 material token”的兼容函数给旧测试使用，但内部应拆出“解析单个 material handle / entry”的函数，供新的 segment pipeline 直接调用。避免新代码继续依赖整段字符串二次扫描。
- `PreparedUserTurnInput.text` 的生成规则：拼接所有 text 片段的 `@file` 展开结果和原始 material chip 显示字符串，保持现有调试 / 测试语义；不要用它作为 source of truth 去反推材料。
- REPL 的 deferred 提交流程不变：准备成功并被核心接收后才 commit；准备失败仍 reject，scrollback 不写假历史。

**不采用的方案**：

- 不采用“让 `@file` 展开时转义 `[Image #...]`”：这会把 CLI UI token 泄漏进文件正文处理规则，未来每种 handle 都要补一遍。
- 不采用“要求 material token 详情完全匹配 registry.format(id)”作为主方案：宽度预算会产生多个合法展示形态，且复制出来的真实 chip 仍可能混入普通文本，无法解决来源问题。
- 不采用“把 `@file` 放到 material 解析之后再跑整段文本”：这会让 material 生成的文本文件内容再次被 `@file` 解析，制造新的二次转换污染。

**验收标准**：

- 补 `user-turn-input.test.ts`：`@file` 展开正文包含活着的 image chip 字面量时，结果仍是 text part，不产生 image part，不产生材料读取错误。
- 补组合测试：真实 material chip + `@file` 引用同时存在时，真实 chip 解析为 image；`@file` 正文中的 chip 字面量保留为 text；顺序正确。
- 补同形普通文本测试：`[Image #1 · arbitrary literal]` / `[File #1 · arbitrary literal]` 不应仅凭 registry 同 id 就解析为材料；如果当前阶段受字符串 composer 限制无法完全关闭，必须至少通过类型标签校验与来源分段锁住 `@file` / 生成文本边界，并在后续结构化 composer 中彻底消除。
- 补未知 id / 类型标签不匹配测试：未知 id 保留 text；label 与 registry entry kind 不一致时保留 text。
- 保留现有真实材料提交测试：输入区真实 image chip 仍解析为 image part；文本文件 chip 仍解析为带来源的 text part；材料读取错误仍能阻断提交且不写 scrollback。

**修复记录**：

- `input-material-resolve.ts` 拆出 `resolveInputMaterialToken()`，把“解析可信 material handle”从“扫描整段字符串”中分离出来。
- `InputMaterialRegistry` 记录自身实际格式化过的 chip 字符串；material 解析必须同时满足 registry id 存在、label 与 entry 类型一致、token 是 registry 生成过的显示 token，避免普通同形文本仅凭 id 越权解析。
- `user-turn-input.ts` 改为来源感知提交期分段：先在原始 input 上切出 text / material-handle 片段；仅 text 片段执行 `@file` 展开；`@file` 生成的新文本不再二次扫描 material chip。
- `PreparedUserTurnInput.text` 保持文本投影：text 片段使用 `@file` 展开结果，material handle 片段保留原 chip 显示字符串；core payload 以 `input.parts` 为准。
- `user-turn-input.test.ts` 补充回归：`@file` 展开正文里的 chip 字面量保持 text；真实 chip + `@file` 混排按来源分别处理；label 不匹配、未由 registry 格式化过的同 id chip 字面量保持 text。

**验证命令**：

```bash
pnpm --filter @zhixing/cli exec tsc --noEmit && pnpm --filter @zhixing/cli exec vitest run src/__tests__/user-turn-input.test.ts src/__tests__/input-material.test.ts src/__tests__/typeahead-input.test.ts
pnpm --filter @zhixing/cli test
pnpm cli:build
```

结果：CLI 类型检查通过；定向 3 个测试文件、85 个测试通过；CLI 全量 140 个测试文件、2119 个测试通过；CLI 构建成功。

### 12. 粘贴含斜杠的普通多行文本 / 代码会被材料采集静默吞行

**状态**：主问题与失败方向补充边界已修复，已测试，已构建；弱候选成功误采集已拆为第 13 个问题待处理

**现象**：用户粘贴普通多行文本或代码时，只要某些行包含 `/` 或 `\`，当前材料采集会把这些行误判为明确路径。`statSync` 失败后，这些行只进入 diagnostics，不回到输出文本，导致用户输入被静默删行；同时本次粘贴被标记为 `ingested`，绕过文本长粘贴折叠。

**审核结论**：问题真实，是第 10 个问题修复后引入的高频回归。第 10 个问题要解决“真实材料批次部分失败不能整批退化”，但当前实现把“任意含斜杠行”当成材料失败项，破坏了“粘贴代码 / 日志必须保真”这个更基础的主路径需求。它不是 `finalizePaste()` 的折叠策略错误；`finalizePaste()` 只是忠实执行 `ingestPastedMaterials()` 的错误分类结果。

**事实证据**：

- `input-material-ingest.ts` 对每个非空行执行 `resolvePastedPath()` + `fs.statSync()`。
- `isExplicitPathLike()` 当前把任意 `/` 或 `\` 判为明确路径信号，而且这个判断早于“未加引号且含空白则不像路径”的防线。
- `finalizePaste()` 只要收到 `kind: "ingested"` 就设置 `shouldFold=false`，因此误分类会同时造成删行和绕过长文本折叠。
- 本轮临时探针直接调用生产函数得到以下事实：
  - 代码块 `return a / b;` 与 `// see src/main.ts` 两行被删除，并产生两条“文件不存在或不可读取”诊断。
  - `hello\nfoo/bar\nbye` 被改成 `hello\nbye`，`foo/bar` 被删除。
  - `import x from "./foo/bar";` 被整行删除。
  - `2026/06/22` 被整行删除。
  - `https://example.com/shot.png` 因 URL 排除规则返回 `not-material`，没有中招。
  - `./missing.png` 与 `missing.png` 当前都会返回 `ingested` + 诊断；其中 `./missing.png` 是强路径意图，`missing.png` 只是弱候选，不应和强路径同级。
- 最小观测输入：

```text
function f() {
  return a / b;
}
// see src/main.ts
const x = 1;
```

当前 `ingestPastedMaterials()` 返回：

```text
function f() {
}
const x = 1;
```

并产生两条“文件不存在或不可读取”诊断，registry size 为 0。

**背后需求**：

- CLI 面向 agent 的最高频工作流之一就是粘贴代码、日志、路径片段和错误堆栈。普通文本保真优先级高于路径粘贴的启发式便利。
- 材料采集只能在用户意图足够明确时接管输入。启发式不确定时必须回退为普通文本，不能删行、不能误报、不能绕过长粘贴折叠。
- 同时仍要保留第 10 个问题的产品目标：当用户确实在粘贴一批材料路径，成功材料应保留；明确路径失败项应提示；弱候选失败项必须文本保真。
- 用户不应学习“哪些斜杠会触发附件模式”。产品本质是：真实文件材料路径被增强为附件；普通文本无论长得多像路径都必须保真。

**目标效果**：

- 粘贴代码、日志、日期、URL、注释、除法表达式、import 语句等普通文本时，内容完整保留，并按长文本规则折叠或展开。
- 没有任何真实材料被识别、且没有强路径意图失败时，本次粘贴必须返回 `not-material`，让文本粘贴路径处理，不能产生材料诊断。
- 至少识别出一个真实材料时，同批次里的强路径失败可以诊断；弱候选失败行继续保留为普通文本。
- 明确本地路径意图失败时可以诊断，例如绝对路径、`~/...`、`./...`、`../...`、Windows 盘符、UNC 路径；但 `foo/bar`、`missing.png`、`src/main.ts` 这类无显式前缀的相对片段在没有任何成功材料时必须回退为普通文本。
- 如果一批粘贴里已有成功材料，无显式前缀的候选路径失败时仍按普通文本保留，不因本批存在材料而升级为错误；候选路径成功时自动采集的旧取舍已由第 13 个问题修订。

**架构判断**：

- 最优解是把材料采集拆成“路径意图分类”和“材料注册”两个阶段，而不是在 `statSync` 异常分支里直接决定吞行。
- 路径意图至少分为三类：强路径、候选路径、普通文本。强路径可以独立触发失败诊断；候选路径失败时回退文本；普通文本永远保留。候选路径成功时自动采集的语义已由第 13 个问题废弃。
- “是否是材料批次”不能由失败项单独决定，必须由真实 material 成功或强路径失败决定。这样既保留材料批量能力，又把不确定启发式的风险还给文本保真。
- 不应把修复放在 `finalizePaste()` 里做兜底，因为它已经拿不到逐行路径意图，只能看到 `ingested/not-material`。正确边界在 `input-material-ingest.ts`。

**最优修复方向**：

- 在 `input-material-ingest.ts` 内引入明确的数据结构，例如 `ParsedMaterialLine` / `PathIntent`：
  - `text`：普通文本，永远原样进入 `outputLines`。
  - `candidate-path`：弱路径候选，如无前缀相对路径、带扩展名文件名；失败时原样保留为文本，不诊断、不移除。成功时自动注册为材料的旧取舍已由第 13 个问题修订。
  - `strong-path`：显式本地路径意图，如绝对路径、home、显式相对路径、Windows 盘符、UNC；失败可诊断。
- 两阶段处理：
  1. 先逐行 trim / unquote / classify，不在分类阶段吞行。
  2. 第 12 个主修复曾对 `candidate-path` 和 `strong-path` 尝试 stat / register；第 13 个问题将采集边界进一步收敛为只处理 `strong-path`。
  3. 再根据全局批次事实生成输出：是否存在成功 material、是否存在强路径失败。
- 收紧路径启发式：
  - URL 明确不是本地材料路径。
  - 未加引号且包含普通空白的行默认是文本，除非整行就是强路径形态。
  - 单纯包含 `/` 或 `\` 只能算候选路径，不能单独触发吞行。
  - 扩展名只能提供候选信号；无成功材料、无强路径形态时，`missing.png` 应保留为普通文本。
  - 带引号本身不等于路径；只有被引号包裹后内容仍满足强路径或候选路径规则时才参与材料采集。
- 返回策略：
  - 有成功 material：返回 `ingested`，成功项替换为 chip；普通文本保留；强路径失败项诊断并移除；候选路径失败项原样保留。成功 material 的来源边界以第 13 个问题修订后的 `strong-path` 为准。
  - 无成功 material、但存在强路径失败：返回 `ingested`，诊断强路径失败；普通文本保留；若没有可插入文本则 `insertText=""`，沿用“明确材料路径全部失败不污染草稿”的语义。
  - 无成功 material、且只有候选路径失败或普通文本：返回 `not-material`，完整交给文本粘贴逻辑。
- 保持 `finalizePaste()` 的现有分层：`not-material` 才进入文本折叠；`ingested` 不触发文本长粘贴折叠。修复后它会自然得到正确分类。

**不采用的方案**：

- 不采用“把 `/[\\/]` 改成更复杂的单个正则”：正则只能继续堆特例，无法表达“候选路径成功时增强、失败时保真”的产品语义。
- 不采用“无成功材料时全部回退文本”：这会让 `./missing.png`、绝对路径、UNC 等明确材料意图失去即时诊断，破坏第 10 个问题的全失败 UX。
- 不采用“在 `finalizePaste()` 里发现 registry size 没变就回退文本”：它无法区分强路径失败和普通文本误判，也无法正确保留混合批次中的说明文字。

**验收标准**：

- 补 `input-material.test.ts`：粘贴含 `return a / b;`、`// see src/main.ts`、`hello\nfoo/bar\nbye` 的普通文本时返回 `not-material`，registry 为空，无 diagnostics。
- 补 `input-material.test.ts`：`import x from "./foo/bar";`、`2026/06/22`、URL 都返回 `not-material`。
- 补 `input-material.test.ts`：`missing.png` 这种无显式前缀候选在无成功材料时返回 `not-material`；`./missing.png`、绝对路径、UNC 等强路径失败仍返回诊断。
- 补 `input-material.test.ts`：有效材料 + 候选缺失路径保留成功 chip，同时把候选缺失行作为普通文本保留；说明文字行完整保留且顺序稳定。
- 补 `typeahead-input.test.ts`：粘贴上述代码块时输入区不丢行；达到长粘贴阈值时仍按文本 paste token 折叠，提交后原文完整。
- 保留第 10 个问题回归：有效材料 + 强路径缺失仍保留成功 chip 并提示失败项；明确材料路径全部失败不污染已有草稿。

**修复记录**：

> 以下为第 12 个主问题的上一轮修复记录。该修复解决了“无成功材料时普通含斜杠文本被吞”的主路径；其中“有成功材料时 candidate-path 失败参与诊断并移除”的语义，已被下方补充问题判定为残留边界，后续修复应以补充问题的目标效果为准。

- `input-material-ingest.ts` 把材料采集从“逐行 stat 失败即吞行”改为“路径意图分类 + 批次判定”：
  - `text`：普通文本直接保留，不参与文件 stat。
  - `candidate-path`：无显式前缀的相对路径片段或带扩展名文件名；上一轮实现中成功识别真实文件时变成材料，失败只在本批已有成功材料时诊断。该成功采集语义已由第 13 个问题修订。
  - `strong-path`：绝对路径、home、显式相对路径、Windows 盘符、UNC；失败可独立诊断。
- `ingestPastedMaterials()` 先处理所有行得到 material / failure / text，再根据整批是否存在成功材料或强路径失败决定 `not-material` / `ingested`，避免单个弱候选失败把普通文本粘贴升级成材料模式。
- 上一轮保留第 10 个问题语义：真实材料 + 缺失候选路径仍保留成功 chip 并提示失败；明确路径全部失败仍不污染已有草稿。该候选失败语义已由下方补充问题修订。
- `input-material.test.ts` 补充普通代码、`foo/bar`、import、日期、URL、无前缀缺失文件名、候选路径随成功材料诊断等回归。候选路径随成功材料诊断这一回归需按补充问题改为“候选失败行保留为文本”。
- `typeahead-input.test.ts` 补充输入区真实链路：粘贴含斜杠代码不触发材料采集，仍按长文本折叠，提交后原文完整。

**验证命令**：

```bash
pnpm --filter @zhixing/cli exec tsc --noEmit && pnpm --filter @zhixing/cli exec vitest run src/__tests__/input-material.test.ts src/__tests__/typeahead-input.test.ts
pnpm --filter @zhixing/cli test
pnpm cli:build
```

结果：CLI 类型检查通过；定向 2 个测试文件、82 个测试通过；CLI 全量 140 个测试文件、2123 个测试通过；CLI 构建成功。

**补充问题：材料批次里的弱候选路径失败仍会吞普通文本行**

**状态**：已修复，已验证，已构建

**现象**：同一次粘贴里只要已有真实材料，当前实现会把其它 `candidate-path` 失败行当作“材料路径打错”处理，只进入 diagnostics，不回写到输入区。结果是普通文本行静默消失。

**最小复现**：

```text
shot.png
foo/bar
bye
```

当 `workspaceRoot/shot.png` 真实存在时，当前输入区会变成：

```text
[Image #1 · shot.png · 2x3 · 24B]
bye
```

`foo/bar` 被删除，并产生“文件不存在或不可读取”诊断。类似场景还包括 `shot.png + TODO/FIXME + bye`、`请看 + shot.png + a/b + 谢谢`、`notes.md + config.json + 收尾`。

**事实证据**：

- `classifyPathIntent()` 当前把 `foo/bar`、`TODO/FIXME`、`config.json` 归为 `candidate-path`。
- 修复前 `ingestPastedMaterials()` 的归并条件是 `line.intent === "strong-path" || hasMaterial`；只要同批已有成功材料，candidate failure 就会进入 diagnostics，不会进入 `outputLines`。
- 本轮直接调用生产函数验证：
  - `shot.png\nfoo/bar\nbye` 返回 `insertText = "[Image ...]\nbye"`，diagnostics 包含 `foo/bar`。
  - `shot.png\nTODO/FIXME\nbye` 返回 `insertText = "[Image ...]\nbye"`，diagnostics 包含 `TODO/FIXME`。
  - `shot.png\nconfig.json\nbye` 返回 `insertText = "[Image ...]\nbye"`，diagnostics 包含 `config.json`。
  - `shot.png\n./missing.png\nbye` 返回 `insertText = "[Image ...]\nbye"`，diagnostics 包含 `./missing.png`；这是强路径失败，属于应保留的诊断语义。
- 修复前测试盲区：已有“说明文字 + 材料”的测试只用了 `请看这张图`、`谢谢` 这类 `text` 行；已有“含斜杠普通文本”的测试没有同批成功材料。因此没有覆盖“真实材料 + 弱候选失败文本行”的组合。

**审核结论**：问题真实，是第 12 个问题的残留边界，不是新的架构问题。第 12 个问题已经修复了“无成功材料时普通含斜杠文本被吞”的主路径，但上一版取舍仍允许“有成功材料时弱候选失败被吞”。这仍违反“普通文本保真优先”的产品本质。

**根因**：

- `classifyPathIntent()` 会把无显式前缀但含 `/`、`\` 或扩展名的无空格行分类为 `candidate-path`。
- `ingestPastedMaterials()` 修复前在 `hasMaterial === true` 时，把所有 `candidate-path` failure 放进 diagnostics，而不是回写原始文本。
- 这个规则本意是保留“材料批次中相对路径打错也能提示”的体验，但 `candidate-path` 天然模糊，无法可靠区分“打错的材料路径”和“普通短文本”。

**背后需求**：

- 粘贴是用户输入正文的高频主路径，任何启发式增强都不能静默丢文本。
- 真实材料识别成功后，可以增强那一行；但其它不确定行必须保真，不能因为同批里有材料就提高吞行权限。
- 相对路径打错的即时提示是次级体验；文本保真是底线体验。

**目标效果**：

- 成功识别的材料继续替换为 chip，并保持图文顺序。
- 普通文本行即使长得像相对路径，只要不是强路径意图，失败时都原样保留。
- `strong-path` 失败仍可诊断并不插入，例如绝对路径、`~/...`、`./...`、`../...`、Windows 盘符、UNC 路径。
- `candidate-path` 失败时不诊断、不移除，回退为普通文本；成功方向的自动采集已由第 13 个问题重新审查。
- 该结论覆盖上一版第 12 个问题里“本批已有成功材料时 candidate-path 失败参与诊断并移除”的旧取舍。

**非目标 / 保留取舍**：

- 第 12 个补充修复只处理弱候选失败方向；“存在的无前缀候选文件名自动注册为材料”的旧取舍已被第 13 个问题重新判定为缺陷，不再作为长期产品语义保留。
- 不新增“candidate-path 失败但已保留为文本”的 warning。当前诊断文案语义是“材料未添加”，如果文本已保留，继续告警会制造噪音和误解。
- 不引入失败 chip。失败 chip 会扩大 handle 生命周期、原子编辑、提交阻断和解析规则，超出本问题需要。

**最优修复方向**：

- 保持 `text / candidate-path / strong-path` 三档分类，不退回正则堆特例。
- 调整输出归并规则：
  - `material`：输出 chip。
  - `text`：输出原文。
  - `failure + strong-path`：输出诊断，不写入草稿。
  - `failure + candidate-path`：输出原文，不诊断。
- `hasMaterial` 只决定本批是否进入 `ingested`，不再赋予 candidate failure 吞文本的权限。
- 更新第 10 个问题相关验收：真实材料 + 缺失的无显式前缀候选路径，应保留成功 chip，同时把失败候选行作为普通文本保留；若用户需要明确表达材料路径失败，应使用强路径形态。

**验收标准**：

- 补 `input-material.test.ts`：`shot.png\nfoo/bar\nbye` 中 `shot.png` 存在时，结果包含 image chip、`foo/bar`、`bye`，diagnostics 为空。
- 补 `input-material.test.ts`：真实材料 + `TODO/FIXME`、真实材料 + `config.json` 缺失时，弱候选失败行保留为文本。
- 补 `input-material.test.ts`：真实材料 + `./missing.png` 仍诊断并移除强路径失败。
- 补 `typeahead-input.test.ts`：CLI 输入区粘贴“材料 + 含斜杠说明行 + 普通结尾”不丢行，提交后的 `prepareUserTurnInput()` 保持 text/image/text 顺序。
- 保留第 12 个问题主回归：无成功材料的含斜杠代码 / import / 日期 / URL 仍按普通文本处理。

**修复记录**：

- `input-material-ingest.ts` 将失败行归并收敛到唯一稳定规则：只有 `strong-path` 失败进入 diagnostics 并不写入草稿；`candidate-path` 失败一律回写原文，不诊断、不吞行。
- `hasMaterial` 只保留“本批是否进入材料摄取结果”的职责，不再参与决定弱候选失败是否可删除用户文本。
- `input-material.test.ts` 补齐真实材料 + 缺失弱候选文件名、真实材料 + 含斜杠弱候选文本、真实材料 + 明确强路径失败三类回归。
- `typeahead-input.test.ts` 补齐 CLI 输入链路回归：材料 + `a/b` 说明行 + 普通结尾在输入区保真，提交后仍解析为 text/image/text 有序 parts。

**验证命令**：

```bash
pnpm --filter @zhixing/cli exec tsc --noEmit && pnpm --filter @zhixing/cli exec vitest run src/__tests__/input-material.test.ts src/__tests__/typeahead-input.test.ts
pnpm --filter @zhixing/cli test
pnpm cli:build
```

结果：CLI 类型检查通过；定向 2 个测试文件、85 个测试通过；CLI 全量 140 个测试文件、2126 个测试通过；CLI 构建成功。

### 13. 弱候选路径成功时会静默采集同名文件并污染上下文

**状态**：已修复，已测试，已构建

**后续边界说明**：本问题只收敛弱候选路径，不再让裸文件名 / 裸相对片段自动采集材料。本节中关于 strong-path 仍按材料路径处理的描述，是第 13 阶段为保留既有路径粘贴能力做出的过渡边界；第 14 个问题已继续把 strong-path 从“单行形态即意图”收敛为“本次粘贴批次级材料意图”。

**现象**：用户粘贴普通文本、文件清单或笔记时，如果某一行恰好是当前工作目录下存在的无前缀候选文件名，CLI 会把这一行静默替换成 material chip；提交后 `prepareUserTurnInput()` 会把文件内容注入 agent payload。用户原本只是写了 `package.json` / `tsconfig.json` 这样的文本，却实际把本地文件全文交给了 agent。

**最小复现**：

```text
package.json
tsconfig.json
```

当 `workspaceRoot` 下两个文件真实存在时，当前输入区会显示两个 `[File #N · ...]` chip；提交后下游解析为两个 `<file path="...">...</file>` text part。

另一个高频复现：

```text
本周计划
package.json
记得测试
```

当前中间一行会被采集为文件材料，最终 prompt 中静默混入 `package.json` 全文。

**事实证据**：

- `classifyPathIntent()` 会把无空白、带扩展名的 `package.json` / `tsconfig.json` 分类为 `candidate-path`。
- `processMaterialLine()` 对 `candidate-path` 和 `strong-path` 都执行 `statSync`；只要文件存在且是普通文件，就注册到 `InputMaterialRegistry` 并输出 material chip。
- `resolveInputMaterialToken()` 对 text-like 文件会读取全文，并注入为 `<file path="...">...</file>` text part。
- 第 12 个补充修复只修复了 `candidate-path` 失败时吞文本；成功方向仍按“文件存在即材料意图”处理。
- 本轮直接调用生产函数验证：
  - `package.json\ntsconfig.json` 在两个文件真实存在时返回 `ingested`，输入区文本变成两个 `[File #N ...]` chip，registry size 为 2。
  - `本周计划\npackage.json\n记得测试` 在 `package.json` 真实存在时返回 `ingested`，中间行被替换成 `[File #1 ...]` chip。
  - 对上述 chip 调 `prepareUserTurnInput()` 后，text part 中出现 `<file path=".../package.json">...</file>`，证明文件内容会进入 agent payload。
  - `./package.json\n./missing.json` 仍表现为强路径语义：成功项生成 chip，失败项进入 diagnostics。这是应保留的明确材料路径行为。

**审核结论**：问题真实，是第 12 个问题同源启发式的反方向残留，也是第 5 个结构化材料输入的产品语义漏洞。第 12 个补充问题已经证明 `candidate-path` 的失败不能证明用户材料意图；同理，文件恰好存在也不能证明用户材料意图。上一版“存在的无前缀候选文件名自动注册为材料”的便利性取舍应推翻。

**根因**：

- `candidate-path` 本质是模糊信号：它既可能是用户要添加的相对路径，也可能是文件清单、讨论文本、笔记、代码片段或命令输出。
- 当前实现用“文件存在”替代“用户明确意图”，把本地文件读取和 agent payload 注入建立在启发式上。
- 失败方向的问题可见为丢行；成功方向的问题更隐蔽，表现为上下文污染、token 浪费，以及把用户未明确交付的本地文件内容读入本轮输入。

**背后需求**：

- 任何会读取本地文件并交付给 agent 的能力，都必须要求足够明确的用户意图。
- 粘贴正文保真优先于路径便利。裸文件名、裸相对片段、文件清单行默认是正文，不应因为本地恰好存在同名文件而改变语义。
- CLI 可以支持“粘贴路径添加材料”，但触发材料采集的路径形态必须是强路径信号，例如 `./x`、`../x`、`~/x`、绝对路径、Windows 盘符或 UNC。

**目标效果**：

- 粘贴 `package.json`、`tsconfig.json`、`README.md`、`src/main.ts` 等无显式前缀文本时，即使文件存在，也按普通文本保留，不生成 chip、不读取文件、不注入 payload。
- 粘贴文件清单、目录树、笔记、讨论内容时，内容必须保真。
- 粘贴 `./package.json`、`../a.txt`、`~/image.png`、绝对路径、Windows 盘符路径、UNC 路径时，仍按材料路径处理：成功生成 chip，失败给诊断。
- 混合粘贴中，强路径成功可生成材料；同批的裸候选文件名仍保留为普通文本，不被升级为材料。

**产品 / 架构判断**：

- 顶级产品语义应以“用户明确交付什么”为中心。裸文件名是正文，不是附件授权；文件恰好存在只是环境事实，不是用户意图。
- 对智能体输入而言，静默注入本地文件比显式报错更危险：它污染上下文、浪费 token，并可能把用户没有明确交付的材料送入本轮对话。
- `candidate-path` 的失败方向已经按文本保真处理；成功方向也必须对称。一个模糊信号不能因为文件存在就升级为读取本地文件的授权。
- 要求 `./`、`../`、`~/`、绝对路径、Windows 盘符或 UNC 作为材料路径信号，是稳定、可解释、可长期演进的产品边界。

**最优修复方向**：

- 收敛材料采集边界：只有 `strong-path` 进入 `stat / register / diagnostic` 流程；`candidate-path` 不再自动采集，按普通文本保留。
- 代码组织上不要保留可执行的 `candidate-path` 材料分支。最佳实现是把 `PathIntent` 收敛为 `text | strong-path`，或者让 `classifyPathIntent()` 对弱候选直接返回 `text`；避免未来维护者再次把弱候选接回 `stat / register`。
- `hasMaterial` 继续只由成功注册的强路径材料决定；强路径失败仍可让本批返回 `ingested` 并上报诊断，保持“明确材料路径全部失败不污染草稿”的语义。
- 不在 `prepareUserTurnInput()` 兜底拦截，因为到那里已经出现 chip，用户可见语义已经被改写。正确边界在 `input-material-ingest.ts` 的路径意图分类 / 采集阶段。
- `finalizePaste()` 不需要承载本问题逻辑。它只接收 `ingested / not-material` 结果，正确分层仍是材料摄取模块负责判断“是否有明确材料意图”。
- REPL / core / provider 不需要改。第 13 个问题只收敛 CLI 粘贴采集入口，不改变已经显式形成 material chip 之后的解析和发送契约。

**不采用的方案**：

- 不采用“只对常见文件名黑名单排除”：`package.json` 只是高频例子，任何存在的裸文件名都可能污染上下文。
- 不采用“candidate 成功时弹 warning”：采集已经改写输入语义，warning 无法消除静默注入风险，还会让普通笔记粘贴变吵。
- 不采用“先生成失败 / 待确认 chip”：这会扩大 handle 生命周期、提交阻断和交互复杂度；当前需求只需要用强路径表达明确意图。

**验收标准**：

- 补 `input-material.test.ts`：工作目录存在 `package.json`、`tsconfig.json` 时，粘贴 `package.json\ntsconfig.json` 返回 `not-material`，registry 为空。
- 补 `input-material.test.ts`：`本周计划\npackage.json\n记得测试` 在 `package.json` 存在时仍返回 `not-material`，原文完整保留。
- 补 `input-material.test.ts`：`./package.json` 存在时仍生成 file chip；`./missing.json` 不存在时仍返回诊断且不污染草稿。
- 补 `input-material.test.ts`：强路径材料 + 裸候选文件名混排时，强路径生成 chip，裸候选文件名保留为文本。
- 补 `input-material.test.ts`：裸 `src/main.ts` 即使真实存在也不生成材料；用户要添加它必须粘贴 `./src/main.ts`。
- 补 `typeahead-input.test.ts`：CLI 输入区粘贴裸 `package.json` 时不出现 `[File #]` chip，提交后 `prepareUserTurnInput()` 只产生 text part，不读取文件内容。
- 补 `typeahead-input.test.ts`：CLI 输入区粘贴 `./package.json` 时仍出现 file chip，提交后解析为文件 text part。

**修复记录**：

- `input-material-ingest.ts` 将 `PathIntent` 收敛为 `text | strong-path`，彻底移除可执行的 `candidate-path` 材料采集分支。
- `classifyPathIntent()` 对弱候选文本直接返回 `text`；裸文件名、裸相对片段、带扩展名文件名不再进入 `stat / register`。
- 强路径路径保持原语义：`./...`、`../...`、`~/...`、绝对路径、Windows 盘符和 UNC 仍可成功生成 material chip，失败仍返回 diagnostics。
- `input-material.test.ts` 补齐裸已存在文件名、普通笔记里的裸文件名、裸 `src/main.ts`、明确 `./package.json`、强路径 + 裸候选混排回归。
- `typeahead-input.test.ts` 补齐输入区真实链路：裸 `package.json` 不显示 `[File #]`，提交准备不读取文件；`./package.json` 仍显示 chip 并解析为文件 text part。

**定向验证命令**：

```bash
pnpm --filter @zhixing/cli exec tsc --noEmit && pnpm --filter @zhixing/cli exec vitest run src/__tests__/input-material.test.ts src/__tests__/typeahead-input.test.ts
```

结果：CLI 类型检查通过；定向 2 个测试文件、92 个测试通过。

**收尾验证命令**：

```bash
pnpm --filter @zhixing/cli test
pnpm cli:build
```

结果：CLI 全量 140 个测试文件、2133 个测试通过；CLI 构建成功。

### 14. strong-path 形态仍会把普通命令 / 日志误判为材料意图

**状态**：已修复，已测试，已构建

**现象**：第 13 个问题已移除 `candidate-path` 整档，裸文件名和裸相对片段默认保真为文本。但剩余的 `strong-path` 档仍把 `./...`、`../...`、`~/...`、绝对路径、Windows 盘符和 UNC 当作明确材料意图。这个公理在 CLI agent 的高频粘贴场景里不总成立：shell 命令、命令清单、构建日志、测试失败、堆栈和源码位置行里都会出现 strong-path 形态的普通文本。

**外部审查结论**：认可。外部审查指出，第 13 个问题把“路径形态是模糊信号”贯彻到弱候选，但没有审查 strong-path 的反例；这与本轮我发现的 `./src/main.ts:12` / `C:\...\main.ts:12` 被当作失败材料路径吞掉，是同一根因。它不是第 13 修复的回归，而是路径意图启发式家族最后一档尚未完成产品定性。

**事实证据**：

- `input-material-ingest.ts` 当前 `PathIntent` 已收敛为 `text | strong-path`，`classifyPathIntent()` 只要命中 `isStrongPathLike()` 就进入 `stat / register / diagnostic` 流程。
- `processMaterialLine()` 对 strong-path 失败返回 `failure`；`ingestPastedMaterials()` 对 failure 只加入 `diagnostics`，不把原始行放回 `outputLines`。
- `finalizePaste()` 收到 `kind: "ingested"` 后不会再走普通长文本折叠，所以 strong-path 误判会同时造成“删行”和“绕过折叠”。
- 本轮生产函数探针确认：
  - `先运行\n./missing-build.sh\n再看输出` 变成 `先运行\n再看输出`，`./missing-build.sh` 被删除并只进入诊断。
  - `先运行\n./build.sh\n再看输出` 在 `build.sh` 真实存在时变成 `先运行\n[File #1 · build.sh · ...]\n再看输出`，提交准备阶段会读取文件内容注入 agent payload。
  - `C:\...\src\main.ts:12` 被当作路径 `C:\...\src\main.ts:12` 去 `stat`，失败后插入内容为空。
  - `./build.sh\nC:\...\src\main.ts:12` 只留下 `build.sh` chip，源码位置行被删除并进入诊断。

**审核结论**：问题真实。第 12 / 13 个问题已经确立“普通文本保真优先于路径便利”，strong-path 失败仍吞行与该原则冲突。strong-path 成功静默注入同样真实，但产品取舍比失败吞行更软：显式 `./foo.png` 很可能就是用户想添加材料；而日志里恰好存在的绝对路径也可能只是正文。二者应在同一个问题下统一审查，因为根因都是“路径形态不能单独证明材料意图”。

**根因**：

- 当前实现是“行级路径形态驱动”：每一行只要像 strong-path，就独立进入 `stat / register / failure`。它没有先判断“本次粘贴整体是不是一个材料路径批次”。
- `failure` 被设计成“材料批次里的失败项”，但在普通日志 / 命令文本里，strong-path failure 其实只是正文行。当前代码把这两种来源混在一起，所以会吞正文。
- 成功方向同理：文件存在只能证明环境里有这个文件，不能证明用户在这次粘贴中授权把它作为材料交给 agent。

**背后需求**：

- 用户粘贴命令、日志、错误栈和源码位置时，系统必须保持原文，不应因为某一行像路径就删掉、替换成 chip 或读取文件。
- 用户粘贴文件路径添加材料时，CLI 仍要提供高效入口；但这个入口必须避免静默破坏正文。
- agent 收到的必须是用户想交付的材料。误删文本是显性破坏；误读本地文件是隐性上下文污染。

**目标效果**：

- strong-path 失败不能静默删除原始行。无论是否诊断，用户输入区和最终提交内容都必须保留可恢复的原文，除非用户明确确认丢弃。
- `:line` / `:line:column` 源码位置默认按文本保留，不把整行当本地文件路径，也不尝试读取去掉行号后的文件。
- 粘贴日志 / 命令清单时，长文本仍按普通文本折叠，不因某个 strong-path 失败项进入 `ingested` 而绕过折叠。
- strong-path 成功采集需要重新定义安全边界：既不能破坏用户粘贴 `./image.png` 添加材料的便利，也不能在“正文 + 路径样文本”混排中静默读取文件污染上下文。
- 用户仍可以构造“文字 + 材料”的最终输入：先输入 / 粘贴说明文字，再单独粘贴文件路径生成 chip，或者先粘贴路径生成 chip 后继续输入文字。材料 chip 已有保活与后续粘贴不清空保障，不需要依赖“同一次混排粘贴”完成。

**产品 / 架构判断**：

- 顶级产品边界不是“某行像路径就读文件”，而是“用户是否明确要把这个文件作为本轮材料交给 agent”。路径形态只能提供线索，不能替代意图。
- 最优架构应把“材料入口”设计成可解释的意图通道，而不是无限调启发式。短期仍可在 CLI 粘贴层收敛规则；长期应走结构化 composer / handle 模型，让材料添加和普通文本天然分层。
- 失败吞行必须优先修，因为它直接破坏正文保真；成功注入需要结合交互成本和材料便利性一起定性，避免从“自动注入”摇摆到“添加材料过重”。
- 第 13 个问题中“strong-path = 明确材料意图”的结论只是弱候选收敛后的过渡判断；第 14 个问题把判断提升到批次级，避免继续用单行形态承载完整意图。

**最优解决方案**：

- 在 `input-material-ingest.ts` 引入批次级材料意图判断：先解析本次粘贴的非空行，再判断本次粘贴是否是“材料路径批次”。只有材料路径批次进入 `stat / register / diagnostic`；只要出现普通文本行、源码位置行、命令行参数行，就整体返回 `not-material`，交回普通文本粘贴逻辑处理。
- 材料路径批次定义：
  - 去掉首尾空行后，每个非空行都必须是可作为材料路径的强路径候选。
  - 强路径候选包括 `./...`、`../...`、`~/...`、绝对路径、Windows 盘符路径、UNC 路径；但不包括源码位置和未加引号的含空白命令行。
  - 带空格路径必须整行加引号；未加引号的 `./build.sh --prod` 默认是命令文本，不是材料路径。
  - `file:line`、`file:line:column`、`path(line,column)` 等源码位置默认是文本引用，不触发材料采集，也不诊断。
- 对材料路径批次逐行处理：
  - 成功解析为普通文件的行生成 material chip。
  - 失败或目录行不删除原文，原始行回写到 `insertText`，同时给诊断；诊断文案应表达“未添加为材料，原文已保留”，避免用户误以为内容消失。
  - 同一批次允许“成功 chip + 失败原文 + 诊断”，这样批量添加材料时仍有可恢复反馈。
- 对非材料路径批次整体保真：
  - 不做任何 `stat`，不注册材料，不产生诊断，不产生副作用。
  - 长日志 / 命令清单继续走文本长粘贴折叠；提交后展开为完整原文。
- 保留单独粘贴路径的高效入口：当用户已在输入区有说明文字时，后续单独粘贴 `./image.png` 仍会生成 chip，因为判断只看“本次粘贴批次”，不是看整个 draft。
- 不在 `prepareUserTurnInput()` 兜底修正，因为到提交准备阶段 chip 已经出现在输入语义里；真正边界仍在 `input-material-ingest.ts` 的意图分类和采集阶段。

**代码组织方案**：

- 将当前“行级 process 即产生副作用”的流程改成两段：
  1. `parsePastedMaterialLines()` 只产出 raw / input / quoted / line intent，不访问文件系统。
  2. `isMaterialPathBatch(lines)` 决定本次粘贴是否进入材料采集；返回 false 时直接 `not-material`，保证无 registry 副作用。
  3. `ingestMaterialPathBatch(lines)` 才执行 `resolvePastedPath()`、`statSync()`、`registerLocalFile()`。
- `PathIntent` 建议扩展为 `text | material-path | source-location`，不要再用 `strong-path` 这个名字承载产品语义；`strong-path` 只是 material-path 的一个语法来源。
- 重新引入 `quoted` 信息，区分 `"./a b.txt"` 这种路径和 `./build.sh --prod` 这种命令。
- 把源码位置识别做成小型纯函数，例如 `parseSourceLocationSuffix(input)`，从右侧识别 `:line` / `:line:column`，避免误伤 Windows 盘符 `C:\` 的冒号。
- `finalizePaste()` 不需要新增业务判断，只继续消费 `ingested / not-material`。这能保持接入面输入控制器和材料摄取模块的职责边界。

**不采用的方案**：

- 不采用“strong-path 失败回写原文但仍返回 ingested”作为完整方案：它能修吞行，但仍会让日志绕过长文本折叠，并产生无意义诊断。
- 不采用“只识别 `:line` 源码位置”作为完整方案：它修一类日志，却无法解决 `./build.sh`、绝对路径行、命令清单等同源误判。
- 不采用“完全关闭 strong-path 自动材料采集”：这会损害粘贴 / 拖拽单个图片或文件路径的主能力，用户需要更重入口才能添加材料。
- 不采用“混排正文里继续自动采集存在的路径，同时弹 warning”：输入已经被改写，warning 不能消除上下文污染。

**验收标准**：

- 补 `input-material.test.ts`：`先运行\n./missing-build.sh\n再看输出` 返回 `not-material`，registry 为空，原文由普通文本粘贴路径保留。
- 补 `input-material.test.ts`：`./src/main.ts:12`、绝对路径 `...\src\main.ts:12`、`file.ts:12:3`、`src/main.ts(12,3)` 等源码位置返回 `not-material`，不生成诊断，不注册材料。
- 补 `input-material.test.ts`：`./build.sh --prod` 这种未加引号含空白行返回 `not-material`；`"./a b.txt"` 在文件存在时仍生成 material chip。
- 补 `input-material.test.ts`：`./shot.png` 单独粘贴仍生成 image chip；`./shot.png\n./note.txt` 仍生成有序材料 chip。
- 补 `input-material.test.ts`：`./shot.png\n./missing.png` 生成 image chip，同时保留 `./missing.png` 原文并返回诊断。
- 补 `input-material.test.ts`：`请看\n./shot.png\n谢谢` 返回 `not-material`，不读取文件、不生成 chip，完整保真为文本。
- 补 `typeahead-input.test.ts`：粘贴包含 strong-path 失败行的长日志仍折叠为 `[Pasted #...]`，提交后 agent payload 是完整原文。
- 补 `typeahead-input.test.ts`：已有说明文字时单独粘贴 `./shot.png` 仍插入 image chip，随后提交得到 text + image 有序 parts，证明用户仍能用分步粘贴构造图文混排。

**修复记录**：

- `input-material-ingest.ts` 改为批次级材料意图判断：`parsePastedMaterialLines()` 只做无副作用解析；`isMaterialPathBatch()` 决定本次粘贴是否进入材料摄取；非材料批次直接返回 `not-material`。
- `PathIntent` 收敛到产品语义：`text | material-path | source-location`。源码位置、未加引号含空白命令行、说明文字混排都不会触发文件系统访问。
- 材料路径批次失败项不再被删除：失败行原文回写到 `insertText`，同时返回“未添加为材料，原文已保留”的诊断。
- 更新旧测试语义：同一次粘贴里的说明文字 + 路径整体按文本保真；需要图文混排时，通过分步粘贴路径生成 chip。
- `input-material.test.ts` 补齐源码位置、命令行参数、带空格路径加引号、纯路径多材料、纯路径部分失败、混排保真等回归。
- `typeahead-input.test.ts` 补齐长日志折叠保真、分步粘贴生成 text + image、路径批次失败项原文保留等真实输入链路。

**定向验证命令**：

```bash
pnpm --filter @zhixing/cli exec tsc --noEmit && pnpm --filter @zhixing/cli exec vitest run src/__tests__/input-material.test.ts src/__tests__/typeahead-input.test.ts
```

结果：CLI 类型检查通过；定向 2 个测试文件、99 个测试通过。

**收尾验证命令**：

```bash
pnpm --filter @zhixing/cli test && pnpm cli:build
```

结果：CLI 全量测试通过，140 个测试文件、2140 个测试通过；CLI 构建通过。

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
