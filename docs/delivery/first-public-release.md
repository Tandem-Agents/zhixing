# 知行首次公开发布：标准与推进方案

状态：准备中；内部 G1/G3 已闭合，G2/G4/G5/G6 仍等待真实外部旅程、账号渠道与发布条件。

## 一、目标与权威

**尽快发布一个边界明确、真实好用、可信且可维护的个人智能体；以优秀开源项目的交付专业度首发，以持续迭代追求长期领先。发布一个合格版本，不等于项目永远完工。**

知行是可独立部署的通用个人助手，长期方向是伴身智能。首发不要求功能数量、生态规模或所有技术达到世界领先；要求对外承诺真实，承诺范围内的体验、正确性、安全与交付质量过关。不得为凑齐“智能体基础设施清单”新增功能，也不得把当前已有正式能力降级、隐藏或删除来降低验收标准。

本文只定义首发边界、验收和推进顺序，不重开架构设计、不替代模块需求、不直接授权发布。依次依据：

- [AE-001](../../research/design/architecture/evolutions/AE-001-companion-intelligence.md) 与[当前生产架构概述](../../research/design/architecture/overview.md)：继承已形成的产品和架构基线。
- [分发与维护策略](../../research/design/modules/distributed-runtime/software-distribution-trust-and-target-strategy.md)、[安装、维护与发布](../../research/design/modules/distributed-runtime/release-and-maintenance-guide.md)：唯一正式分发路径与维护合同，不另建发布系统。
- [验证运行手册](../../research/design/workbench/verification-runbook.md)：验证方式、证据复用和资源纪律。
- 项目文档维护技能：新文档按职责归属，旧目录按需渐进迁移，不整体搬家。

## 二、当前判断

本轮只读核查基线为 `125213a6`；以下是方案依据，不是已经通过首发验收的证明。

| 已核实事实 | 对首发的意义 |
|---|---|
| AE-001 迁移任务记录为待用户确认，已有生产架构概述、回归和制品证据 | 不从零审计或再迁移一次；先核对证据输入与候选版本是否一致。架构完成不等于公开发布完成 |
| 已有 npm 打包、16 个公开包检查、Windows helper/tarball 验证与候选发布脚本 | 发布工程已有基础，优先复用；本轮未执行发布或重新验证这些结果 |
| 根目录已有 MIT LICENSE；根 README 只有中文版，结构图只列 research，缺少完整首次使用入口 | 补齐中英文入口、真实结构和首个任务路径；“数据都在本机”“插件无限扩展”等表述需按真实边界修正 |
| GitHub About 仍描述 Yuling 生态执行运行时；16 个公开包 repository 仍指向 longxia/zhixing，实际仓库为 Tandem-Agents/zhixing | 统一项目身份和包元数据，不能让公开门面指向旧产品或旧仓库 |
| 仓库未见贡献、安全报告、行为准则和问题/PR 模板；没有 docs/README.md；也未查到公开组织默认文件 | 建立最小、实际可用的使用者和贡献者入口，不堆空模板 |
| GitHub Releases 为空；公开 npm 查询 @zhixing/cli 返回 404 | 尚无可核实的公开 CLI 交付；npm scope/包权限、二次验证及安全报告通道需早核实，不能据此推断账号无权限 |
| 旧模块材料经历跨模块重构，已有部分明确标记为历史/废弃；当前架构概述已更新 | 逐项区分有效需求、过期实现说明和历史材料；不能把所有旧文档都当作新一轮开发欠账 |

## 三、发布前必须达到的标准

| 发布门 | 必须成立 | 足够的验收证据 |
|---|---|---|
| G1 产品承诺 | 正式支持 Windows 10/11 x64、Node >=24、npm 全局安装；既有正式能力不回退。准确说明本地部署、模型服务数据流、执行/审批与隔离边界、成本前提和已知限制；不宣称尚未实现的沙箱、记忆、插件平台或其他系统支持 | 中英文入口、公开命令、当前生产能力与发布说明一致；版本号和稳定性承诺明确 |
| G2 用户完成事情 | 一个不了解架构的用户能按文档安装、配置所需模型、完成一个有真实工具效果的任务、查看并恢复对话；取消/失败有真实终态和明确下一步；能诊断、停用、维护和卸载且符合数据保留合同 | 隔离 Windows 用户数据目录中的实际产品旅程；真实模型验证由用户控制凭据与外部调用授权，不读取或展示用户秘密。配对、渠道、恢复等已承诺能力复用有效直接证据，对失效交界补验，不临时删减承诺 |
| G3 工程与安全 | 现有功能、协议、历史持久化、权限、恢复与单机/多设备行为保持；无未处置 P0/P1 和已确认可利用的高风险问题；公开源码及制品无秘密或私人数据，许可证和所分发第三方内容合规 | 候选基线上有效的架构/安全门禁、根级 lint/test/build、受影响直接测试和依赖/制品检查。只输出秘密扫描的位置与类别，不输出秘密。测试绿灯不代替用户旅程 |
| G4 制品可用 | 复用现有分发合同：16 个公开包版本、精确依赖、exports、仓库元数据和许可正确，私有测试包不发布；CLI/helper 从实际包安装可用，维护与卸载行为成立 | canonical package check、Windows x64 tarball smoke；真实发布时再验证 registry 候选版本、integrity、CLI shrinkwrap 和候选安装，全部成立后才提升 latest |
| G5 开源交付完整 | 使用、贡献、维护、安全反馈和版本变化都有清楚入口；中英文主入口等价；当前文档不误导用户与贡献者；仓库与 npm 页面指向同一产品和版本 | 下节文件与元数据清单闭合；命令/链接有效，反馈通道真实可达，公开包页能解释用途并找到权威文档 |
| G6 发布闭环 | 经用户明确授权发布后，npm 对应版本、Git 标签和 GitHub Release 指向同一候选代码与版本；发布说明包含能力、支持边界、已知问题和维护注意事项；维护者与反馈入口明确 | 从公开渠道干净安装和最窄 smoke 成功，最终制品与登记证据匹配；不能用本地 workspace、旧 dist 或“上传成功”替代 |

