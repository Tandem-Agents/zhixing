# 单元登记:第 20 单元 · generation 1

<!-- 身份头部:登记时填写,登记后不可变 -->

- **unitId**:20
- **generation**:1
- **登记时间**:2026-07-22
- **登记来源**:用户明确要求开始 distributed-runtime 模块第 20 单元开发

> 本文件是该单元代际的唯一状态源;登记协议、写序纪律与幂等判定见工作台主文档静态区。以下节结构、各表说明与表头、分片账本、九类核查面行、问题/排除/教训表、两轮终审行是固定骨架,只维护字段值与数据行。

## 当前状态

- **当前状态**:已完成
- **连续无新增问题轮数**:2 / 2
- **交付物是否冻结**:是
- **交付物文件集**:71 个业务、测试、golden 与架构文件（工作台状态文件不计入交付指纹）
- **当前交付物指纹**:`f126d78f2320742c2322fa3b3a375d83ce6aa34c1c6003f1df787fdc4f7b0d08`（`SHA256(UTF8(sorted(path<TAB>SHA256(file-bytes)<LF>)))`）
- **架构来源**:`research/design/modules/distributed-runtime/distributed-runtime-charter.md` 的 S5 控制面边界与 `research/design/modules/distributed-runtime/specification.md` 第 20 单元、§3.6～3.7、§4.2

## 固定边界

- **功能范围**:将派发、started、提交、cancel/supersede、queryLedger 与 usage intake 接入认证 mesh；以 assigned outbox 和既有 S3/S4 guard 为唯一远端入口，正式启用跨机执行
- **架构不变量**:任何远端执行先有耐久 assignment；消息先验、资产先行、双侧凭证激活与能力守卫均不可旁路；adapter 只承载既有端口语义；重试、断线与崩溃不得产生无日志执行、双活或重复提交
- **验收条件**:conversation/user job/system job 的既有取消与终结矩阵在进程内/mesh 双拓扑等价；断网、重连、重投及 owner/executor 崩溃可收敛；旧 epoch、旧 assignment、错 executor 与未授权方法全部 fail-closed
- **必要上下游**:S2 认证 mesh session；S3 assignment、提交、取消/uncertain 与 job 日志；S4 capability、permission、resource guard；第 19 单元资产传输与 mesh adapter
- **明确不属于本单元**:第 21～24 单元 stream/spool、数据面票据、surface 内容资产、中继与渠道最终性；第 25 项以后业务模块接入；为远端路径复制第二套状态机、guard 或恢复语义

## 审查分片

- **是否启用**:是
- **决定依据**:生产启用横跨组合根、owner→executor、executor→owner 与恢复/双拓扑四个闭包，任一闭包遗漏都会形成无日志执行或双活风险
- **完整单元与跨切片必审项**:assignment 耐久→凭证激活→资产在场→远端调用→started/usage/提交→ACK/终结全链；连接身份与 executor 绑定；断线、响应丢失、重启、重投与旧路径退役

| 切片 | 审查闭包（边界、依赖、局部验收） | 输入基线 | 当前轮次 | 本轮进度 | 收敛状态 | 封版信息包（结论、保证、证据、重开条件） |
| ---- | ---------------------------------- | -------- | -------- | -------- | ---------- | ---------------------------------------- |
| S20-A 组合根与连接选择 | 认证连接发现、executor 绑定、角色装配、启停与旧路径边界 | 当前交付闭包 | 集中修复复核 | 100% | 已完成 | 角色入口只动态加载本角色运行时，禁用角色包零值导入；executor 服务按认证 peer 角色授权。证据 V20-21～V20-22；重开条件：角色入口、运行时模块图或服务注册策略变化。 |
| S20-B owner→executor 控制 | dispatch、cancel/supersede、queryLedger、assigned outbox 与重试 | 当前交付闭包 | 集中修复复核 | 100% | 已完成 | 资产传输以耐久激活为根并绑定短时精确闭包；dispatch 在首个耐久 preflight 前完成载荷与 activation 验证。证据 V20-21～V20-22；重开条件：grant、preflight 或资产先行写序变化。 |
| S20-C executor→owner 控制 | started、提交、usage intake、ACK 与双侧 guard | 当前交付闭包 | 集中修复复核 | 100% | 已完成 | executor→owner 传输仅接受已激活 executor 的精确授权，submission/usage 继续复用既有 guard。证据 V20-21；重开条件：提交、查询响应或资产授权来源变化。 |
| S20-D 恢复与双拓扑 | 断网/重连/重投、双端崩溃、conversation/job 矩阵及旧路径退役 | HEAD `8723e9d` | 集中修复后复核 | 100% | 已完成 | 配对以可判定中间态跨越 SecretStore 写入；远端 stream 全帧复用 ingress 元数据；停机先封准入，sealed 恢复类型化区分状态、暂态与损坏。重开条件：状态矩阵、两端口、stream 摘要或重连/恢复所有权变化。 |

### 完整单元横向审查记录

> 启用分片时每轮必填;默认消费封版信息包,有疑问可下钻细节,确认问题或结论失效时重开切片。

