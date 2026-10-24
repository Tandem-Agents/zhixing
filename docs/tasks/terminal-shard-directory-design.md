# 转录分片目录：有界打开、精确重驱与崩溃恢复

本文定义会话转录（`transcript/`）的分片目录：打开会话、追加 run、重驱已提交 run、clear、retention 与只读读取各自的状态与 I/O 边界。上位约束见 `docs/architecture/terminal-startup-state.md` §4.6（分片与 run 位置、写入与恢复）与 §8（工作量计量口径）。

## 1. 范围与目标

本设计只覆盖当前存储格式。早期本地测试资料（v1 `index.json` 格式）按 §6 一次性转换，不提供跨版本自动迁移、降级往返或旧格式长期兼容。

| 编号 | 目标 |
|---|---|
| T1 | 打开会话只读固定大小的根，与历史规模无关 |
| T2 | 新提交零历史读取；重驱按索引路径定位（允许对数深度），只读目标 run 自己的字节；位置绑定会话、clear 边界、runIndex、分片身份、字节范围、内容摘要与来源 |
| T3 | 每步写入有固定上界，不整写 |
| T4 | 写入顺序为意图 → 追加 → 发布；崩溃与同实例失败都只核对本意图的有界尾部，不重复追加，不拼出坏行；未确认耐久的结果保持“未知”，不当成成功；单次写入只写出一部分时写满为止，不把短写当成整条记录 |
| T5 | clear / delete / retention（先撤可见再物理删、可续做）；只读侧看到一致的已发布前缀 |
| T6 | 前驱定位不遍历目录 |
| T7 | 两种生产写入口（owner 物化 `appendCommittedRunRecord`、local-turn `appendRunRecord`）都覆盖，失败重试有稳定身份 |
| T8 | 纯转录会话的计数接口为 O(1) |
| T9 | 已发布范围内的字节被截短或不可解析时报损坏，不读成更短的历史；清空之前取得的游标同样读不穿清空点 |

## 2. 设计要点

1. **可见范围是序号前缀。** retention 按序号从旧到新退役，遇到第一个不满足判定的片就停；物理删除落后于撤可见，可续做。前驱 = seq − 1（不小于可见下界时）。这样目录里没有原地覆盖的可变条目，只读侧持有的已发布视图不会被改写。时钟回拨时只会多保留，是保守方向。
2. **根是同一文件里的 A / B 两半，原地交替写。** 每次提交不新建文件（避免文件新建的扫描开销），也没有“先删除再改名”的窗口。
3. **每片一个定长位置文件 `<seq>.pos`，位置项兼作 run 的意图。** 重驱不论目标多旧，都只读定位元数据与目标自己的字节，读量不受同片中其他（可能很大的）run 影响。位置项先于正文落盘，本身就是意图，所以每次提交仍是 3 次 fsync。
4. **来源绑定复用 owner 提交已有的字段**：`assignmentId`、`commitRevision`、`digest`，不新增业务协议。

## 3. 结构（均在 `transcript/` 内）

### 3.1 根 `root.bin`：A 半 512B、B 半 512B、意图区 512B

每一半是一份已发布状态，字段均为定长二进制：
- `epoch`（128 位随机数，转换时生成）、`pub`（发布序号，单调递增）；
- `active { seq, createdAt, firstRunIndex, prevSealedSize }`：prevSealedSize 是活跃片之前那一片封片时的字节数；
- `tail { size, nextRunIndex }`：已发布前缀，活跃片中 size 之前全是完整行；
- `last`：最近发布的 run，`{ runIndex, seq, from, to, sha256, 来源摘要, commitRevision }`；
- `clear { generation, boundaryRunIndex, lastClearAt? }`；
- `visible { fromSeq, fromRunIndex, deletedBelowSeq }`；
- `strictFrom { seq, offset }`：严格区起点，其后的已发布字节都由当前格式写出，必须是完整、可解析的行；之前的字节来自旧测试格式转换（§6），沿用旧语义容忍坏行；
- 校验和。

prevSealedSize 与 strictFrom 的编码以 0 表示未记录：未记录时读者按文件实际长度读取、整体按容忍处理。

当前根 = 两半中校验通过且 pub 较大的那一半。发布 pub = k + 1 时写另一半并 fsync，这就是提交点；新的一半写撕裂时校验失败，旧的一半仍是当前根。

