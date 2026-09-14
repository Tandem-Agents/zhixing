# AE-001 边界纠偏双人协作

类型：自主执行与独立审查协作文档。

本文只维护双方交接、问题处置和验证证据；目标、四个单元范围与完成状态以[迁移任务](../tasks/ae-001-companion-intelligence-architecture-migration.md)第九节“架构边界补充纠偏”为唯一权威。

## 双方与沟通

| 职责 | 对话名称 | 对话 ID |
|---|---|---|
| 执行、问题核实与修复、最终验证、维护本文和任务状态 | zhixing 项目调度者 | `01a02f45-1a72-7690-90e8-9e8def854d08` |
| 四个执行单元的独立架构与功能审查 | zhixing项目架构师 | `01a06ff2-bf10-7f83-b982-f462c4594ed9` |

双方 host 均为 `local`，共享工作区 `E:\Dev\longxia\zhixing`。通过对话消息工具直接互发交接，等待对方结果使用任务等待工具；不要求用户转述，不另建对话。消息写清单元、轮次、所审输入、请求和结论。恢复时先读本文与任务当前台账，再读对方最新交接，不依赖聊天记忆。

执行者独占源码、测试和本文写入；审查者只读源码与文档，通过消息返回结论，不同时修改交付物。双方均不操作暂存区、提交历史或远程；已有暂存变更原样保留。审查期间执行者暂停代码修改与构建，避免读到变化中的输入；必要定向测试由双方明确约定一方执行，禁止同时跑同一验证闭包。

## 背景与边界

项目正准备首版发布。既有 AE-001 迁移已形成产品领域、Intelligence Kernel、正确性机制和 ApplicationHost，但发布前的外部视角源码复核发现部分实现仍未兑现既定边界。本次只补齐已有架构，不重启迁移、不增加功能、不改变发布范围；发布准备与架构纠偏分别管理。

| 顺序 | 单元 | 要消除的问题 |
|---|---|---|
| 1 | HOST-C01 | 运行期从共享装配容器取服务；Runtime 改写进程身份；组件绕过入口固定数据根重新读环境 |
| 2 | HOST-C02 | 构造依赖仍经共享产物总线、有序数组和名称切片隐式表达 |
| 3 | KERNEL-C01 | Kernel 中残留 Workscene 产品指引与 Profile 策略 |
| 4 | NOTICE-C01 | 共享 Journal 与投递参与适配中残留产品通知、文案和结果语义 |

当前只完成单元 1 的开发、审查与最终验证；后续三个单元未授权在本轮开始实现。单元 1 可保留仅限构造期的容器，由单元 2 退出；任何运行期旁路不能借此后置。审查应依据[AE-001 权威设计](../../research/design/architecture/evolutions/AE-001-companion-intelligence.md)、任务范围、源码及真实调用链，不以测试数量、文件大小或执行者自述代替结论。

## 协作顺序与结束条件

1. 执行者先交代背景与当前交付；审查者读取上述权威、任务顶部及第九节、相关生产入口，返回“背景已理解”及范围理解。此步不启动测试或全局重审。
2. 背景确认后，执行者明确发出审查请求。审查者对当前单元做一次完整问题盘点：覆盖目标义务、全部生产者/消费者、动态换代、异常与恢复、功能等价及无价值复杂度。先读代码，再以必要的轻量定向验证证伪疑点；不运行包全测、模块回归或重型组合验证。
3. 审查者一次性按根因返回问题清单：位置、生产依据、影响、修正方向和验收条件；无问题直接通过，不为凑轮次硬找问题。已知未覆盖范围与证据缺口必须明示。
4. 执行者核实并集中修复真实问题，覆盖同根消费者，完成必要直接验证后交回受影响范围。审查者复核变化和直接交界，未受影响结论复用；存在问题继续闭环，代码及必要审查证据无问题后明确给出通过结论。
5. 审查通过后才执行最终验证。先列精确命令、真实失效输入、可复用证据、耗时与截止；同输入已通过的构建和测试不重复，禁止以整包全测代替影响面识别。重型验证串行，构建与依赖其产物的检查不得并发。
6. 按用户本次约定，最终验证发现问题由执行者单独定位、修复并复验受影响闭包，不再增加额外审查轮次。不得借此改功能或扩单元；若确需改变架构/产品范围，报告用户裁决。
7. 审查通过、最终验证通过、无未解决的范围内问题，才在任务文档标记当前单元完成并停止。不得自动提交或开始下一单元。