| 轮次 | 完整输入基线 | 全范围与跨片核查 | 重开触发 / 切片 / 问题 | 结论 |
| ---- | ------------ | ---------------- | ---------------------- | ---- |
| 实现收口 | HEAD `8723e9d` + 当前交付闭包 | bootstrap→trust→连接→assignment→worker→started/usage/提交/终结；身份、崩溃与单机回退 | S20-A～D / U20-02～U20-10 | 全部根因已闭合，无未解决问题 |
| 独立终审 | HEAD `8723e9d` + 指纹 `66a8748f…7abe` | 角色装配、在线 trust 生效、端点原子持久化、配对跨崩溃续接及同族入口 | S20-A、S20-D / U20-08、U20-12～U20-14 | 4 项真实问题，当前不可提交 |
| 独立终审二 | HEAD `8723e9d` + 指纹 `66a8748f…7abe` | 预认证传输、资源上界、恢复启动时序、异常终态及现有问题同族横扫 | S20-A、S20-D / U20-12、U20-15 | 新增 1 个根因，U20-12 影响面补全；当前不可提交 |
| 架构者交叉复核 | HEAD `8723e9d` + 指纹 `66a8748f…7abe` | executor→owner 错误分类与执行计划字面验收逐项对账 | S20-C、S20-D / U20-10、U20-16 | 重开 1 个既有根因，新增 1 个验收缺口；当前不可提交 |
| 限定同族横扫 | HEAD `8723e9d` + 指纹 `66a8748f…7abe` | 信任/角色装配、远程耐久义务、配对 bootstrap 的全部生产端、消费端、恢复入口与异常终态 | 无新增根因；U20-10、U20-13 影响面补全 | 7 项问题边界完整，停止泛审并集中修复 |
| 集中修复 | 当前未冻结交付闭包 | U20-08/U20-10/U20-12～16 的生产端、消费端、恢复与双拓扑验收 | 无新增根因；7 项均完成直接验证 | 已知问题整批闭合，进入修复后完整横向审查 |
| 修复后横向审查 | 当前未冻结交付闭包 | capability 时限、mesh 调用时限、submission guard、资产传输与恢复重驱的全链语义 | S20-B、S20-C / U20-17 | 运输、授权、资产写与耐久分类所有权已分离；直接测试通过，根因闭合 |
| 修复后横向审查二 | 当前未冻结交付闭包 | submission preflight 的零资产终结、已提交回放与 fresh 深验写序 | S20-C / U20-18 | 稳定拒绝由 guard 零读取返回，committed 仅读 bundle，closure 深验归 fresh owner 提交；根因闭合 |
| 修复后横向审查三 | 当前未冻结交付闭包 | 已认证连接上的端点发布、pairing bootstrap 完成与秘密清理写序 | S20-A、S20-D / U20-19～U20-21 | 连接期义务统一重驱；恢复依据最后删除；direct/short/resume 与 control-plane 直接测试通过 |
| 修复后横向审查四 | 当前未冻结交付闭包 | 认证设备身份到 executor 逻辑身份的提交、资产与 usage 三入口绑定 | S20-C / U20-22 | 三入口统一消费组合根映射；生产 `executor:<deviceId>` 不再被提交服务误拒；直接测试通过 |
| 最终验证归因 | 当前未冻结交付闭包 | 角色拆分后的单机测试装配、重 IO 测试预算与 executor-only 输出边界 | U20-11、U20-23 | 测试装配显式注入本地 executor；配对测试族统一预算；异步错误统一走 CLI writer |
| 修复后横向审查五 | 当前未冻结交付闭包 | 角色组合根、输出消费者、耐久测试族及逻辑 executor 身份三入口复核 | 无 | 未发现新增根因；定向测试、CLI 构建与 CLI 整包验证通过 |
| 修复后横向审查六 | 指纹 `9c916b…3a7c` | assignment 全链、角色零装配、连接期义务、身份映射、异常终态与模块边界 | 无 | 第二轮零新增；复用同一指纹证据，单元可冻结 |
| 独立终审三 | 指纹 `9c916b…3a7c` | 配对 continuation、SecretStore 跨存储写序及 acceptance 前后全部崩溃点 | S20-D / U20-24 | 首次出码的 `offered` continuation 可先于候选秘密耐久，冻结失效 |
| 独立审查四 | 当前交付闭包 | 多 executor 选宿、在线/能力门禁与单机回退；本地/跨机 stream 元数据及摘要等价 | S20-A、S20-D / U20-25～U20-26 | 新增 2 个根因；当前不可提交 |
| 独立审查五 | 当前交付闭包 | 启动 preflight、角色副作用、停机准入与 sealed 恢复异常的全生命周期 | S20-A、S20-D / U20-27～U20-29 | 新增 3 个根因；配对 ACK 与 trust/transport 写序候选已证伪并登记排除 |
| 集中修复后横向审查七 | 指纹 `aa630b93…96a2` | 跨存储写序、选宿资格、跨拓扑摘要、启动单源、停机栅栏与恢复错误分类 | 无 | 六项根因及同类面闭合，直接测试和类型边界通过，未发现新增问题 |
| 冻结终审一重开 | 指纹 `aa630b93…96a2` | ready 前全部配置校验与设备域副作用；远端义务全部错误终态；选宿输入与稳定策略 | S20-A / U20-27 | mesh 配置运行时校验仍晚于设备密钥创建；端点超时与当前选宿策略疑点分别按 X20-08、X20-09 排除，同族零新增 |
| U20-27 集中修复复核 | 指纹 `ed1db67…2cb4` | mesh 形状、本地角色参数、startup 结构化诊断与 bootstrap 首个副作用 | S20-A / U20-27 | 单源谓词前置完成；纯合同 8/8、startup/bootstrap/topology 12/12 通过，非法配置零解锁且零设备密钥写入 |
| 重冻结独立终审一 | 指纹 `ed1db67…2cb4` | 配置加载→startup ready→bootstrap→trust 授权→endpoint 发布全链；全部校验与副作用线性化点 | 无 | 同一谓词覆盖外层诊断与内部防线，授权校验保持 fail-closed；零新增问题，累计 1/2 |
| 重冻结独立终审二 | 指纹 `ed1db67…2cb4` | S5→S6 单元边界；角色/trust/endpoint/连接/assignment 身份链；启停、恢复与双拓扑交叉面 | 无 | 未提前实现第 21 单元数据面；各权威来源、重驱所有权及单机回退一致，零新增问题，累计 2/2 |
| 最终验证重开 | 指纹 `ed1db67…2cb4` | CLI 全包静态输出门禁 | S20-A / U20-30 | `topology-command.ts` 新增 15 处直接 console；其余 169 文件、2419 项通过，冻结失效 |
| U20-30 集中修复复核 | 指纹 `7018ec7c…9e96` | serve 启动失败全部输出分支、writer 默认实现与测试注入 | S20-A / U20-30 | 未扩充例外清单；静态门禁与 topology 直接测试 4/4、Biome 通过，根因闭合 |
| 最终重冻结终审一 | 指纹 `7018ec7c…9e96` | runServeCommand 全部调用方、CliWriter 默认/注入实现与各启动失败分支 | 无 | 既有单参数调用兼容，错误内容与退出码不变；零新增，累计 1/2 |
| 最终重冻结终审二 | 指纹 `7018ec7c…9e96` | 完整 S5 控制面封版信息包、输出边界及 S5→S6 范围 | 无 | 仅输出端口实现变化，权威状态、身份链、恢复和双拓扑结论均未失效；零新增，累计 2/2 |
| 独立审查七 | 当前完整交付物 | 已排除项与迟发现教训复用；全部远端服务的签发权、peer 角色、耐久激活、资源闭包及首个副作用横扫 | S20-A～C / U20-32～U20-33 | 资产服务将历史验签误作当前授权；共享 registry 又把 executor 写服务暴露给远端 executor，并在完整派发验证前写入控制租约；当前不可提交 |
| 独立审查八 | 当前完整交付物 | 复用 X20-01～X20-09 并执行 L20-01～L20-09；复核信任/连接生命周期、远端响应绑定、角色装配及 preflight 首个耐久写 | 无新增；补全 U20-33，新增 X20-10 | 现有四项问题边界完整；发行方运行期迁移按 X20-10 排除，停止泛审并集中修复 |
| 集中修复二 | 当前交付闭包 | 角色求值闭包、资产签发权/激活/资源集合、服务方向矩阵及 dispatch 首个耐久写 | 无新增根因；补齐 U20-33 activation 验签分支 | 四项根因一次闭合；合并直接验证与派生结构预检通过，进入冻结准备 |
| 冻结终审一 | 指纹 `f126d78f…0d08` | 复用 X20-01～X20-11并执行 L20-01～L20-09；角色求值、跨存储恢复、预认证资源、资产授权、服务方向、首个耐久写与双拓扑全链 | 无 | 零新增，累计 1/2；同一指纹进入冻结终审二 |
| 冻结终审二 | 指纹 `f126d78f…0d08` | 独立复用 X20-01～X20-11并执行 L20-01～L20-09；assignment 全生命周期、历史验签/当前授权分离、重连重放、角色启停及 S5→S6 边界 | 无 | 零新增，累计 2/2；进入最终验证 |
| 最终验证 | 指纹 `f126d78f…0d08` | 单独全量构建；受影响七包串行全测；运行时导出、diff 与冻结指纹复核 | 无；core 默认并发噪声按 X20-12 排除 | 全部门禁通过，交付物未修改，第 20 单元完成 |

## 派生产物闭包

> 表头固定。交付物文件集中的每个文件或同类组至少落入一行;派生项包括 lockfile、golden、schema/快照、生成清单及结构/导出基线。结论只允许“待核查”“通过”或“不适用:依据”;存在未归类文件或待核查项不得冻结。

| 交付物变化(文件或同类组) | 派生关系与必须同步/核对项 | 低成本检查与证据 | 结论 |
| -------------------------- | ------------------------ | ---------------- | ---- |
| core identity/schema 与 providers 配置 | schema 导出、配置解析与边界测试 | V20-03、V20-21～V20-22 | 通过 |
| mesh bootstrap、checkpoint、TLS、service registry 与 blind rendezvous | package exports、tsup 入口、握手、配对及服务授权测试 | V20-01、V20-21～V20-22 | 通过 |
| executor ledger 恢复集合 | ledger 生产/消费端、资产激活读取与恢复测试 | V20-02、V20-21 | 通过 |
| CLI 组合根、control plane、worker 与 adapter | profile/access-surface、角色拓扑、生产装配与测试 | V20-21～V20-22 | 通过 |
| specification 与工作台 | 单元边界、资产授权合同、排除项与验证证据 | 第 20 单元合同逐项对账；V20-21 | 通过 |
| lockfile、结构、golden 与运行时导出 | 无依赖版本变化；结构基线同步；运行时导出可解析 | V20-22 | 通过 |

## 关键原语核查

> 表头固定,每个关键原语一行;五项必须落到具体事实,结论只允许“待核查”“通过”或“有问题:编号”。任一行未通过,问题盘点不得结束。

| 关键原语 | 唯一事实源 | 生效/线性化点 | 崩溃与竞争插点 | 生产者/消费者 | 时间、空间、重放与队列上界 | 结论 |
| -------- | ---------- | ------------- | -------------- | ------------- | -------------------------- | ---- |
| trust 与角色投影 | AuthorityCommitLog trust 流 | trust 事件耐久并通过 checkpoint 后 | 配对、恢复根激活、在线撤销 | bootstrap authority / control plane 与授权目录 | 单调事件链；历史验签身份只增，当前授权按投影替换 | 通过 |
| 启动组合根 | `runStartupCheck` ready 结果 | 全部配置、SecretStore 与语义检查通过后 | 配置损坏、废弃字段、首次设备密钥与端点写入 | topology command / service host / mesh bootstrap | 单次检查；ready 前零角色副作用 | 通过 |
| endpoint 与连接 registry | 设备域 bootstrap store | endpoint 耐久提交后发布内存快照 | 重拨、端点更新、撤销、stop | executor dialer / anchor listener | 有界重试；每 peer 单一活动连接 | 通过 |
| pairing continuation | mesh bootstrap store | 自足 continuation 与 SecretStore 候选秘密共同构成恢复依据 | 任一步崩溃与恢复重入 | pair command / recovery bootstrap | 单条 continuation；完成、过期或稳定拒绝后清理 | 通过 |
| 预认证 rendezvous | 配对 offer expiry 与 relay 资源预算 | 绝对 deadline 与 matcher 容量准入 | 半帧、静默连接、随机 key 洪泛、超时与关闭 | pair command / blind relay matcher | 全程可取消；全局容量有界；所有终态释放 | 通过 |
| assignment worker | conversation assignment ledger | assigned/received/sealed 耐久状态 | dispatch 响应丢失、owner 瞬时失败、cancel、运行时异常、重启与停机 | owner adapter / executor worker / submission adapter | 关闭后零新执行；sealed 义务遇不确定读取失败继续可重驱 | 通过 |
| executor 选宿 | trust、在线连接与 CapabilityDescriptor | assignment 耐久前确定唯一 executor | 离线、能力失配、多候选与本地可用 | owner selector / mesh directory / recovery | 仅匹配者可选；稳定策略；无匹配保持排队 | 通过 |
| stream 摘要链 | ConversationDispatch.ingress | 每个数据帧 append 时固定元数据 | 本地/跨机切换、事件/yield/interaction 组合 | conversation runtime / remote worker / bundle verifier | 同一逻辑帧跨拓扑摘要一致 | 通过 |
| assignment 资产授权 | assigned/received 激活事实与精确 transfer 闭包 | 每次远端 probe/read/append 前 | 自签 capability、跨 assignment/ref、过期与重复传输 | 双向资产 service / ArtifactStore 与 receiver | 每次逻辑传输的 ref、方向、数量、总字节与 TTL 有界 | 通过 |
| mesh 服务方向授权 | 本地角色、认证 peer 角色与耐久 owner/assignment 归属 | handler 读取载荷及写入任何耐久事实前 | 双角色共享 registry、同角色横向调用、伪造 owner-control | control plane / executor、submission、usage、snapshot 与 endpoint 服务 | 每连接服务视图有界；拒绝路径零耐久副作用 | 通过 |