读取规则：
- **写者**（持锁）读到两半都无效：当前根损坏，失败关闭并标记受损，不扫描分片猜一个新根。
- **只读者**（不持锁）读到两半都无效：可能正好被两次连续发布夹住，有界重读 3 次；仍不收敛就报可重试状态，不当作损坏，不写盘。
- EACCES、EIO 等读取错误照常抛出。
- `root.bin` 不存在：
  - transcript 目录为空：新会话（§4.0）；
  - 有 v1 `index.json`：旧测试格式（§6）；
  - 已有分片却既没有根也没有 v1 索引：失败关闭，不覆盖已有资料。
- 只读端的 read、stat 与正文读取，都以同一次取到的根为边界。

### 3.2 意图区（root.bin 第三段）

用于 clear（run 的意图由位置项承担；retention 撤可见只改根，是一次原子发布，不需要意图）。字段：`epoch`、`forPub = 写入时的 pub + 1`、目标的分片 / 偏移 / 长度 / sha256、换片信息、校验和。有效条件：校验和正确、epoch 一致、forPub 等于当前 pub + 1。只要发布（包括其他操作的发布）推进过，旧意图自然失效。

### 3.3 位置文件 `<seq>.pos`

- 文件头 256B：`epoch`、`seq`、`firstRunIndex`、分片创建时刻、前一片的封片长度、校验和。前一片的封片长度在换片的 A1 随新片文件头写下（等于当时的 `tail.size`），读者据此核对更早封存片的长度。
- 第 (runIndex − 该片 firstRunIndex) 项即该 run，256B 定长二进制（四个 sha256 就占 128B，其余定长字段与保留区补足 256B）。
- 字段：`runIndex`、`offset`、`length`、sha256(行字节)、sha256(runId)（local-turn 为全零）、sha256(assignmentId)、sha256(digest)、`commitRevision`、来源类别（owner / local-turn）、`epoch`、`forPub`、校验和。
- 一项作为意图有效的条件：校验和正确、epoch 一致、`forPub = 当前 pub + 1`，且 `runIndex = nextRunIndex`。仅凭“位置在已发布水位之外”不算有效意图。
- 被放弃的项由下一次尝试原位覆盖（同槽重用）。
- 已发布的项（runIndex < nextRunIndex）只读不改；随分片一同退役。

### 3.4 分片

- 序号连续：换片取 `active.seq + 1`。
- header 带 `firstRunIndex`（换片时的 nextRunIndex）；旧读者只校验 header 的必需字段，容忍这个新增字段。
- run 与 clear 都在追加前判断换片，所以分片大小 ≤ 阈值 + 一条记录。
- 可见片 = `[visible.fromSeq, active.seq]`。
- 每片的已发布长度：活跃片为 `tail.size`；活跃片的前一片为根里的 `active.prevSealedSize`；更早的片为其后继片位置文件头里的前一片封片长度。

## 4. 操作（store 锁内）

实例状态只有两种：`ready` 与 `dirty`。任一步抛错都转 dirty；dirty 时下一次操作先执行恢复 R（§5），从磁盘重读根，不信缓存。

发布的耐久确认：
- 根的一半写入或 fsync 失败时，这一半可能已经可见却未耐久。实例把它记为**待确认发布**并转 dirty（包括 retention 的发布）；R 先处理它（§5），确认之前不在旧缓存上继续写，也不让旧缓存覆盖已经可见的更高 pub。
- 打开时从盘上读到的根由更早的实例发布，可能没有完成 fsync。本实例依据它作出确认之前（重驱返回已投影、retention 物理删除），先把这一半原样重写并 fsync；本实例自己的发布成功即已确认。每个打开态至多一次。
- 所有写入循环到写满为止，某次写入没有进展就报错；读取同样读满或读到文件尾。

### 4.0 新会话初始化

只在 transcript 目录为空时进行（§3.1）。先把完整的 `root.bin`（A 半为 pub = 1、`active.seq = 1`、`tail.size = 0`、nextRunIndex = 0、`prevSealedSize = 0`、`strictFrom = { 1, 0 }`）写入临时文件并 fsync，再改名为 `root.bin` 并 fsync 目录，根要么完整存在、要么不存在；首片文件不在此时创建，而是由第一次追加的 A2 连同 header 一起写出（目标为新片、offset 0）。所以初始化只有一步：根发布之前崩溃，目录仍为空，重开即重做；发布之后，根已存在。`tail.size = 0` 时活跃片文件不存在属于正常状态。

### 4.1 打开

读 `root.bin`（1.5KB）；检查 run 意图的两个固定候选（活跃片 `.pos` 的第 (nextRunIndex − firstRunIndex) 项、下一片 `.pos` 的第 0 项，各 256B，可能不存在）；若存在有效意图就执行 R；然后 stat 活跃片（`tail.size = 0` 时允许不存在），要求 `size == tail.size`：
- 更大：有未经意图解释的字节，失败关闭，不截断；
- 更小：已发布数据被截，失败关闭。

