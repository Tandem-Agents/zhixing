# （待命名）

> **静态区**：本区记录固定问题、收敛规则和提示词，未经用户明确要求不得修改或清理。

## 一、问题描述及分析

第 8 单元主体开发约用 40 分钟。随后以“修复到本单元没有问题为止，并连续两轮审查无新增问题”为目标进入审查修复，约 3 小时后仍未完成：第一轮无新增问题审查尚未通过，最新修改仍待验证。

实际过程中，先后围绕秘密存储、迁移、并发与崩溃恢复、安全边界、凭据最小投影、启动流程及其消费者发现问题；每发现一处便进行修复和局部验证，再继续审查，后续又发现其他问题并重复该过程。实际工作循环是“审查发现问题 → 立即修复 → 局部验证 → 继续审查”，没有先形成一份完整问题清单再集中处理。

## 二、目标模式协作协议

### 1. 唯一目标与完成条件

在不降低审查深度、测试覆盖或最终质量的前提下，高效完成当前单元的审查与修复：必要影响面达到最优架构、不留已知债务；同一份未修改交付物的全部验收与必要验证通过，并连续两轮完整审查无新增真实问题后立即结束。

后续单元、无关重构和架构未要求的无限防御不在范围内；确需改变边界时先重新确认，禁止静默扩面。

### 2. 执行闭环

| 阶段            | 完成门禁                                                                         | 下一步                                                                                               |
| --------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 边界锁定        | 来源、范围、不变量、验收、必要上下游、排除项、核查对象、交付物指纹和验证计划齐全 | 终审一                                                                                               |
| 终审一 / 终审二 | 整轮只读扫完，问题一次收齐，交付物未变化                                         | 有问题进入问题裁决；零问题且证据缺失进入集成验证；零问题且证据齐全时终审一进入终审二、终审二进入完成 |
| 问题裁决        | 按根因去重；每项写清事实、完整影响面、最优方案、共同验证范围和验收条件           | 集中修复                                                                                             |
| 集中修复        | 全部问题一次修完，共同范围只做一次最小回归；更新交付物、覆盖表与证据状态         | 集成验证                                                                                             |
| 集成验证        | 交付物冻结；全部必要证据有效                                                     | 验证失败回问题裁决；内容改过回终审一；同一指纹的终审一已通过则进终审二                               |
| 完成            | 同一份交付物全部验收与必要验证通过，连续两轮完整审查零新增问题                   | 立即结束                                                                                             |

### 3. 五条核心规则

1. **边界完整**：终审前把架构要求、验收、全部交付文件、跨边界符号、生产端、消费者和测试映射到九类核查面；每面必须有对象或不适用依据，禁止扩面或漏项。
2. **先审完再修**：终审整轮只读，只登记问题；全部扫完后统一裁决。问题按根因合并，一次覆盖生产端、类型组合、消费者、异常终态和测试，再集中修复。
3. **命令必须有证据缺口**：运行测试、构建或门禁前，先在账本登记证明目标与当前缺口、最小命令、具体输入闭包、阶段和成本；执行后记录结果、实耗与输入指纹。输入指纹为命令及其工具/配置、源码、测试和依赖闭包的路径与内容哈希。同一目标已有相同输入的有效证据时禁止重跑。
4. **昂贵验证只跑一次**：修复阶段只做按共同范围合并的最小回归；全部问题修完并冻结交付物后，才按依赖顺序运行静态/类型、直接测试、受影响包、反向依赖、必要构建和 golden/安全门禁，每层同一输入最多一次。失败先归因，无变化不得重跑；仅并行已证明输出隔离且互不争用的命令。
5. **变化精确失效**：交付物变化使两轮审查归零；机械证据仅在本行输入指纹变化时失效。终审二必须重新读取交付物独立判断，不重复有效测试；达到完成条件立即结束。

### 4. 动态区维护

- 动态区是唯一状态源。每次开始、目标续跑或历史压缩后先完整读取本文；阶段转换前写完当前结果，转换后立即更新状态。
- 本文和构建产物不属于交付物；暂存状态不影响指纹。动态区格式固定，只维护字段值和表格内容；已解决问题保留到完成。
- 用户确认完成或开始下一单元时清空动态内容并恢复初始状态；第一部分及其他静态内容未经用户要求不得修改。

### 5. Codex 目标模式提示词

