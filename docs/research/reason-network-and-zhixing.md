# Reason Network与知行：产品、架构与通信判断

日期：2026-10-20。状态：总控与战略架构师分别独立分析、交叉质询后共同认可。本次是产品与架构判断，不代表安装、通信或新架构实施已经验收；没有裁撤产品能力。

研究对象：[reason-machines/reason-network](https://github.com/reason-machines/reason-network/tree/69ddc39237cb1174f629b75b22fa713d8f20d4f4)，v0.10.8，固定提交69ddc39237cb1174f629b75b22fa713d8f20d4f4。知行已提交基线4920f19c；工程师昨晚的11份产品/测试增量未验，原样保留。执行路线只在[终端迁移执行计划](../tasks/terminal-migration-delivery-plan.md)维护。

## 1. 共同结论

**保留跨设备使用的用户价值，收敛权威移动对普通业务的影响；通信和执行实现保持可替换，不因现有投入而认定必须全部自建。**

RN原样不能承担知行当前承诺的全部个人助理与任务执行责任，但它确实覆盖一部分跨设备协作场景，并提供值得复用的异构Agent通信实现。“不同层”不是拒绝替代的理由；替代应比较需要谁补齐哪些责任及其净成本。

现阶段不建议裁掉原生跨端，不用它替换整个mesh/authority/runtime组合，也不新开通用通信平台或独立底座重写项目。依据是当前责任覆盖与替代方案的剩余收益尚不足以证明更优，而不是“已经实现就必须保留”。这不是未来唯一架构的断言。

## 2. 用户需要与技术选择

知行是可独立部署的通用个人智能体，服务生活与工作，长期朝伴身智能发展。用户需要在真实文件、工具和设备上完成事情、持续可用、状态连续、体验简单，不需要理解内部拓扑。[产品定位](../../README.md)、[产品哲学](../philosophy.md)、[原始需求](../../research/design/modules/distributed-runtime/always-online-and-local-execution-requirements.md)是判断起点。旧Memory已退役，不能把“已有统一长期记忆”当作事实。

| 用户价值 | 与权威移动的关系 |
|---|---|
| 一台电脑上的完整能力 | 不依赖权威移动 |
| 常开设备值班，定时任务和消息接入持续可用 | 可以由固定所有者提供 |
| 在指定电脑真实环境执行，离线排队、上线续接 | 可以远端执行而保持所有者不动 |
| 从不同设备继续同一对话和任务 | 可以访问同一所有者，不必为每次交互迁移权威 |
| 本机交互顺畅、配对和使用简单 | 是体验要求，不规定具体底层实现 |
| 值班设备失联时本机继续并在之后并入，更换或丢失值班设备后保持连续 | 需要明确的状态接续/承接机制；现架构通过收编、迁居和灾备实现，具体做法和范围可重新评估 |

收编、迁居、灾备不是因为已有代码而不可讨论。若缩小它们，必须说明离线对话可见性、跨设备续聊、停机切换及恢复体验的具体变化，再由用户裁决。

## 3. RN的实际架构和保证

每台机器运行一个Rust守护进程，MCP、CLI和宿主插件/钩子接入会话；SQLite保存会话名、信箱、outbox与回执。跨机器使用iroh 1.3 QUIC，支持mDNS、打洞和加密中继。默认可使用n0发现/中继，也能自建中继；“无需自建服务器”不等于没有中继或发现基础设施。[网络源码](https://github.com/reason-machines/reason-network/blob/69ddc39237cb1174f629b75b22fa713d8f20d4f4/src/net.rs)、[持久化源码](https://github.com/reason-machines/reason-network/blob/69ddc39237cb1174f629b75b22fa713d8f20d4f4/src/store.rs)

成员与机器身份用签名名册管理。公开消息帧为Hello、State、Presence、Msg、Ack；没有自动接管个人助理的业务状态。MCP提供list_team、send_message、ask_user，以及不能主动推送时的check_inbox。不同宿主分别有push、turn、pull等级，普通MCP通知不是通用唤醒入口。[协议](https://github.com/reason-machines/reason-network/blob/69ddc39237cb1174f629b75b22fa713d8f20d4f4/src/proto.rs)、[MCP](https://github.com/reason-machines/reason-network/blob/69ddc39237cb1174f629b75b22fa713d8f20d4f4/src/mcp.rs)

消息ID去重与至少一次投递同时存在；90秒未确认的推送可再出现。正文上限64KiB，存在入站限速及Agent循环限制。outbox超过7天会清理；离线会话超过一天可连同未读信被遗忘；新会话可能继承同仓库、同类Agent的名称和信箱，名称不等于永久绑定原会话。[投递](https://github.com/reason-machines/reason-network/blob/69ddc39237cb1174f629b75b22fa713d8f20d4f4/src/daemon/mail.rs)、[会话登记](https://github.com/reason-machines/reason-network/blob/69ddc39237cb1174f629b75b22fa713d8f20d4f4/src/daemon/sessions.rs)

socket写入成功可被记为Delivered/read，不证明模型已处理、回信或任务完成。至少一次也不意味着必然重复副作用：接收应用可以承担任务幂等、执行账本和未知结果处理，但这些保证不能从消息回执中获得。

项目采用MIT OR Apache-2.0。其朋友团队信任模型、入站策略及本机审批证明有明确边界；机器签名不能对抗已经控制本机的软件。采用时必须保留我们的代理来源、固定身份、授权和串行交付规则。[设计及信任边界](https://github.com/reason-machines/reason-network/blob/69ddc39237cb1174f629b75b22fa713d8f20d4f4/DESIGN.md)

## 4. 按用户场景比较

| 场景 | RN或其连接的Agent能做什么 | 产品/接收应用仍须承担 |
|---|---|---|
| Claude与Codex讨论方案 | 发现、投递、唤醒、回复路由 | 用户授权、整轮协作、审查和业务完成判断 |
| 家中请求公司电脑Agent整理资料 | 请求可传到已有Agent，由它执行并回信，存在真实功能重合 | 环境与能力匹配、权限、任务身份、结果验收和恢复 |
| 多设备上的同一助理连续工作 | 可以作为连接或协作适配之一 | 对话/任务状态、原始请求与确认归属、持续服务和调度 |
| 断线、重启、结果未知 | 保留和重投消息、提供网络状态 | 不重执行已知完成工作，未知结果如实呈现，终态及预算结算 |
| 收编、迁居、灾备 | 本仓库不提供知行的对应状态承接实现 | 来源认证、旧写者失效、安装恢复与兼容；可换实现，但须计入责任和成本 |

知行也不保证外部世界副作用恰好一次：既有合同区分已完成未提交、可证明未开始和结果未知，未知进入uncertain，不能盲目重执行。不能把消息网络说成必然重复、把自研实现说成绝对不会重复。

外部Agent原则上可以成为执行实现。当前其工具、权限、确认及生命周期属于各自宿主，承接我们完整能力与结果接受合同需要适配和验证。尚未证明整体替换的净收益更高，因此本次交付不扩入外部执行者项目；这不把知行自己的认知内核永久定为唯一实现。

## 5. Claude Code与Codex如何收消息

RN主要路径是：发送方 → 本机daemon → 跨机时的iroh → 接收方daemon → 该Claude会话自己的MCP子进程 → 消息socket → 原Claude进程。同机无需跨机器网络。

Claude向自身子进程提供消息socket及所需本机认证上下文。Unix使用域socket，Windows使用named pipe。主路径不要求关闭VS Code标签、不分叉对话，也不启动第二个claude进程resume同一会话。[原生投递](https://github.com/reason-machines/reason-network/blob/69ddc39237cb1174f629b75b22fa713d8f20d4f4/src/agent.rs#L203-L243)、[MCP事件处理](https://github.com/reason-machines/reason-network/blob/69ddc39237cb1174f629b75b22fa713d8f20d4f4/src/mcp.rs#L337-L350)

仓库另有daemon依据会话登记直接投递的分支，Windows该分支读取本机peerToken文件。本次没有读取这些令牌，也不把它作为我们的接入方案。Codex主路径调用codex queue --thread指定既有对话；钩子补充回合内上下文。不能把DESIGN列出的其他备选机制当作本版本已实现路径。[Claude登记](https://github.com/reason-machines/reason-network/blob/69ddc39237cb1174f629b75b22fa713d8f20d4f4/src/claude.rs)、[Codex投递](https://github.com/reason-machines/reason-network/blob/69ddc39237cb1174f629b75b22fa713d8f20d4f4/src/daemon/mail.rs#L256-L310)

本机只读核验：2026-10-20，VS Code的Claude Code 2.1.301目标架构师会话存活，普通登记中确有Windows消息管道。**这是入口存在证据，不是端到端通信已验收。** 之前把并发resume冲突扩大为“面板开着就无法收消息”的判断应纠正，具体版本和授权继承仍须在接入时核实。

官方Claude channels也支持向运行会话推送，但有相应开关、认证及组织条件，与本仓库的实际socket路径不能混作一回事。[官方说明](https://code.claude.com/docs/en/channels)

## 6. 知行的耦合与要调整的边界

认知内核已通过运行信封、事件和SessionRuntime适配与产品owner衔接，不是全部内核绑死mesh。但本机与跨端共用的权威、恢复、资源和Host装配仍有实质关联；1a中导入来源、迁居后当前owner和执行证明就是实际交界。分包不等于改动影响已被封闭。

| 状态类型 | 来源/承接机制负责 | 领域仍负责 |
|---|---|---|
| 原生会话 | 既有权威与运行边界 | 业务事实、读模型与恢复义务 |
| 完整home迁居/灾备后 | 已验来源与安装、日志视图、当前owner/任期及围栏 | 业务映射、合法权限/设备环境语义和受影响回归，不重复解释迁居协议 |
| 收编后的会话 | 认证基线、来源命名、转移状态机、committed-base及原子发布 | 由认证资料构建当前/exact/pending视图，保持业务语义、兼容及恢复，不自行拼原WAL或计算迁移任期 |

**这是责任目标，不是“零领域工作”的保证。** 种子构建可能分页、读取制品并保存恢复进度，不冻结为一个纯函数。新增状态仍可能需要兼容、删除/clear、精确历史读取及回归。设备管理、信任、工作区的设备身份是合法业务，不能一律禁止；要限制的是普通业务自行推断来源、迁移代际和当前权威。

不因此建设通用迁移平台、提前改造全部领域或增加每包一轮全面架构审计。随现行任务处理实际越界；共有端口无法承接真实义务时，带证据交双方判断，不用“两包之后”之类任意阈值。当前慢点也包含历史扫描与同步维护，不能无测量地把全部时间归于跨端，或承诺换网络后自动消失。

## 7. 开发通信推荐及代价

针对目前同机两个既有会话，推荐保留文件信箱正文与协作约定，以宿主原生入口替代用户手动唤醒：Claude自身受授权的会话适配使用父会话socket，Codex用已验证queue。保持固定会话、消息关联/去重、代理来源、串行交付与权限边界；不另起执行者、不读出或转交令牌、不绕过权限。

理由是身份、合同与生命周期贴合，不是“代码少所以维护免费”。我们承担私有宿主接口变化的维护，具体实现仍需验收。会话适配也会随宿主常驻，只是不必注册独立登录服务。

RN可无团队只服务本机、关闭自动更新，经MCP按需启动daemon，不必使用全局setup或登录服务。不能按默认配置否决整套采用；若实际接入证明上游本地模式更省维护且能精确绑定，应优先复用。**本研究没有启动安装、配置修改、自动唤醒或新测试会话。**[本地运行](https://github.com/reason-machines/reason-network/blob/69ddc39237cb1174f629b75b22fa713d8f20d4f4/src/daemon/mod.rs#L42-L78)、[按需启动](https://github.com/reason-machines/reason-network/blob/69ddc39237cb1174f629b75b22fa713d8f20d4f4/src/client.rs#L166-L218)、[关闭更新](https://github.com/reason-machines/reason-network/blob/69ddc39237cb1174f629b75b22fa713d8f20d4f4/src/daemon/update.rs)

## 8. 对当前工程的决定与保留风险

- 保留工程师11份未完成产品/测试增量。交互长尾仍是已证用户体验工作，推荐由同一工程师从原证据接续，不重新熟悉、不回滚有效成果。
- 前置包不夹带通用权威边界改造；1b、2和3～7维持共同顺序，在原任务必要审查中落实上述约束，不另立平台项目。
- 通信接入与产品工程分开安排。战略结论交用户前工程保持暂停；本轮没有恢复、安装或裁撤。
- B方向仍有跨端和兼容维护成本。未来若有更低剩余成本且完整兑现需求的替代，应当更换；没有证据宣称成本最低、降至十分之一或边际成本接近零。
- 若缩减收编或某类在线迁居，必须说明具体连续性变化、旧资料处理、替代责任和净成本，再作范围裁决。

本次直接阅读固定源码与知行相关实现，未构建/运行RN。CI声明三平台Rust单测；two_machines.py是在一台主机两个home、模拟Agent，其中Codex命令为fake替身。DESIGN另声称macOS真实会话验证，不能扩大为我们已验证Windows/VS Code。验证边界影响接入成本，不用于否定跨端用户价值。[CI](https://github.com/reason-machines/reason-network/blob/69ddc39237cb1174f629b75b22fa713d8f20d4f4/.github/workflows/ci.yml)、[测试脚本](https://github.com/reason-machines/reason-network/blob/69ddc39237cb1174f629b75b22fa713d8f20d4f4/tests/e2e/two_machines.py)

双方独立稿、质询及20261020T112946255明确确认保存在本机协作记录20261020-reason-network-strategy-69dd。本文保留长期结论与公开源码依据，过程信件不是另一份执行计划。