不倒扫，不列目录。

### 4.2 追加（两个入口共用；k = 当前 pub）

- **A1 准备**：判断换片（`tail.size ≥ 阈值`）。
  - run：写目标片 `.pos` 的对应项（forPub = k + 1）并 fsync；换片时是新片 `.pos` 的第 0 项，新文件还要 fsync 所在目录。
  - clear：写意图区并 fsync。
- **A2 追加**：在 offset 写入行（换片时连同 header），fsync；新文件 fsync 目录。
- **A3 发布**：写另一半根：pub = k + 1，tail 前移，`nextRunIndex + 1`，`last` 换成本条；换片时更新 `active`，`prevSealedSize` 取换片前的 `tail.size`。fsync。

失败处理：
- 任一步抛错时，**在本次调用内立即执行 R**，再按 R 的结果返回：已发布就返回成功，已放弃就抛错。
- 耐久边界：R 读回的完整行或新根半，不能直接当作已耐久。要把这些字节原样重写、fsync 成功后，才能发布或确认。按“位置项 → 行 → 根”的顺序逐一确认。
- 重写加 fsync 仍失败：实例保持 dirty，抛出专用的“结果未知”错误（`TranscriptOutcomeUnknownError`），下一次操作先跑 R。

两个入口的稳定身份：
- **owner 物化**：来源为 `assignmentId` / `commitRevision` / `digest`。R 遇到完整且已确认耐久的行即发布；owner 重驱时按 §4.3 比较来源与记录。
- **local-turn**（`appendRunRecord`）：
  - `promote` 把队首的 `provisionalRunIndex` 作为 `expectedRunIndex` 传入，经 manager → CLI 适配 → store 一路传到底层。
    - 若 `expectedRunIndex < nextRunIndex`：按 §4.3 取出该位置已发布的记录与传入记录比较，相同则返回已存在（不追加），不同则报冲突。身份来自位置，比较正文只是核对。
    - 若等于 nextRunIndex：正常追加。
  - `recordTurn` 不自动重试，不传 expectedRunIndex，靠本调用内的 R 让返回的结果就是最终结果。
  - 以后某次操作里的 R 发现 local-turn 的未发布意图时，一律截断放弃，使先前报告的失败成立。
- **结果未知**：
  - `recordTurn` 收到时，不按“本轮不成为对话事实”处理，而是让 manager 重建该会话的窗口视图（从已发布状态重新装载）。仍在执行的任务、pending 队列与清理责任按现有生命周期保留并收尾，不丢弃。
  - `promote` 保留队首，下次带同一 expectedRunIndex 重试。
  - run-turn 的提交失败钩子把“结果未知”与“确定失败”分开上报。

### 4.3 重驱（runIndex < tail.nextRunIndex）

1. `r < visible.fromRunIndex`：已投影，证据已退役。零文件 I/O。
2. `r == last.runIndex`：读 [from, to)，核 sha256，解析这一条记录，与传入记录比较；owner 入口再比较来源摘要与 commitRevision。相同为已投影，不同为冲突。
3. 其他：在 `[fromSeq, active.seq]` 内按 header 的 firstRunIndex 二分（O(log N) 次 header 读取），读归属片 `.pos` 中的对应项，再只读该项的字节范围，核对后同上比较。位置项无效时判定位缺失。

返回已投影（含证据已退役）之前，当前根若未经本实例确认耐久，先按 §4 确认。

### 4.4 clear

与 §4.2 相同的三步（意图写在意图区），先判断换片。发布 `clear = { generation + 1, boundaryRunIndex: nextRunIndex, lastClearAt }`。

### 4.5 retention（Host 维护调用 store，持同一把锁）

每步至多 K = 32 片。

1. **撤可见**：从 fromSeq 起，对非活跃片判定“seq + 1 的 header createdAt < cutoff”（按后继封笔时刻保守判断，cutoff 来自保留期配置）；遇到第一个不满足的就停，不越过未过期片。发布根推进 fromSeq 与 fromRunIndex（取新 fromSeq 片位置文件头的 firstRunIndex）；这是一次原子发布，撕裂时旧的一半仍是当前根。
2. **物理删**：撤可见已确认耐久（本步刚发布，或按 §4 确认打开时读到的根）之后，对 `[deletedBelowSeq, fromSeq)` 逐个 unlink 分片与 `.pos`，遇到 EBUSY 停下；发布根推进 deletedBelowSeq。中断后按 deletedBelowSeq 重入。