## 覆盖与核查

> 覆盖来源包括架构要求、不变量、验收项、交付文件与跨边界符号、生产端、消费者和测试;核查面固定为状态、入口与生产端、消费端与继承面、生命周期、并发与崩溃点、异常路径与终态、安全边界、模块边界、测试与验收。每轮填写“通过:证据”“不适用:依据”或“有问题:编号”。

| 覆盖来源 | 来源项 | 核查面 | 对象或路径 | 问题盘点结论与证据 | 终审一结论与证据 | 终审二结论与证据 |
| -------- | ------ | ------ | ---------- | ------------------ | ---------------- | ---------------- |
| 第 20 单元 | 跨机控制面 | 状态 | assignment/ledger/journal/outbox | 通过:全部状态写入复用既有权威端口 | 通过:未知结果保留义务 | 通过:零资产回放与终结成立 |
| 第 20 单元 | 全部控制方法 | 入口与生产端 | topology、conversation owner 与通用 job adapter | 通过:startup 单源且 selector 在 assignment 前联合在线与能力 | 通过:角色装配按拓扑分离 | 通过:设备到 executor 映射单源 |
| 第 20 单元 | 双向 adapter | 消费端与继承面 | mesh handlers、guards、ports | 通过:复用既有端口 guard | 通过:传输与业务时限分离 | 通过:稳定分类无第二套谓词 |
| 第 20 单元 | 连接与 assignment | 生命周期 | connect/reconnect/revoke/terminal | 通过:停机同步封准入后关闭 control 并 drain | 通过:连接先停止准入 | 通过:连接期义务可重驱 |
| 第 20 单元 | 重试与恢复 | 并发与崩溃点 | outbox、响应丢失、双端重启 | 通过:配对中间态可判定，sealed 暂态重驱、损坏上报 | 通过:响应丢失和双端重启覆盖 | 通过:恢复依据最后删除 |
| 第 20 单元 | 失败收敛 | 异常路径与终态 | cancel/supersede/uncertain/ACK | 通过:稳定拒绝与未知结果分离 | 通过:取消和 supersede 复用 guard | 通过:ACK 与 usage 义务闭合 |
| S2/S4 | 身份与能力 | 安全边界 | peer/capability/lease/epoch、预认证资源 | 通过:资产 grant 绑定签发权、激活、方向、精确闭包与预算；服务方向按认证 peer 授权 | 通过:预认证时限和容量有界 | 通过:载荷与 activation 验证先于控制租约写入 |
| 第 19～21 单元 | 范围分界 | 模块边界 | transport/control/stream | 通过:仅启用控制面 | 通过:数据面留在第 21～24 单元 | 通过:专用业务入口按 X20-03 排除 |
| 第 20 单元 | 双拓扑矩阵 | 测试与验收 | conversation/recovery 与通用 job adapter | 通过:远端三类 stream 帧统一消费 ingress 元数据 | 通过:故障矩阵与 user-job 实链路在场 | 通过:两拓扑使用同一端口合同 |

## 问题清单