```text
/goal 完成当前开发单元的审查与修复：不降低审查深度、测试覆盖或最终质量，在锁定边界内达到最优架构、不留已知债务。

首个动作，以及每次续跑或历史压缩后的首个动作，都是完整读取 `research/design/workbench/development-review-optimization.md`。严格执行其执行闭环和五条核心规则，把动态区作为唯一状态源；门禁未满足不得转换阶段。

按动态区状态持续推进；每次阶段转换前先更新动态区。只有需要用户改变范围、授权高风险动作或作出无法由项目事实确定的产品决策时才暂停，其余情况自主推进。

唯一完成条件：同一份未修改交付物的全部验收与必要验证通过，并连续两轮完整审查无新增真实问题；达到后立即结束，未达到不得宣称完成。
```

---

## 动态区

> 以下标题、说明、字段和表头是固定格式；只维护字段值和表格数据。

### 当前状态

- **单元**：分布式运行时执行计划第 8 单元（S2）：SecretStore、凭据迁移与 ready 状态
- **架构来源**：`distributed-runtime-charter.md` §4/§10/§13(不变量 6)/§14(S2)；`specification.md` §2.3/§2.4/§6.4/§七/§十一/§十二(口径 6)/§十五(提交 8)
- **当前状态**：完成
- **连续无新增问题轮数**：2 / 2
- **交付物是否冻结**：是（83 个交付文件第二次集中修复后重新冻结）
- **交付物文件集**：83 个（不含本文）：`package.json`；`pnpm-lock.yaml`；`packages/secrets/**`；`packages/mesh/{package.json,tsup.config.ts,src/index.ts,src/credential-exposure.ts,src/device-key-store.ts,src/device-readiness.ts,src/__tests__/credential-exposure.test.ts,src/__tests__/device-key-store.test.ts,src/__tests__/device-readiness.test.ts}`；`packages/providers/{src/config-loader.ts,src/config-validator.ts,src/create-provider.ts,src/credentials-loader.ts,src/index.ts,src/model-capability.ts,src/paths.ts,src/resolve.ts,src/types.ts,src/__tests__/config-validator.test.ts,src/__tests__/credentials-loader.test.ts,src/__tests__/integration.test.ts,src/__tests__/llm-roles.test.ts,src/__tests__/resolve.test.ts}`；`packages/cli/{README.md,package.json,src/index.ts,src/repl.ts,src/startup.ts,src/__tests__/startup-secret-store.test.ts,src/security/secret-boundary.ts,src/security/__tests__/secret-boundary.test.ts,src/registries/channels.ts,src/registries/providers.ts,src/runtime/config-command.ts,src/runtime/mcp-config.ts,src/runtime/__tests__/runtime-host.test.ts,src/config-editor/checks/messaging.ts,src/config-editor/checks/model.ts,src/config-editor/index.ts,src/config-editor/panels/main.ts,src/config-editor/runner.ts,src/config-editor/state.ts,src/config-editor/types.ts,src/config-editor/__tests__/panels-render.test.ts,src/serve/access-surface.ts,src/serve/access-surfaces.ts,src/serve/advancement-controller.ts,src/serve/channels.ts,src/serve/command.ts,src/serve/profile.ts,src/serve/__tests__/conversation-surface.test.ts}`；`packages/core/src/security/{index.ts,builtin-rules.ts,policy-engine.ts,security-pipeline.ts,__tests__/builtin-rules.test.ts,__tests__/policy-engine.test.ts}`；`packages/orchestrator/src/runtime/{create-agent-runtime.ts,__tests__/create-agent-runtime.test.ts}`；`packages/runtime-host/src/runtime-host.ts`；`packages/server/src/__tests__/{distributed-runtime-structure.test.ts,__goldens__/distributed-runtime-structure.golden.json}`；`scripts/{check-runtime-package-exports.mjs,check-secret-boundaries.mjs,runtime-baseline.mjs}`；`research/design/specifications/{README.md,context-management-v3-redesign.md,credentials-and-onboarding.md,mcp-host.md,runtime-session-hot-reload.md,skill-system.md}`
- **当前交付物指纹**：SHA-256 路径+内容聚合 `a924a9ba593bfdc096874d723ef8111f3d295233bd898d6e3008ce235070ece3`（C3）

### 固定边界

