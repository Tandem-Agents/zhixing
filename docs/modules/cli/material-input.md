# CLI 材料输入架构

CLI 负责把用户明确交付的本地材料加入本轮输入：输入区展示简短、可删除的 chip，提交时读取为[共同材料输入](../conversation/material-input.md)。文本折叠由[文本粘贴](text-paste.md)负责；文件和图片不是长文本 token 的另一种外观。

## 采集：先判断意图，再访问文件

`input-material-ingest.ts` 在一次完整 paste 内解析路径 item。只有全部非空 item 都被判为材料路径，才访问文件系统；普通说明、命令、日志与路径混排时，整批保留为文本。不因同名文件恰好存在，就把正文变成读取文件的请求。

当前支持有明确路径前缀的路径、带引号路径与窄口径 POSIX 路径转义：

- 单行多个路径须各有明确边界，如 `"./a.txt" "./b.txt"`；普通空格分隔的 `./a.txt ./b.txt` 不自动采集。
- POSIX 非引号路径以 `./`、`../`、`~/` 或 `/` 开头时，按白名单还原空格、括号、`&` 等反斜杠转义；不做变量替换、glob、命令替换或 shell 求值。Windows 反斜杠不作为 POSIX 转义，含空格路径需明确引号。
- 裸文件名、URL、日期和源码位置属于文本；即使给 `src/main.ts:12:3` 加引号，也不改变其源码引用语义。`file://` 不作为本地材料 URI 解析。

这是保守的路径意图识别，不是独立的安全沙箱或完整读取授权系统。显式 `@file:` 是另一条文本引用入口，不能把它的解析与 paste 路径猜测混为一谈。

采集成功登记文件路径、名称、大小、MIME 和可取得的图片尺寸，按顺序生成 chip；MIME 检测结合文件头。明确材料批次中部分失败时，成功项仍可加入，失败项保留原始 token 并返回独立诊断，不整批降级、不吞行，也不把诊断混入正文。后续普通文本粘贴或材料添加不删除已有材料；移除由用户编辑决定。

## 输入态与引用生命周期

`InputMaterialRegistry` 与文本 `PasteRegistry` 分开存储，共用输入 handle 的原子编辑和布局机制。registry 按路径及现有元数据条件复用 id，不是内容哈希去重，也不会冻结文件内容。

chip 使用 `[Image #N · …]` 或 `[File #N · …]`，展示名称、大小及可用尺寸，不铺开文件内容。格式化按可视宽度压缩名称与元数据，文本先去除会破坏 token 的字符；渲染层负责原子换行及极窄宽度兜底，不承担材料解析。

左右移动、Backspace 和物理 Delete 按完整 handle 操作；Ctrl+D 保留补全候选删除职责。统一 pattern 同时用于布局、编辑与补全 word 边界，但不代替提交时的来源校验。

引用保活覆盖当前草稿、输入历史和浏览历史前保存的草稿，通过槽位引用索引增量更新；不能只按当前输入框回收，也不能永久保留整个会话的所有材料。历史淘汰且无其他引用时回收 registry 项及其已生成 token 记录。恢复 chip 不等于文件仍可读，提交时必须重新检查。

## 从 chip 到结构化正文

`prepareUserTurnInput` 先按原输入分段，再分别准备材料与普通文本：

1. 材料引用须同时匹配 registry id、Image/File 类型和 registry 实际生成过的 token；不能仅凭同形字符串与 id 读取文件。
2. 只在文本段内解析 `@file:`；展开得到的文件正文不再扫描为材料 handle，防止文件中的同形字符串触发附件读取。
3. 按原顺序生成 `input.parts`，相邻 text 可合并但不越过 image。`PreparedUserTurnInput.text` 是文本投影，不从它反推材料。

当前输入 buffer 仍是字符串，来源保护依赖分段和已生成 token 集合，不是具备不可伪造身份的结构化编辑器；与本会话已生成 token 完全相同的手写字符串不能据此声称已被区分。

读取由 `input-material-resolve.ts` 完成：重新 stat、处理文件消失和读取异常；图片检查大小并重新嗅探文件内容后生成 image part，默认上限 5 MiB；支持的文本文件默认上限 100 KiB，包装为带文件路径的 text part。非文本文件明确报不支持，不把乱码或文件名当材料正文。添加 chip 后修改文件会影响提交时读取的内容，当前没有快照保证。

## 提交与失败边界

REPL 使用 deferred 输入提交。输入准备报错、材料不可读或不支持时，拒绝 pending submission，保留草稿并显示原因；用户可修正文件或移除材料后重试。不能为了得到成功结果静默丢掉失败材料。

当前 `beginUserTurn` 的 `onAccepted` 回调会 commit，调用正常返回后也会幂等 commit，之后才分派等待准则确认、合同失败或取消等结果。因此“所有核心未接受情形都保留草稿且不回显”的旧目标并未被当前实现完整保证；模型能力检查失败也不能概括为提交前拒绝。

commit 保存输入历史、清空输入区并写 scrollback：文本粘贴展开成原文，材料 chip 保持摘要，不把文件全文或图片编码铺满终端。scrollback 是已写出的终端历史，不能依赖后续展开或撤销来补救。输入提交回显不等于材料已被模型消费。

## 范围与维护验证

当前可靠采集链是路径文本进入 rich input；没有据此承诺原生剪贴板图片 bytes、`/attach` 命令或 PDF/Office 解析。legacy readline 不复制另一套 chip 编辑器。材料准备与模型消费范围以[共同合同](../conversation/material-input.md)为准。

直接验证应覆盖：明确路径与普通正文的双向区分、混排不访问文件、quoted/escaped 路径与 Windows 保真、部分失败回写、继续粘贴保留旧材料、原子编辑和宽度、历史恢复与淘汰、同形 token 与 `@file:` 来源隔离、图文顺序、文件变化及读取失败、准备拒绝保留草稿，以及提交回显与实际接收的区别。不能用旧测试计数或单个纯函数绿灯代替真实输入链验证。

实现入口：[采集](../../../packages/cli/src/input-material-ingest.ts)、[Registry](../../../packages/cli/src/input-material-registry.ts)、[读取转换](../../../packages/cli/src/input-material-resolve.ts)、[正文准备](../../../packages/cli/src/user-turn-input.ts)、[输入控制器](../../../packages/cli/src/typeahead-input.ts)、[REPL](../../../packages/cli/src/repl.ts)。