> 每个根因只保留一行;“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试;状态只允许“待裁决、待修复、修复中、待验证、已验证”。已解决问题保留到单元完成。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| U20-01 | 生产组合根缺可信角色投影、端点耐久和连接生命周期。 | 安全原语与产品 bootstrap 之间缺少装配合同。 | 角色选择、认证连接及第 19 单元 adapter 生产启用。 | 以耐久 bootstrap、角色门禁和唯一连接所有权接入既有端口；单机/mesh 同构。 | 已验证 |
| U20-02 | 恢复根曾为占位实现，激活时间早于独立复制读回。 | 恢复根激活未以真实持久化与独立可恢复证据为门禁。 | 初始配对、恢复包与灾难恢复可信度。 | 创建真实恢复 checkpoint，复制与独立读回成功后再以当时时钟激活。 | 已验证 |
| U20-03 | 入站 socket 未由 TLS server 完成服务端认证，盲中继待配对 socket 的错误所有权不完整。 | 原始传输建立与认证 session 生命周期分离。 | anchor 入站认证、待配对连接异常与资源释放。 | 现有 socket 注入认证 TLS server；registry 单一持有错误处理与关闭责任。 | 已验证 |
| U20-04 | 恢复仅选择 sealed assignment，已耐久 received 的任务重启后失联。 | 恢复集合未覆盖所有可继续推进的非终态。 | executor 重启后的派发、封包与重复执行防护。 | ledger 单源投影 received/sealed 可恢复集合，worker 统一重驱。 | 已验证 |
| U20-05 | control stop 先等待 server close，再关闭活动连接，可形成停机死锁。 | listener 与连接关闭顺序违反资源依赖方向。 | anchor 停机、在线 peer 与进程退出。 | 先停止接收并关闭活动连接，再等待 listener 完成关闭。 | 已验证 |
| U20-06 | 远端 cancel、运行时异常、交互与计量未归属同一执行生命周期。 | 在线运行时与耐久协议的终结所有权分散。 | abort、started、usage、交互、提交与异常终态。 | worker 单一持有 AbortController 和运行终结，复用既有 observer/guard/提交端口。 | 已验证 |
| U20-07 | 历史签名验证身份与当前活跃授权曾共用同一集合。 | 历史真实性与在线准入两种时间语义被混合。 | trust 撤销后的日志重放、能力验证与新请求准入。 | 保留全历史身份用于验签，独立活跃集合用于当前授权。 | 已验证 |
| U20-08 | 在线 trust reconcile 只替换活跃授权集合，启动时冻结的验签身份集合不增加新成员；新配对 executor 虽可建连，其签名快照仍被拒。 | 历史验签身份与当前授权虽已分离，但 trust 增量只传播到后者。 | 在线 enroll 的 transport、能力快照、usage/提交验签与即时可用性；现有测试只证明建连。 | trust reconcile 以单一入口追加并校验历史身份、替换活跃授权，再重建连接；撤销只收缩授权、不删除历史验签身份。新增无需重启即可验签并执行业务的端到端测试。 | 已验证 |
| U20-09 | 通用远端选择可能把专用业务 invocation 降级为普通 agent 执行。 | 第 20 单元通用控制面缺少产品模块边界门禁。 | perspectives、advancement、scheduler 等后续模块语义。 | 仅普通 agent invocation 且合法 ingress/source 组合可远端；专用模块留给既定后续单元。 | 已验证 |
| U20-10 | worker 曾把 started 的稳定拒绝当不确定失败；现又把 `submitBundle` 的全部 `committed:false`（包括 `retryable:true`）和 mesh `service-failed` 当稳定拒绝，`finalizeUsage` 同样在 owner 瞬时异常时终止；owner 等待循环另有一份同类传输错误谓词。 | 远端调用没有以 `AuthorityError.retryable` 与“未知结果不得丢义务”为单一分类合同，各消费者各自按异常类型猜测。 | reportStarted、sealed bundle 提交、usage intake、owner 派发/恢复等待、owner 瞬时 IO/负载失败、响应丢失与 executor 重启；提交或计量义务可停摆至进程重启，现有测试只覆盖连接类失败。 | 单源化远端结果分类：明确 `retryable:false` 的结构化拒绝及本地输入错误才稳定终止；`retryable:true`、`service-failed` 与连接结果未知均保留义务并有界退避。全部入口共用谓词，补 owner 瞬时异常、结构化稳定拒绝和恢复测试。 | 已验证 |
| U20-11 | bootstrap 与 pairing 重 IO 测试曾漏显式预算；pair 命令及 executor-only 异步错误曾绕过 CLI 输出端口；access-surface fixture 曾未同步。 | 新生产接线的测试预算、输出边界与结构派生项未按同族一次对齐。 | CLI 包测稳定性、pairing 全测试族、两种长生命周期宿主、用户输出与入口结构门禁。 | pairing 测试族统一有界 IO 预算；pair 与 executor-only 宿主均持有 stdout writer；fixture 同步并由结构门禁覆盖。 | 已验证 |
| U20-12 | 角色外层 loader 已拆分，但真实模块闭包仍交叉加载：anchor 路径经 `setup-delivery` 值导入 executor governor，并经 `access-surfaces→mesh-runtime-assembly→conversation-assignment-worker` 值导入 executor submission；executor 路径又经 `setup-delivery` 值导入 anchor admission、governor 与 delivery participant。现有测试只 mock loader 调用，未观察模块求值。 | 角色隔离停留在工厂调用层，共享组合模块仍同时承载两种角色的运行时实现依赖。 | anchor-only 与 executor-only 的禁用角色零加载合同、启动体积与未来模块初始化副作用；当前未证实权威状态或既有功能回归。 | 把角色专属构造器收进各自动态角色模块，共享组合层只保留中性端口与类型导入；以真实进程入口/module graph 测试断言禁用角色包不被求值，并保留零监听、零权威写与启动顺序验收。 | 已验证 |
| U20-13 | joiner continuation 不保存完整 invitation 与 issuer 会合端点；`zz pair` 无 invitation 时转入 issuer 路径，过期旧 offer、稳定拒绝及 bootstrap ACK 后崩溃均无终态清理。 | 配对续接记录不是自足的耐久状态机，恢复入口与清理条件依赖用户再次提供旧瞬时输入。 | direct/relay、两种配对方式、pre-accept 失败、post-accept 响应丢失及完成 ACK 崩溃；重启后无法仅凭耐久材料重新会合，并可遗留 continuation/pairwise secret 永久阻塞后续配对。 | continuation 耐久保存完整 invitation、会合端点与阶段；命令启动自动检测并续接，按权威 commit/本地 completion 判定恢复或幂等清理；过期与稳定拒绝删除候选 secret。覆盖无 invitation 重启、旧 offer 终结、新码重试和 ACK 后崩溃。 | 已验证 |
| U20-14 | endpoint 服务先更新内存 directory，后写设备域文件；落盘失败后同 revision 重试被内存判 replay，重启又回到旧端点。 | 同一 endpoint 投影存在两个非原子提交点，发布顺序违反“先耐久、后可见”。 | 已认证端点自更新、磁盘失败、重试、进程内拨号选择及重启恢复；形成内存/磁盘分叉。 | 由耐久 store 单点校验并提交，成功后再发布内存快照；失败保持两侧旧值，同 revision 可安全重试。补写失败、重试与重启一致性测试。 | 已验证 |
| U20-15 | 配对候选只把 offer deadline 用到建连与首字节，随后 `receivePairingFrame/readExactly` 可被半帧无限挂起；`BlindRendezvousMatcher` 对任意合法随机 key 建最长一小时的 socket/timer/map 表项且无总量上界。 | 预认证字节通道在完整协议准入前没有统一的 deadline、取消与容量所有者。 | direct/relay 配对的 issuer/joiner、错误 peer 抢占候选、截断/静默连接、公开盲中继随机 key 洪泛及关闭清理；现有测试只覆盖合法帧和主动 close。 | 由连接生命周期统一持有从 accept/connect 到预认证完成的绝对 deadline 与 AbortSignal，所有读写可取消且 EOF 立即失败；matcher 增加明确的全局容量上界并以 `resource-exhausted` 拒绝超额，超时/关闭必释放。补半帧、静默、过期、容量边界与释放测试。 | 已验证 |
| U20-16 | 执行计划要求在 mesh 拓扑复核 6.1/6.2/6.2b 及断网、重连、重投、owner/executor 崩溃矩阵；此前只有 conversation 的少量 adapter 场景，缺 user-job 实链路和逐项证据映射。 | 状态机逐边证据、端口 conformance 与跨机故障证据未按依赖关系组合，包级绿色被误当成验收映射。 | conversation 36 行、user job 38 行、system job 6 行、两端口全部方法及跨机故障矩阵。 | 保留状态机矩阵为唯一逐边事实源，以同一 RunExecutorPort/RunSubmissionPort 的进程内与真实 mesh conformance 证明拓扑等价；补 user-job 实链路，并将断网、重连、响应丢失、重投及双端恢复逐项映射到测试。system job 按合同锚点本地执行且不进入 mesh。 | 已验证 |
| U20-17 | mesh adapter 把 capability / `AuthorityCallContext.deadlineAt` 的业务授权时限直接作为传输截止时间；凭证过期后请求在 submission guard 前即被中止，且 `submitBundle` 仍先尝试资产上传。 | 业务授权时限、传输资源时限与耐久重放分类由 adapter 混为一个所有者，越过 owner/executor guard 的唯一分类权。 | owner→executor 控制、executor→owner started/mirror/cancel-proof/bundle、已提交 bundle 的响应丢失重放、稳定耐久拒绝、资产上传及 worker 重启重驱；过期历史凭证无法取得合同允许的零写 replay/rejection。 | mesh request channel 单一持有传输超时，业务时限只由端口 guard 判定；`submitBundle` 在授权时限已过时不得写临时资产，直接把既有 bundle identity 交给 owner guard，允许已耐久对象 replay/rejection，fresh 写仍 fail-closed。覆盖过期 exact replay、稳定拒绝、fresh 资产写拒绝和 owner-control 恢复。 | 已验证 |
| U20-18 | submission guard 已能仅凭耐久投影判定历史 attempt、旧 epoch、终态或打开 conflict 的稳定拒绝，但 preflight 返回值为 `void`，mesh handler 随后仍读取 bundle 并深验 closure；冷恢复时缺失非必要资产会把合同要求的零写拒绝/回放变成 transport 失败。 | guard 的终结能力没有穿过 adapter 接口，payload 读取与 fresh 提交深验没有按耐久分类分层。 | conversation/job `submitBundle` 的 durable-rejection、committed exact replay、owner 冷启动、executor 资产丢失与响应丢失重投；现有测试只覆盖资产仍在场的回放。 | preflight 返回 `continue` 或稳定 bundle 结果；adapter 对稳定结果零读取直接返回，其他路径只加载 bundle artifact，closure 深验唯一归 owner port 的 fresh 提交分支。覆盖无 bundle artifact 的稳定拒绝、committed 回放不读依赖 closure、fresh 提交仍完整深验。 | 已验证 |
| U20-19 | 已认证连接建立后，local endpoint 只发送一次；接收端一次瞬时耐久失败即永久放弃本连接内的更新。旧端点随后失效时，拨号方可能无法建立触发再次发布的新连接。 | 耐久端点更新被实现为 fire-and-forget 通知，没有由当前认证连接持有直至稳定结果的重驱义务。 | anchor 端点变更、接收端瞬时磁盘失败、长连接存续及后续断线重连；失败只上报，现有测试仅覆盖连接建立。 | 每条认证连接持有本机端点发布义务；`service-failed` 按有界退避重试，连接关闭、控制面停止或稳定协议拒绝即终结。补一次耐久失败后同连接自动写入新 revision 的测试。 | 已验证 |
| U20-20 | pairing continuation 的在线完成清理只在连接建立时尝试一次；`markBootstrapComplete`、continuation 清理或候选 secret 删除出现瞬时 IO 失败后，当前长连接存续期间不再收敛。 | 端点发布与 bootstrap 清理两项连接期耐久义务缺少共同的生命周期重驱所有者。 | pairing ACK 后崩溃恢复、完成标记、issuer continuation 与候选 secret；失败会长期保留恢复态和秘密，直至下一次断线或重启。 | 单源连接期义务执行器统一持有成功、稳定拒绝、连接关闭和有界退避；bootstrap 清理对本地耐久失败持续重驱。覆盖不确定失败重试与稳定拒绝终结。 | 已验证 |
| U20-21 | issuer/joiner 的完成、过期和在线恢复路径先清 continuation、后删候选 secret；删除失败后已失去 offerId/peer 的耐久恢复依据，重驱仍会留下孤儿秘密。joiner 在 continuation 保存失败前的回滚还只删 pairwise secret。 | 多资源清理顺序未遵守“恢复依据最后删除”，失败回滚也未覆盖全部已创建秘密。 | 正常完成、已完成重启、过期未提交、issuer 在线完成及 joiner proof-ready 前失败；候选 pairing/pairwise secret 的驻留与后续新配对。 | 所有路径统一先写可恢复的 `secret-pending`，再写秘密并推进可续接阶段；完成/废弃统一先删 secret、最后清 continuation，任一失败均保留恢复依据。覆盖 direct QR/short、响应丢失续接与连接期清理。 | 已验证 |
| U20-22 | 生产 executor 逻辑身份为 `executor:<deviceId>`，提交服务却与认证连接的原始 `deviceId` 直接比较；adapter 测试把两者设为同值，掩盖了远程 started/提交/交互都会被拒。 | 设备传输身份到 executor 逻辑身份的映射只接入资产和 usage，提交入口另写了相等谓词。 | reportStarted、submitBundle、submitCancelProof、mirrorInteractions；生产组合根、认证 peer、提交 guard 与现有同值 fixture。 | anchor 组合根提供唯一 `executorIdForPeer`，提交与 usage 共用；未知或非活跃 peer fail-closed。补原始 deviceId 映射到带前缀 executorId 的直接测试。 | 已验证 |
| U20-23 | 角色拆分后，本地单机协议测试仍直接构造 `ConversationProtocolRuntime`，未提供已变为显式依赖的 local executor，导致 9 条合法用例在执行前失败。 | 测试组合根未随生产角色装配边界同步，隐含依赖被误当成协议行为。 | 单机 conversation 的准入、恢复、取消、提交与投影测试；不影响生产组合根。 | 测试工厂显式注入真实 local executor 端口，允许个别用例覆盖依赖；目标文件 19/19 与 CLI 整包 2411/2411 通过。 | 已验证 |
| U20-24 | 首次签发配对邀请时先耐久 `offered` continuation，后写候选配对秘密；两步之间崩溃后，未过期 continuation 会因秘密缺失持续失败，无法立即续接或重新出码。 | acceptance 前的 continuation 与 SecretStore 跨存储写序缺少可恢复的中间态；U20-21 只闭合了后续 `secret-pending` 与清理路径。 | issuer 首次 direct/relay、QR/short 出码，进程崩溃、重启和旧 offer 未过期窗口；joiner、acceptance 后续接与完成清理已核查无同类遗漏；现有测试未注入该崩溃点。 | 将首次候选秘密与可判定恢复状态按崩溃安全协议提交；重启时仅凭耐久材料即可续接，或在 acceptance 前自动废弃并立即重新出码，不等待旧 offer 过期。补两次耐久写之间崩溃及重启测试。 | 已验证 |
| U20-25 | 生产 `RemoteConversationExecutionDirectory.select()` 只从 trust-active executor 中按 deviceId 排序取首个，不检查认证连接在线状态、CapabilityDescriptor 与 ExecutionManifest 匹配，也不执行显式绑定/近期亲和策略；存在本地或后续健康 executor 时仍会固定选择首个离线/失配设备。 | 组合根以“受信任设备枚举”代替 owner 的唯一 `ExecutorSelector`，把信任、在线、能力与稳定路由四个谓词拆散到派发后的失败路径。 | 普通 conversation 的初次 assignment、离线/失配/多候选 executor、可用本地回退与恢复重驱；已分配恢复必须保持原 executor，不属于重选范围；job 产品入口按 X20-01 排除。现有测试未覆盖生产 selector。 | 在 assignment 耐久前由单一 selector 联合 trust-active、已认证在线连接与版本化能力匹配，按显式绑定、近期亲和及冻结的本地策略稳定选宿；无匹配保持排队并暴露能力缺口，不得先派发再猜。覆盖首个离线但次个在线、首个失配但次个匹配、多候选稳定性、本地策略及恢复不重选。 | 已验证 |
| U20-26 | 本地 conversation 执行把 `ingress.turnOrigin` 写入全部 agent-event、agent-yield 与 interaction 帧；远端 worker 只给 interaction 写入，event/yield 使用空元数据或仅 lineage。`StreamDigestChain` 对 `{seq,payload,meta}` 摘要，故同一合法输入在两拓扑生成不同 `streamFinal.streamDigest`。 | 两个执行拓扑分别组装 stream 元数据，远端实现没有消费 `ConversationDispatch.ingress` 这一唯一来源。 | channel-origin 普通 conversation 的 event、yield、interaction 组合，SealedBundle 签名摘要、owner 对账及第 21 单元 spool/路径切换；job 无 turnOrigin。现有测试只验证本地 digest，未做 local/mesh 等价。 | remote worker 从 envelope ingress 一次派生不可变 `streamMeta`，所有数据帧统一复用，event 只叠加 lineage；补含 event/yield/interaction 的 channel run 本地与远端 `streamFinal` 一致性测试。 | 已验证 |
| U20-27 | 外层已改为先取得 `runStartupCheck` ready，但 `loadConfig` 只把 `mesh` 强转为类型，ready 未运行 mesh 合同校验；`prepareMeshRuntimeBootstrap` 又先 `loadOrCreateDeviceKey`、后经 `resolveEffectiveMeshRoles` 校验配置。非法字段或角色参数因此会绕过结构化诊断；其中运行时形状错误还会先写设备密钥再失败。 | 统一 startup preflight 没有消费 mesh 的单源运行时谓词，bootstrap 自身也未把纯校验置于首个设备域副作用之前。 | `zhixing serve`、REPL 共用 startup、bootstrap 直接调用、首次设备密钥、anchor endpoint 与角色装配；非法 mesh 配置可留下设备身份副作用，现有 topology mock 只证明外层调用顺序。 | 让同一 `validateMeshRoleBootConfig` 完成形状与本地角色参数校验：startup 在触碰 SecretStore 前将失败转为结构化配置错误，bootstrap 在创建设备密钥前再次执行该纯谓词；trust 授权子集仍在读取 trust 后校验。补 startup 零 unlock、bootstrap 零 key 及 mesh 正反例测试。 | 已验证 |
| U20-28 | `MeshRuntimeAssembly.stop()` 先等待 `worker.close()`、后关闭仍可接收请求的 control plane；`ConversationAssignmentWorker.accept()` 又不拒绝已关闭状态。停机窗口内的新 dispatch 可在 close 已取运行任务快照后启动，既不被 abort 也不被等待，停机返回后仍可能执行模型或工具。 | 停机只中止已有执行，没有先关闭远端准入，也没有在 worker 自身建立关闭栅栏。 | executor-only 与本地双角色宿主、已认证连接、dispatch durable accept、运行时副作用及进程停机；当前测试只覆盖既有运行被 abort，未覆盖 close 与新 dispatch 并发。 | worker 先同步关闭准入并让 `accept` 在关闭后只保留已耐久待恢复事实、绝不启动任务；再关闭 control 断开入口，最后 abort/drain 已有任务。补 dispatch 与 close 交错、停机后零新 runtime 及下次启动可恢复测试。 | 已验证 |
| U20-29 | worker 恢复 sealed assignment 时，`#resumeSealedSubmission` 对 `ledger.sealedBundle()` 的任意异常均静默 `return`；瞬时存储失败和账本/资产损坏都被当成“没有 sealed bundle”，任务从运行表消失且本进程无再次恢复触发。 | 非 sealed 状态与不确定耐久读取失败共用无类型异常分支，吞掉了可重驱义务和损坏可观测性。 | executor 启动恢复、sealed 未 ACK、重复 dispatch、ArtifactStore/ledger 瞬时失败或损坏、owner 提交与 ACK；现有测试只覆盖成功恢复。 | 让 ledger 返回带 phase 的类型化结果，显式区分“无 sealed bundle”与读取失败；对启动枚举出的 sealed 义务，不确定存储错误有界重驱，完整性错误 fail-stop/上报。补首次读取失败后同进程成功提交、非 sealed 重放零误报及损坏显式失败测试。 | 已验证 |
| U20-30 | 新增 serve topology 启动入口直接使用 15 处 `console.log/error`，CLI 全包的统一输出端口门禁失败。 | 拆分生产入口时只迁移了输出内容，没有把既有 CliWriter 依赖一并显式传递。 | server 启动失败诊断、非交互输出、测试注入与 CLI chrome 不变量；功能状态机不受影响，但交付门禁不成立。 | `runServeCommand` 接受可注入 CliWriter，默认使用无 chrome 的 stdout writer；全部诊断统一走 `writer.line`，测试注入 writer 验证内容，不扩充例外清单。 | 已验证 |
| U20-31 | 派生产物闭包仍记录 mesh `94/94`、CLI `169/169、2411/2411`，而有效验证账本已是 mesh `95/95`、CLI `170/170、2420/2420`。 | 最终窄修复更新了验证账本，却未同步重复维护的派生产物摘要。 | 工作台证据一致性与后续复审复用；不影响业务功能。 | 以验证账本为结果单源，派生产物表只引用证据编号；两处不得继续重复维护结果计数。 | 已验证 |
| U20-32 | `assignment.artifacts` 只验证 capability 的签名可由历史信任集合通过、请求 `assignmentId` 与 `executorId`；不检查签名者是 assignment 权威、不命中 assigned/received 激活，也不检查 `ref` 属于该 assignment 闭包。活跃 executor 可用自身设备密钥自签未来 capability，在 anchor 上读任意已知 ref，或反复写任意最大 512 MiB 的 ref。 | 资产通道旁路 S3/S4 双侧激活 guard，把“历史真实性”误当“当前授权”，且没有耐久的传输闭包与聚合预算。 | owner→executor 与 executor→owner 的 probe/read/append，历史/伪造 assignment、跨闭包资产、ArtifactStore 机密性与磁盘容量；现有测试只拒绝请求字段与 capability 的 assignmentId 不同。 | 以 owner 签发的耐久激活为唯一授权根，派生短时 transfer grant 并绑定认证源/目标、方向、精确规范化 ref 集、聚合字节与 TTL；owner→executor 由 owner 签发，executor→owner 只允许激活指定的 executor 签发。存储访问前验证全部绑定，并覆盖错 signer、未激活、跨 ref/assignment、预算及过期。 | 已验证 |
| U20-33 | 双角色宿主把本机 `assignment.executor` 注册到所有认证连接共用的 registry；anchor 接受的远端 executor 因而可调用本机 executor。handler 未检查 peer 为 owning anchor，且以尚未绑定 dispatch 的请求摘要先写 `control-lease-renewed`，再加载 envelope 校验真实控制身份；未授权 peer 或合法 anchor 的错配请求均可先污染账本再失败。 | 本地启用角色被误当作远端调用权限；服务分发与两阶段 preflight 都没有在首个耐久写前闭合“本地角色 × peer 角色 × owning authority × 真实载荷”的单一授权。 | 默认 anchor+executor 拓扑、远端 executor 横向调用、任意 assignment 的账本污染与 owner 抢占；后续 activation/dispatch 校验失败不能撤销已落盘控制租约。 | 在分发线性化点建立按认证 peer 的角色化服务视图；executor 写服务只允许 owning anchor。dispatch 必须先从已验签 envelope 得到控制绑定并与请求摘要一致，再调用耐久 preflight；cancel/supersede/query 也须先完成身份字段运行时校验。补远端 executor、合法 anchor 错配 envelope/activation 的零写入测试及完整服务矩阵。 | 已验证 |