- **功能范围**：统一 SecretStore 后端；设备私钥与 provider/channel/MCP 秘密本机存取；`credentials.json` 校验迁移后清退；CredentialExposureRecord；设备 paired→configured→ready/degraded 预检；一次性引导与秘密边界门禁。
- **架构不变量**：秘密只存目标设备 SecretStore；日志、协议、配置投影只见 SecretRef；秘密不进网格、同步、备份与迁移；未 ready 设备不得承担对应角色；单机仍是同一路径且未启用角色零加载；失败必须 fail-closed，不得以明文回退维持运行。
- **验收条件**：明文扫描为零；迁移逐条写入、回读校验、全部成功后清退，失败可回滚且不留下半迁移权威；设备撤销可列出暴露账号；locked/unavailable 或配置缺失进入 degraded/阻断角色；S2 相关安全矩阵、受影响测试、构建与 golden 全绿。
- **必要上下游**：CLI 启动与配置编辑；providers 凭据解析/实例化；channel/MCP 装配；mesh 设备身份与撤销；runtime-host/orchestrator 秘密注入边界；core 安全策略；workspace 包导出、结构门禁与文档契约。
- **明确不属于本单元**：不做跨设备秘密同步、备份或迁居；不启用业务 mesh；不实现 S3 AuthorityCommitLog/run 协议；不实现 S4 CredentialBindingDescriptor/Manifest 匹配；不替用户自动完成无可信授权的第三方凭据吊销；不扩展其它凭据类型或后续角色生命周期。

### 覆盖与核查

> 覆盖来源包括架构要求、不变量、验收项、交付文件与跨边界符号、生产端、消费者和测试；核查面固定为状态、入口与生产端、消费端与继承面、生命周期、并发与崩溃点、异常路径与终态、安全边界、模块边界、测试与验收。每轮填写“通过：证据”“不适用：依据”或“有问题：编号”。

| 覆盖来源       | 来源项                             | 核查面         | 对象或路径                                                                               | 第一轮结论与证据 | 第二轮结论与证据 |
| -------------- | ---------------------------------- | -------------- | ---------------------------------------------------------------------------------------- | ---------------- | ---------------- |
| 架构           | paired→configured→ready/degraded | 状态           | `mesh/device-readiness.ts`、CLI startup、role/profile gates                            | 通过：六态转移、失败原因、角色 guard 与线性引导合同闭合；业务 mesh 未启用，无遗漏角色入口 | 通过：独立复核终态不可回退、检查缺失 fail-closed 与角色不匹配拒绝，无新增问题 |
| 架构/交付物    | 秘密生产与录入入口                 | 入口与生产端   | CLI config/startup、provider/channel/MCP registries、device-key store                    | 通过：完整凭据仅在 CLI 启动/编辑组合根产生，三域与设备密钥分别进入本机 SecretStore | 通过：入口均由同一组合根和本机端口承载，未见秘密旁路或第二权威 |
| 架构/交付物    | SecretRef/秘密消费                 | 消费端与继承面 | providers create/resolve、runtime-host、orchestrator、serve/channel/access-surface       | 通过：三域负字段投影封死组合面，全部生产消费者已收窄，精确结构门禁闭合 | 通过：反查全部完整类型与最小投影消费者，类型组合和结构门禁一致，无遗漏继承面 |
| 架构           | SecretStore 与旧凭据迁移           | 生命周期       | platform/vault store、master key、`credentials.json` 迁移/清退、设备撤销 exposure      | 通过：创建、换代、清退、撤销及前滚恢复均有唯一权威路径，普通写与迁移错误语义分离 | 通过：独立重放创建、切换、恢复、清退与撤销链，所有终态均可收敛且不回退明文 |
| 架构/验收      | 原子迁移与存储并发                 | 并发与崩溃点   | file lock、vault 原子写、迁移逐条写/回读/提交/回滚/清退                                  | 通过：锁、generation manifest、读回校验和切换前回滚/切换后前滚覆盖各崩溃边界 | 通过：复核活/死 owner、ABA、manifest 前后及未知结果插点，无双持有、混合 generation 或逆向覆盖 |
| 架构/验收      | fail-closed 终态                   | 异常路径与终态 | locked/unavailable、缺失/损坏、迁移中断、清退失败、ready→degraded                       | 通过：未知提交不逆向覆盖，清理失败不改写操作结果；不可用、残留明文和检查失败均阻断 ready | 通过：异常分类、前滚提示与 ready 阻断逐项对应承载代码，失败不会伪装成功 |
| 不变量 6       | 秘密不越界                         | 安全边界       | secrets 包、core policy、CLI boundary、scanner、wire/config/docs                         | 通过：本机存储、最小投影、动态保护路径及真实 L2 边界一致，门禁拒绝已知硬隔离矛盾表述 | 通过：复核 realpath、动态目录、系统凭据命令、投影与文档威胁边界，未见泄露或过度承诺 |
| 包边界         | 新包与组合根                       | 模块边界       | workspace/package exports、mesh/providers/cli/runtime-host 依赖、structure golden        | 通过：SecretStore 实现仅由 CLI 组合根依赖，providers/mesh 只依赖端口，导出与结构 golden 闭合 | 通过：依赖方向、公开导出和零业务 mesh 边界保持单向，无提前启用后续单元能力 |
| 执行计划提交 8 | 完整验收面                         | 测试与验收     | secrets/mesh/providers/cli/core/orchestrator/server 测试、scanner、lint、build、baseline | 通过：V1–V11 覆盖直接行为、反向依赖、边界门禁、构建与行为/结构基线，C3 证据有效 | 通过：逐项反查验收与有效证据闭包，无失效输入、未测承诺或需重复运行的证据缺口 |