验证纪律参考[开发工作台](../../research/design/workbench/unit-development-workbench.md)、[审查工作台](../../research/design/workbench/unit-review-workbench.md)、[验证手册](../../research/design/workbench/verification-runbook.md)和[验证耗时复盘](../postmortems/2026-08-06-final-validation-overrun.md)。本次双方分工与最终验证失败处置按以上用户约定执行，不套用额外角色或重复审批流程。

## 当前交接：HOST-C01

- 基线：`3f31c9b4a95e52bf1b5da1804e1740e103a8167b`；审查对象为 `git diff HEAD -- packages` 对应的当前工作区，必须同时看暂存和未暂存变更。既有发布、文档迁移变更不混入代码审查。
- 背景交接输入：59 个代码/测试文件；diff 文本按行以 LF 连接、UTF-8 编码的 SHA-256 为 `d2e393af38a22f2f6323e9caeaf0421ec57995ab9419236b141b7f347ba94d51`。审查开始前及结束时核对，发生变化只使受影响结论失效。
- 状态：2026-09-14 HOST-C01 已完成。R3 独立审查通过，R1 两项及 R2 遗漏全部关闭；最终构建、类型检查及定向回归全部通过，无范围内未解决问题。其余三个单元未开始。
- 实现交接：长期回调改为直接持有稳定依赖；当前 owner/连接/代际继续查询原责任者；身份投影沿主/子 Runtime、Profile 和确认链显式传入；home 沿入口、Host/角色 bootstrap、存储、窗口指引及日志链显式传递。未启动其余三个单元。
- 重点复核：状态聚合与第一方终态的绑定时点；启动/恢复/公开入口顺序；Mesh owner 变化；资源 governor 换代；无通道的合法分支；Executor-only 独立入口；同根存储、懒建场景、只读降级、指引动态重读；多 Runtime 身份隔离及子运行传递。此清单是风险提示，不限制完整范围检查。
- 复用证据：core 4 文件 158 项；orchestrator 25 文件 394 项（新增 Runtime 身份隔离单例随后单独通过）；CLI 24 文件 201 项（其中失败断言修正后 3 文件 13 项通过）；另 7 文件 82 项集成回归通过。只复用未受后续修改影响的结论；当前构建、类型检查和受影响闭包以文末最终验证结果为准。
- 补验证据：协议迟绑定状态订阅/防重绑断言、最新根绑定与配置消费者均已通过定向验证；无待补项。审查者未重复执行测试。
- 效率纠正：前一轮在独立审查前过早运行了较重的回归。现已停止扩大验证；先审查、集中修复，再复用有效证据完成最终验证。

### 交接与问题处置记录

| 轮次 | 请求/结论 | 处置与下一步 |
|---|---|---|
| HOST-C01 / 背景交接 | 对方已确认三个闭包、功能与生命周期保护及后续单元边界；未启动测试或修改文件 | 背景交接完成 |
| HOST-C01 / R1 | 不通过；固定 home 未覆盖秘密保护、发现/状态/日志/清理、REPL 重连及配置换代；无通道 Mesh 被致命判空 | 两项已核实；集中闭合全部消费者与合法缺席分支，再交受影响范围复核。审查者未修改文件或运行测试 |
| HOST-C01 / R2 | 原两项主要修正通过；剩 REPL 新建场景未给本地 workspace helper 传固定 home | 已补交互入口，helper 的 home 改必填，独立 workspace 命令也显式传入；三处生产调用者闭合 |
| HOST-C01 / R3 | 独立审查通过；完整 tracked diff 指纹 `4d25f47a7a11b520229a113f411205c3c2ea1beb3cb14ab7d973407fdd5f86e3`，两份未跟踪测试未变；三处 workspace 调用者显式根闭合 | 实际 REPL 组合回调定向 1/1 通过（14.77 秒，主体 318ms）可复用；进入最终验证，不追加审查轮次 |

R2 历史输入：当时 `git diff HEAD -- packages` 的同算法 SHA-256 为 `62d7ab0ed0102b86621f7c9b6aef10599865e5a1d8fd29b90813da7fee43899c`，另含未跟踪新增 `runtime/__tests__/core-host-home-binding.test.ts` 与 `config-command-home.test.ts`；共 81 个 TypeScript 文件。当时只读语法转译检查与 diff 空白检查通过，新增行为测试留至最终验证，现已通过。R1 未受影响的身份、状态订阅及运行期边界结论复用。

