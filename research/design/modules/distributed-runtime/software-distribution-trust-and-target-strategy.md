# 软件分发信任与产品边界

> 决策日期：2026-08-16。本文确定当前产品边界；平台规则仍以正式发布时的官方要求为准。

## 核心结论

智能体能力不产生软件签名要求。访问文件和工具、执行命令、后台运行、委派子智能体、保存状态或携带私有 Node，都不是必须签名的功能边界。

签名责任来自知行是否自行承担两类软件交付：

- **自有自动更新**：客户端从知行控制的更新源下载并激活程序时，必须验证发布者、内容完整性和版本顺序，因此需要独立发布签名及完整恢复合同。
- **原生一体化安装**：知行直接分发 Windows/macOS 原生安装制品时，需要相应代码签名或公证，才能形成可信、自然的系统安装体验。

这两项属于交付便利性，不是个人智能体的核心能力。核心产品是理解用户、调用工具、持续完成任务并可靠保存工作，其实现、验证和使用不得依赖签名证书、公证服务、自有更新源或发布基础设施。

## 当前产品裁决

当前版本及可预见的早期阶段不提供原生一体化安装和自有自动更新：

- 通过 npm 全局包交付，用户自行具备受支持的 Node；当前不把 `npx`、源码运行或其他包管理器声明为安装、试用或托管渠道。
- 当前正式支持并验证 Windows x64；macOS 与 Linux 保持架构和源码可移植性，但在取得对应真实环境与必要证据前不作发布承诺，也不构成当前交付门禁。
- 安装和更新由用户显式触发，不在后台替换程序。
- 不建设自有 stable feed、生产发布密钥、Windows/macOS 签名公证、五目标原生程序树或自动切版恢复链。
- 不把未签名原生制品描述为可信的一键安装方案。

该裁决只收窄软件交付方式，不降低保留能力的产品体验、正确性、安全性和耐久性。只有真实使用证据表明 npm 交付阻断目标用户使用时，才重新评估原生安装与自有自动更新；重新引入时必须作为完整产品能力设计，不保留半套预留框架。

保留能力不变量：单机完整使用，多设备统一产品、配对与信任、anchor/executor 协作、跨设备任务与结果恢复、备份恢复、安全停机和设备移除均保持不变；现有 `ZHIXING_HOME`、设备身份、信任、配置和用户工作不得因交付方式切换而迁移或删除。各设备改为独立安装和显式更新兼容版本，既有协议协商与版本偏斜保护继续生效。

## 三类事实不得混淆

1. **发布签名**：保护自有更新通道中的 index、manifest 和 artifact identity；仅在知行重新拥有更新通道时需要。
2. **操作系统签名或公证**：建立原生制品的系统发布者信任。Windows 和 macOS 有各自机制，Linux 没有统一的厂商公证体系。
3. **目标机交付证据**：证明声明支持的平台能够安装、运行、更新和移除。它是质量证据，不是签名，也不应要求当前未声明的目标提供证据。

## DeepSeek Harness 对照

DeepSeek Harness 具备完整的本机智能体能力，包括工作区读写、Shell 与持久终端、后台任务、子智能体、持久会话、插件、审批和沙箱。它没有因为这些能力而建立独立应用签名。

其主产品通过 Node 和 npm/npx 交付；官方文档与公开发布流水线未提供自有 stable feed、后台程序替换或 Windows/macOS 原生安装器。Python SDK 内置的运行时和 Linux 原生 helper 也分别封装在 PyPI wheel 与 npm 平台包中。发布身份和下载完整性主要由包注册表、发布认证及制品摘要承担，当前公开流水线未发现 Authenticode、Developer ID、Apple notarization 或独立 DeepSeek 应用发布签名。

因此，DeepSeek Harness 的边界说明：强智能体可以把软件分发交给包管理器，而不自行拥有原生安装和更新信任链。当前知行采用相同的**签名责任边界**——保留完整智能体能力，把安装和显式更新交给 npm。这里不表示两款产品的具体功能、架构或体验逐项相同。