## 已排除问题

> 保存已证伪疑点供复审复用;使用与重开规则见工作台静态区。裁决只允许“已排除”或“已重开→问题编号”,重开时保留原行。

| 编号 | 原疑点与已验证事实 | 排除依据与适用边界 | 证据与输入基线 | 重开条件 | 最终裁决 |
| ---- | ------------------ | ------------------ | ---------------- | -------- | -------- |
| X20-01 | 第 20 单元是否必须接通 job 产品生产入口。 | 本单元交付通用 job mesh adapter；scheduler/job 产品拓扑归第 26 单元。 | execution plan 第 20、26 单元边界；当前通用 adapter 测试 | 第 26 单元边界调整 | 已排除 |
| X20-02 | 是否应同时实现 stream、确认、内容与回复数据面。 | 第 20 单元只启用控制面；数据面与 surface 归第 21～24 单元。 | specification 单元顺序与当前模块依赖 | 第 21～24 单元边界调整 | 已排除 |
| X20-03 | 是否应远端执行 perspectives、advancement、scheduler 或 subagent invocation。 | 这些模块的远端业务语义归第 26～28 单元；当前只允许普通 agent invocation。 | invocation 判别门禁与 execution plan | 后续模块提前并入本单元 | 已排除 |
| X20-04 | 公共 service host 加载是否等于未授权 mesh 角色激活。 | 终审证实公共 host 会无条件创建 authority、conversation owner 与 recovery，已超出无副作用组合根。 | role topology、profile 与 access-surfaces 生产装配 | 已满足：公共 host 产生角色专属权威副作用 | 已重开→U20-12 |
| X20-05 | CLI `tsc --noEmit` 的 8 项 credential projection 类型错误是否由本单元引入。 | 错误文件与消息和 X18-01 既有基线一致，均在 config-editor/startup；第 20 单元改动文件无新增类型错误。 | 当前指纹类型检查；CLI 构建及 2411 项包测通过 | 本单元改动文件出现类型错误，或既有 8 项的文件、数量、消息发生变化 | 已排除 |
| X20-06 | pairing 最终 `bootstrap-complete` ACK 丢失后，issuer 是否永久保留 continuation 与候选秘密。 | issuer 保留 `commit-ready`；joiner 已耐久完成后建立的任一认证连接都会触发连接期义务，按 peer/offer 幂等完成标记、删 secret、最后清 continuation。 | pair command 完成写序、`MeshRuntimeAssembly.#finalizePairingBootstrap` 与连接期重驱 | 移除认证连接上的完成义务，或完成清理不再保留 `commit-ready` 恢复依据 | 已排除 |
| X20-07 | trust enroll 先于 transport peer 文件可见时，在线 anchor 是否永久错过新 peer。 | control plane 每秒同时重读 trust 与 transport peer；即使首轮因 peer 尚未落盘而不重启，后续 `peersChanged` 仍会触发 transport 重建。 | `#watchTrust`、`#refreshTransportPeers` 与 `reconcileTrust` 的联合条件 | 轮询不再观察 transport peer 变化，或 peer 更新改为无可观测存储 | 已排除 |
| X20-08 | endpoint 发布只重试 `service-failed`，是否会在 `request-timeout` 后于同一连接永久丢失更新义务。 | `MeshRequestChannel` 的 request timeout 会立即停止 channel 并关闭认证连接；连接期义务随连接终结，拨号方重连后重新建立并发布 endpoint。当前 endpoint 服务的可持续瞬时耐久错误统一包装为 `service-failed`，现有谓词覆盖该形态。 | request-channel timeout/close 写序、control-plane 每次认证连接的 endpoint obligation 与 U20-19 收敛测试；指纹 `aa630b93…96a2` | request timeout 不再关闭连接，或 endpoint 服务新增不会断连且表示瞬时失败的错误码 | 已排除 |
| X20-09 | 第 20 单元是否必须实现显式设备绑定与近期亲和的完整选宿策略。 | 本单元启用的普通 conversation 只生成无 device/workspace 的环境要求；设备绑定、workscene 与业务亲和输入尚无生产者。当前候选已按 trust-active、认证在线、能力匹配筛选并以 deviceId 稳定排序，本单元可达输入不存在被忽略的更高优先级信号。 | charter §7、当前 manifest 构造、RuntimeExecutionProfile 与生产 selector；指纹 `aa630b93…96a2` | 任一生产入口开始提供 `EnvironmentRequirement.deviceId/workspace`、显式绑定或耐久亲和事实 | 已排除 |
| X20-10 | control plane 与 worker 使用启动时 issuer，在线 `issuer-transition` 后不会切换拨号和提交目标。 | 第 20 单元没有 issuer-transition 生产入口；当前可达 trust 更新仅为配对、角色与撤销，计划迁居和灾难恢复归 S9 后续单元。当前 issuer 冻结不影响本单元可达行为。 | charter §9/S9、specification 迁居状态机、当前 pairing/control-plane/worker 生产路径 | 本单元边界纳入 issuer-transition，或生产路径可在不重启时接收并生效该事件 | 已排除 |
| X20-11 | `contracts:lint` 是否证明本轮合同变更违规。 | 唯一报错来自未被第 20 单元修改的 `core/authority/artifact-store.ts` 流式 SHA-256；本轮 schema typecheck 通过且新增 grant 无 lint 报错。 | `git diff HEAD -- artifact-store.ts` 为空；V20-22 | 本单元修改该文件，或 lint 新增指向第 20 单元变更的违规 | 已排除 |
| X20-12 | core 前台包测的 3 项 5 秒超时与 1 项文件锁繁忙是否为功能回归。 | 同时误启动的后台 core 全测已 145/145 文件、2400/2400 项通过；失败文件隔离后 31/31 通过，随后单 worker 全包再次 2400/2400 通过。失败由重复重型验证资源竞争造成，无功能断言不一致。 | V20-23；指纹 `f126d78f…0d08` | 无重复验证负载时隔离用例或单包全测出现可复现失败，或失败变为功能断言不一致 | 已排除 |