### 问题清单

> 每个根因只保留一行；“完整影响面”固定写明生产端、类型组合、消费者、异常终态和测试；状态只允许“待裁决、待修复、修复中、待验证、已验证”。

| 编号 | 事实与证据 | 根本原因 | 完整影响面 | 最优解决方案与验收条件 | 状态 |
| ---- | ---------- | -------- | ---------- | ---------------------- | ---- |
| P1 | L2 合同已改为真实边界，但门禁只检查免责声明存在，未拒绝同文重新出现“任何 AI 文件访问”等矛盾硬隔离承诺。 | 门禁只做正向存在性检查，未校验冲突表述。 | 生产端：SecurityPipeline/Bash；类型：保护路径规则；消费者：全部 AI 工具；终态：文档可同时承诺 L2 与 L3；测试：合同回归门禁。 | 保持既定 L2 架构；门禁同时要求真实边界并拒绝“任何 AI 文件访问”等硬隔离表述。默认/自定义路径与命令阻断保持全绿，全文不得再把 L2 描述为进程沙箱。 | 已验证 |
| P2 | 未知提交终态已类型化并可前滚，但通用 `writeCredentials` 也会收到写着“明文源保留”的错误，非迁移场景文案失真。 | 把迁移专属处置写进了跨入口通用错误类型。 | 生产端：generation 提交；类型：通用错误与迁移包装；消费者：写凭据、启动迁移、配置编辑器；终态：未知；测试：两类入口文案与前滚。 | 通用错误只说明激活状态未知、禁止逆向覆盖、下次回读；仅迁移包装说明旧明文保留。既有两类未知结果与下一次恢复测试均通过。 | 已验证 |
| P3 | 三域投影已用负字段封死且 resolver/factory 已收窄，但结构门禁仍整体豁免 `packages/providers/src/`，未来运行时文件可重新持有完整对象而不报警。 | 门禁豁免粒度大于允许的组合/仓储边界。 | 生产端：CLI 组合根；类型：三域精确投影；消费者：providers runtime、orchestrator/CLI；终态：未来回退可静默进入；测试：结构门禁。 | 完整投影只精确允许 providers 的类型定义、凭据仓储、barrel 以及 CLI 启动/编辑组合根；其余 provider 运行时文件一律由同一扫描拒绝，删除冗余 resolver 特判。 | 已验证 |
| P4 | stale heartbeat 会让仍存活但暂停的进程被夺锁，现有测试还把“活 PID + stale”规定为可回收；锁释放异常又可在 `finally` 覆盖已确定的操作结果。 | 锁协议把心跳超时误当所有权失效，并把清理结果与业务提交结果混为一谈。 | 生产端：两类 vault/协调锁；类型：锁记录与 release；消费者：全部 SecretStore 读写和迁移；终态：暂停恢复双持有、提交成功却报失败；测试：活 PID stale、死 PID、代际释放、清理失败。 | 所有权 fail-closed：PID 存活即不得回收，stale 只辅助回收死进程/无效记录；释放按 token 防 ABA、短重试，最终清理失败只告警且不得覆盖已完成操作结果。测试证明暂停活 owner 不被夺、死 owner 可回收、旧代 release 不删新代。 | 已验证 |

### 验证计划与证据账本

> 状态只允许“待执行、有效、失效、诊断”。“待执行”必须写明当前证据缺口，输入闭包必须具体到可重复计算指纹。当前历史证据未记录实耗，以完整交付物指纹 `C1 = 8dfdf16fd28cbc87c7c5823dcb3777756335eb8401563acaf265b5bfd9cd7c86` 保守绑定且只对当前未修改交付物有效；后续执行按各行输入闭包计算独立指纹。