## 当前交付合同

- 发布明确、不可变的包版本并锁定生产依赖。
- 明确受支持的 Node 与操作系统范围。
- 安装、同版修复和前向升级使用公开、可复现的 npm 命令；当前不承诺已运行新版本后的降级，不得把 npm 能下载旧包等同于用户数据可安全回退。
- 维护失败须给出重试、重新安装当前明确版本或前向安装最新版本的唯一行动；知行不维护内部 previous 版本或承诺自有自动回滚。
- 不将包管理器摘要或目标机测试误称为知行发布签名。

## 官方资料

- [Microsoft：Windows 代码签名选项](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Apple：Developer ID](https://developer.apple.com/support/developer-id/)
- [Apple：macOS 公证](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Debian：apt-secure](https://manpages.debian.org/testing/apt/apt-secure.8.en.html)
- [RPM：rpmsign](https://rpm.org/docs/6.1.x/man/rpmsign.1)
- [DeepSeek Harness：官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [DeepSeek Harness：架构](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DeepSeek Harness：npm 发布流水线](https://github.com/deepseek-ai/deepseek-harness/blob/master/.github/workflows/release.yml)
- [DeepSeek Harness：Python 内置运行时与发布](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk-runtime/README.md)

---

## 现有系统对齐清单

目标：完成全部事项后，当前系统只保留“用户 Node + npm 全局包 + 显式维护”的一条交付路径；源码、公共合同、文档、测试和派生资产不再暗示私有 Node、原生安装器、自有更新源或平台签名仍是当前能力。

本清单完成到“可发布、可本机手测”为止，不写入真实 npm registry。外部发布只由用户另行授权后执行下述本地发布命令；发布命令自身必须在移动 CLI `latest`前完成全部 registry 侧验证。

### A. 权威文档与当前工作台

- [x] 同步[需求文档](./always-online-and-local-execution-requirements.md)、[架构总纲](./distributed-runtime-charter.md)、[执行规格](./specification.md)、[发布维护指南](./release-and-maintenance-guide.md)和[Node 边界](./node-runtime-boundaries.md)：删除原生一体化安装、私有 Node、自有 stable feed、自动检查/下载/切版/回滚、签名 manifest/index、固定五目标原生发布门；写入 npm 交付、显式维护、失败行动和上述保留能力不变量。
- [x] 更新[架构总览](../../architecture/overview.md)、根 [README](../../../../README.md)和 [CLI README](../../../../packages/cli/README.md)：给出唯一正式安装、同版修复、前向升级、停用与卸载命令，明确不支持已运行新版本后的降级，并写清 Node 前置、支持范围、数据保留和托管服务处理顺序；全局目录不可写时只引导使用用户级 Node 安装或其官方修复方式，不建议 `sudo npm`、放宽系统目录权限或修改知行以外的 npm 配置；不得继续把仓库运行方式当作用户安装说明。
- [x] 在 [0.1 发布准备旧稿](../../drafts/release-0.1-readiness-issues.md)的原生安装章节顶部标记“已被本文裁决取代”并链接本文；保留历史讨论，不让旧稿继续充当当前方案。
- [x] 重定稿[模块独立审查工作台](../../workbench/module-submit-review.md)中的 MIR-01～MIR-03、MIR-12、MIR-14～MIR-18、MIR-20，作废旧证据并转为 `[~]`；开箱与装配、供应链信任、维护资源、安装移除、公开反馈、兼容故障和交付闭包全部改按 npm 路径判定。本任务不得把实现或验证结果直接写成 `[x]`，后续另行执行模块独立复审。
- [x] 第 38 单元封版记录只保留历史事实：在 `research/design/workbench/unit-review-ledgers/unit-38.gen-1.md` 标明其合同已由本文取代，并将 `unit-38-final-acceptance-ledger.json`移入该历史目录后由 ledger 引用。`unit-development-workbench.md`和`unit-submit-review.md`不得继续把第 38 单元内容呈现为当前待办或当前规范。

### B. 唯一包管理器交付合同

- [x] 当前唯一官方渠道固定为 npm 全局安装：安装 `npm install -g @zhixing/cli`；同版修复或前向升级先运行`zz stop --maintenance`，再安装当前明确版本或`@latest`并运行新`zz`恢复托管；已运行新版本后不得引导安装旧版本。卸载先运行`zz app remove`，再执行`npm uninstall -g @zhixing/cli`。`npx`、源码运行和其他包管理器在形成完整独立合同前均不声明支持，避免临时缓存入口被误装成 managed/always-on 服务。
- [x] 根 `package.json`与全部运行时可达的`packages/*/package.json`补齐统一版本、`engines.node`、license/repository、`publishConfig`和精确发布文件；`engines.node`只声明经验证的最低版本，不无依据锁死补丁或最高版本，`@zhixing/test-utils`继续 private。发布时由 pnpm 将`workspace:*`转换为同版注册表依赖，全部生产依赖使用精确版本；CLI 作为应用包发布`npm-shrinkwrap.json`并复验 registry integrity，不能用用户安装时不会读取的`pnpm-lock.yaml`冒充发布锁。禁止 tarball 残留 workspace 协议、源码、测试、秘密或开发资产；同步开发锁文件且不得引入用户级 npm/pnpm 配置。
- [x] 保留`release-version.mjs`及 CLI 版本投影作为包版本单源；删除根脚本`release:channel:embed`、`release:program-tree`、`release:artifact`、`release:target-evidence`、旧`release:tooling:test`和旧`release:check`，增加窄`package:check`：构建、pack 并检查全部公开包，在临时根中把本轮所有知行 tarball 作为同版 exact 依赖安装，再运行真实 CLI/package import smoke；packed manifest 必须已经是最终 registry 依赖，临时 file 引用不得进入任何 tarball、lock 或源码。不得建设本地 registry。
- [x] 增加唯一、可重入的本地 npm 发布命令：用户授权发布后，首次写 registry 前只读确认当前 npm 身份、二次验证、`@zhixing` scope 及全部包名的发布权限；冻结同一源码与版本输入，运行时依赖包按拓扑发布到固定非用户候选 tag，再生成 CLI `npm-shrinkwrap.json`、重 pack，并从 registry exact closure 重跑`package:check`；CLI 通过候选 tag 发布且全部 integrity 全等后，才把 CLI `latest`指向该版本。重试只接受 registry 中版本和 integrity 与本轮 tarball 全等的已发布依赖，冲突即终止，任一步失败都不得移动 CLI `latest`。发布只消费用户当次显式 npm 认证，不在仓库保存 token 或应用私钥；当前不建设 CI 发布系统、stable index、签名 manifest、平台 installer 或 release report。
- [x] 当前发布 target exact-set 固定为 Windows x64，并在权威文档中写明最低 Windows 与 Node 边界；共享 CLI package manifest 不设置会阻断 macOS/Linux workspace 开发的`os/cpu`，最终 CLI 在配置、身份、服务或 home 首效果前用现有平台边界稳定拒绝未支持目标。删除`packages/mesh/package.json`面向用户安装时编译 checkpoint native helper 的生命周期脚本；mesh 构建从本轮 Windows 预构建 helper 生成同包窄 descriptor（OS/arch、包版本和摘要），打包检查与 runtime 在首次 spawn 前均对 exact bytes 复验，缺失或错配时零副作用拒绝并给出唯一行动。macOS/Linux 保留既有平台抽象，但在获得对应真实环境并完成同一最小安装验收前不发布对应 helper、不声明支持；不得恢复私有 Node 程序树、签名 manifest 或固定十二 journey 证据。
- [x] 知行公开包不得以`preinstall/install/postinstall/prepare`执行编译、下载、配置、服务注册或 home 写入；第三方生产闭包的安装脚本须按 exact 包版本形成最小审计清单，证明零网络下载、系统配置、服务注册和`ZHIXING_HOME`副作用，无法证明即替换依赖或拒绝发布。首次真实`zz`运行才可在现有交互与权限边界内创建配置、设备身份或托管服务，安装失败必须保持零知行状态副作用。

### C. 删除自有更新与原生安装生产链

- [x] 删除只服务旧交付方案的 CLI 模块及直接测试：`release-channel`、`release-verifier`、`program-store`、`installation-receipt`、`update-controller`、自动检查`runtime`、`upgrade-lifecycle`、`durable-file`、`program-installer-entry`和`program-root-removal`；删除生成文件`packages/cli/src/generated/release-channel.ts`。把仍保留的 doctor 与 prepare-uninstall 生产职责及直接测试移出`packages/cli/src/update`后删除整个 update 目录，禁止用旧命名继续暗示更新 owner 存在。
- [x] 从 anchor/executor/foreground 组合根移除 ProgramStore、release verifier、startup upgrade resume、candidate health、自动检查 timer/round、更新通知和 cleanup 注册。涉及 `packages/cli/src/serve/command.ts`、`executor-role-runtime.ts`、`host-stop-lifecycle.ts`、`local-conversation-owner.ts`；保留 stop/removal/uninstall 共用的 accepted-work、delivery、host owner 和安全停机原语。
- [x] 删除 `zz update`、`--restore-previous`和 update 状态输出；REPL、`zz status`及第一方 surface 不再读取或显示候选、下载、切版、恢复通知。保留既有协议/schema 协商与跨设备版本偏斜保护；doctor 保留本机配置、托管服务和备份配置检查，版本偏斜只比较现有连接两端 protocol range 来判断需更新的设备，并给出在该设备执行`npm install -g @zhixing/cli@latest`的唯一行动，不公开内部协议号、不恢复更新事实源或新增版本映射。
- [x] 删除 `server.update.prepare/health/status/consumeNotice`及`server.update.changed`通知，清理`packages/server/src/context.ts`、RPC method/index、CLI `rpc-program-update-facade`及所有消费者；不得保留无生产 owner 的兼容空壳。
- [x] 从`device-lifecycle`协议、journal 和公开 exports 删除`upgrade` identity、专属 phase、`upgraded/rolled-back`终态及组合根分支；stop、executor removal、anchor uninstall 的现有合同不变。产品尚无已发布 upgrade 耐久记录，因此不增加生产迁移 reader；开发机旧记录只提供显式清理说明，启动时不得继续扫描旧更新事实。
- [x] 删除`packages/core/src/protocol/release.ts`及其公开 exports/tests；若 durable schema inventory 仍被核心协议消费，将`DurableSchemaCompatibility`移入`durable-schema.ts`自身，禁止为保留该通用类型而留下 release 协议外壳。
- [x] 把`zz app remove`收敛为 npm 卸载的安全引导入口：内部责任明确命名为 prepare-uninstall，只保留安全停机、future launch exact disable/unregister、失败补偿和`ZHIXING_HOME`数据保护，删除 program root、stable installer 与异步删除 helper。成功终态固定为“已停止且不再自动启动，程序尚未卸载”，并只给 exact npm 卸载命令；不得以函数名、返回值或文案宣称包删除已经完成。
- [x] 托管服务 definition 绑定当前已安装包的绝对 CLI 入口和`process.execPath`；给现有`zz stop`增加窄`--maintenance`：先对 exact definition 关闭 future launch并回读，再走既有 stop coordinator 到安全终态；stop 拒绝或失败时只补偿本操作造成的 enabled→disabled，成功则保持 disabled，并给出 npm 安装后运行新`zz`的唯一行动。新 CLI 启动复用现有 reconcile 更新 definition 并恢复托管，不新增 update journal。用户在该流程外移动或删除 Node 时，OS 可能无法启动旧 definition，产品不得伪称能在进程启动前自愈；用户运行新 CLI/doctor 后必须识别漂移并给出 reconcile 的唯一行动，且全程保护`ZHIXING_HOME`。运行期不得调用裸`node`、npm 或 PATH 猜测，也不得在包文件被替换时继续旧进程。

### D. 删除旧发布工具、配置与派生资产

- [x] 删除`scripts/release-channel.mjs`、`build-program-tree.mjs`、`build-release-artifact.mjs`、`release-target-evidence.mjs`、旧`release-check.mjs`、`release-tooling.mjs`及其测试；通用版本同步、package exports、供应链、安全与 S7 门禁继续保留。
- [x] 从`packages/cli/tsup.config.ts`删除`program-installer`入口；CLI 构建只生成 npm 包实际消费的入口和资产。
- [x] 清理 S7/registry/runtime 派生资产：删除 update RPC、update cleanup owner、installer、ProgramStore、upgrade phase和发布 journey 的 descriptor，随后按当前生产图重建`canonical-registry`、distributed-runtime、runtime-lifecycle及相关 golden；不得手工留下旧行。
- [x] 清理仓库内旧 program tree、candidate/baseline、target evidence、release report、publish index及嵌入 channel/trust 产物。当前开发机只有在直接确认 Windows `%LOCALAPPDATA%/Zhixing` 旧程序根存在且不含用户数据时才显式清理；没有真实环境的 macOS/Linux 不产生清理任务，新产品启动流程也不得自动删除任何旧根。
- [x] 核对仓库配置和已有资源清单；只有存在直接证据时才清理旧 stable feed、原生制品、签名、公证、发布 job、变量及凭据引用，并在确认不被其他流程复用后删除，禁止读取或记录 secret 值。无已登记外部资源即结束，不为清理假设中的系统而登录、扫描或新建 CI/托管设施。

### E. 测试与验收替换

- [x] 删除或改写旧 release/ProgramStore/update/installer/upgrade/RPC 直接测试；新增负向结构测试，证明生产图零 stable URL、公钥、自动更新网络请求、timer、ProgramStore、upgrade lifecycle、update RPC和私有 Node launcher。
- [x] 本地`package:check`必须证明：所有公开 tarball版本全等且零`workspace:*`；packed manifest 的生产依赖均为精确 registry 版本，本地临时装配零路径泄漏；知行包零安装脚本、第三方安装脚本与审计清单全等；tarball仅含声明资产；在干净 Windows x64 临时环境可安装；`zz`/`zhixing --version`与 help 可执行；运行时 subpath 可解析；Windows native helper 可用；卸载 tarball 后不删除`ZHIXING_HOME`。正式发布命令另在候选依赖已入 registry 后证明 CLI shrinkwrap、安装结果版本和 registry integrity 全等。不得用 workspace 源码、历史目标证据或未声明平台的模拟结果代替。
- [x] 覆盖知行可控制的显式维护旅程：首次 tarball 安装与首次`zz`初始化、同版修复、前向升级、`stop --maintenance`成功/拒绝/补偿/重放、Node 不兼容首效果前拒绝、用户 Node 原地升级或路径换代后的显式恢复、disabled old definition→npm 安装→new definition reconcile、应用停用→npm 卸载；确认文档与 CLI 均不提供降级行动。npm 自身的目录权限、registry 不可用和安装失败不做故障模拟，只核对文档给出安全恢复行动，并由“知行包零安装脚本”证明失败不会留下知行配置、身份或服务副作用；零 `sudo npm`、raw path、内部 identity 或伪成功。
- [x] 增加功能保全矩阵并穿过打包后的公共入口与受修改的真实组合根：Agent Loop、配置与秘密、Provider、内置工具、MCP、network、server/RPC、CLI/REPL和飞书通道均能从 tarball 解析并装配；在当前 Windows x64 机器上以隔离 home、真实 child process 和 loopback 连接覆盖单机与配对拓扑、anchor/executor 三进程形态、配对与信任、跨设备任务派发/结果回收/断线恢复、备份恢复、安全停机、应用停用和永久设备移除的受影响边界。版本兼容时行为不变，版本不兼容时 fail-closed 且只给目标设备的显式 npm 更新行动；不得要求第二台物理设备、未支持平台或真实外部凭据，也不得用 workspace 源码、未触及生产装配的单元测试代替。
- [x] 按项目验证纪律运行受影响类型检查、直接测试、结构门、一次全量构建和一次本地 tarball 安装 smoke；不得以 workspace 源码运行或历史 dist 代替打包后的真实消费。

### F. 最终清零标准

- [x] 对当前源码与非历史文档执行残留扫描：除本文的边界说明外，`stable feed/index`、`ProgramStore`、`ProgramUpdateReceipt`、`server.update.*`、`kind=upgrade`、私有 Node、program installer/tree、五目标、签名/公证和 target-local journey 均不得作为当前能力、入口、配置或门禁出现。
- [x] 历史记录必须明确标记“当时事实、现已被本文取代”，不得参与当前构建、测试、审查或发布；活动工作台、README、帮助、RPC registry、package manifests和生产装配必须只有 npm 路径。
- [x] 对照“保留能力不变量”逐项复核公共命令、RPC、协议、组合根和真实用户旅程；除明确删除的原生安装与自有自动更新外，不得出现能力、平台、数据、恢复或安全合同回退。
- [x] 全部清单完成、派生资产重建、受影响 MIR 均为 `[~]`且旧证据已作废、工作区没有旧发布生成物后，判定本次范围收缩已达到可发布、可本机手测；模块独立复审与真实 npm 发布均不是本清单完成条件。

### 完成证据（2026-08-16）

- 33 项实现、消费链、异常终态、直接测试与派生资产已闭合；受影响 MIR 保持 `[~]`等待独立复审。
- 最终 `pnpm build`、结构门、S7/registry/golden 与受影响直接测试通过；本轮未执行真实 npm 写入。
- `pnpm package:check -- --skip-build` 以干净 Windows x64 临时 consumer 验证 16 个公开 tarball、公共入口、helper 与卸载数据保护；聚合 SHA-256 为 `d58884918af12b4f7143b464c588bea0e30253d11ac641608f30ae2331fedbf0`。

---

## 执行提示词

```text
目标：完整执行本文“现有系统对齐清单”，把当前产品收敛为“用户 Node + npm 全局包 + 显式维护”的唯一交付路径，并达到可发布、可在当前 Windows x64 开发机手动测试的状态。除本文明确删除的原生安装和自有自动更新外，核心能力、用户数据、身份、信任、配置、恢复与安全合同不得回退；不得扩展到未支持平台、自有发布基础设施或其他产品范围。

首个动作及每次续跑或历史压缩后的首个动作：完整读取本文的产品裁决、交付合同、当前清单及已引用权威文档，读取 `research/design/workbench/verification-runbook.md`，再核对工作区、暂存区、当前生产调用图和清单状态；只依据当前文件与源码继续，保留用户既有变更，不得暂存、提交、推送或改写暂存区。

持续执行：

1. 动手前只做一次有界可行性门禁：把每项绑定到现有责任边界、生产者、消费者、直接测试和当前机器可取得的证据，重点排查无法实现、隐含第二事实源、破坏保留能力、要求真实 npm 写入、第二台机器、未支持平台、CI、证书/公证、秘密或超过十分钟且不可拆分的本地门禁。若当前裁决能唯一推出安全替代方案，先集中修正对应清单项及直接权威文档，再复核其直接交界并继续；不得为原文字面要求硬做错误方案。只有替代选择会改变产品体验、核心能力、外部承诺或产生不可逆外部动作时才停止，带着事实、影响和最优选项报告用户。不得把推测风险、未来能力或纯观测设施加入清单。

2. 按 `A 文档与工作台 → B npm 交付合同 → C 保留职责迁移与旧生产链删除 → D 工具/配置/派生资产清理 → E 测试与验收替换 → F 最终清零` 顺序实施。先同步权威边界，再完成 package manifests、`package:check`、Windows helper descriptor、`stop --maintenance`、doctor、prepare-uninstall和托管 definition；保留职责及直接测试稳定后，才删除 update/release/ProgramStore/installer/upgrade/RPC 生产链并重建 S7/registry/golden。只复用现有事实源、stop coordinator、managed adapter、handshake compatibility和构建原语，不新增 updater、版本 registry、迁移 reader、通用 manifest/lifecycle/runner/诊断框架。

3. 每项必须同时闭合生产实现、消费链、异常终态和直接测试后才标为 `[x]`；勾选不代表独立审查通过。发现同根遗漏时先补正原项再实现，不另建重复事项；发现范围外问题只记录事实并停止扩面。删除前逐引用证明仅服务旧路径；移动 doctor 与 prepare-uninstall 后删除空 update 命名空间。仓库内生成物按已证明边界清理；开发机旧程序根先只读确认，缺失即结束，存在但无法证明不含用户数据时不得删除。不得登录、扫描或修改未登记外部系统，不读取或记录 secret。

4. 渐进验证且始终先查验证手册：每个修改阶段只运行受影响类型检查、直接测试和结构门；下游依赖上游 `dist` 时先构建对应上游，类型检查与构建不得并发；失败先区分实现、测试和运行方式，只重跑失效闭包。预计超过十分钟、无进度或不可断点续跑的本地门禁，先拆成可判定的直接证据；确实不可替代时取得用户认可后再运行。源码稳定后只运行一次最终全量构建，再运行本地 `package:check`与一次 Windows x64 tarball 安装 smoke；不得运行无关包全测、模块回归、同输入重复构建、未支持平台模拟或真实 npm 发布。所有临时结果在完成归因并确认路径后清理，收口时不得遗留进程、日志、临时包或测试 home。

5. 本地验收必须穿过打包后的公共入口和真实生产边界：packed manifests、全部本轮 tarball、CLI bin、运行时 subpath、Windows helper exact bytes、managed service、doctor、prepare-uninstall、stop coordinator及受修改组合根；多设备边界只用当前机器上的隔离 home、真实 child process和loopback。不得用 workspace 源码、历史 dist、mock 自报、第二台物理设备、macOS/Linux、真实外部凭据或 registry 状态代替。正式发布命令只实现并验证其本地纯逻辑；未获用户另行授权不得执行 npm 登录、publish、dist-tag 或任何外部写入。

6. 全部实现与验证通过后冻结同一源码、构建产物和本地 tarball 指纹，整轮只读执行四路冷启动对抗复核：唯一 npm 路径与旧链零残留；保留能力、数据和托管维护无回退；Windows 包闭包、helper 与本地验收真实可消费；权威文档、帮助、生产装配、S7/registry/golden及历史标记全等。主动重造未支持平台误门禁、旧进程重启竞争、doctor/app remove误删、降级误导、本地验收偷渡 registry和旧资产复活反例。发现真实反证时修正原项并回到对应实现与验证；任何源码或交付物修改都会使冻结指纹及本次复核失效。

完成条件：33 项全部为 `[x]`；权威文档、生产实现、消费链、直接测试和派生资产一致；最终全量构建、本地`package:check`及一次 Windows x64 tarball smoke通过；旧更新/安装/签名链零当前入口或门禁，保留能力矩阵无回退，受影响 MIR 只按本文要求转为 `[~]`等待独立复审。满足后明确报告“现有系统对齐清单已完成，可以开始本机手动测试”并立即停止；不得自行执行模块独立复审、真实 npm 发布、归档、暂存、提交或推送。
```