P0 指秘密泄露、数据损坏、越权执行等严重问题；P1 指正式核心旅程阻断、错误结果/终态或无法按合同恢复。不能通过改叫“已知限制”绕过这两类问题。其他缺陷可以在不违反正式承诺的前提下明确披露并进入后续版本。

**现有能力必须保护，但不要求首发新增能力。** 强沙箱、新记忆/OWNWARD、新平台、新交互表面、插件生态、自动更新等，不因“别人有”自动成为首发阻塞项；如发现当前安全合同确实不成立，则按真实缺陷修复，不能靠声明免责。

### 对外文件与仓库信息

| 内容 | 首发处置 |
|---|---|
| README.md / README.en.md | 定位、适合的使用场景、少量可复现效果展示、支持环境、安装与首次任务、模型配置入口、安全/数据边界、当前限制、文档/贡献/支持/许可链接；互链且承诺等价。不把内部架构名词当产品卖点，不强制制作视频或新官网 |
| docs/README.md | 按“使用者 / 贡献者 / 架构与研究”导航；优先链接现有有效文档。提供最短可执行快速开始；现有文档不足时只补缺失内容，不批量搬目录 |
| LICENSE 与公开包说明 | 保留现有 MIT；核验实际 tarball 许可内容及第三方分发义务。各公开包具备正确用途、接口稳定性说明和主文档链接，不复制 16 套完整教程 |
| CONTRIBUTING.md | 当前开发环境、安装/构建/最窄测试、代码与提交规范、如何提 issue/PR、支持和变更流程；开发者源码运行不得冒充用户正式安装渠道 |
| SECURITY.md / CODE_OF_CONDUCT.md | 真实安全报告渠道、支持版本和披露边界；简短行为准则及实际受理方式。可用 GitHub 私密漏洞报告，但必须确认已启用；不得编造邮箱、团队或响应时限 |
| .github 中问题与 PR 入口 | 最小问题报告/需求请求入口和 PR 模板，收集复现、环境、范围与验证；提醒不上传凭据和私人日志。支持说明可合入 CONTRIBUTING，不必为文件数量重复建 SUPPORT |
| 版本说明 | 首版范围、安装、风险/限制、维护方式和后续方向；后续版本说明行为变化。指定一份版本说明为源，GitHub Release 引用/发布它，不把原始 commit 列表当 release notes |
| GitHub / npm 元数据 | 修正 About、description、repository、bugs 等已有或必要字段；补准确 topics，homepage 仅链接真实可用入口。确认发布 scope、包权限、账号二次验证及维护者访问权限；不保存/展示 token |

不为首发强行增加官网、文档站、CLA、复杂治理、资金页、徽章、签名公证、新安装器或 CI 发布平台。许可证、测试、安全和贡献机制必须真实有效；文件齐全或徽章齐全本身不是质量证明。当前分发合同明确不建设 CI，首发先兑现可复现的本地自动验证与发布流程，后续是否引入 CI 独立裁决，不擅自改变该合同。

## 四、推进方式：有限发布线 + 持续维护线

```text
R0 冻结首发范围、核实发布通道与真实阻塞项
  ├─ R1 修复已证实的产品/制品阻塞项 ─┐
  └─ R2 补齐公开文档、社区入口和元数据 ─┴─ R3 候选冻结与验收 ─ R4 授权发布

持续维护：模块文档校准、目录渐迁、后续模块迭代 ──────────→ 后续版本
```

| 顺序 | 工作与完成边界 |
|---|---|
| R0 先查关键条件 | 核对迁移终态证据与当前候选输入；按 G1/G2 走一次首次用户路径；确认版本、npm 发布权限及安全反馈渠道。登记有事实依据的阻塞项、对应发布门和最窄解决动作。形成可开工清单即可结束，禁止重新建立全项目事实库或重复架构审计 |
| R1 只修阻塞项 | 每包解决一条真实失败链，闭合生产、消费端和直接验证；没有发现缺陷就不造任务。预期影响多个独立责任时先拆包，不重构无关模块，不借发布增加功能 |
| R2 并行交付门面 | 按 G5 清单集中完成中文/英文入口、社区文件、导航及元数据；复用现有架构概述和维护指南。包 manifest 与 R1 同文件时由同一责任人处理，不抢写；GitHub 设置待授权后修改 |
| R3 验收候选版本 | 冻结代码、版本、构建配置和验收输入；核对 G1～G5，取得或复用同输入的有效证据，完成首次用户旅程及最终制品检查。发现真实问题只修其失效闭包，未解决不得宣告技术就绪 |
| R4 完成公开交付 | 另获推送/发布授权后按现有候选发布流程操作，完成 G6；登记版本、标签/commit、制品、说明和反馈渠道。达到退出门即结束发布工作，不等持续维护清空 |