| 编号 | 证明目标与当前缺口   | 最小命令或检查                                                                                     | 输入闭包                                                   | 阶段 / 成本 / 实耗 | 结果                                                                                       | 证据输入指纹 | 状态 |
| ---- | -------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------ | ------------ | ---- |
| V1   | 秘密边界与包导出闭合 | `pnpm security:secrets`；`pnpm runtime:package-exports`                                        | 两个门禁脚本、workspace 清单/exports、被扫描运行与文档表面 | 集成验证 / 秒级    | C3 通过秘密边界；包导出输入未变，沿用 C2                                                      | `C3`       | 有效 |
| V2   | 当前单元直接行为     | secrets 全包；mesh readiness/key/exposure；providers、CLI、core、orchestrator、server 直接相关测试 | 本单元生产端、消费者、直接测试及测试配置                   | 集成验证 / 分钟级  | C3 通过 credentials-loader 23 条；providers 228、secrets 18、CLI startup 5 及其余未变输入沿用 C2/C1 | `C3`       | 有效 |
| V3   | 受影响包回归         | providers、core、orchestrator、server、CLI 全包测试                                                | 五个包的源码、测试、配置及 workspace 依赖闭包              | 集成验证 / 分钟级  | C3 workspace DTS 构建闭合公共类型全部反向依赖；运行行为未变，包级证据沿用 C2/C1               | `C3`       | 有效 |
| V4   | mesh 回归            | 当前单元 17 条及其余纯协议 26 条                                                                   | mesh 当前单元表面、纯协议实现与测试                        | 集成验证 / 分钟级  | 通过；全包另被上一单元固定日期测试导致的证书过期阻断，已隔离为非本单元回归                 | `C1`       | 有效 |
| V5   | 格式与静态边界       | 供应链门禁、秘密门禁、当前交付文件 Biome                                                           | 门禁脚本、依赖清单、当前可检查交付文件                     | 集成验证 / 秒级    | C3 通过秘密门禁与本轮变更文件 Biome；供应链输入未变沿用既有证据                               | `C3`       | 有效 |
| V6   | workspace 构建闭合   | `pnpm build`                                                                                     | 全 workspace 源码、构建配置、依赖清单与锁文件              | 集成验证 / 122s    | C3 通过：17 个 workspace 项目                                                               | `C3`       | 有效 |
| V7   | 行为与结构基线       | `pnpm runtime:baseline`                                                                          | baseline 脚本、golden、包导出及 server/CLI/结构输入        | 集成验证 / 120s    | C2 通过：包导出、server/CLI 行为 golden、结构 golden                                        | `C2`       | 有效 |
| V8   | 仓库级失败归因       | `pnpm test`；隔离 tools-builtin 超时用例                                                         | 全 workspace 测试；隔离用例输入                            | 诊断 / 分钟级      | 递归并发时既有用例 5s 超时；独立复跑 213ms 通过；不作为本单元验收证据                      | `C1`       | 诊断 |
| V9   | 集中修复最小回归     | providers/secrets `tsc --noEmit`；3 个 providers 测试文件；file-lock 测试                          | C2 修改的类型、迁移终态、锁协议及 77 条直接测试             | 集中修复 / 秒级 / 38s | 通过：两包类型检查；providers 72 条、secrets 5 条                                           | `C2`       | 有效 |
| V10  | C2 必要集成闭包       | providers/secrets 全包测试；CLI startup-secret-store；秘密/包导出门禁；变更文件 Biome；`pnpm build`；`pnpm runtime:baseline` | C2 全部源码、测试、门禁、反向类型依赖、workspace 构建与行为/结构 golden | 集成验证 / 315s | 全部通过；未重复运行根递归测试                                                              | `C2`       | 有效 |
| V11  | C3 收敛修复闭包       | credentials-loader 直接测试；`pnpm security:secrets`；变更文件 Biome；`pnpm build`                   | C3 的通用错误文案、精确豁免门禁、L2 冲突表述拒绝及 workspace 构建 | 集成验证 / 约 123s | 全部通过：credentials-loader 23 条、秘密门禁、Biome、17 个 workspace 构建                    | `C3`       | 有效 |

### 终审记录

| 轮次   | 审查侧重                             | 矩阵是否完整 | 新增问题 | 交付物指纹 | 结论 |
| ------ | ------------------------------------ | ------------ | -------- | ---------- | ---- |
| 第一轮 | 需求、架构、功能闭环、状态、回归     | 是           | 0        | `C3`       | 通过，进入终审二 |
| 第二轮 | 并发、崩溃、安全、异常终态、测试盲区 | 是           | 0        | `C3`       | 通过，完成 |