修复：Anchor/Executor 显式绑定秘密保护、发现锁、token、state/ready 与日志；REPL 及独立入口固定连接根，贯通懒启动、重连、远端 surface、配置换代及停止清理；公开配置文件独立固定位置并继续重读内容，SecretStore 不再由配置目录反推。Managed preflight 与本地 workspace 共用入口根。无通道 Mesh 的移除、迁移、拒新/排空/恢复共用既有有限空入站生命周期，必需责任者断言保留。未新增产品能力或改变其他单元。

最终验证范围：上游发生 server 路径参数及 providers 配置路径 API 变更，复核通过后先构建，再运行受影响的精确测试与 CLI 类型检查；未运行整包测试或重复之前的重型 7 文件回归。

### HOST-C01 最终验证计划

依次串行；命令输出与退出码保留在本对话，失败立即保留具体反例，不把超时当成功，不换参数重跑无结果范围。时间为执行预算而非测量结果；到期仍无可定位结果则停下检查运行方式。

| 顺序 | 命令/精确范围 | 失效原因与预算 |
|---|---|---|
| 1 | 根目录 `pnpm build` | server/providers API 新增参数，必须先更新上游声明及 CLI 产物；预计 4～6 分钟，截止 10 分钟 |
| 2 | providers：`node node_modules/vitest/vitest.mjs run src/__tests__/config-loader.test.ts --maxWorkers=1 --reporter=verbose` | 显式配置路径读写与既有语义；预计 15 秒，截止 1 分钟 |
| 3 | CLI：`pnpm --filter @zhixing/cli exec tsc --noEmit` | 所有生产调用者的必需输入及新上游声明；预计 30 秒，截止 2 分钟 |
| 4 | CLI 定向文件：runtime 下 core-host-home-binding、core-host-connection、config-command-home、config-command、surface-core-host-link、repl-local-view；security 的 secret-boundary；serve 的 daemon、stop、topology-command、startup-server-owner；根 __tests__ 的 startup-secret-store。均用 `node node_modules/vitest/vitest.mjs run <精确文件列表> --maxWorkers=1 --reporter=verbose` | 根绑定、重连/启动/停止、配置编辑与合法缺席的直接闭包；预计 2～3 分钟，截止 6 分钟 |
| 5 | CLI：`node node_modules/vitest/vitest.mjs run src/serve/__tests__/conversation-protocol-runtime.test.ts -t 'admits queued cancellation' --maxWorkers=1 --reporter=verbose`；`git diff --check` | 补协议迟订阅/单次终态绑定的未执行断言；预计 20 秒，截止 1 分钟 |

复用之前 core 身份/确认/存储、orchestrator 主子 Runtime、CLI 存储/指引/换代以及 7 文件集成证据；本轮 REPL workspace 定向 1/1 不重复。无需包全测、组合 baseline、制品打包或四单元总验收。

### HOST-C01 最终验证结果（2026-09-14）

| 验证 | 结果 |
|---|---|
| 根目录 `pnpm build` | 17 包全部通过，约 146 秒 |
| providers 配置路径定向测试 | 29/29 通过，Vitest 耗时 1.08 秒 |
| CLI `tsc --noEmit` | 首次发现文本调用包装函数把可选参数推断为必填；显式声明 `GovernedTextCall` 后复验通过 |
| 修正后的 `pnpm cli:build` | 通过；上游未再改动，不重复全量构建 |
| 上述 CLI 12 文件及新增 `serve/__tests__/governed-control-llm.test.ts` | 共 13 文件、98/98 通过，Vitest 耗时 28.13 秒 |
| 协议迟绑定 `admits queued cancellation` | 1/1 通过，29 项无关用例跳过；耗时 10.31 秒 |
| 实际 REPL 组合回调 | 复用 R3 前已通过的定向 1/1；不重复运行 |
| `git diff --check` | 通过 |

最终阶段只修复上述调用签名，并补充执行真实组合回调的 governor 换代回归，确认每次调用仍读取当前 governor。按用户约定自行修复、复验，不增加正式审查轮次。没有功能扩展，没有未结束的构建或测试进程。

最终 tracked 代码 diff 同算法 SHA-256：`6bf4713809a1b02620b8e28a968e6cde79176b11a7ce283fc7471a6929664238`；上述两份未跟踪测试相对 R3 未变。HEAD 保持基线，暂存区指纹保持 `d2e393af38a22f2f6323e9caeaf0421ec57995ab9419236b141b7f347ba94d51`。所有修复留在工作区，未操作 Git，未开始 HOST-C02。

完成通知：最终结果回传时，任务列表仍能找到审查方 ID，但消息工具两次返回 `thread not found`，故未送达；结果已在本文落盘供恢复时读取。这不影响此前已取得的 R3 通过结论，不触发重审或重跑测试。