R0 不是先通读所有源码才允许进入 R1/R2；只核实会改变首发范围、阻塞判断或证据复用的事实。发布账号条件优先核实，避免最后才发现无法交付；不要为检查权限误运行真实发布命令。

工作包默认 2～4 小时、一条结果链；短任务不凑时长，阶段不是工作包。约四小时未闭合、连续两条实质路径失败或意外扩面时，在安全检查点反馈并调整路径，不把一天耗在单个未知问题上。协调者独立核对变更与证据，执行者不自行暂存、提交或发布。

### 什么可以进入发布阻塞清单

仅限：正式产品承诺不成立；安全/数据/恢复合同破坏；无法可靠安装、交付、维护或反馈问题；公开说明及元数据错误会误导使用和贡献。每项必须有当前事实与对应发布门。

仅为代码更漂亮、模块更强、目录更整齐、文档更全面或未来可能需要的事项进入持续维护线。不能把首发范围外能力改名为“基础设施完善”塞回来；也不能把真实阻塞改名为“后续优化”放过去。

### 并行与后续功能如何不干扰发布

- 只有一个执行者时，优先做发布线；维护线排队，不声称已经并行。多人时按互不重叠的责任与文件并行，合流由协调者复核；不以采用新协作系统为发布前提。
- 沿用当前 develop/main 与版本标签，不新增复杂分支体系。候选冻结后，只允许发布阻塞修复进入候选；其他工作留在独立分支/工作区进入下一版本，不混入候选目录和构建产物。
- 新模块需求仍走自己的需求、架构、任务和验收；只有用户明确决定纳入当前版本，才重估受影响发布门。通常完成后进入下一版本，不等待它才能发布首版。
- 重型构建、测试与打包在本机串行。跨工作区也不能同时争用同一 dist、临时数据或验收进程；独立的文档工作可并行。
- 发布后维护缺陷与新功能按风险排优先级；紧急修复基于已发布版本制作新版本并同步主开发线，不覆盖已发布 tag/包，不承诺不受支持的程序降级。

## 五、滞后文档与目录：先消除误导，再逐步校准

**首发前完成：** 根 README 的真实结构、文档入口、使用/配置/安全/维护指引、当前架构入口与公开接口说明正确，所链接内容可用；仍以“当前实现”名义指导错误操作或安全判断的文档，必须纠正相关段落或明确其适用范围并指向有效说明。直接影响本版使用、贡献和验收的说明不能以“文档以后再写”跳过。

**不阻塞首发：** 全部模块的深层设计重写、历史资料搬迁和全目录统一。未核实的旧实现细节不得冒充当前指南；按需标注实现说明待核/历史参考，保留仍有效的需求和用户原始构想。已经明确废弃的材料不是待恢复的功能清单。

每次只治理一个有真实使用或开发需求的模块：沿当前生产入口与消费链核实职责，分清有效需求与过期实现说明，更新唯一现行说明；确需迁移时按技能确定归属，同时更新入口、交叉链接及读取该路径的脚本/测试。确认无断链后再处理旧位置，不凭目录名批量删除，不用当前代码反向废止有效需求。

后续模块开发的完成标准包含同步受影响的现行说明与导航；只有直接交界失效才扩查其他模块。这样目录和文档随真实工作持续收敛，不再另起一场阻塞交付的全仓整理。

## 六、验证、状态与退出

- 先核对已有有效证据，再补缺口。同一生产/构建/测试输入的结果可以复用；Git 历史整理改变 commit ID 不自动意味着代码证据失效。旧绿灯只有能反绑内容和运行环境时才有效。
- 实现修复先做最窄测试；涉及上游时先构建对应产物再测消费者。最终候选取得根级与制品所需证据，但不因每个 README 修改重复全测；文档变动检查其承诺和链接，manifest/打包输入变动重取对应制品证据。
- 执行以验证手册为准：重型任务串行、首次保留失败详情、只重验失效闭包；不放宽断言、不用 mock 或旧 dist 冒充真实交付。沿用 canonical package check，避免包装出另一套全量门禁。
- 本地打包与 registry 候选是不同检查点：现有发布流程会依据已发布依赖生成 CLI shrinkwrap 并重打包；须核验最终候选及 integrity，不能把合法重打包误判为源码漂移，也不能跳过最终候选安装验证。
- 所有演练使用隔离目录和 ZHIXING_HOME，清理临时进程/文件；不动真实私人数据。真实外部调用、仓库配置、Git 写入、推送与 npm/GitHub 发布按各自授权执行。
- 阻塞登记只记事实、发布门、责任人、下一动作和证据；无须新增通用跟踪系统。每次实质阶段完成汇报整体状态及剩余阻塞，不按文件数/测试数估算百分比；如给百分比须说明粗估依据，不让“99%”代替剩余工作说明。