## 迟发现教训

> 仅登记“先前通过后才发现”的真实遗漏。检测动作必须可执行并写明适用范围;每个适用轮次追加执行证据。

| 编号 | 对应问题与先前通过轮次 | 遗漏机制 | 后续必做的检测动作与适用范围 | 应用记录（轮次:证据） |
| ---- | -------------------------- | -------- | ------------------------------------ | ---- |
| L20-01 | U20-08、U20-12～U20-14；实现收口 | 组合根测试只证明启动成功，未逐项验证在线信任增量、角色零实例化、先耐久后可见及 continuation 自足恢复。 | 对每个角色/缓存-耐久双写/跨崩溃状态，机械检查在线变更、写失败、重启恢复和禁用角色零副作用四类路径。 | 集中修复前:交叉复核已覆盖 trust、角色、endpoint 与 pairing continuation；冻结终审一:真实角色求值、endpoint 先耐久后可见及 continuation 自足恢复通过；冻结终审二:在线 trust 增量、撤销断连与跨崩溃恢复通过。 |
| L20-02 | U20-10、U20-15；实现收口及 U20-10 先前验证 | 只测了部分连接错误方向，未把全部返回形态和预认证资源生命周期作为同一所有权矩阵。 | 对每个远端入口枚举结构化 retryable true/false、未知服务失败、连接失败、本地输入错；对预认证通道枚举 deadline、abort、EOF、容量与释放。 | 集中修复前:已横扫三个 worker 消费点及 direct/relay 双侧读写与 matcher；冻结终审一:单源错误分类及 deadline/abort/EOF/容量释放复核通过；冻结终审二:远端义务分类和预认证资源矩阵独立复核通过。 |
| L20-03 | U20-16；实现收口 | 以包级全测替代执行计划字面验收，没有把每项验收映射到具体测试身份及两种 adapter。 | 冻结前逐条建立“验收项→测试套件/参数→两拓扑结果”映射；缺任一映射即登记问题，不得用包级绿色替代。 | 集中修复前:已对账 6.1/6.2/6.2b 与现有 mesh 测试，确认承载缺口；冻结终审一:双拓扑验收映射逐项完整；冻结终审二:状态机、mesh 与故障证据逐项可追溯。 |
| L20-04 | U20-19～U20-21；U20-13 先前验证 | 只验证耐久状态可恢复，未检查在线瞬时失败是否重驱及清理最后一步失败后是否仍保留恢复依据。 | 每项跨资源义务同时检查“瞬时失败继续重驱”和“恢复依据最后删除”；任一步失败后必须能仅凭耐久状态继续。 | 修复后横向审查三:端点发布、bootstrap 完成及 issuer/joiner 全部 secret/continuation 写序已横扫；冻结终审一:端点、bootstrap 与秘密清理写序复核通过；冻结终审二:重连义务与恢复依据最后删除独立复核通过。 |
| L20-05 | U20-25～U20-26；冻结轮 | 双拓扑验收只对齐端口与状态机，未对齐派发前资格谓词和进入权威摘要的逐字段输入。 | 双拓扑启用时同时比较“选宿输入与结果”和“相同逻辑输入的签名/摘要输出”；差异必须有冻结合同依据。 | 独立审查四:已对照 selector 全部输入及三类 stream 数据帧；冻结终审一:在线候选、能力选择与三类帧元数据同源；冻结终审二:assignment 前选宿与本地/远端摘要等价通过。 |
| L20-06 | U20-27～U20-29；冻结轮 | 启停测试覆盖静态拓扑和既有任务，却未检查 preflight 前副作用、关闭期间新准入及恢复读取失败分类。 | 对生产宿主机械执行“ready 前零副作用→关闭先拒新→可重驱事实不吞异常”三段生命周期检查，并注入每个边界的失败/并发。 | 独立审查五:已核对 topology、assembly、worker 与 ledger 恢复链；冻结终审一重开:沿真实 `loadConfig→ready→bootstrap` 下钻，确认 mesh 运行时校验仍晚于设备密钥写入并重开 U20-27；本轮冻结终审一:校验前置、停机栅栏与类型化恢复通过；冻结终审二:生产启停与 sealed 恢复分类独立复核通过。 |
| L20-07 | U20-12；最终验证通过后的独立终审 | mock loader 只证明工厂未调用，未证明已选宿主的传递值导入不会求值禁用角色实现。 | 角色隔离验收必须从真实进程入口检查模块求值闭包；禁用角色包或角色专属模块被加载即失败，并与零监听、零权威写共同验收。 | 本轮独立终审:静态追踪 anchor/executor 双向值导入，重开 U20-12；集中修复二:真实入口求值 10/10、结构模块图 1/1 通过；冻结终审一:真实入口闭包无禁用角色值导入；冻结终审二:动态导入门禁与生产调用点复核通过。 |
| L20-08 | U20-32；多轮安全审查与最终验证后 | 只核对 capability 字段与认证 peer 的表面一致，未追溯签发权、耐久激活及资源集合是否来自同一权威事实。 | 对每个远端服务逐项证明“签名可验证→签发者有权→耐久激活命中→资源/方向/预算闭合”；任一环仅靠请求自报即登记问题，并横扫同类服务。 | 独立审查七:收齐 U20-32～U20-33；集中修复二:grant 4/4、adapter 16/16，双侧耐久激活生产/消费对账通过；冻结终审一:三类 grant 生产端与双侧消费端闭包通过；冻结终审二:签发权、当前激活、精确资源及预算链独立复核通过。 |
| L20-09 | U20-33；多轮双拓扑审查与最终验证后 | 只按本地启用角色注册服务，未验证同一 registry 上每类远端 peer 的服务视图，也未证明 preflight 摘要在首个耐久写前已绑定真实载荷。 | 生成“本地角色 × peer 角色 × service”矩阵；逐格追踪首个耐久写，授权身份及其摘要必须先由独立可信来源验证，拒绝路径零读写。 | 独立审查七/八:收齐 U20-32～U20-33；集中修复二:registry 授权 10/10，错摘要与坏 activation 均在耐久 preflight 前拒绝；冻结终审一:服务矩阵及 dispatch 首写顺序复核通过；冻结终审二:全服务方向和拒绝前零耐久副作用独立复核通过。 |