撤可见的发布失败时按 §4 记为待确认：读者可能已经看到推进后的 fromSeq，之后的写入先确认或判定它未发生，不会用旧的 fromSeq 复活已撤可见的前缀。

### 4.6 delete

repo 先持久删除 meta.json，再递归删除会话目录；随后 store 丢弃该会话的打开态缓存，同 id 重建时从磁盘重新打开。读者遇到 `root.bin` 不存在且 meta.json 也不存在时，按“已删除”处理，不当作空历史；既无根也无 v1 索引却有分片文件时，读写两侧都失败关闭。

### 4.7 读：倒读、字节读者、离线（只读、不持锁）

- 一次读取先取根（§3.1），得到视图 `{ pub, active, tail.size, visible, clear, strictFrom }`，每片只读已发布长度（§3.4）：活跃片读到 `tail.size` 为止，封存片读到封片长度。
- 文件短于已发布长度、或严格区内有不完整 / 不可解析的行：损坏，抛错。严格区之前（旧测试格式转换来的字节）沿用旧语义：倒读跳过坏行，字节读者只跳过末尾不完整的记录。
- 清空边界：遇 ClearRecord 即结束；runIndex 小于视图 `clear.boundaryRunIndex` 的 run 也不产出，所以清空之前取得的 `before` 游标不论落在哪一片都读不穿清空点。
- 前驱：`seq − 1`，不小于 `visible.fromSeq` 时才有效。
- 遇 ENOENT：
  - 分片序号小于新读到的 fromSeq：视图已过时，该片已撤可见，读取到此结束；
  - 否则：损坏，抛错。
- 读者不等待写者，不写盘。
- bootstrap 的 lastClearAt、readRunsReverse、byte-reader 的前驱都从根取。

### 4.8 计数接口

- 有 owner 前缀（`baseRevision > 0`）：沿用 owner 读目录的可信 count。
- 纯转录会话：计数 = `tail.nextRunIndex − max(clear.boundaryRunIndex, visible.fromRunIndex)`，O(1)，与现有只统计实际可见 run 的语义一致。

## 5. 恢复 R

先处理待确认发布（§4）：
- 盘上当前根的 pub 等于它：核对这一半的字节与它一致，原样重写并 fsync 后确认；在本次调用内就是“已发布”；
- 盘上当前根的 pub 比它小 1：这次发布没有发生，丢弃，按下面的意图处理；
- 其他：失败关闭。

再按意图类别分别处理：

- **run 意图**：只查活跃片 `.pos` 的第 (nextRunIndex − firstRunIndex) 项，以及下一片 `.pos` 的第 0 项（换片），按 §3.3 判断是否有效。
  - 下一片 `.pos` 存在而分片文件不存在：A1 后的正常崩溃点，放弃即可。
- **clear 意图**：意图区，按 §3.2 判断。
- **retention**：撤可见是根的一次原子发布，没有中间状态；物理删除按 deletedBelowSeq 续做。

run 与 clear 意图按下表判定，目标文件当前大小为 s：

| 情况 | 处理 |
|---|---|
| s == offset | 放弃（不写盘，下次 A1 覆盖） |
| offset < s < offset + length | 截断回 offset 并 fsync（换片且 offset 为 0 时删文件），放弃 |
| s == offset + length 且 sha256 相符 | 重写并 fsync 确认耐久后：owner 执行 A3 发布；local-turn 在本调用内执行 A3，在以后的操作里截断放弃 |
| sha256 不符，或 s > offset + length | 失败关闭 |

没有有效意图时，只校验 `size == tail.size`（§4.1）。

要覆盖的场景：A1 前、A1 后、A2 写一半、A2 后、A3 写一半；同实例在每一步后抛错再重入；放弃后又发生 clear（被放弃的意图项已清零，且因 pub 推进而失效）；同槽重用；换片只写了 `.pos` 还没写正文；物理删 EBUSY。

### 5.1 不变量与全部生产者

1. **`[fromSeq, active.seq]` 内的分片文件都存在，且 `active` 文件大小 ≥ `tail.size`。**
   - 新分片在 A2 创建，A3 才切换 active；
   - 截断只作用于意图证明属于自己、且在 tail.size 之后的字节；
   - 物理删只删 fromSeq 以下的片。
2. **`tail.nextRunIndex` = 已发布前缀最后一个 run 的 runIndex + 1，`last` 是这条 run，且 runIndex < nextRunIndex 的位置项都已发布、不再改写。** 只有 A3 推进它们；clear 不改 runIndex；A1 只写 runIndex = nextRunIndex 的项。
3. **当前根至少有一半有效。** 写入只针对非当前的那一半。