当前发布门：

- [x] G1 产品范围与公开承诺一致。
- [ ] G2 真实首次使用、持续使用与维护旅程成立。
- [x] G3 工程、安全、数据和现有能力保障成立，无未处置 P0/P1。
- [ ] G4 同候选基线的正式制品验证通过。
- [ ] G5 中英文入口、文档、社区与仓库/包元数据就绪。
- [ ] G6 经授权完成公开发布，并从公开渠道验证交付。

状态依次为“方案已制定，待执行 → 准备中 → 候选验收 → 技术就绪，待发布授权 → 已发布”。G1～G5 成立才能进入技术就绪；实际公开交付并满足 G6 才是已发布。勾选必须附对应版本/输入与直接证据；输入变化立即恢复受影响门，不保留带条件的通过。

不凭当前静态核查承诺几天完成。R0 结束即可根据已确认阻塞项、外部权限和现有证据给出首发窗口；期间只有真实新增阻塞才能改变窗口，长期维护清单不进入首发关键路径。发布门全部成立后结束本轮交付，持续维护按下一版本继续。

## 七、当前执行检查点

- 当前任务是本首发方案，不是重新开启 AE-001 迁移。既有协调提示词的质量、效率及独立复核规则继续适用，其旧任务动态行不作为本轮任务来源；提示词本身未修改。
- 起点：`125213a6`，唯一进场暂存变更为本文。保留用户暂存内容；不从旧任务或提示词文本继承 Git 写权限。用户随后已授权本次发布准备涉及的 GitHub 操作；npm 登录及其他需要人工账号操作的边界统一后置，优先完成项目内部工作。正式公开发布仍须先满足候选验收与渠道条件，不因授权提前宣告完成。
- `RELEASE-P01` 已独立接受：README 中英文与 docs 导航齐备；34 个本地链接存在，7 组 PowerShell 代码块双语一致，工作区/审批/维护说明已反绑 startup、resolveWorkspace、PermissionMatcher、REPL 和维护合同。纠正了目录隔离保证、同版修复意外升级和每次人工批准的误述，去掉执行过程自述。仅是公开使用说明闭合，真实模型、registry 安装及维护旅程尚未验收，未勾选任何 G 门。
- `RELEASE-P02` 已独立接受：16 个公开 manifest 的差异仅为 repository/homepage/bugs，包 README 已补齐；本轮实际 pack 16/16 均含 README 和与根文件一致的 MIT 许可，无需复制许可。现有结构测试 3/3、版本检查及脚本语法检查通过。已删除无依据的标题和外链限制；协调者直接调用两份实际检查函数，确认自然标题与 Node.js 外链可通过、空文档仍拒绝，元数据和随包许可保护保留。未重跑未失效的打包；这些证据不等于正式安装验收。
- `RELEASE-P03` 已独立接受：贡献指南、简短行为准则、问题/需求与 PR 模板及三处导航已补齐。首次源码运行顺序已改为安装、构建、运行；定向测试采用真实 core 文件和验证手册中的包内入口。行为举报区分 GitHub 平台渠道与项目责任，未编造私密联系人。协调者核对 43 个本地链接、命令顺序与实际文件；未为文档改动执行构建或全测。安全报告渠道尚未启用，不能借文件齐备勾选 G5。
- `RELEASE-P04` 已独立接受：输入为 `HEAD 125213a66489af3cc9edec392fc4fec613328e9b` 加已接受的 P01～P03 工作区；当前相对 HEAD 没有生产 TypeScript、依赖、版本、exports/bin、构建配置或 lockfile 变化，39 份实际 delivery overlay（根 manifest/lock/workspace/许可、两份 canonical 检查输入、安装脚本审计、16 包 manifest 与 README）的组合 SHA-256 为 `dcd3dae1f40558523aff8caf0e5fe4dff17aa01ba425748c03073f612a563339`，协调者重算一致。因 Git 忽略的既有 `dist` 没有独立内容标识，本轮未用 `--skip-build`，只运行一次默认 `pnpm package:check`；exit 0，结构门 `3/3`、版本检查与 17 个 workspace fresh build 成功，随后 16 个 `0.1.0` tarball 完成精确依赖/元数据/README/根 MIT 校验、隔离 clean install、全部声明 export 目标加载、installed CLI JS 的 version/help/doctor/maintenance/app-remove/空 home 首次非交互边界、Windows x64 helper 实际启动关闭及 npm uninstall 后 `ZHIXING_HOME` sentinel 保留，组合 tarball SHA-256 为 `87878dc16728e3e6de495a7e142d722f7196c09ce7798ae7a37e61b713a4958f`，协调者核对实际命令输出一致。结束后临时 package-check 根、独立 npm cache/userconfig、helper/child 与相关进程均为零；没有使用真实 home、秘密、模型账号、全局安装、托管定义、registry 写入或发布。
- P04 证据复用与未验范围：AE-001 最终独立验收中的根功能回归、contracts、runtime、security/S7 证据所依赖的生产/测试/合同/安全输入未被 P01～P03 改动，继续作为历史同内容证据引用；本轮没有声称重新运行根 lint/test。P02 改动的 package metadata、README 与两个 delivery 检查输入已由本次 fresh build、结构门和完整 canonical 制品状态机直接覆盖。本地候选仍未验证 npm registry candidate/integrity/CLI shrinkwrap、全局安装后的 `zz`/`zhixing` bin shim、真实 OS managed definition、真实模型首次任务及远程发布；因此本记录不勾选 G1～G6，也不宣称 G4、技术就绪或已发布。
- 外部待办后置：`npm whoami` 返回 `ENEEDAUTH`，按用户要求暂不推进登录、scope 权限或真实发布。GitHub 操作已授权，但当前可用浏览器显示未登录、未发现可调用的 GitHub 连接器，私密漏洞报告仍为关闭；不读取凭据绕过，不把授权等同于设置已生效。账号会话就绪后再启用渠道、校准 About/topics 并核对远程结果；不阻塞本地开发与验收，不反复要求用户登录。相应发布门保持未完成。
- `RELEASE-P05` 已独立接受：新增唯一版本说明 `docs/delivery/releases/0.1.0.md` 与唯一社区安全权威 `SECURITY.md`，并把中英文 README、文档导航、贡献指南和缺陷模板收口为引用；版本说明仅登记当前已实现能力、Windows 10/11 x64 + Node >=24 支持边界、数据/执行/费用、维护和已知限制，明确尚未发布。安全政策如实说明私密报告渠道尚未启用；26 份公开入口的 65 个本地链接均存在。按 P04 同输入的 16 包 fresh-build 输出扫描 878 个实际制品文件无秘密候选；当前树与拟公开新增内容的有限扫描覆盖 2105 份文件。协调者核实唯一待判命中是历史研究记录中的通用设备账户名（5 处），未发现凭据、真实个人身份或访问能力暴露依据；现已按文档可移植性统一为 `<USER>` 占位，不构成 P0/P1，不要求历史清洗，也不因此阻塞 G3/G5。问题模板的政策引用已改用 GitHub 绝对链接，避免 Issue Form 的渲染位置改变相对路径。其余命中为合成测试凭据、变量名或示例；有限扫描不宣称证明任何秘密都不可能存在。
- P05 许可裁决：16 个公开包未设置 third-party bundling，338 份 fresh source map 的 836 个 source 引用中无 `node_modules`/`.pnpm` 来源，Windows helper 只引用仓库源码与平台库；实际可解析的安装生产闭包为 214 个唯一第三方包版本，许可证集合为 MIT 167、ISC 18、BSD-3-Clause 16、BlueOak-1.0.0 5、Apache-2.0 4、BSD-2-Clause 2、0BSD 2，无未解析、未声明、copyleft 或自定义项。canonical `pnpm licenses list --prod --json` 因本机 pnpm store 缺少 `cli-highlight@2.1.11` 索引元数据而无法产出报告，故本轮使用 16 个公开 manifest 从实际 Node 解析路径递归读取 dependency/optional/peer manifest，并确认全部依赖可解析；P04 已证明每个 tarball 带与根一致的 MIT 许可，本轮未发现需要新增 NOTICE 或改许可文本的分发内容。该有限核查不冒充通用供应链审计。
- `RELEASE-P06` 已独立复核：CLI 指南已按生产事实纠正配置文件覆盖、home 派生端口与发现、`/mcp`、安全停机、持久 token、隐藏日志现状和历史常驻服务材料标识；协调者进一步发现 `lifecycle.ts` 用 `process.once` 安装 SIGINT，因此“重复 Ctrl+C 一定只记录”的描述无证据，已改为等待停机完成、不重复中断；不据此新增停机功能。只读生产反查入口为 `providers/src/paths.ts`、`cli/src/commands/config-commands.ts`、`cli/src/serve/{command,executor-role-runtime,stop,logs}.ts` 与 `server/src/{lifecycle,server,process-lock,server-state}.ts`。
- P06 生产依赖审计：2026-09-06 使用隔离的空 npm user/global config 与官方 npm registry，只运行一次 `pnpm audit --prod --json`；命令按发现风险返回 exit 1，覆盖全部 workspace 生产依赖和 16 个公开包，报告 232 个生产依赖、86 条 advisory（critical 0 / high 32 / moderate 49 / low 5），原始 JSON 为 493433 bytes、SHA-256 `98583134063514374ce31ef02c1262e4b8e04a8b8283818d43c2cd739957c4bc`。本记录只保留公开包名、版本、路径和公告，不保留本机绝对路径、配置或秘密；未运行 audit fix，manifest、lockfile 与依赖安装均未改变。

  | 实际版本与公开包路径 | 报告 | 生产可达性与公告条件裁决 | 发布处置 |
  |---|---:|---|---|
  | 初始 `brace-expansion@5.0.5` ← `@zhixing/tools-builtin > glob@13.0.6 > minimatch@10.2.5`；P07 后锁定 `5.0.9` | 3 high / 1 moderate | `glob.pattern` 与 `grep.glob` 由运行期工具输入直接进入 `glob`，schema/调用前均无长度或 brace 限制，且两个只读工具无需审批；[GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) 明确 `<5.0.9` 可由约 25 KB 输入造成不可捕获 OOM、约 400 KB 输入长时间阻塞，并把经 glob 传入的不可信 pattern 列为受影响条件。P07 前生产 ESM 默认入口实际加载 `glob/dist/esm/index.min.js` 的内嵌旧实现；现已让 Glob/Grep 只走公开 `glob/raw`，由外部 `minimatch` 解析锁定的 `brace-expansion@5.0.9`，并在 workspace、构建产物和隔离安装后的 tarball 上直接验证 | **`RELEASE-G3-01` 已独立确认修复**：根 override/lockfile 与 CLI candidate root override 均拒绝 `<5.0.9`；发布脚本还要求最终 CLI shrinkwrap 中每个 brace entry 为 `5.0.9` 且带 integrity。恢复 `glob` 默认入口、放宽 override/lock/shrinkwrap、移除任一 Glob/Grep 受限子进程反例，或相关 dependency graph 改变，均使本证据失效 |
  | `ws@8.20.0` ← `@zhixing/server`，同一解析版本也被 Feishu SDK 使用 | 1 high / 1 moderate | Host 的 `WebSocketServer({ noServer: true })` 在 JSON-RPC 认证前处理 frame，且未显式降低 `maxPayload`；但正式 CLI 只绑定 `127.0.0.1`、没有公开 host 参数，Feishu client 的对端固定为平台服务。[GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) 要求恶意 peer 发送大量碎片。当前支持形态未建立远程攻击者控制 frame 碎片的路径 | 未定为当前发布阻塞；发布后维护时可升级至 `>=8.21.0`，并在最终候选复核 Server/Feishu 连接闭包。若支持监听面或 peer 信任边界改变，本裁决立即失效 |
  | `undici@7.25.0` ← `@zhixing/network` | 4 high / 6 moderate / 2 low | 生产只使用 `fetch`、`Agent`、`EnvHttpProxyAgent` 与 HTTP(S) `ProxyAgent`；没有 `WebSocket`、SOCKS agent、cache interceptor、cookie helper 或 retry interceptor。官方 [Undici 7.x 安全发布说明](https://github.com/nodejs/undici/releases) 中的 high 条件集中在 WebSocket、SOCKS 与共享 cache，当前未命中；MCP HTTP 只经禁 redirect 的安全 fetch 发送协议 JSON | 未确认当前可利用高风险，不阻塞本轮；发布后维护时可升级至 `>=7.29.0` 并重取 network/MCP 定向证据。生产若加入上述 API，裁决失效 |
  | `@anthropic-ai/sdk@0.85.0` ← `@zhixing/providers` | 1 moderate | 当前 adapter 只构造 Messages streaming client；不启用本地文件系统 Memory Tool。公告 [GHSA-p7fg-763f-g4gf](https://github.com/advisories/GHSA-p7fg-763f-g4gf) 的文件权限条件不可达 | 非阻塞依赖维护输入；升级至 `>=0.91.1` 时重取 Anthropic adapter 定向证据 |
  | `axios@1.13.6`（10 high / 17 moderate / 1 low）、`protobufjs@7.5.5`（5 high / 6 moderate）、`@protobufjs/utf8@1.1.0`（1 moderate）、`form-data@4.0.5`（1 high）、`qs@6.15.1`（3 moderate） ← `@zhixing/channel-feishu > @larksuiteoapi/node-sdk@1.60.0` | 44 条 | 当前只用固定 Feishu/Lark domain 的 WS 收件、固定生成的 protobuf Frame、JSON 卡片发送与已签名回调；不加载攻击者 schema/descriptor/`Any`，不调用 SDK multipart API，也未发现可由 channel payload 产生的 prototype pollution source。Axios 的高危公告（如 [GHSA-35jp-ww65-95wh](https://github.com/advisories/GHSA-35jp-ww65-95wh)）要求先有 prototype pollution 或特定 proxy/redirect/config gadget；protobuf `Any` DoS [GHSA-wcpc-wj8m-hjx6](https://github.com/advisories/GHSA-wcpc-wj8m-hjx6) 要求含 `Any` 的不可信 schema 与 JSON/plain-object 转换，均未由当前链满足 | 未确认当前可利用高风险；发布后维护时集中升级 Lark SDK/其兼容传递依赖并重取 Feishu 连接、收件、回调和发送证据。若增加文件上传、可配置 API endpoint/schema 或发现 prototype pollution source，裁决失效 |
  | `hono@4.12.22`（1 high / 10 moderate / 1 low）、`@hono/node-server@1.19.14`（1 moderate）、`body-parser@2.2.2`（1 low）、`ip-address@10.2.0`（1 high / 2 moderate） ← `@zhixing/mcp > @modelcontextprotocol/sdk@1.29.0` | 17 条 | 正式 MCP 只导入 SDK `client/*` 与 `shared/transport`；未导入或启动 SDK 的 Hono/Express server、static/Lambda/CORS/rate-limit 分支 | 当前生产不可达、非阻塞；发布后维护升级 SDK 后重取 client-only import 与 transport 闭包。任何 MCP server 入口加入即失效 |
  | `fast-uri@3.1.2` ← MCP SDK client 默认 Ajv | 6 high | client 构造会加载 Ajv/fast-uri，但当前仅用于内存 JSON Schema 引用解析；没有 `loadSchema` 网络回调，也不以解析出的 host 作 SSRF/信任裁决。现有 host-confusion 公告要求下游据错误规范化结果发网或作安全判断，当前未形成该效果链 | 未确认当前可利用高风险；发布后维护随 MCP SDK/Ajv 闭包升级至 `>=3.1.6`，并保留 MCP tool-schema 拒绝证据。若启用远程 schema 加载或用解析结果发网，裁决失效 |

- P06 制品输入复核：CLI README 当前 SHA-256 为 `fe237a75bbcac435f1311fa3bfb6cd0e4c74c7128841be793cb53259947a88e0`。最初从根使用 `pnpm --filter @zhixing/cli pack` 在实际 pack 前因 pnpm 报 `Unknown option: recursive` 退出；随后仅在 `packages/cli` 目录执行一次窄 `pnpm pack`，未 build、install 或运行完整 package check。新 tarball SHA-256 为 `4dd082b48bc3b86d309de1b798f873e22147aa69fbeb72105ceef4ab40eb78b4`；包内 README 与输入 hash 全等，包内 `LICENSE` 与根 MIT 的 SHA-256 均为 `b1d8f64a3e0816139f7d3de3bb0a173f64757578010090cd5a6a008ebe6304f1`，`@zhixing/cli@0.1.0` 的 repository/directory/homepage/bugs/public access、双 bin 与 20 个 exact registry dependency 均成立。本次 hash 只证明 CLI 内容与元数据，不取代 P04 的 16 包 fresh build/install/helper 证据；P04 组合 tarball hash 不包含新 README，已明确失效且不得继续引用为当前候选 G4 证据。
- `RELEASE-P07` 已独立接受：旧生产 `glob` 默认入口在 `--max-old-space-size=64` 子进程上处理同一约 25 KB 公告形态输入时约 `3.9s` 即以 heap OOM 退出；改用 `glob/raw` 并锁定 `brace-expansion@5.0.9` 后，同一受限入口约 `6.2s` 正常结束。Glob 与 Grep 的源码直接闭包连同正常路径/brace/filter 行为共 `4` 文件 `55/55` 通过，其中两个对抗用例分别命中真实工具；交付结构门 `4/4` 通过，构建后的 tools-builtin 两处 import 均为 `glob/raw`。仅一次根 `pnpm build` 成功构建全部 `17` 个 workspace 包；随后仅一次 `pnpm package:check -- --skip-build` 完成 `16` 个公开包的 tarball、隔离 clean install、公开入口、安装后 Glob/Grep 同一 `64 MB / 15s` 对抗边界、CLI/helper 与 uninstall/sentinel 检查，组合 tarball SHA-256 为 `9ee5b69587139da38cedf22451d22559c2df0f8d49e8f73b62befe63b4e12fee`，临时 package-check 根已由 canonical finally 清理。本包未运行 publish、registry 写入、登录或其余 advisory 升级。 协调者核对真实构建/安装命令结果与产物入口，另直接调用发布脚本的实际 `verifyShrinkwrap`：合法版本通过，旧版本、缺 integrity、嵌套旧版本和缺 brace 四类输入均拒绝（5/5），结构门独立 4/4；未执行发布入口。
- P07 候选与验证边界：workspace override 负责开发/构建图，CLI manifest override 在发布脚本把已打包 CLI 解压为 candidate root、生成 lock/shrinkwrap 时生效；`verifyShrinkwrap` 再对最终 `brace-expansion@5.0.9 + integrity` fail closed。package check 的 16 包本地 tarball 消费证明正式安装形态实际通过修复链，但不冒充尚未执行的 registry candidate/shrinkwrap 或全局安装。P07 直接执行 tools-builtin 全包 TypeScript 检查时命中的既有 `ContentThreat` 窄 subpath 类型出口缺口已由 P08 最窄关闭；P07 的 brace 修复、直接测试和发布脚本边界没有因此改变。
- `RELEASE-P08` 已独立接受：`@zhixing/core/skills/admission` 以 type-only 方式正式导出其公开合同已使用的 `ContentThreat`，未新增 runtime export、根 barrel 或第二合同；fresh `packages/core/dist/skills/admission.d.ts` 已包含该类型，tools-builtin 真实 `tsc --noEmit` 通过。core admission 与 tools-builtin admit-skill 直接闭包共 `2` 文件 `13/13` 通过，单文件 Biome 与 runtime package exports 通过；仅一次根 `pnpm build` 成功构建 `17` 个 workspace 包。随后仅一次 `pnpm package:check -- --skip-build` 完成结构门 `4/4`、16 个公开包的 tarball、隔离 clean install、公开入口、CLI/helper、brace 对抗和 uninstall/sentinel 检查，组合 tarball SHA-256 为 `6d61946be888dbc5f5cd2c726eb666b6cc2cc6ed80677b73f605a2c78aea89bc`，canonical finally 已清理临时根。本轮未重跑 P07 的直接闭包、根级测试或审计，未访问账号、真实模型、registry 或远程仓库。 协调者另行执行 tools-builtin 类型检查及本轮 4 个 TypeScript 文件的 Biome 均通过，并核对实际 13 项测试、制品命令结果与声明产物。内部交接基线为 `HEAD 125213a66489af3cc9edec392fc4fec613328e9b + 当前工作区`；相对该基线的 44 份交付相关输入（P04 原 39 份，加发布脚本、3 份生产源码和新增 brace 测试）按路径排序后组合 SHA-256 为 `ffc222115bb491d07ff7a969afe66df266630d5a7cd657750f6b08178e881ded`。记录状态修改不改变此输入集合；后续修改须按影响重验。

  | 发布门 | 当前可复用/新增证据 | 尚未闭合的唯一边界 |
  |---|---|---|
  | G1 | **内部条件已闭合**：P01 中英文入口、P05 `0.1.0` 版本说明、P06 CLI 指南与 P08 最终 manifest/制品输入一致；公开说明统一为 Windows 10/11 x64、Node `>=24.0.0`、发布后的 npm 全局安装入口，并明确本地部署、模型数据流、真实效果/审批/隔离、费用和首版限制；未把强沙箱、长期记忆、无限插件平台或其他系统支持写成现有承诺 | 无；真实模型旅程属于 G2，公开 registry/global-install 的交付证明属于 G4，不与本门的承诺校准混算 |
  | G2 | P04 隔离安装后的 CLI 基础 smoke；既有同内容的对话恢复、停止、维护与卸载直接证据 | 用户控制凭据的真实模型首次任务/持续会话；真实 Windows 托管定义，以及承诺的配对/渠道/备份旅程在最终候选输入上的适用复核 |
  | G3 | **内部条件已闭合**：既有架构、安全、持久与恢复证据；P05 源码/制品秘密与许可核查；P06 一次生产依赖审计及可达性裁决；P07 关闭唯一确认可利用的 `RELEASE-G3-01`；P08 关闭 `ContentThreat` 窄类型出口缺口，并以 fresh build、真实 tools-builtin typecheck、13 项直接测试及同基线 package check 恢复工程/安装闭包 | 无当前未处置 P0/P1 或已确认可利用高风险；依赖组按已登记失效条件进入发布后维护，不把 advisory 数量冒充可利用性 |
  | G4 | P08 当前 fresh-build 输入的 16 包 canonical tarball/install/helper/uninstall 与安装后 brace 对抗证据（组合 tarball SHA-256 `6d61946be888dbc5f5cd2c726eb666b6cc2cc6ed80677b73f605a2c78aea89bc`） | registry candidate/integrity/CLI shrinkwrap、公开安装与真实全局 bin/托管 smoke |
  | G5 | P01～P03、P05 的中英文入口、导航、贡献/行为/问题模板、安全政策和版本说明；P06 CLI 指南当前事实 | 私密漏洞渠道真实启用、GitHub About/topics 与远程链接/页面核对；最终包页/仓库元数据随候选复核 |
  | G6 | 发布脚本与零写默认入口已有历史证据 | npm 身份/scope/2FA、候选发布、Git tag、GitHub Release、latest 提升及公开渠道干净安装均待单独授权和账号会话 |

- 当前唯一确认可利用的内部安全阻塞 `RELEASE-G3-01` 已在 P07 独立确认关闭，`ContentThreat` 类型出口缺口也已在 P08 关闭；`ws`、Undici、Anthropic、Feishu 与 MCP 依赖组仍是有明确失效条件和最窄升级边界的发布后维护候选，不以 advisory 数量伪装成当前可利用问题。G1/G3 因内部有限集合已全等而勾选；G2/G4/G5/G6 不因局部证据预勾，整体仍是“准备中”，不宣称技术就绪或已发布。
- 内部准备在 P08 独立接受后停止派发，无当前已确认的内部阻塞。外部条件按用户要求后置、具备哪项先处理哪项：①用户控制凭据完成隔离 home 的真实模型首次任务、持续会话和适用旅程；②已授权的 GitHub 操作待登录会话可用后，启用私密漏洞报告、校准 About/topics、同步并核对公开文件；③npm 登录、scope/2FA 与 npm 发布授权就绪后，沿既有流程发布 candidate 并核验 integrity/shrinkwrap、公开全局安装和真实托管。候选发布与验收属于 G4 的必要步骤，不误设“先 G4 通过才允许发布 candidate”的循环；只有 G1～G5 成立才能完成 G6 的正式推广、标签/Release 与公开复验。不得读取凭据、绕过登录或用本地 tarball 冒充外部结果；本次未暂存、提交、推送或发布。

## 参考依据

“顶级开源项目”没有一份自动保证质量的统一文件清单。本文采用与当前规模相称的工程和社区实践，不宣称取得认证：

- [OpenSSF Best Practices：Passing](https://www.bestpractices.dev/en/criteria/0)：参考获取软件、文档、贡献、版本说明、测试与安全披露等方面；自动测试与是否部署 CI 不是同一要求。
- [GitHub 社区健康文件](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file)：参考贡献、行为准则、安全与问题模板；模板必须有实际维护方式。
- [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)：用于版本标签、发布说明与公开交付入口。