## 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口,输入闭包必须具体到可重复计算指纹;执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口 | 最小命令或检查 | 输入闭包 | 阶段 / 成本 / 实耗 | 结果 | 证据输入指纹 | 状态 |
| ---- | ------------------ | -------------- | -------- | ------------------ | ---- | ------------ | ---- |
| V20-01 | mesh bootstrap、TLS、配对与 trust | `pnpm --filter @zhixing/mesh test --silent --reporter=dot` | mesh 源码与测试 | 包级 / 中 / 25.5s | 12/12 文件、95/95 项通过；后续仅 CLI 输出改动，输入闭包未变 | `ed1db67…2cb4` | 有效 |
| V20-02 | ledger 恢复与执行端合同 | `pnpm --filter @zhixing/executor exec vitest run --maxWorkers=1 --silent --reporter=dot` | executor 源码与测试 | 包级 / 高 / 466.7s | 4/4 文件、414/414 项通过；后续仅 CLI 输出改动，输入闭包未变 | `ed1db67…2cb4` | 有效 |
| V20-03 | 配置 schema 与解析 | `pnpm --filter @zhixing/providers test --silent --reporter=dot` | providers 源码与测试 | 包级 / 低 / 已完成 | 11/11 文件、229/229 项通过，3 skipped | `66a8748f…7abe` | 有效 |
| V20-04 | 共享合同与既有回归 | `pnpm --filter @zhixing/core test --silent --reporter=dot` | core 源码与测试 | 包级 / 中 / 已完成 | 144/144 文件、2396/2396 项通过 | `66a8748f…7abe` | 有效 |
| V20-05 | 生产组合根、control plane 与 worker | CLI 整包验证 | CLI 与上游构建产物 | 包级 / 高 / 180.6s | 170/170 文件、2420/2420 项通过 | `7018ec7c…9e96` | 有效 |
| V20-06 | CLI 类型边界 | `pnpm --filter @zhixing/cli exec tsc --noEmit` | CLI 与上游类型 | 开发 / 中 / 18.9s | 仅 X20-05 的既有 8 项；本单元文件零新增 | `ed1db67…2cb4` | 有效 |
| V20-07 | 最终构建与运行时导出 | `pnpm build`；`pnpm cli:build`；`pnpm runtime:package-exports` | 完整交付闭包 | 最终 / 高 / 已完成 | 17 包全量构建与运行时导出通过；窄修复后仅失效的 CLI 构建再通过 | `7018ec7c…9e96` | 有效 |
| V20-08 | 6.1/6.2/6.2b 与故障矩阵在进程内/mesh 双拓扑等价 | executor 既有逐边套件；CLI adapter/worker/control-plane/bootstrap/role/setup 定向套件 | 状态机矩阵、两类 adapter 与故障注入 harness | 验收 / 高 / 已完成 | executor 4/4 文件、414/414 项；CLI 170/170 文件、2420/2420 项通过 | `7018ec7c…9e96` | 有效 |
| V20-09 | 运输时限与耐久分类解耦 | `pnpm --filter @zhixing/cli exec vitest run src/serve/assignment-mesh-adapter.test.ts --silent --reporter=dot`；CLI `tsc --noEmit` 归因 | assignment mesh adapter、runtime assembly 与直接测试 | 开发 / 中 / 36.04s | 12/12 通过，含过期 exact replay、过期读与过期写；类型检查仅有既有凭据投影基线错误，改动文件零新增 | 当前未冻结交付闭包 | 有效 |
| V20-10 | submission guard 零读取终结与分层深验 | owner-kernel `tsc --noEmit`、build；CLI assignment adapter 直接测试 | 双域 journal、submission adapter 与真实 conversation/job harness | 开发 / 中 / 26.25s | owner-kernel 类型检查/构建通过；CLI 12/12 通过，含真实 guard 稳定拒绝、缺失 bundle 零读取及 committed 不读 closure | 当前未冻结交付闭包 | 有效 |
| V20-11 | 端点更新义务在瞬时耐久失败后自动收敛 | mesh build；CLI control-plane 直接测试 | endpoint 耐久提交、认证连接与发布重驱 | 开发 / 低 / 16.8s | mesh 构建通过；control-plane 5/5 通过，含首次落盘失败后同连接重试并写入新 revision | 当前未冻结交付闭包 | 有效 |
| V20-12 | 连接期耐久义务统一重驱 | CLI connection-lifetime 与 control-plane 直接测试 | 通用义务执行器、端点发布与 bootstrap 完成接线 | 开发 / 低 / 21.6s | 2/2 文件、7/7 通过；不确定失败重试、稳定拒绝终结及端点落盘收敛均成立 | 当前未冻结交付闭包 | 有效 |
| V20-13 | pairing 恢复依据与秘密清理写序 | CLI pairing 整文件 | pairing continuation、两阶段秘密写入、完成/废弃清理 | 开发 / 中 / 26.81s | 7/7 通过，含秘密写入边界、立即重发、QR/short/relay 与 response-loss resume | `aa630b93…96a2` | 有效 |
| V20-14 | 认证设备与 executor 逻辑身份绑定 | CLI assignment adapter 直接测试；Biome | submission handler、anchor 组合根与生产映射 | 开发 / 低 / 27.9s | adapter 13/13 通过；四个改动文件静态检查通过 | 当前未冻结交付闭包 | 有效 |
| V20-15 | 最终 CLI 生产装配与包内负载 | CLI 构建；CLI 整包测试 | CLI 源码、测试及当前上游构建产物 | 最终 / 高 / 已完成 | CLI 构建通过；170/170 文件、2420/2420 项通过 | `7018ec7c…9e96` | 有效 |
| V20-16 | 生产 selector 的在线、能力与稳定策略 | setup-delivery selector 定向测试 + 生产目录静态复核 | mesh 连接目录、能力目录、manifest matcher 与 conversation 组合根 | 开发 / 低 / 23.2s | 1/1 通过：失配候选跳过、后续匹配选中、本地回退；生产目录只枚举 trust-active 且已认证在线连接并稳定排序 | `aa630b93…96a2` | 有效 |
| V20-17 | channel-origin stream 跨拓扑摘要等价 | worker 与 conversation runtime 定向测试 | ingress、三类数据帧与 StreamDigestChain | 开发 / 中 / 87.8s | worker 10/10、conversation runtime 19/19 通过；event/yield 摘要及 interaction binding 共用同一 turnOrigin | `aa630b93…96a2` | 有效 |
| V20-18 | startup preflight 单源与 ready 前零副作用 | startup、bootstrap、topology 与 mesh validator 定向测试 | startup、topology command、mesh bootstrap store、mesh 配置谓词与 SecretStore | 开发 / 低 / 27.75s | mesh 合同 8/8、startup/bootstrap/topology 12/12 通过；非法配置零 SecretStore 解锁、零设备密钥写入 | `ed1db67…2cb4` | 有效 |
| V20-19 | worker 停机准入与 sealed 恢复异常分类 | worker + ledger 恢复定向测试 | control plane、worker、ledger、artifact store | 开发 / 低 / 37.1s | worker 10/10；ledger 2/2 通过：关闭后零准入、读取暂态同进程重驱、损坏显式上报、非 sealed 类型化返回 | `aa630b93…96a2` | 有效 |
| V20-20 | CLI 统一输出端口 | no-direct-console 门禁 + topology command 直接测试 | topology command、CliWriter 与静态门禁 | 开发 / 低 / 18.1s | 2/2 文件、4/4 项及 Biome 通过；诊断全部走可注入 writer，例外清单未扩大 | `7018ec7c…9e96` | 有效 |
| V20-21 | U20-12、U20-32～U20-33 合并直接验证 | core grant、mesh request-channel、CLI adapter/role/worker/runtime/setup/access-surface 定向集；CLI `tsc --noEmit` | 角色模块图、grant、双侧激活、服务方向、dispatch preflight 与直接消费者 | 合并 / 中 / 已完成 | core 4/4、mesh 10/10、CLI 6 文件 72/72；activation 前移后 adapter 16/16；CLI 类型检查仅 X20-05 的既有 8 项 | `f126d78f…0d08` | 有效 |
| V20-22 | 合同与派生资产预检 | contracts typecheck、schema typecheck、runtime exports、结构 golden、Biome、diff check | core schema/export、CLI/mesh 模块拓扑、结构基线与改动文件 | 冻结准备 / 低 / 已完成 | typecheck、schema、runtime exports、结构 1/1、20 文件 Biome 与 diff check 通过；总合同 lint 唯一旧报错按 X20-11 排除 | `f126d78f…0d08` | 有效 |
| V20-23 | 同一冻结交付物的最终构建、包级回归与机械门禁 | `pnpm build`；core、mesh、providers、owner-kernel、executor、CLI、server 串行全测；runtime exports、diff 与指纹复核 | 71 文件完整冻结交付闭包 | 最终 / 高 / 已完成 | 17 包构建通过；core 145/145 文件、2400/2400 项，mesh 12/12、96/96，providers 12/12、229 通过/3 跳过，owner-kernel 7/7、180/180，executor 4/4、414/414，CLI 170/170、2425/2425，server 41/41、745/745；运行时导出与 diff 通过，最终指纹一致 | `f126d78f…0d08` | 有效 |