## 6. 旧测试格式一次性转换

- 触发：有 v1 `index.json`（version 1），且没有 `root.bin`。当前根损坏不走这里（§3.1）。
- 按 v1 的 shards 列表逐片读取（线性一次），得出 active、`tail.size`、nextRunIndex、last、clear 边界（最后一个 ClearRecord）、各片的 firstRunIndex 与位置项，写 `.pos` 与根。
  - v1 列出、文件却缺失的片：低于最低现存片的视为早已清理，fromSeq 取最低的现存片；位于现存片之间的缺片不推断、不隐藏，转换失败关闭并列出缺失序号。v1 活跃片换片后尚未写入而不存在属于正常状态。
  - 活跃片尾部有撕裂行：不补换行，不当作合法提交；转换后先换到新片再继续追加，原片保持原样。
  - 各片的现有长度记为封片长度（写进后继片的位置文件头与根）；`strictFrom` 取转换后活跃片的现有末尾，转换来的字节按旧语义容忍坏行，之后写入的字节进入严格区。
  - `index.json` 原件保留。
- 一次性，与正常打开分开计量。

## 7. 计量（每步上界，全文件）

符号：R = 单条记录字节，K = 32，N = 可见分片数。

| 步骤 | 读 | 写 | fsync | 缺失探测 / 列目录 | 与 N |
|---|---|---|---|---|---|
| 打开 | root.bin 1.5KB；2 个候选位置项各 256B；1 次 stat | 0（有意图时见 R） | 0 | 固定 2 处候选（可能不存在）/ 0 | 无关 |
| 追加 run / clear | 0 | 位置项 256B 或意图 512B、行 R、根一半 512B | 3（新文件加目录） | 0 / 0 | 无关 |
| 重驱最近一条 | R | 0（打开后首次确认时根一半 512B） | 0（首次确认时 1） | 0 / 0 | 无关 |
| 重驱更早一条 | ≤ ⌈log₂N⌉ 个 header；位置项 256B；R | 同上 | 同上 | 0 / 0 | 对数 |
| 倒读每跨一片 | 更早的封存片多读后继片位置文件头 256B | 0 | 0 | 0 / 0 | 无关 |
| retention 一步 | ≤ K+1 个 header | 意图、根；≤ 2K 次 unlink | ≤ 3 | 0 / 0 | 每步有界 |
| 旧测试格式转换（一次） | v1 与全部分片 | `.pos`、根 | 每文件 1 次 | 0 / 0 | 一次性、单列 |

关闭条件：
- 除旧格式转换外，各行在 8 / 32 / 128 片对照下计数相同，或只按 ⌈log₂N⌉ 增长（仅“重驱更早一条”）；
- 没有列目录、没有整写；缺失检查只有打开时那 2 处固定候选，不随历史数量增长；
- 每次提交的写入与 fsync 前后实测并记录。

## 8. 验证

1. 全文件计数探针（fs.promises 全方法加 JSON.parse），按 §7 的步骤，8 / 32 / 128 片对照；另构造同片中有一条无关大 run 的重驱，确认读量不受其影响。
2. 故障注入：§5 列出的全部场景；半行后再追加不出现拼接；`promote` 在 A3 抛错后重试同一队首不重复，provisionalRunIndex 对齐；`recordTurn` 的确定失败与结果未知分别验证；重写加 fsync 仍失败时结果保持未知。
   - 正文、位置项、根以及恢复重写的短写：写满后才确认；
   - 根 fsync 持续失败：本次与之后的恢复都不能确认，故障消除后确认且不重复追加；retention 撤可见的发布失败后，写入不复活已撤可见的前缀；
   - 已发布范围被截（活跃片行边界 / 行中、封存片行边界）与严格区坏行报损坏，转换来的坏行照旧跳过；清空之前的游标跨片、同片、冷读都读不穿清空点。
3. 读者与 retention、读者与换片、读者与连续两次发布的交错：读者不等待，视图一致；未收敛时报可重试状态。
4. 两种入口全覆盖；编码边界：480 个字符全转义的 runId、2^53−1 的序号与偏移。
5. 既有语义反例：已退役、冲突、定位缺失、EIO 严格、空中间片。
6. 旧测试格式转换：用合成的 v1 资料覆盖可读、可追加、可重驱、clear 边界、撕裂尾、中间缺片失败关闭；本机资料在首次打开时自动转换。
7. 受影响文件首跑，涉及存储的加真实刷盘。