### 双拓扑验收映射

| 验收面 | 状态机唯一证据 | mesh / 故障证据 | 结论 |
| ------ | -------------- | --------------- | ---- |
| 6.1 conversation 36 行 | assignment ledger 逐边、竞态与崩溃套件 | 真实 journal/ledger 生命周期、全部端口方法、取消与 supersede guard | 通过 |
| 6.2 user job 38 行 | job assignment 参数化 38 行 | 新增真实 user-job dispatch→started→bundle commit 链路；通用取消/查询/提交端口共用同一 wire 与 guard | 通过 |
| 6.2b system job 6 行 | job assignment 参数化 6 行 | system job 按冻结合同锚点本地执行，不进入 assignment mesh | 通过 |
| 跨机故障 | owner/executor 崩溃重放与幂等状态矩阵 | range 断点续传、连接重建、未知结果保留义务、sealed 重驱及重复提交回放 | 通过 |

## 终审记录

| 轮次 | 审查侧重 | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论 |
| ---- | -------- | ------------ | -------- | ------------ | ---- |
| 第一轮 | 需求、架构、功能闭环、状态、回归 | 是 | U20-08、U20-12～U20-14 | `66a8748f…7abe` | 未通过，待集中修复 |
| 第二轮 | 并发、崩溃、安全、资源上界、异常终态、测试盲区 | 是 | U20-15；补全 U20-12 | `66a8748f…7abe` | 未通过，待集中修复 |
| 修复后轮 | 全链所有权、同族根因、双拓扑、角色装配与最终验证 | 是 | U20-17～U20-23；重开 U20-11 | 当前未冻结交付闭包 | 问题均已验证，连续无新增 1 轮 |
| 冻结轮 | 完整交付物横向关系、生产/消费端、异常终态与回归证据复核 | 是 | 无 | `9c916b10…3a7c` | 第二轮零新增，最终验证通过 |
| 独立终审三 | 配对跨存储写序、崩溃恢复与同族路径 | 是 | U20-24 | `9c916b10…3a7c` | 未通过，待修复后重冻结 |
| 独立审查四 | 多 executor 选宿合同与跨拓扑权威摘要等价 | 是 | U20-25～U20-26 | 当前交付闭包 | 未通过，待集中修复 |
| 独立审查五 | 启动 preflight、停机准入与 sealed 恢复异常分类 | 是 | U20-27～U20-29 | 当前交付闭包 | 未通过，待与 U20-24～U20-26 集中修复 |
| 冻结终审一重开 | startup 真实校验链、全部连接期错误终态与选宿输入 | 是 | 重开 U20-27；X20-08、X20-09 排除 | `aa630b93…96a2` | 未通过，待集中修复后重新冻结 |
| U20-27 集中修复复核 | mesh 单源校验、startup 诊断与 ready 前零设备域副作用 | 是 | 无 | `ed1db67…2cb4` | 通过，交付物重冻结并重置两轮独立终审 |
| 重冻结独立终审一 | startup→bootstrap 线性化点与信任授权闭包 | 是 | 无 | `ed1db67…2cb4` | 通过，零新增，累计 1/2 |
| 重冻结独立终审二 | 完整单元横向关系、S5/S6 边界与既有功能兼容 | 是 | 无 | `ed1db67…2cb4` | 通过，零新增，累计 2/2；进入最终验证 |
| 最终重冻结终审一 | serve 启动输出合同、调用兼容与静态门禁 | 是 | 无 | `7018ec7c…9e96` | 通过，零新增，累计 1/2 |
| 最终重冻结终审二 | 完整单元横向关系与窄修复影响传播 | 是 | 无 | `7018ec7c…9e96` | 通过，零新增，累计 2/2；仅重取失效的 CLI 最终证据 |
| 最终验证 | 构建、运行时导出、mesh/executor/CLI 包级回归、diff 与指纹 | 是 | 无 | `7018ec7c…9e96` | 全部通过；指纹与冻结值一致，第 20 单元闭环 |
| 独立终审六 | 真实角色模块加载闭包与工作台证据一致性 | 是 | 重开 U20-12；新增 U20-31 | `7018ec7c…9e96` | 未通过，待集中修复后重冻结 |
| 独立审查七 | 远端服务签发权、peer 角色、耐久激活、资源闭包及拒绝前副作用 | 是 | U20-32～U20-33 | 当前完整交付物 | 未通过；同族服务矩阵已收齐，待与 U20-12、U20-31 集中修复 |
| 独立审查八 | 信任/连接生命周期、响应绑定、角色装配及 preflight 首个耐久写 | 是 | 无；补全 U20-33，新增 X20-10 | 当前完整交付物 | 未通过；连续零新增 1/2，现有四项问题边界完整，转集中修复 |
| 集中修复二 | 角色求值、资产授权、服务方向与 preflight 写序 | 是 | 无新根因；补齐 U20-33 activation 验签 | 当前待冻结交付物 | 四项问题均已验证；派生预检闭合，进入冻结准备 |
| 冻结终审一 | 角色求值、跨存储恢复、预认证资源、资产授权、服务方向、首个耐久写与双拓扑全链 | 是 | 无 | `f126d78f…0d08` | 通过，零新增，累计 1/2 |
| 冻结终审二 | assignment 全生命周期、历史验签/当前授权分离、重连重放、角色启停与 S5→S6 边界 | 是 | 无 | `f126d78f…0d08` | 通过，零新增，累计 2/2；进入最终验证 |
| 最终验证 | 全量构建、受影响包回归、运行时导出、diff 与指纹 | 是 | 无；X20-12 排除资源噪声 | `f126d78f…0d08` | 全部通过；交付物未修改，第 20 单元完成 |

<!-- registration-complete: unit-20.gen-1 -->
