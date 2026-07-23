# 知行分布式运行时 · 可执行规格

> 方向、不变量与实施序列以 [知行分布式运行时架构总纲](./distributed-runtime-charter.md) 为准，本文承载字段级规格；两者冲突总纲赢，发现总纲自身矛盾按封版流程回改总纲。需求原话见 [需求与信息核验](./always-online-and-local-execution-requirements.md)。
>
> **审查口径**（只审可实现性与完备性，不受理方向异议——方向异议指向总纲走重开流程）：① 覆盖性——总纲点名构件逐一有唯一展开，18 条不变量各有测试口径；② 无歧义——字段有类型语义、转移有触发守卫，冻结区零业务 `unknown`；③ 一致性——与总纲零冲突、术语单源；④ 可开工性——S1 仅凭本文与代码基线可开工。

## 一、规格总则

### 1.1 标识符、epoch 与时钟

```ts
type Ulid = string;          // 26 字符 Crockford Base32，可排序
type IsoTime = string;       // ISO-8601 UTC；语义恒为"签发者时钟"，接收端换算本地单调 deadline
type Digest = string;        // "sha256:<hex64>"；算法前缀显式，默认 SHA-256，S2 供应链评审可替换
type KeyConfirmation = string; // "mac:<suite>:<base64url>"；有密钥认证值，不是 Digest，不得进入摘要注册表
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
interface Signature { alg: string; keyId: string; sig: string }   // 默认 ed25519
```

- id 前缀规则：`run- / asg- / jobrun- / req- / rsv- / use- / xfer- / cap- / tkt- / grt- / ich- / dlv- / int- / offer-` + Ulid。conversationId 沿既有；本地域对话恒为 `local-<deviceId 前 8 位>-<Ulid>`。
- 协议标识符统一为非空且不超过 480 个 UTF-16 code unit；所有生产端、wire validator、耐久 reducer 与恢复投影复用同一判定。自由文本和原始字节使用各自字段合同，不套用标识符上界。
- epoch 规则（uint64、单调、永不回退）：`anchorEpoch`（迁居 / 换代 +1）、`trustEpoch`（issuer-transition +1）、`ownerEpoch`（对话权威转移 +1）、`localGovernorEpoch`（设备级治理域 epoch，仅本地域整体重置时 +1；单个对话被收编不改变它，对话级 fencing 由该对话自己的 `ownerEpoch` 承担）、`streamEpoch`（assignment 数据面重连 +1）。`localDomainId = "local:"+deviceId`。
- 时钟：协议时间戳恒为签发者时钟；跨设备只用 `issuedAt + TTL` 换算单调 deadline；`maxClockSkewMs = 120_000`（初值，S2 标定）。
- 幂等键单源表：入口 `(surfacePrincipal, ingressId)`；控制写 `requestId`；allow-once 应答 `(assignmentId, interactionRequestId)`；渠道 challenge 外发 / grant `challengeId`；提交 `(conversationId, runId)` / `(taskId, jobRunId)`；派发 `assignmentId`；扣账 `usageId`；结算 `reservationId + 动作`。DeliveryOutbox 入队键统一为 `D("DeliveryEnqueueKeyBody",1,keyBody)`，`keyBody` 的唯一字段合同是 §4.3 `DeliveryEnqueueKeyBody`；同一权威事实重放必须复用原键，不得以当前 epoch、attempt 或投递目标另造身份；同键仅在 `intentDigest` 相同时回放原 item，否则拒绝为 `idempotency-conflict`。

### 1.2 规范化字节与签名域分离（全部签名 / digest 对象共用）

- 规范化：wire 与签名输入采用 UTF-8 的 RFC 8785（JCS）规范化 JSON；uint64 一律以规范十进制字符串上 wire，避免跨语言精度分歧。
- 签名输入固定为 `"zhixing:<schemaId>:v<version>" + 0x00 + canonicalPayload`，覆盖除 `signature` 外的全部字段；`schemaId + version` 与 DTO 顶层版本一致（域分离，杜绝跨类型/版本重放）。
- 验证端对完整对象图递归拒绝未知字段与错误类型；字段演进只经顶层 `v` 升版（本文全部跨 wire DTO 顶层带 `v: 1`，行文省略不重复标注）。所有嵌套判别联合、数组元素、可选对象均复用其唯一版本化 validator；“字段存在”只按 `!== undefined` 判定，禁止以 truthy/falsy 绕过对象校验。
- 摘要域单源：`D(schemaId, v, payload) = H(UTF8("zhixing:" + schemaId + ":v" + v) || 0x00 || JCS(payload))`；原始内容摘要记为 `B(bytes) = H(bytes)`。两者输出均为 §1.1 `Digest`。`D` 用于协议对象/子对象身份，`B` 只用于不可变原始字节；禁止以裸 `H(JCS(...))` 新造协议摘要。
- 有密钥认证域单源：`K(schemaId,v,key,payload) = MAC(key, UTF8("zhixing:" + schemaId + ":v" + v) || 0x00 || JCS(payload))`，输出 §1.1 `KeyConfirmation`；字段自身及同层 finished/authenticator 集合不得进入 payload。当前仅注册 `PairingJoin.confirmation` 与 `PairingFinished.*.keyConfirm`，不得以 `Digest` 代替或把无密钥 `D` 当作密钥确认。
- **自摘要**：先从完整对象排除 `signature` 与正在计算的自摘要字段，再计算 `D`；随后签名覆盖**含已计算摘要**在内、仅排除 `signature` 的完整对象。当前自摘要注册表唯一包含：`TrustRuleSnapshot.digest`、`ResourceLease.digest`、`UsageReport.digest`、`ConfigAssetRecord.digest`、`CommitEnvelope.envelopeDigest`、`MutationBatch.digest`、`ExecutionManifest.digest`、`JobCommitFence.digest`、`SealedBundle.digest`、`CheckpointEnvelope.digest`。未登记的字段不得被解释为“包含它的对象之摘要”。
- **无自摘要字段的对象/子对象身份**：签名 DTO 被其他对象按摘要引用时，身份统一为 `D(schemaId, v, 对象去 signature)`，重签不改变身份；当前目标包括 `HomeTrustEvent`、`DispatchEnvelope`、`EvidenceRequest`、`DataPlaneTicket`、`SourceFreezeProof`、`PermissionSnapshotLease` 与 `InteractionMirrorBatch`，其中 `PermissionLeaseDigest = D("PermissionSnapshotLease",1,PermissionSnapshotLease 去 signature)`、mirror 耐久请求身份 = `D("InteractionMirrorBatch",1,InteractionMirrorBatch 去 signature)`。无签名子对象按其命名 schema 直接计算；`AssignmentActivationDigest = D("AssignmentActivationPayload",1,AssignmentActivationPayload)`。
- **链摘要**：home 信任链 genesis 的 `prevEventDigest = D("HomeTrustChainSeed",1,{homeId})`，后续 `prevEventDigest / chainHead.eventDigest` 引用上条 `HomeTrustEvent eventDigest`。assignment 账本固定 `L0 = D("AssignmentLedgerSeed",1,{assignmentId})`，`Ln = D("AssignmentLedgerStep",1,{previous: L(n-1), entry: AssignmentEntry_n})`；`LedgerEvidencePage.chainDigest`、`DispatchRejectionProof.ledgerDigest`、`DispatchConflictProof.receivedLedgerDigest`、`SupersedeProof.ledgerDigest` 与 `CancelProofBody.ledgerDigest` 均引用对应 `recordSeq` 的 `Ln`。interaction 审计链固定 `M0 = D("InteractionMirrorSeed",1,{assignmentId})`，每个 `interaction-finished` 按完成次序分配连续 ordinal，并计算 `Mn = D("InteractionMirrorStep",1,{previous:M(n-1),entry:{ordinal,seq,requestId,kind,outcome}})`；`at` 由批次签名绑定但不进入链步（共享 assignment reducer 无需日志 envelope 时间即可复算）。`streamDigest` 使用 §5.6 的独立链公式，不混用本规则。
- **内容与引用摘要**：`ArtifactRef.digest`、`ContentAssetRef.digest`、`CheckpointEnvelope.chunks[].digest`、`EvidenceRequest.items[].digestHint`、证据 `contentDigest`、副作用 `resultDigest`、投递回执 `receipt.digest` 与恢复验证 `nonceDigest` 恒为各自所指不可变原始字节的 `B(bytes)`；`PairingOffer.issuer.keyFingerprint = B(规范公钥字节)`。`manifestDigest / snapshotDigest / parentDigest / reportDigest / envelopeDigest / requestDigest` 等引用字段必须等于目标对象按本表得到的摘要，不得对引用字段所在对象再哈希。`FinalOutboxRecord.digest / FinalFrame.digest` 固定引用 `SealedBundle.digest`；`AssetIndexEntry.digest` 固定引用对应资产 artifact 的 `ArtifactRef.digest`。
- **派生子对象摘要**：`ControlEnvelope.payloadDigest`、challenge `displayDigest`、delivery 的 key / `intentDigest` / open / resolution / responseBinding 摘要、confirmation `decisionDigest`、uncertain `openFactDigest / factDigest`、system job `paramsDigest`、`TaskDefinitionBody.deliveryPlan.planDigest`、`PairingOfferDigest` 与恢复计划 `activationDigest` 均以各自命名 schemaId 调用 `D`；其中 `ConfirmationDecisionDigest = D("ConfirmationDecision",1,{requestId,decision})`，绑定一次确认操作的完整规范决定；`DeliveryResponseBinding = D("DeliveryResponseBinding",1,{itemId,attempt,startedAt})`——transport 响应归属绑定，不含 anchorEpoch、迁居不变；delivery 的 open / resolution 摘要含 epoch、仅用于 uncertain 裁决 fencing，与响应绑定不得混用。`PairingOfferDigest = D("PairingOffer",1,offer)`、`paramsDigest = D("SystemJobParams",1,params ?? null)`、`planDigest = D("JobDeliveryPlan",1,{delivery})`。`CredentialExposureRecord.principalFingerprint / CredentialBindingDescriptor.principalFingerprint = D("CredentialPrincipal",1,{service,canonicalProviderPrincipal})`，只允许来自 service-verified 身份核验，`user-alias` 必须省略；`ObservationToken.preStateFingerprint / postStateFingerprint = D("EvidenceObservationState",1,{items})`，items 按请求顺序承载 `{kind,locator,state:{kind:"missing"}|{kind:"present",contentDigest}}`。各节只列 payload 字段，不再另立算法。新增或升版任何 `Digest` 类型字段必须先登记为“自摘要 / 对象身份 / 链 / 内容 / 引用 / 派生”之一；有密钥认证值必须用 `KeyConfirmation`，contracts lint 未命中或多重命中即失败。
- 引用目标注册表（同名字段按所在 DTO 取对应行，禁止按名字猜）：

  | 引用字段 | 唯一目标 |
  |---|---|
  | `snapshotDigest / manifestDigest / parentDigest / reportDigest` | `TrustRuleSnapshot.digest / ExecutionManifest.digest / ResourceLease.digest / UsageReport.digest` |
  | activation 的 `commit.envelopeDigest`；恢复验证/流记录的 `envelopeDigest` | `CommitEnvelope.envelopeDigest`；`CheckpointEnvelope.digest` |
  | `dispatchDigest / ticketDigest / requestDigest` | `DispatchEnvelope` 对象身份；`DataPlaneTicket` 对象身份；`EvidenceRequest` 对象身份 |
  | assigned / activation 的 `permissionLeaseDigest`；conflict proof 的 `acceptedActivationDigest / conflictingActivationDigest` | `PermissionLeaseDigest`；对应 `AssignmentActivationDigest` |
  | `PairingAcceptance.transcriptDigest / HomeTrustEvent.pairingTranscriptDigest` | 同一 `D("PairingTranscript",1,{offer,join,pakeRounds})`（不含 acceptance，避免自引用） |
  | `freezeProofDigest / trustTransitionDigest / readyProofDigest` | `SourceFreezeProof` 对象身份 / 对应 `issuer-transition` 的 `HomeTrustEvent eventDigest` / `D("ReadyProof",1,readyProof)` |
  | `checkpointDigest / checkpointEnvelopeDigest / authorityCatalogDigest` | 对应导出检查点 artifact 的 `ArtifactRef.digest` / `CheckpointEnvelope.digest` / `D("AuthorityCatalog",1,catalog)` |
  | `baseDigest / targetDigest`；`JobCommitFence.deliveryPlanDigest` | `D("WindowSnapshot",1,{windowEpoch,messages})`；`TaskDefinitionBody.deliveryPlan.planDigest`（同一 occurrence 两字段必须相等） |
  | `FinalOutboxRecord.digest / FinalFrame.digest / AssetIndexEntry.digest` | `SealedBundle.digest / SealedBundle.digest / 对应 ArtifactRef.digest` |

- 验证边界：任何会改变耐久状态或激活能力的消费者，必须依序完成 DTO/version/未知字段校验 → 按注册类别复算摘要 → 验签（如有）→ 逐项核对引用目标；未知摘要域、缺摘要、前像缺字段、复算不等或引用错目标均在落盘、激活、CAS、对账或恢复前 fail-closed，禁止按字段名猜测或兼容性回退。`Message.tool_use.input` 虽是开放 JSON 子树，仍必须递归满足规范 JSON（plain object / dense array / JSON primitive；禁止 accessor、Date、BigInt、undefined、稀疏数组及非规范数值），进程内、耐久重放与 mesh 共用同一验证器。
- 验收：同一 payload 经进程内与 mesh adapter 得到同一摘要；逐字段篡改、错误纳入自身摘要或 `signature`、漏字段、跨 schema/version 重放全部拒绝；每个 `Digest` 类型字段在上述注册表恰命中一类，`KeyConfirmation` 不得命中。随 S2 建立跨语言固定向量，后续节点复用。

### 1.3 外部符号引用表（引用不复制；字段级定义住权威模块，本文 contracts 以 `import type` 按符号消费）

| 本文符号 | 代码基线现状 | 说明 |
|---|---|---|
| `Message` | 现有同名 @ `packages/core/src/types/messages.ts`（包入口导出） | LLM 协议消息 |
| `UserTurnInput` | 现有同名 @ `packages/core/src/types/user-input.ts` | 用户输入载体 |
| `TranscriptRunRecord` | ≙ 现有 `RunRecord` @ `packages/core/src/transcript/shard/types.ts`（现键 `runIndex`，S3 增 `runId`） | 完整协议 `messages` 序列 |
| `WindowCompactInstruction` | ≙ 现有 `WindowCompact` @ `packages/core/src/context/window/types.ts`（S3 明确其"幂等缓存更新指令"语义） | windowCompact 指令 |
| `TaskListState` | 现有同名 @ `packages/core/src/conversation/types.ts` | 任务清单状态 |
| `TaskListOp` | 本文冻结（§1.3b；现状为整份状态替换 `updateTaskListState`，首个 op 即 set 全量） | 任务清单操作 |
| `AdvancementControlEvent` | ≙ 现有 `AdvancementStoreEvent` @ `packages/core/src/advancement/types.ts:315`（控制日志十类事件的既有判别联合，直接 import type） | 推进控制日志事件族 |
| `AdvancementSnapshot` | ≙ 现有 `AdvancementSession` @ `packages/core/src/advancement/types.ts`（S1 直接 import type；读结果不落 log，体量无阈值约束） | 推进状态快照 |
| `TrustRule` | ≙ 现有 `PermissionRule` @ `packages/core/src/security/types.ts:238` | 本机信任规则存储 DTO |
| `PortableTrustRule` | 本文冻结（§1.3b）；由 `TrustRule` 显式投影，排除本机路径与可变命中统计 | 跨设备签名规则 DTO |
| `TrustRuleSnapshot` | 本文冻结（§1.3b） | 签名规则快照 |
| `ScheduleTaskSpec` | ≙ 现有 `TaskSpec` @ `packages/core/src/scheduler/facade.ts`（完整型 `ScheduledTask`；进程内领域类型，**不上 wire**——wire 用 §3.2 `ScheduleTaskSpecDto` 显式白名单：action 仅 agent-turn、webhook endpoint 整体 `SecretRef`、origin / system 等权威字段锚点生成） | 调度任务定义源类型（派发另用 §5.2 `JobExecutionInstruction`） |
| `TaskSchedule` / `TaskPriority` | 现有同名 @ `packages/core/src/scheduler/types.ts`（进程内领域类型，**不上 wire**——wire 用 §1.3b `TaskScheduleDto` / `TaskPriorityDto` 快照） | 调度周期与优先级 |
| `DeliveryTarget` | 现有同名 @ `packages/core/src/channels/types.ts:48`（进程内领域类型，**不上 wire**——wire 用 §1.3b `DeliveryTargetDto` 快照） | 任务来源投递目标（锚点生成，只读） |
| `MemoryAppendPayload` | 本文冻结（§1.3b；自三域现有写入签名——memory=`SaveOptions`、journal=`append(content, date?)`、people=`save(id, PersonMeta, content)`——机械归一） | 记忆 / journal / people 追加载体 |
| `MemoryEntry` / `PersonEntry` / `JournalEntry` | 现有同名 @ `packages/core/src/memory/` | 记忆域实体（读结果载体） |
| `MemoryCategory` / `PersonMeta` | 现有同名 @ `packages/core/src/memory/`（进程内领域类型，**不上 wire**——wire 用 §1.3b `MemoryCategoryDto` / `PersonMetaDto` 快照） | 记忆分类与人物元数据 |
| `DeliveryItem` | 现有同名 @ `packages/core/src/delivery/types.ts:31`（由 delivery 流投影生成，不上权威日志） | 渠道发送器兼容投影 |
| `EnqueueParams` / `IDeliveryPipeline.enqueue` | 现有同名 @ `packages/core/src/delivery/types.ts:100 / :110`；现实现于 `pipeline.ts:199`，唯一生产调用 @ `scheduler.ts:519` | 目标态由六类权威生产者内部构造 enqueued；公开生产入口保留至 scheduler 接入 JobJournal 后随旧路径整体退役（执行计划第 26 项） |
| `SkillUsageRecord` | 本文冻结（§1.3b；现有 `SkillUsage` @ `packages/core/src/skills/types.ts:35` 无 skillId，adapter 自 store 的 map 键补齐） | 技能使用记录 |
| `SkillRecord` / `SkillState` / `SkillMode` | 现有同名 @ `packages/core/src/skills/types.ts` | 技能管理载体（进程内领域类型，**不上 wire**——wire 写面用 §3.2 `SkillWriteDto` / `SkillStatePatch`（mode 用 §1.3b `SkillModeDto`），id / revision / createdAt 等权威字段锚点生成） |
| `EvidenceKind` | ≙ 现有 `ObjectiveSignalKind` @ `packages/core/src/advancement/types.ts` | 证据类型 |
| `EvidenceLocator` | 现有同名 @ `packages/core/src/advancement/types.ts` | 证据定位符 |
| `WorkScene` | 现有同名 @ `packages/core/src/workscene/types.ts` | 工作场景定义（进程内领域类型，**不上 wire**——wire 用 §3.2 `WorksceneDto`，workdir 以设备域引用表达） |
| `SegmentRecord` | ≙ 现有 `SegmentMeta` @ `packages/core/src/conversation/types.ts:73`（已导出，`SegmentPersistence.appendSegment` 的入参类型，直接 import type） | 段元数据条目 |
| `AgentYield` | 现有同名 @ `packages/core/src/loop/types.ts` | run 主输出流事件 |
| `TurnOrigin` | 现有同名 @ `packages/core/src/types/tools.ts` | turn 来源标识 |
| `SessionEventProjection` | 本文定义（§5.6 封闭判别联合，自现 `UI_EVENT_PROJECTION` 白名单 @ `packages/server/src/rpc/session-events.ts:101` 固化）；替换 `payload: unknown` 的现有 `SessionEventEnvelope` | 带外事件白名单投影 |
| `AgentEventMap` | 现有同名 @ `packages/core/src/types/agent-events.ts`（包入口导出） | 运行时事件谱（透传组 payload 类型源） |

冻结纪律：本文冻结区业务字段一律用上表符号或本文定义的 DTO，零 `unknown`；跨 wire 对象全部为本文定义的独立、版本化 DTO。标注"本文冻结"的符号字段见 §1.3b——S1 只按该合同在权威模块建立唯一导出（S1 开工清单第 2 步），后续节点不得重新发明字段；contracts 独立 typecheck 作门禁。

### 1.3b 需新建符号的冻结字段（S1 合同，权威模块按此建导出）

```ts
type TaskListOp = { op: "set"; state: TaskListState };   // 现状即整份替换（updateTaskListState）；增量 op 随真实需要经 v 升版
interface SkillUsageRecord { skillId: string; lastHitAt: IsoTime; hitCount: number }   // ≙ SkillUsage + map 键提升为 skillId
interface PortableTrustRule {
  id: string; pattern: { tool: string; argument: string };
  decision: PermissionDecision; scope: PermissionScope; createdAt: number;
  contextId?: PermissionContextId; contributors?: TrustContribution[];
} // 可选字段缺省时省略；contextPath / lastMatchedAt / matchCount 不上 wire
interface TrustRuleSnapshot { snapshotVersion: number; rules: PortableTrustRule[];
  generatedAt: IsoTime; digest: Digest; signature: Signature }   // digest 按 §1.2 自摘要；锚点签发；PermissionSnapshotLease.snapshotDigest 指向它
// 值域 / 小对象快照区：**新上 wire 的领域类型一律在此冻结快照**（协议基座符号如 Message / AgentYield 除外——其演进天然连动顶层 v）。
// 裁决依据：领域类型演进不得静默扩张 wire——扩张必须显式升版；wire 侧枚举收窄使未知新值 fail-closed 拒绝而非静默通过。
type MemoryCategoryDto = "profile" | "person" | "journal";                       // ≙ MemoryCategory（memory-store.ts:20）值域快照
interface PersonMetaDto { name: string; relation: string; birthday?: string; tags?: string[] }   // ≙ PersonMeta（people-store.ts:21）逐字段快照
type TaskPriorityDto = "low" | "normal" | "high" | "urgent";                     // ≙ TaskPriority（scheduler/types.ts:16）
type TaskScheduleDto = { kind: "once"; at: IsoTime } | { kind: "interval"; everyMs: number }
                     | { kind: "cron"; expr: string; tz?: string };              // ≙ TaskSchedule 现三分支（S3.5 扩 after / self-paced 时显式升版）
type SkillModeDto = "main" | "work";                                             // ≙ SkillMode（skills/types.ts:13）
interface DeliveryTargetDto { channelId: string; to: string; threadId?: string } // ≙ DeliveryTarget（channels/types.ts:48）逐字段快照；adapter 映射未知字段拒绝
interface OutboundContentDto { text: string; markdown?: string;
  media?: Array<{ ref: ArtifactRef; type: "image"|"file"|"audio"|"video" }> } // ≙ OutboundContent；媒体改内容寻址，外部 URL 不进权威日志

type MemoryAppendPayload =                        // 三域现有写入签名的机械归一（memory-store.ts:58 / journal-store.ts:111 / people-store.ts:81）
  | { domain: "memory";  category: MemoryCategoryDto; id: string; meta: Record<string, JsonValue>; content: string }  // ≙ SaveOptions（meta 收窄为 JsonValue）
  | { domain: "journal"; content: string; date?: string }
  | { domain: "people";  id: string; meta: PersonMetaDto; content: string };
// 三分支逐字段与对应 store 写入签名做 adapter conformance 测试；未知 category、缺 relation 在反序列化层拒绝。
```

`GlobalControlMutation / GlobalStagedMutation` 的 memory-append 分支形态随本联合（`domain` 判别即路由），不再另带 domain 字段。

### 1.4 总纲构件名映射（总纲名为同义引用，字段级以本文名为准）

| 总纲构件 | 本文展开 |
|---|---|
| RunCommitBundle | `SealedBundle`（§5.4） |
| RunFinalOutbox | `final-outbox` 逻辑流 + `FinalOutboxRecord`（§4.3）与终态投递（§5.5） |
| AuthorityMutationJournal | assignment 流 `staged-mutation` 记录 + `MutationBatch`（§4.3 / §4.4） |
| RunInteractionJournal | assignment 流 `interaction-requested`（pending 权威）+ `interaction-finished`（终态权威：应答 / 取消 / 过期）+ `RunSubmissionPort.mirrorInteractions`（审计镜像）（§4.3 / §3.7） |
| ControlRequestEnvelope | `ControlEnvelope`（§5.1） |
| ControlRequestJournal | control 流 `received / applied` 记录（§4.3） |
| 执行账本 | assignment 逻辑流（§4.3） |
| TrustTransition | `trust` 流 `issuer-transition` 事件（§2.1） |
| JobManifest | `ExecutionManifest` + `JobDispatch`（§5.2 / §5.3） |

### 1.5 错误形态

```ts
interface AuthorityError {
  code: "unauthorized" | "capability-expired" | "epoch-stale" | "revision-conflict" | "fence-rejected"
      | "busy" | "not-found" | "invalid" | "lease-exhausted" | "missing-base" | "typed-stale"
      | "capability-gap" | "unavailable-offline" | "idempotency-conflict";
  message: string; retryable: boolean;
}
// message 为非空 UTF-8 文本且至多 4KiB；code、message、retryable 的 accepted-domain 由生产端、wire、日志 reducer 与 companion 投影共用同一结构谓词。
type DispatchConflictError = Omit<AuthorityError, "code"|"retryable"> &
  { code: "idempotency-conflict"; retryable: false };
```

## 二、身份、信任与凭证

### 2.1 设备、home 与信任事件链

```ts
interface DeviceIdentity { deviceId: string /* "fp:"+multibase(sha256(publicKey)) */; publicKey: string;
  displayName: string; platform: "windows"|"macos"|"linux"|"headless"; enrolledAt: IsoTime }
type DeviceRole = "anchor"|"executor"|"surface";

type HomeTrustEventBody =
  | { t: "genesis"; issuer: DeviceIdentity }       // 唯一首事件：seq=0、trustEpoch=1、issuer 自签；prevEventDigest=D("HomeTrustChainSeed",1,{homeId})
  | { t: "enroll"; device: DeviceIdentity; roles: DeviceRole[]; pairingTranscriptDigest: Digest }   // 绑定配对握手 transcript
  | { t: "reenroll"; deviceId: string; pairingTranscriptDigest: Digest }   // domain-reset 后同设备重入：守卫 = 该设备处于 pending-reenroll
                                                                            // 且事件 trustEpoch = reset 后当前 epoch；状态只允许 pending-reenroll → active
  | { t: "role-change"; deviceId: string; roles: DeviceRole[] }
  | { t: "revoke"; deviceId: string; reason: string }
  // 恢复根事件按 op 判别，非法组合在类型层不存在。签名域（对 §1.2 规则的显式特化）：
  // rootProof = 新根私钥对「除 signature 与 rootProof 外的事件体」按同一 JCS + 域分离规则的反签（先签）；
  // 事件 signature 覆盖含 rootProof 在内的其余字段（后签）——无自包含歧义，验证顺序 = 先验 signature 再验 rootProof。
  // 制衡边界：issuer 无权 rotate / invalidate（失控锚点不能静默替换或废止用户手中的恢复码）。
  // 恢复包 = 一个高熵主秘密；域分离派生两把键：签名根（Ed25519，验 issuer-transition / rotate 等）与
  // 备份封装根（X25519，检查点 DEK 封装收件键）——"用途一把钥匙一个派生"，签名键永不用于加密。
  | { t: "recovery-root"; op: "establish"; rootPublicKey: string; backupPublicKey: string; rootProof: Signature;
      signedBy: "issuer" }                        // 守卫：链上无有效根（从未建立 / invalidate 后 / domain-reset 后）
  | { t: "recovery-root"; op: "rotate"; rootPublicKey: string; backupPublicKey: string; rootProof: Signature;
      signedBy: "recovery-root" }                 // 守卫：链上有有效根；仅旧根可签（主动换 / 泄露置换）
  | { t: "recovery-root"; op: "invalidate"; signedBy: "recovery-root" }   // 守卫：链上有有效根；灾难恢复随之不可用
  | { t: "domain-reset"; nextTrustEpoch: number; reason: "recovery-root-lost";
      coSign: { deviceId: string; sig: Signature } }
      // 恢复包丢失的唯一链上补救（正式合同）：issuer 签发；效果 = trustEpoch+1、当前恢复根即刻失效、
      // 仅允许作为 §七 RecoveryActivationPlan.domain-reset-establish 的首事件原子提交，禁止单独 append；
      // 全部非签发设备转 pending-reenroll（逐台重新配对 join 才回 active——物理在场即带外授权）。
      // 制衡守卫：coSign **恒必填**且共签设备 ≠ issuer 设备（另一台 active 设备上的用户确认，机械可验）——
      // issuer 永远无法单方废根。签名域与 rootProof 同规则：coSign.sig = 共签设备对「除 signature 与 coSign 外
      // 事件体」的签名（先签），事件 signature 后签覆盖含 coSign 的其余字段。
      // 单设备 home 丢失恢复包**无链上补救**：不存在能授权 reset 的用户凭证，任何原地重置都等于 issuer 自授权；
      // 产品引导走"重建 home"仪式（新 homeId、新链、重新 establish）——旧根加密的备份随之不可用，代价如实告知。
      // reset 后链上无有效根，establish 守卫随之成立。
  | ({ t: "issuer-transition"; nextTrustEpoch: number; fromIssuerKeyId: string; toIssuerKeyId: string;
      toDeviceId: string } & (
        | { reason: "migration"; signedBy: "issuer" }
        | { reason: "disaster-recovery"; signedBy: "recovery-root" }));
      // 目标必须是 active anchor；当前 issuer 在 transition 生效前不得被撤销或移除 anchor 角色。
interface HomeTrustEvent { homeId: Ulid; seq: number; prevEventDigest: Digest;   // 哈希链接，seq 单调
  trustEpoch: number; body: HomeTrustEventBody; at: IsoTime; signature: Signature }

interface HomeTrustRecord {              // 签名快照 = trust 流投影；全设备缓存、按链重放验证
  homeId: Ulid; trustEpoch: number;
  chainHead: { seq: number; eventDigest: Digest };
  issuer: { deviceId: string; issuerKeyId: string };
  recoveryRootPublicKey?: string;        // 纯投影：链上最近一条有效 recovery-root 事件的签名根；主秘密离线在用户手中
  recoveryBackupPublicKey?: string;      // 同事件的备份封装根投影（X25519 收件键）——检查点封装用它，永不用签名键加密
  members: Array<{ device: DeviceIdentity; roles: DeviceRole[]; state: "active"|"revoked"|"pending-reenroll" }>;   // pending-reenroll = domain-reset 后待重新配对
  signature: Signature;
}
type AnchorTransferCommit =                      // 锚点切换的唯一提交事实，按模式判别——两种模式的可证明前提不同，不共用一条无法同时满足的合同
  | { mode: "planned"; transferId: string; sourceDeviceId: string; targetDeviceId: string;
      freezeProofDigest: Digest;                 // 绑定源端 SourceFreezeProof（准入已关、在途已收束）
      checkpointDigest: Digest; authorityCatalogDigest: Digest;
      trustTransitionDigest: Digest;             // 绑定同时 prepare 的 TrustTransition（签发权移交）
      nextAnchorEpoch: number; nextTrustEpoch: number; targetIssuerPublicKey: string;
      readyProofDigest: Digest; signature: Signature /* 当前签发者 */; at: IsoTime }
  | { mode: "disaster-recovery"; transferId: string; targetDeviceId: string;
      checkpointEnvelopeDigest: Digest;          // 绑定已解封验证的 CheckpointEnvelope（§七）——不声称源端已冻结，源端已丢失
      authorityCatalogDigest: Digest;
      trustTransitionDigest: Digest;             // 绑定恢复根签发的 issuer-transition（总纲 §9：DR 由恢复根签同一 transition）——
                                                 // 权威切换与信任换代恒为同一原子事实，两模式此项一致
      nextAnchorEpoch: number; nextTrustEpoch: number; targetIssuerPublicKey: string;
      readyProofDigest: Digest; signature: Signature /* 恢复根签名 */; at: IsoTime };
interface SourceFreezeProof {                    // 源端权威签发：准入已关、在途已收束、导出即此检查点
  transferId: string; scope: "conversation"|"anchor"; subject: string;
  sourceEpoch: number; checkpointDigest: Digest; lastLsn: number; signature: Signature }
interface ConversationTransferCommit {           // 收编（conversation 域）的唯一切换事实，目标锚点签发
  transferId: string; conversationId: string; sourceDeviceId: string;
  freezeProofDigest: Digest; checkpointDigest: Digest;
  sourceOwnerEpoch: number; nextOwnerEpoch: number; signature: Signature; at: IsoTime }

interface PairingOffer { offerId: Ulid; homeId: Ulid;
  protocolVersion: string; issuer: { deviceId: string; keyFingerprint: Digest }; issuerNonce: string;
  method: { kind: "qr-secret" }                  // 二维码内嵌 ≥128-bit 高熵一次性秘密——离线枚举不可行，密钥确认即安全
        | { kind: "short-pake"; suite: string /* PAKE 套件标识，S2 供应链选型、可替换 */ };
  expiresAt: IsoTime /* issuedAt+120s */; singleUse: true;
  attempts: { max: number /* 初值 3 */; onExhaust: "expire" } }   // 在线尝试**仅按 offerId** 持久计数（§下方 pairing 流）+ 指数退避，超限 offer 即刻作废——不按来源计数（来源可伪造）
type PairingJoin =                               // 按配对方式判别——两种 join 各自字段完备，缺 auth / 多 auth 的组合类型层不存在
  | { method: "qr-secret";  offerId: Ulid; device: DeviceIdentity; joinerNonce: string;
      confirmation: KeyConfirmation }            // = K("PairingJoinConfirmation",1,K_secret,{offer,join 去 confirmation})——无自引用；高熵秘密的密钥确认
  | { method: "short-pake"; offerId: Ulid; device: DeviceIdentity; joinerNonce: string };
      // 短码分支 join 零密钥材料——密钥交换走下方 PakeRound 通道；method 必须与 offer.method 一致（guard 拒绝错配）
interface PakeRound { offerId: Ulid; round: number; from: "issuer"|"joiner";
  payload: string }                              // 双方**交替多轮**的 PAKE 不透明消息（round 单调、from 交替，乱序 / 跳轮拒绝）；
                                                 // 合同不解释 payload 内部（suite 可替换）；**全程不产生任何可离线校验物**——
                                                 // 短码只参与 PAKE 内部交换，验证只能在线逐次进行，离线字典攻击结构性不可行
interface PairingAcceptance {                    // 库无关握手收尾合同（suite 可替换，transcript 语义不变）：
  offerId: Ulid;                                 // 单次 acceptance，绑定链头防重放
  transcriptDigest: Digest;                      // offer + join + 全部 PakeRound 的有序规范化摘要——双方各自计算必须一致（MITM / 降级即失配）
  chainHead: { seq: number; eventDigest: Digest }; acceptedAt: IsoTime;
  finished: PairingFinished }                    // method 必须与 offer.method 一致（guard 拒绝错配）
type PairingFinished =                           // 按配对方式判别——short-pake 缺 keyConfirm 的组合类型层不存在
  | { method: "qr-secret";  issuer: { sig: Signature }; joiner: { sig: Signature } }   // 密钥确认已由 join.confirmation 承担
  | { method: "short-pake"; issuer: { sig: Signature; keyConfirm: KeyConfirmation };
                            joiner: { sig: Signature; keyConfirm: KeyConfirmation } };
  // sig：设备密钥签名，域 = 除 finished 外的**整个 acceptance 体**（沿 §1.2 规则）——替换链头即验签失败，承担设备身份绑定；
  // keyConfirm：**PAKE 会话密钥确认**（= K("PairingFinished",1,KDF(K_pake,"finish"||role),{offerId,transcriptDigest,chainHead,acceptedAt})；
  // finished 整体不入前像，角色进入派生 key，结构性无自引用），任一验证失败即拒绝——
  // 证明"共享短码"的是 keyConfirm 而非设备签名。
// 在线尝试的耐久载体：签发端锚点域 pairing 流先写 `pairing-attempt-started(offerId,offerDigest,attemptId,ordinal,at,retryNotBefore)`；该记录必须在任何
// secret-dependent 响应前 fsync（PAKE 尤其在返回 issuer round 前），因此攻击者丢弃后续消息也已消耗一次在线尝试。计数键**仅 offerId**
//（不按来源设备——来源身份可伪造）；ordinal > attempts.max 恒拒绝并作废 offer。验证失败在返回前追加同 attemptId 的 failed；
// 验证成功只允许消费仍为 started 的 attempt。
// 原子规则：acceptance 全验通过后，`pairing-attempt-succeeded` 与 trust 流 `enroll` / `reenroll` **同一 CommitEnvelope 原子写**
//（同锚点进程同物理 log，§4.1）——"offer 已耗尽而设备未入链"与"已入链而 offer 仍可用"两种半提交态不存在；
// offer 的使用 / 作废状态**只由 pairing 流投影**，无独立可变状态。验收（随 S2）补：started fsync 前后、返回 PAKE round 前后、
// 原子成功点前后崩溃注入、succeeded 重放幂等、并发双 join 的 singleUse 仲裁（恰一胜出）。成功响应丢失后的重放从同一权威日志返回
// 已包含该 trust event 的当前投影，不依赖调用方保留提交前链头；请求内容与 succeeded 记录不一致时拒绝。
// 验收（随 S2 安全对抗矩阵）：离线字典（截获全部 wire 消息后枚举短码 → 无可校验物）、在线爆破（offerId 单键限次 + 退避 +
// 超限作废 + 换伪身份不重置）、MITM / 降级（transcript 失配）、重放（singleUse + chainHead）、乱序 / 跳轮各有对抗用例。
```

信任事实的唯一形态是签名、单调、哈希链接的 `HomeTrustEvent`（genesis / enroll / role-change / revoke / recovery-root / domain-reset / issuer-transition），落锚点域 AuthorityCommitLog 的 `trust` 逻辑流；genesis 是 issuer 自签且必须耐久的唯一首事件，后续投影重建不得依赖日志外锚点；`HomeTrustRecord` 只是带链头摘要的签名快照投影（含恢复根——投影链上当前有效根，无独立写路径），任何设备可凭事件链重放验证成员、撤销与恢复根的对象、顺序与当前水位。配对 = offer + join（短码分支另经 PakeRound 通道交替多轮）+ **acceptance 收尾**（transcript 摘要双方一致、双向 finished——设备签名绑身份 + PAKE 密钥确认证共享短码、单次 acceptance 绑链头——离线字典 / 在线爆破 / MITM / 降级 / 重放 / 乱序各有机械拒绝点，随 S2 安全对抗矩阵验收）→ 签发者写 `enroll`（reset 后重入写 `reenroll`）事件入链，事件绑定 pairingTranscriptDigest。恢复根在首次启用网格能力（首次配对 / 加密备份 / 迁居）的同一引导流建立：展示恢复包 → 用户保存 → 回读验证（重输校验段）→ 先完成新根检查点的独立复制与真解封验证，再原子激活 `recovery-root(establish)` 并开放该能力（§七）；轮换（主动换 / 泄露置换）走同一用户仪式与原子激活，切换前旧根持续有效；泄露且暂不换新由旧根签 `invalidate`（灾难恢复随之不可用，直至新根建立）；**丢失恢复包走 `domain-reset + establish` 原子计划**（字段合同与守卫见上——issuer 发起 + 第二设备共签恒必填，计划激活后新根与已验证备份同时生效、全设备逐台重新配对回 active；单设备 home 无链上补救，走重建 home 仪式）；单机开箱不生成。验收（随 S2）：issuer 签 rotate / invalidate 必被拒；无 coSign 或共签设备 = issuer 设备的 domain-reset 必被拒（含单设备 home）；已失效旧根签发 issuer-transition / rotate 必被拒；轮换、丢失 reset、泄露、离线设备追赶（含跨 reset 追赶）各有链重放用例。

### 2.2 凭证族（短租约、签名、可验证；全部按用途判别联合，非法组合在类型层不存在）

```ts
interface DataPlaneTicketBase { ticketId: string; ref: ExecutionRef; assignmentId: string;
  surfacePrincipal: string; executorId: string; issuedAt: IsoTime; expiry: IsoTime; signature: Signature }
// job 确认能力与 conversation 等价（现状 scheduler ephemeral broker 接 ConfirmationHub、确认回任务来源——能力不退化）：
// 手动 job-run 的票据签给本次已认证发起 surface（admitted.ingress）；定时 job 的渠道应答者不持设备连接，改用下述单次渠道授权。
type DataPlaneTicket =
  | DataPlaneTicketBase & { kind: "run-observe";  renewable: true }    // 只读续流
  | DataPlaneTicketBase & { kind: "run-interact"; renewable: true }    // 含 observe；直连 surface 的 allow-once 凭证
  | DataPlaneTicketBase & { kind: "abort";        renewable: false };  // 止损专用

interface ChannelResponderRef { channelId: string; platformSubject: string; tenant?: string } // 渠道适配器自已认证入站派生，调用方不可自报
interface ChannelChallengeTokenBase<R extends ExecutionRef> {   // owner 预签、随互动消息下发并由平台 callback 原样带回；解决回复与请求的抗篡改关联
  challengeId: string; ref: R;
  assignmentId: string; interactionRequestId: string;
  route: DeliveryTargetDto; displayDigest: Digest;       // = D("InteractionDisplay",1,{toolName,display})，防止 token 与用户所见决策内容错配
  issuedAt: IsoTime; expiry: IsoTime; signature: Signature }
type ConversationChannelChallengeToken = ChannelChallengeTokenBase<Extract<ExecutionRef, { execution: "conversation" }>>;
type JobChannelChallengeToken = ChannelChallengeTokenBase<Extract<ExecutionRef, { execution: "job" }>>;
type ChannelChallengeToken = ConversationChannelChallengeToken | JobChannelChallengeToken;
interface ChannelMessageRef { channelId: string; messageId: string; threadId?: string } // 各字段为 ≤480 UTF-16 code unit 的非空标识；平台发送回执仅审计 / 展示，不充当授权
interface ChannelInteractionGrant {                    // 定时 job 的单次应答凭证；只由 job owner（锚点）签发；
  grantId: string; ref: Extract<ExecutionRef, { execution: "job" }>;
  assignmentId: string; interactionRequestId: string; challengeToken: JobChannelChallengeToken;   // conversation challenge 在类型层不可进入 grant
  route: DeliveryTargetDto; responder: ChannelResponderRef;
  decision: { allowed: boolean; reason?: string };      // 决策入签名域，host / 中继不可篡改
  issuedAt: IsoTime; expiry: IsoTime; signature: Signature }
type InteractionAnswerAuthority =
  | { via: "surface-ticket"; ticketId: string }
  | { via: "channel-grant"; grant: ChannelInteractionGrant };  // grant 全文随 assignment 记录耐久化，审计可独立验签
```

票据时序（签发 → 续期 → 失效闭环）：assignment 落 `assigned` 记录且 executor `received` 后，owner 先在对应 run / job 流 fsync `ticket-issued`，再经各 surface 既有控制连接下发票据——向当前同会话 observer 签 `run-observe`，仅向原始 surface（admitted 记录 `IngressContext.surfacePrincipal` 所指）签 `run-interact`，并同时预签 `abort`（expiry 覆盖 assignment 存续，owner 失联止损由此成立）；发送失败按未 revoked 的 issued 记录幂等重驱。后加入的 observer 订阅时只取 observe；原始 surface 断线重连经 owner 重认证后才续 interact，续期同样先记 issued。续期恒经 owner 控制通道（surface ↔ owner），executor 不签发不续期。失效：重派 / 取消 / 提交 / uncertain 用户裁决关闭旧 assignment 任一发生，owner 在对应 run 流写 `ticket-revoked` 并向 executor 推送吊销通告，executor 立即断开该票据的连接并在验证层拒绝后续使用；surface 失权（连接注销 / 设备撤销）同此路径；推送不可达时由短 TTL 兜底。
**conversation 渠道时序**（飞书等渠道对话触发确认——与第一方 surface 等价的确认能力）：渠道 turn 的 `admitted.ingress` 为 channel 分支，其规范化 `surfacePrincipal` 即锚点渠道宿主的应答身份——owner 按“原始 surface”同一语义向渠道宿主（锚点进程内组件，经进程内 adapter）签 `run-interact` + `abort` 票据；宿主订阅 interaction 帧后，必须先 fsync `ConversationChannelChallengePreparedRecord`（其 `frameSeq` 即该帧耐久接管水位），**再 ACK executor**，随后才向 `replyTarget` 发送只携签名 `ConversationChannelChallengeToken` 的互动消息（票据绝不下发渠道）；崩溃或 ACK 丢失均按 prepared−closed 与 frameSeq 幂等重驱。平台 callback 原样带回 token，宿主验平台身份 + `responder` 与 ingress.responder 全等 + token 签名 / expiry / displayDigest，通过后**持票**提交 allow-once（surface-ticket 分支——channel grant 类型层 job-only）。pending / finished 权威仍唯一在 executor；重复 callback 回放原结果。
**job 域时序**：手动 job-run——`admitted.ingress` 所指发起 surface 获 interact + abort 票据，语义与上同构；定时 job——**不签数据面票据**（渠道用户不持设备连接，无票据可用的 principal），由 job owner 以 §5.6 `owner-relay` 身份耐久续流。收到 `interaction.requested` 后，锚点在同一 CommitEnvelope 写 `channel-challenge-prepared + channel-relay-cursor`，再 ACK executor；prepared 内的 owner 签名 `JobChannelChallengeToken` 随互动消息下发，token.displayDigest 必须等于实际渲染的 toolName + display，发送按 challengeId 幂等重试。平台 callback 必须原样带回 token，渠道适配器先验证平台身份，锚点再验 token 签名 / expiry / displayDigest、challenge 仍 pending、route 以及结构化 `ChannelResponderRef` 与任务创建时耐久化的 `interactionResponder` 全等；通过后先耐久写含完整 grant 的 `channel-challenge-granted`，再由 host principal 转交 executor。executor 对 grant 与内嵌 token **分别验签**，并逐字段要求 ref / assignment / interaction / challenge / route 一致、token.displayDigest 等于 assignment 流 pending request 的 `D("InteractionDisplay",1,{toolName,display})`、grant.expiry 不晚于 token.expiry，再验证 responder / decision；任一不符拒绝。成功后以 `(assignmentId, interactionRequestId)` 单次幂等落 `interaction-finished`；审计 `by` 只能由 grant.responder 派生，禁止采信转发方自报。重复 callback 回放原 grant / 原结果；origin、interactionResponder 任一缺失，token 不可回传或任一校验失败、渠道不可达或授权过期 → 不存在合法应答，走 `auto-resolved(no-interactive-surface)` fail-closed。

```ts
type AuthorityPortMethodId =                         // 封闭字面量联合 = §三全部携 AuthorityCallContext 的端口方法，contracts 冻结；
  | "session.readSessionMeta" | "session.readTranscriptTail" | "session.readTaskList" | "session.readAdvancementState" | "session.mutate"
  | "global.read" | "global.mutate"
  | "intent.record" | "intent.list" | "intent.decide"
  | "reservation.enqueueRoot" | "reservation.prepareAssignmentRoot" | "reservation.prepareSystemJobRoot" | "reservation.acquireRoot"
  | "reservation.acquireChild" | "reservation.reserveUsage" | "reservation.consume" | "reservation.settle" | "reservation.release"
  | "submission.reportStarted" | "submission.submitBundle" | "submission.submitCancelProof" | "submission.mirrorInteractions"
  | "governor.submitUsageReport"
  | "executor.dispatch" | "executor.cancel" | "executor.supersede" | "executor.queryLedger";
// 五类 principal 各持**封闭方法子集**——凭证签发器与 guard 共用同一矩阵，非法 principal×方法组合在类型层不存在；
// 验收 = 自动生成"全部方法 × 五类 principal"允许 / 拒绝矩阵，进程内与 mesh adapter 等价（不变量 16 的机械承载）：
type AssignmentMethodId = Extract<AuthorityPortMethodId,
  | "session.readSessionMeta" | "session.readTranscriptTail" | "session.readTaskList" | "session.readAdvancementState" | "session.mutate"
  | "global.read" | "global.mutate"
  | "reservation.acquireChild" | "reservation.reserveUsage" | "reservation.consume" | "reservation.settle" | "reservation.release"
  | "submission.reportStarted" | "submission.submitBundle" | "submission.submitCancelProof" | "submission.mirrorInteractions">;   // reservation 面只能操作自身 scope 与 lease 后代，不得终结根租约
type SurfaceMethodId = Extract<AuthorityPortMethodId,
  | "session.readSessionMeta" | "session.readTranscriptTail" | "session.readTaskList" | "session.readAdvancementState" | "session.mutate"
  | "global.read" | "global.mutate" | "intent.list" | "intent.decide">;
type SubmissionMethodId = Extract<AuthorityPortMethodId,
  "submission.reportStarted" | "submission.submitBundle" | "submission.submitCancelProof" | "submission.mirrorInteractions">;
type OwnerControlMethodId = Extract<AuthorityPortMethodId, "executor.dispatch" | "executor.cancel" | "executor.supersede" | "executor.queryLedger">;
type UsageReporterMethodId = Extract<AuthorityPortMethodId, "governor.submitUsageReport">;
type HostMethodId = Exclude<AuthorityPortMethodId, OwnerControlMethodId | UsageReporterMethodId | SubmissionMethodId>; // 特殊跨域面不得以 host 绕过；再由 component 白名单收窄
interface PrincipalMethodMatrix { assignment: AssignmentMethodId; surface: SurfaceMethodId; host: HostMethodId;
  "owner-control": OwnerControlMethodId; "usage-reporter": UsageReporterMethodId }
type ResourceSelector = `${"conversation"|"task"|"asset"|"memory-domain"}:${string}`; // 精确 id 选择器，无通配；guard 按前缀域 + id 相等匹配

type AuthorityCapability =
  | { capId: string; executorId: string; scope: { execution: "conversation"; conversationId: string };
      ownerEpoch: number; methods: AssignmentMethodId[]; resources: ResourceSelector[];
      assignmentId: string; issuedAt: IsoTime; expiry: IsoTime; signature: Signature }
  | { capId: string; executorId: string; scope: { execution: "job"; taskId: string };
      anchorEpoch: number; methods: AssignmentMethodId[]; resources: ResourceSelector[];
      assignmentId: string; issuedAt: IsoTime; expiry: IsoTime; signature: Signature };
// 激活：签名本身只产生候选；owner 侧 guard 查本地 run / job `assigned`，executor 侧 guard 查 assignment 流 `received.activation` 的 owner 签名证明；
// 两者都只在 capId 被激活清单收录且 assignmentId / executorId / scope 全等时放行。事实/证明不存在、未列 capId 或已 superseded / revoked 均不得取得新的活跃写权。
// 吊销：owner 在对应流写 `capability-revoked`（按 capId / assignmentId）并推送通告，guard 立即拒绝 active 调用；
// RunSubmissionPort 的 settlement / durable-replay / durable-rejection 不是恢复活跃写权，而是由 owner 在同一串行前缀先证明“当前 attempt 的可信终结证据只会收窄状态”“请求已被耐久事实完全吸收、零追加”或“耐久栅栏决定零写入拒绝”后，
// 仅以原 capability 验历史 assignment/executor/method/scope 身份；其严格边界见 §3.7，禁止 adapter/调用方自报模式或把该例外用于 session/global/resource 新写。
// 推送不可达由短 TTL 兜底——与 DataPlaneTicket 吊销同构。重派 / 取消 / 提交 / uncertain 用户裁决关闭旧 assignment 即吊销其全部 capability。

type AdmissionClass = "interactive"|"advancement"|"scheduler"|"orchestration";
interface ResourceLease { reservationId: string; parentId?: string;
  admissionClass: AdmissionClass;        // 由签发入口派生（非调用方自报）；子租约恒继承父
  workload: { kind: "run"|"job"|"orchestration-node"|"control"|"evidence"; id: string; attempt: number };
  scopeBinding: { kind: "conversation"; conversationId: string; ownerEpoch: number }
              | { kind: "job"; taskId: string; anchorEpoch: number }
              | { kind: "control"; subject: string };
  audience: { executorId?: string; provider?: string; model?: string };   // 至少绑一项，空受众拒签
  budget: { maxTokens?: number; maxCalls?: number; maxCostMinor?: number } // 至少一项上限，空预算拒签
  domain: { kind: "anchor"; anchorEpoch: number } | { kind: "local"; localDomainId: string; localGovernorEpoch: number };
  delegation?: { executorId: string; maxDepth: number;                 // 仅根 lease 可携：授权该 executor 的本地 governor
    maxBudget: { maxTokens?: number; maxCalls?: number; maxCostMinor?: number } }  // 以设备密钥签发有界子租约（深度 / 预算受此上限）
  parentDigest?: Digest;                                               // 子租约恒携父 lease digest，guard 按 §1.2 复算父/子摘要并验父签名 + delegation 范围 + 签发者设备签名
  issuedAt: IsoTime; expiry: IsoTime; digest: Digest; signature: Signature }   // digest 按 §1.2 ResourceLease 自摘要

type AssignmentWorkload =
  | { kind: "run"; id: string; attempt: number }
  | { kind: "job"; id: string; attempt: number };
type AssignmentResourceLease =                       // 派发根租约专型：签名候选不等于已激活，非法 workload / scope / audience 组合类型层不存在
  | (Omit<ResourceLease, "parentId"|"parentDigest"|"workload"|"scopeBinding"|"audience"> & { parentId?: never; parentDigest?: never;
      workload: Extract<AssignmentWorkload, { kind: "run" }>;
      scopeBinding: Extract<ResourceLease["scopeBinding"], { kind: "conversation" }>;
      audience: ResourceLease["audience"] & { executorId: string };
      activation: { kind: "assignment"; assignmentId: string } })
  | (Omit<ResourceLease, "parentId"|"parentDigest"|"workload"|"scopeBinding"|"audience"|"domain"> & { parentId?: never; parentDigest?: never;
      workload: Extract<AssignmentWorkload, { kind: "job" }>;
      scopeBinding: Extract<ResourceLease["scopeBinding"], { kind: "job" }>;
      audience: ResourceLease["audience"] & { executorId: string };
      domain: Extract<ResourceLease["domain"], { kind: "anchor" }>;
      activation: { kind: "assignment"; assignmentId: string } });
type ImmediateRootWorkload = { kind: "control"; id: string; attempt: number };   // run / user-job 走 prepareAssignmentRoot；system-job 走 prepareSystemJobRoot
type SystemJobResourceLease =                       // system job 无 assignment；以 SystemJobFence 为独立激活锚
  Omit<ResourceLease, "admissionClass"|"parentId"|"parentDigest"|"workload"|"scopeBinding"|"domain"> & { admissionClass: "scheduler"; parentId?: never; parentDigest?: never;
    workload: Extract<AssignmentWorkload, { kind: "job" }>;
    scopeBinding: Extract<ResourceLease["scopeBinding"], { kind: "job" }>;
    domain: Extract<ResourceLease["domain"], { kind: "anchor" }>;
    activation: { kind: "system-job"; jobRunId: string } };
type ImmediateRootResourceLease =                   // control-class 根租约：reserve 记录即时激活（无需第二归属事实；仍入队过公平准入，见 §十候选生命周期）
  Omit<ResourceLease, "parentId"|"parentDigest"|"workload"> & { parentId?: never; parentDigest?: never; workload: ImmediateRootWorkload };
type ChildResourceLease =                           // 仅编排 / 取证可派生；父链字段类型层必填
  Omit<ResourceLease, "parentId"|"parentDigest"|"workload"> & { parentId: string; parentDigest: Digest;
    workload: { kind: "orchestration-node"|"evidence"; id: string; attempt: number } };
type ReservableResourceLease = AssignmentResourceLease | SystemJobResourceLease | ImmediateRootResourceLease | ChildResourceLease;
type AssignmentReservationRequest =
  | { assignmentId: string; executorId: string; workload: Extract<AssignmentWorkload, { kind: "run" }>;
      scopeBinding: Extract<ResourceLease["scopeBinding"], { kind: "conversation" }>; budget: ResourceLease["budget"] }
  | { assignmentId: string; executorId: string; workload: Extract<AssignmentWorkload, { kind: "job" }>;
      scopeBinding: Extract<ResourceLease["scopeBinding"], { kind: "job" }>; budget: ResourceLease["budget"] };
interface SystemJobReservationRequest { workload: Extract<AssignmentWorkload, { kind: "job" }>;
  scopeBinding: Extract<ResourceLease["scopeBinding"], { kind: "job" }>; budget: ResourceLease["budget"] }

interface UsageReport {                          // executor → 所属域 governor 的周期扣账上报
  reporterId: string /* executorId */;
  rootReservationId: string;                     // usageSeq 的序空间归属：**每个根 reservation（delegation 链根）一条独立连续序**——
                                                 // 由本机 ledger 随 consume 分配，intake 水位按 (reporterId, rootReservationId) 维护
  workloadRef: { kind: "assignment"; assignmentId: string }       // run / job 负载
             | { kind: "evidence"; requestId: string };           // 无 assignment 的取证负载——同一治理闭环，不借道 run 提交
  fromUsageSeq: number; toUsageSeq: number;      // 连续区间（该根序内）
  usages: Array<{ usageSeq: number; reservationId: string; usageId: string; tokens?: number; calls?: number; costMinor?: number }>;
  digest: Digest; signature: Signature }              // digest 按 §1.2 UsageReport 自摘要
// intake 先按 §1.2 复算 report.digest、验签并核对根 lease 链，再推进无缺口水位：区间不衔接（fromUsageSeq ≠ 该根已 ack 水位 +1）返回 typed 错误促重发缺段；usageId 仍幂等，重复上报零重复计费。

type AuthorityEpochRef =                          // fencing 锚，与 AuthorityCapability.scope 同构：
  | { execution: "conversation"; conversationId: string; ownerEpoch: number }   // ownerEpoch 两域通用（§1.1：对话权威转移 +1；锚点域与本地域对话各有各的）
  | { execution: "job"; taskId: string; anchorEpoch: number };
interface ControlLease { controlLeaseId: string; assignmentId: string; authority: AuthorityEpochRef;
  renewalSeq: number; issuedAt: IsoTime; expiry: IsoTime /* 短 TTL，签发 owner 经控制连接心跳滚动续签 */;
  signature: Signature }
type ExecutionRef =                               // conversation / job 统一工作身份——主体与权威 epoch 一体判别，
  | { execution: "conversation"; runId: string; conversationId: string; ownerEpoch: number }   // "job 主体 × conversation epoch"类
  | { execution: "job"; jobRunId: string; taskId: string; anchorEpoch: number };               // 非法凭证在类型层不存在；
                                                  // 贯穿权限租约、数据面票据、StreamFrame、abort 请求与交互路由（#确认能力两域等价）
interface PermissionSnapshotLease { snapshotVersion: number; snapshotDigest: Digest;
  binding: ExecutionRef; assignmentId: string; executorId: string;
  controlLeaseId: string;                // fail-closed 的机械判定锚：绑定的 ControlLease 过期 / 断线未续 →
                                         // 快照即失效，安全管线拒绝规则放行，仅合法 allow-once 单次授权（surface ticket / channel grant）可逐次放行
  issuedAt: IsoTime; expiry: IsoTime; signature: Signature } // TTL 上限 24h；接收时按 §1.1 换算本地 deadline
type PermissionLeaseDigest = Digest;      // = D("PermissionSnapshotLease",1,PermissionSnapshotLease 去 signature)；标识确切租约实例而非其 snapshot 资产
// 快照本体权威恒在锚点（信任规则全局域）；本地域会话使用锚点签发的最近快照缓存 + 本地域对话的 ControlLease（owner 就在本机，心跳恒可续），过期同样 fail-closed。
// ControlLease 以 (controlLeaseId, assignmentId, authority, renewalSeq) 标识确切续期代际；executor 验签、验有界 TTL 与允许时钟偏差后，
// 把剩余存活期换算为本地单调 deadline，并在 assignment 流耐久 control-lease-renewed。renewalSeq 只可递增；旧代、错绑定、断线未续或
// 本地 deadline 到期均立即失效，墙钟变化不得改变进程内已接受代际的存活期。owner-control 在终态后仍可续短租约做确切请求重放与账本恢复；
// 执行权由 received / started、fence、abort 与终态独立关闭，故终态续期不得恢复 PermissionSnapshotLease 或任何工具副作用权。
interface AssignmentActivationProof {            // owner 在 reserve+assigned 原子提交后签发；executor 无需回查 owner 日志
  ref: ExecutionRef; assignmentId: string; executorId: string;
  dispatchRef: ArtifactRef; manifestDigest: Digest; permissionLeaseDigest: PermissionLeaseDigest;
  capIds: string[];                               // capIds 按字节升序、零重复，必须与 assigned 及 DispatchEnvelope 全集相等
  reservation: { reservationId: string; attempt: number };
  commit: { lsn: number; envelopeDigest: Digest };                      // 指向同时含 governor reserve + run/job assigned 的 CommitEnvelope
  issuedAt: IsoTime; signature: Signature }                              // issuedAt = 所指 CommitEnvelope.at
type AssignmentActivationPayload = Omit<AssignmentActivationProof, "signature">;
// 唯一等价规则：JCS(AssignmentActivationPayload) 字节全等；载荷由所指 CommitEnvelope + DispatchEnvelope 确定性重建。
// signature 只证明该载荷，允许重启后重新签发且不参与等价判断；同 assignmentId 的载荷任一字段不同均拒绝，不得以重签掩盖冲突。
```

### 2.3 SecretStore 端口与迁移

```ts
interface SecretStorePort {
  put(ref: SecretRef, value: string): Promise<void>; get(ref: SecretRef): Promise<string|null>;
  delete(ref: SecretRef): Promise<void>; list(prefix: string): Promise<SecretRef[]>;
  unlockState(): Promise<"unlocked"|"locked"|"unavailable">;
}
type SecretRef = { kind: "provider"|"channel"|"mcp"|"device-key"|"webhook"|"rendezvous"; bindingId: string };
// rendezvous：pairwise 会合秘密（§2.5），bindingId = 对端 deviceId；生命周期与删除时机由 §2.5 约束。
```

秘密只以 `SecretRef` 出现在一切日志与协议中。`credentials.json` 迁移：检测明文 → 逐条写入 SecretStore 的版本化迁移命名空间 → 逐条回读校验 → 全部通过后**立即删除明文原文件**；回滚只能由迁移助手从 SecretStore 显式导出恢复旧格式；`ready` 预检包含"零明文残留"。

### 2.4 凭据暴露记录（撤销收束的数据面）

```ts
interface CredentialExposureRecord {     // 落锚点域 log 的 exposure 流；非秘密
  deviceId: string; bindingId: string; service: string;
  principalFingerprint?: Digest; tenant?: string; scopes?: string[];
  state: "active"|"compromised"|"rotated"; markedAt: IsoTime;
  rotationHint?: string;                 // 第三方轮换入口的用户指引文案键
}
```

设备撤销：`revoke` 事件入 trust 链 → 该设备全部暴露记录置 `compromised` 并阻断路由 → 可达则校验本地清退、失控则逐项引导第三方轮换 → 新 binding 经 revision 核验后置 `rotated`。

### 2.5 生产 mesh bootstrap 与控制面连接（S5 装配合同；身份与配对自 §2.1，传输原语自 S2 握手 / 出站隧道 / 盲中继，全部复用不改动）

**角色授权与单机默认**：trust 链已建立时，设备获准承担的角色唯一来自链当前投影（§2.1 `enroll` / `role-change` / `reenroll` 的 roles 与成员 state）。设备本地启动配置只声明"启用哪些已授权角色"及其运行参数，是 ready 门槛的一部分，**不是授权事实源**：启动校验要求 `enabledRoles ⊆ 链投影授权角色` 且本设备 `active`，任一越界即**整个启动 fail-fast 失败**——配置与链脱节必须显式暴露，禁止静默剪除部分角色后部分启动；校验通过后生效角色即 `enabledRoles` 全集（不变量 5：未启用角色零加载零监听）。链上 `revoke` / 角色移除对在线连接立即断连（S2 吊销时限），对重启由同一启动校验拒绝。**链未建立（无 genesis）即单机形态**：本机以内置默认 `anchor + executor` 装配、mesh 零监听（第 6 单元既有边界），零配置零新概念；首次 `zz pair` 出码在同一引导流内先原子建链——`genesis`（issuer = 本机）与 `role-change`（本机，roles = 当前装配角色）同批耐久入链（§2.1 事件合同不改动：enroll 携配对 transcript 的守卫只约束配对入网设备，首设备角色经 role-change 承载，issuer 经 genesis 已在链上），建链成功配对流程才可继续；自此角色授权唯一来自链、内置默认永久失效。两态由"链是否存在"机械判定，无第三态。

```ts
interface MeshRoleBootConfig {           // 设备域本地配置；不上 wire、不入 trust 链、不含秘密
  enabledRoles: DeviceRole[];            // 声明启用；必须 ⊆ 链投影授权，越界整个启动 fail-fast
  anchorListen?: { bind: { host: string; port: number };    // 仅 anchor：直连监听（绑定地址）
    advertised?: Array<{ host: string; port: number }> };   // 对外公布的直连地址；bind 为通配地址时必填，缺失则 descriptor 不公布 direct 项
  relayRegistration?: { host: string; port: number };       // 仅 anchor：向盲中继保持出站注册（NAT 后可达的承载），同时作为 descriptor 公布的中继会合点
}
interface MeshEndpointDescriptor {       // 跨设备 wire 对象：可达性提示，非信任材料——不入签名域、不入 trust 链
  v: 1; deviceId: string;
  transports: Array<{ kind: "direct"; host: string; port: number }
                  | { kind: "blind-relay"; relay: { host: string; port: number } }>;
  revision: number; at: IsoTime }
// 运行时校验（收发同一实现）：未知字段拒；transports 1..8 且两种形态之外类型层不存在；
// host 1..255 字符；port 1..65535；revision 正安全整数、同 deviceId 严格递增回退拒；at 规范时间戳。
```

**配对会合（先于认证的首次传输——引导链第一环）**：配对码的带外交付物 = 一次性配对秘密（§2.1）+ **出码设备的会合信息**（direct 地址和/或 blind-relay 会合点 + **一次性高熵配对 rendezvous id**；二维码内嵌，短码场景 `zz pair` 同屏显示、新设备随码输入）。配对经中继会合时的键即该 rendezvous id（`RendezvousKey` 编码，见会合协议）——独立随机生成、只作会合标识、不参与认证；**短码只进入 PAKE，任何中继可见物不得由短码派生**（低熵值的派生物是可离线枚举的校验物，破坏 §2.1 抗离线字典合同）。新设备凭会合信息建立**未认证传输通道**（S2 socket-transport），§2.1 配对消息（offer / join / PakeRound / finished / acceptance）在该通道上交替；通道上只允许配对协议消息、其余一律拒，身份信任仅在 acceptance 后成立，MITM / 重放 / 爆破由 §2.1 既有机械拒绝点承担。**pairwise rendezvous secret 不经传输**：双方从配对已共享的会话密钥材料（short-pake 分支 = PAKE 会话密钥，qr 分支 = 高熵一次性秘密——均为 §2.1 密钥确认的既有材料）按 `"zhixing:rendezvous:pairwise:v1"` 域分离**各自独立派生**；secret 只进设备 SecretStore，引用形态 `{ kind: "rendezvous", bindingId: 对端 deviceId }`（§2.3），不入配置、trust 流、descriptor 与任何 wire / 日志。**删除时机**：acceptance 未提交的配对失败 / 超时（孤儿候选）、引导废弃、对端 `revoke` 或角色移除不再需要连接时均 `delete`；轮换为新值原子覆盖——秘密不留孤儿驻留。定性为非信任材料——泄露至多造成会合干扰与关联，身份恒由端到端握手保证，经认证连接协商轮换即收束。

**引导崩溃闭环（写序与幂等续传）**：双方在提交 acceptance **之前**先完成 pairwise secret 的派生并 fsync 入 SecretStore（候选态）——acceptance 耐久提交（入链 / 消费一次性码）时，重连密钥材料必已在场，不存在"已入链却无重连密钥"的半完成态。acceptance 完成后同一通道升级为已认证配对通道，随引导流交付：双方 `MeshEndpointDescriptor` 与 `HomeTrustRecord` 签名快照（§2.1 既有投影，此后经认证连接追赶事件链、设备本地重放验证）；全部交付完成后双方各自耐久写**引导完成标记**，secret 随之转正。配对 rendezvous id 保留至引导完成标记落盘才失效：引导中任一侧崩溃或断线，重启后凭已耐久的候选 secret 与仍有效的 rendezvous（或 pairwise 键）重新会合、重新认证握手并**幂等续传**剩余交付——不重新配对、不重复入链、不重复消费配对码；acceptance 提交前崩溃则配对未成立，按 §2.1 一次性语义重新出码。

**盲中继会合协议（S2 `bridgeBlindRelay` 之上的撮合合同）**：双方各自出站连接中继后先发一帧规范 hello：

```ts
type RendezvousKey = string;             // "rzv:" + 64 位小写 hex（32 字节）；独立会合令牌类型——
                                         // 不是 Digest（不入 §1.2 六类注册表）、不是 KeyConfirmation（非密钥确认语义）；
                                         // contracts lint 对其独立校验格式，冒用 Digest / KeyConfirmation 即失败。
interface BlindRendezvousHello { v: 1; key: RendezvousKey; ttlMs: number }
// 首帧；未知字段拒；ttlMs 1..3_600_000（挂起上限与初值 S5 标定）。key 两种来源、同一编码与校验：
// 控制面 = "rzv:" + hex(MAC(pairwiseRendezvousSecret, UTF8("zhixing:rendezvous:v1") || 0x00 || UTF8(utcDate)))
//（secret 住 SecretStore，派生见配对会合段）；配对 = 带外交付的一次性高熵配对 rendezvous id（随机生成，
// 不由任何低熵值派生）。中继只见令牌与 IP，不见设备身份与明文；能算出 key 者（曾持 secret）至多造成
// DoS 与关联，身份恒由隧道内端到端握手保证，secret 经认证连接轮换即收束。
```

中继按 key 撮合：首条连接挂起（时长 = min(ttlMs, 中继上限)，超时断开）；第二条同 key 到达即桥接进入 `bridgeBlindRelay` 纯转发并清除表项；挂起中第三条同 key 拒；桥接后同 key 新连接开启新一轮挂起；任一端断开即清除表项并断开对端。会合键是 pairwise 的，故锚点的 `relayRegistration` = **对 trust 链投影中每个需连接锚点的 `active` 远端 peer，同时维护当前与前一时间窗各一条挂起注册连接**（注册数量上界 = 2 × 链投影 active 成员数），每条独立走"被会合消费或断开后立即重注册"的生命周期；进入新时间窗即补注册新窗键，早于前一窗的注册即时撤销（有界清理）；peer 被 `revoke` 或角色移除即撤销其全部注册。拨号方依次尝试当前与前一时间窗——双侧各覆盖两个相邻窗口，任一方向的时钟偏差小于一个窗口长度时键必有交集，不存在窗口切换的确定性断连边界。会合成功只是取得字节通道，S2 认证握手随后在通道内端到端进行，失败即断。

**端点引导（新增 bootstrap 合同；信任零新增）**：`MeshEndpointDescriptor` 是纯可达性提示——信任只来自 §2.1 设备密钥与 S2 双向认证握手，端点缺失、错误或被篡改只导致连接失败，天然 fail-closed，故不入签名域。交付与更新：① 配对引导流内经已认证配对通道交换（见上）；② 接收方按 deviceId 落设备域本地耐久，`revision` latest-wins、回退拒；③ 后续变更经任一已认证 mesh 连接以 negotiated-version 服务推送，接收方只接受 `descriptor.deviceId = 该连接认证对端` 的自述更新（任何设备不得代改他人端点）；更新不可达时旧端点保留为候选。anchor 的 descriptor：`direct` 项取 `advertised` 配置（bind 为通配地址且未配置 advertised 时不公布 direct 项），`blind-relay` 项取 `relayRegistration`。

**控制面连接所有权与建立序列**：非锚点角色设备（S5 为 executor；后续 surface 同规则）是唯一拨号方，锚点恒不主动拨号——direct 监听与盲中继出站注册二者至少其一承载锚点可达性。拨号方按对方 descriptor 依序尝试：全部 `direct` → 依次经 `blind-relay` 项按上述会合协议会合（握手与 guard 仍端到端，中继零明文——S2 保密性验收覆盖）；全部失败按 `OutboundMeshTunnel` 既有退避策略有界重试。连接不可达不改变任何权威语义：派发滞留由 assigned outbox 承载、产品呈现按 §十一"目标离线→任务已排队"。连接级重连唯一归拨号方；assignment 级重驱恒由各 outbox 谓词（§3.6 / §5.5）驱动——两层解耦，互不假设对方状态。锚点接受连接的授权谓词 = 握手身份属于 trust 链投影的 `active` 成员且角色相容，别无第二来源。

**验收（随第 20 单元前置提交）**：链未建立时单机默认装配零监听，首次出码 `genesis + role-change` 原子入链、建链失败配对不得继续、此后内置默认失效；本地配置声明链外角色启动即拒、链上撤销后重启拒且在线断连；descriptor 未知字段 / 越上界 / revision 回退拒，端点逐字段篡改仅致连接失败、零信任影响、零权威变更；配对在仅 direct、仅 relay 两形态下均能从码走到 acceptance，未认证通道上非配对消息拒，中继可见的配对会合键与短码统计独立（不可作离线枚举校验物）；pairwise secret 两端独立派生结果一致、零传输、只以 `{kind:"rendezvous"}` 落 SecretStore，配对失败 / 引导废弃 / 对端撤销三类删除时机零孤儿驻留；`RendezvousKey` 格式独立校验，冒用 `Digest` / `KeyConfirmation` 被 contracts lint 拒；acceptance 提交时候选 secret 必已耐久，acceptance 后、引导完成前的每个崩溃点重启均凭保留的 rendezvous / pairwise 键幂等续传（不重新配对、不重复入链、不重复消费码），引导完成标记落盘后 rendezvous 失效；会合协议的挂起超时、第三连接拒、断线清理、错 key 不撮合、注册被消费后重注册、多 executor 经各自 pairwise 键并发会合互不干扰、双向时钟偏差一窗内跨窗口切换会合不中断逐项通过；direct 不可达自动经 relay 会合且端到端认证与 guard 语义不变，双侧均 NAT 场景经 relay 建连；拨号方唯一重连、锚点零主动拨号、未启用角色零监听；全端点不可达时零权威变更，任务按排队 / 离线文案呈现。

## 三、端口接口（contracts 冻结）

```ts
type AuthorityPrincipal =
  | { kind: "assignment"; capability: AuthorityCapability }             // executor 侧调用
  | { kind: "surface"; surfacePrincipal: string; connectionId: string } // 已认证接入面调用
  | { kind: "host"; component: string }                                 // 进程内可信组件，装配期注册白名单
  | { kind: "owner-control"; grant: OwnerControlGrant }                 // owner → executor 的派发 / 取消 / supersede / 账本查询
  | { kind: "usage-reporter"; executorId: string };                     // executor → governor intake 专用（evidence 等无 assignment 负载也可构造）：
                                                                        // guard 验设备认证连接身份 = executorId + 报告签名 + 报告内 lease 链溯到本域根租约
interface OwnerControlGrant { assignmentId: string;
  scope: { execution: "conversation"; conversationId: string; ownerEpoch: number }
       | { execution: "job"; taskId: string; anchorEpoch: number };
  methods: OwnerControlMethodId[];   // 逐方法绑定（§2.2 封闭子集），跨方法重放被 guard 拒绝
  callerDeviceId: string; requestId: string; requestDigest: Digest; controlLease: ControlLease;
  issuedAt: IsoTime; expiry: IsoTime; signature: Signature }
interface AuthorityCallContext { principal: AuthorityPrincipal; requestId: string;
  expectedRevision?: number; deadlineAt: IsoTime }
```

一切权威端口调用（含读）必携 `AuthorityCallContext` 过同一 guard：assignment 验 capability 的 scope / 方法与资源 / expiry；surface 验连接认证与会话归属；host 验装配期白名单；owner-control 由 executor 验 grant 签名 keyId、callerDeviceId、认证连接设备与耐久派发 owner 四者全等，scope / epoch 当前，内嵌 ControlLease 有效，并要求 `requestId` 及 `requestDigest = D("OwnerControlRequest",1,{method,assignmentId,authority,requestId,body})` 全等本次调用；usage-reporter 由 governor 验设备连接身份与报告签名、lease 链溯根——进程内与跨机同一实现。

### 3.1 SessionStatePort（达对话 owner）

```ts
interface SessionMeta { conversationId: string; ownerEpoch: number; baseRevision: number;
  name?: string; sceneId?: string; turnCount: number; lastActiveAt: IsoTime }
interface TranscriptCursor { shardId: string; runIndex: number }
interface TranscriptPage { records: TranscriptRunRecord[]; next?: TranscriptCursor }

interface SessionStatePort {
  readSessionMeta(conversationId: string, ctx: AuthorityCallContext): Promise<SessionMeta>;
  readTranscriptTail(conversationId: string, ctx: AuthorityCallContext, cursor?: TranscriptCursor, limit?: number): Promise<TranscriptPage>;
  readTaskList(conversationId: string, ctx: AuthorityCallContext): Promise<TaskListState>;
  readAdvancementState(conversationId: string, ctx: AuthorityCallContext): Promise<AdvancementSnapshot>;
  mutate(conversationId: string, m: SessionControlMutation | SessionStagedMutation, ctx: AuthorityCallContext): Promise<{ revision: number }>;
}
// 三组判别联合：来源边界由类型层封死（管理入口 / run staged / 提交内务互不可越界），guard 再按 §3.8 守卫表逐 kind 验 principal
type SessionControlMutation =                     // 仅 ControlEnvelope session-write（surface / host）可携
  | { kind: "task-list-op"; op: TaskListOp }
  | { kind: "advancement-event"; event: AdvancementControlEvent }   // host（owner-services）专用
  | { kind: "session-meta"; patch: { name?: string; sceneId?: string|null; viewLayerState?: string } }  // sceneId = workscene 进出的会话域绑定
  | { kind: "window-op"; op: "clear" | "compact" }   // clear = transcript 清空事实 + 窗口归零；compact = owner 就地压缩（经 ControlCompletionPort），产物落 segment-append 与缓存指令
  | { kind: "conversation-delete" };
type SessionStagedMutation =                      // 仅 assignment 流 staged-mutation（executor run 内）可携
  | { kind: "task-list-op"; op: TaskListOp }
  | { kind: "segment-append"; segment: SegmentRecord };
type SessionInternalRecord =                      // 提交内务：仅 owner CAS 事务内产生，任何外部入口不可携
  | { kind: "content-asset-index"; entries: ContentAssetRef[] };
```

### 3.2 GlobalStatePort（达锚点；本地域物理不装配）

```ts
// wire DTO（路径永不上 wire；进程内领域类型由 adapter 双向映射）
interface WorksceneDto { id: string; name: string;
  workspace?: { deviceId: string; bindingRef: string };   // 设备域引用（≙ EnvironmentRequirement.workspace）
  createdAt: IsoTime; lastActiveAt: IsoTime }
interface SkillWriteDto  { name: string; description: string; content: ArtifactRef }   // 写面只有内容语义字段：
interface RubricWriteDto { title: string; description: string; content: ArtifactRef }  // id / revision / state / createdAt / zone / source
                                                                                        // 全部由锚点生成派生，调用方零权威字段（正文经内容寻址，无 dir 路径）
type SkillStatePatch =                            // "至少一项必填、其余可选"的三分支联合——空 patch 类型层不可构造，
  | { mode: SkillModeDto; pinned?: boolean; disabled?: boolean }   // 且保留一次请求原子更新多字段的既有能力；
  | { pinned: boolean; mode?: SkillModeDto; disabled?: boolean }   // SkillState 的 id / createdAt 为锚点权威字段，不在写面
  | { disabled: boolean; mode?: SkillModeDto; pinned?: boolean };
interface ConfigAssetRecord {                    // 无远程调用方的非秘密期望配置的单族权威载体
  domain: "guidance"|"channel-registry"|"model-profile"|"policy"|"prompt-assets";
  key: string; revision: number; schemaId: string /* 该 domain 的版本化 value schema id，contracts 冻结注册表 */;
  value: JsonValue; digest: Digest }                  // digest 按 §1.2 ConfigAssetRecord 自摘要
// secret-free 的机械保证（非注释承诺）：①写入口唯一 host principal（类型层已封）②写入按 schemaId 校验 value 结构，
// 秘密形字段只允许 SecretRef 形态 ③不变量 6 的 wire / 存储审计扫描覆盖本族。domain 的 schema 演进随其模块 S 节点注册。

type GlobalQuery =
  | { kind: "memory-search"; domain: "memory"|"journal"|"people"; query: string; limit: number }
  | { kind: "memory-stats"; domain: "journal"|"people" }
  | { kind: "trust-rules"; scope?: string }
  | { kind: "schedule-list"; includeDisabled?: boolean }
  | { kind: "workscene-list" }
  | { kind: "config-asset"; domain: ConfigAssetRecord["domain"]; key?: string }
  | { kind: "asset-index"; asset: "skills"|"rubrics"|"prompt-assets" };
interface AssetIndexEntry { id: string; kind: "skills"|"rubrics"|"prompt-assets"; revision: number; digest: Digest }
type GlobalReadResult =
  | { kind: "memory-search"; hits: Array<{ domain: "memory"|"journal"|"people";
      entry: MemoryEntry | JournalEntry | PersonEntry; score?: number }> }
  | { kind: "memory-stats"; domain: "journal"|"people"; count: number; lastWriteAt?: IsoTime }
  | { kind: "trust-rules"; snapshot: TrustRuleSnapshot }
  | { kind: "schedule-list"; tasks: TaskDefinition[] }   // 仅 user 任务——system 任务经 isInternal 拦在一切用户视图外（既有语义）
  | { kind: "workscene-list"; scenes: WorksceneDto[] }
  | { kind: "config-asset"; records: ConfigAssetRecord[] }
  | { kind: "asset-index"; entries: AssetIndexEntry[] };

// 三组判别联合（与 session 域同构）：管理入口 / run staged / 提交内务，类型层封死来源
// ScheduleTaskSpec 的 wire 投影（一手基线 scheduler/types.ts:50-64：action = agent-turn | system，webhook 属 TaskDelivery）。
// 两刀切干净：① wire 上只承载**用户任务**（action 仅 agent-turn）——system 任务是 host-only 维护件（见下），
// 不存在 surface / run staged 能构造 system handler 的路径；② webhook 的 url 本身可携令牌，与 headers 同属秘密面——
// **endpoint 整体**（url + headers）入 SecretStore，wire / 日志 / 备份只见 SecretRef，秘密录入走 SecretStore 专用流程。
type TaskDeliveryDto =
  | { kind: "none" }
  | { kind: "channel"; channel: string; to: string; threadId?: string }   // threadId 承载线程语境（≙ DeliveryTarget.threadId），不得在投影中丢弃
  | { kind: "webhook"; endpoint: SecretRef };
type ScheduleActionDto = { kind: "agent-turn"; prompt: string; model?: string; tools?: string[] };
interface ScheduleTaskSpecDto {                   // 显式字段白名单——wire 可写面到此为止；不用 Omit 派生（源类型加字段即静默扩权）
  name: string; description?: string; enabled: boolean; priority: TaskPriorityDto;
  schedule: TaskScheduleDto; action: ScheduleActionDto; delivery?: TaskDeliveryDto }
// 白名单外字段恒由锚点生成，wire 提交即反序列化层拒绝：id / createdAt / updatedAt / state 随 create 分配维护；
// origin / interactionResponder / createdInTurn 取自本次入口上下文（turnOrigin / 已认证渠道主体 / 当前 turn，不信任调用方自报——通知与确认来源不可伪造）；
// system 恒 false——内置任务只经 TaskDefinitionBody.kind:"system"（host-only），wire 无法伪造内部任务标志。
type SystemHandlerId = "__transcript-gc"|"__journal-gc"|"__advancement-gc";   // 封闭枚举，随维护任务模块的 S 节点扩展
// system 任务（内置维护）：{ handler: SystemHandlerId; params?: JsonValue }，仅由锚点装配层内部 ensureSystemTask 注册——
// 不进任何 mutation 联合、不上 wire、不进用户列表（isInternal 既有拦截）；零业务 unknown 由 JsonValue + 封闭枚举保证。
interface DeliveryRequestDto {                    // run 内投递意图：内容 + 目标语义，零队列状态字段
  target: { kind: "turn-origin" } | { kind: "explicit"; target: DeliveryTargetDto };   // 默认回发起来源；跨通道必须用户明示，线程语境不丢
  content: string | { ref: ArtifactRef } }         // string 由锚点归一为 OutboundContentDto.text；ref 必须解引用为 OutboundContentDto

// 每个动作一个字段完备的判别分支——"create 无 spec / delete 无 id / set-state 无 state"类非法组合在类型层不存在；
// 反序列化、签名 schema 与 guard 直接共享这些封闭联合，adapter 无隐含规则可发明
type ScheduleWriteMutation =
  | { kind: "schedule-create";    spec: ScheduleTaskSpecDto }
  | { kind: "schedule-update";    taskId: string; spec: ScheduleTaskSpecDto; taskRevision: number }
  | { kind: "schedule-set-state"; taskId: string; state: "enabled"|"disabled"; taskRevision: number }
  | { kind: "schedule-delete";    taskId: string; taskRevision: number };
type SkillWriteMutation =
  | { kind: "skill-create";    record: SkillWriteDto }                    // 新建：skillId = skillNameToId(name) 锚点生成，调用方不携；
                                                                           // 撞名**拒绝**（invalid，沿 store.ts:192 既有语义——绝不静默生成不同 id）
  | { kind: "skill-update";    skillId: string; record: SkillWriteDto; expectedRevision: number }   // 更新：对象级 CAS
  | { kind: "skill-admit";     record: SkillWriteDto }                    // 接纳 linked：skillId 同样锚点生成
  | { kind: "skill-set-state"; skillId: string; patch: SkillStatePatch; expectedRevision: number }
  | { kind: "skill-archive";   skillId: string; expectedRevision: number };
// 现有 save_skill 工具的 upsert 语义由 adapter 拆解：目标不存在 → skill-create，存在 → skill-update（携当前 revision）；wire 合同不设 upsert。
type RubricWriteMutation =                        // 按 RubricStore 现状（saveOwn / updateOwn / archive）建模；
  | { kind: "rubric-save-own";   rubric: RubricWriteDto }        // linked 经资产同步进入、不经写面；rubricId / revision 锚点分配
  | { kind: "rubric-update-own"; rubricId: string; rubric: RubricWriteDto; expectedRevision: number }
  | { kind: "rubric-archive";    rubricId: string; expectedRevision: number };
type WorksceneWriteMutation =
  | { kind: "workscene-create";      name: string; workspace?: { deviceId: string; bindingRef: string } }
  | { kind: "workscene-rename";      sceneId: string; name: string; expectedRevision: number }
  | { kind: "workscene-set-workdir"; sceneId: string; workspace: { deviceId: string; bindingRef: string } | null;  // null = 解绑
      expectedRevision: number }
  | { kind: "workscene-delete";      sceneId: string; expectedRevision: number };
type TrustWriteMutation =
  | { kind: "trust-persist"; rule: TrustRule }
  | { kind: "trust-revoke";  ruleId: string };
// 变更类分支（update / set-state / set-workdir / rename / archive / delete）的对象级 revision CAS 字段**必填**——
// 与 schedule 族 taskRevision 同义（命名沿各域习惯）；create / save / append 类凭 requestId 幂等，无 CAS 字段。

type GlobalControlMutation =                      // 仅 ControlEnvelope global-write（surface / host）可携
  | { kind: "memory-append"; payload: MemoryAppendPayload }      // domain 判别在 payload 内（§1.3b）
  | ScheduleWriteMutation | SkillWriteMutation | RubricWriteMutation | WorksceneWriteMutation | TrustWriteMutation
  | { kind: "config-asset-write"; record: ConfigAssetRecord };   // host（锚点本地配置 adapter）专用
type GlobalStagedBase =                           // conversation / job 共有的 staged 写面
  | { kind: "memory-append"; payload: MemoryAppendPayload }
  | ScheduleWriteMutation
  | { kind: "skill-usage"; record: SkillUsageRecord }
  | Extract<SkillWriteMutation, { kind: "skill-create"|"skill-update"|"skill-admit" }>   // run 内工具 = save_skill（adapter 拆 create/update）+ admit_skill
  | WorksceneWriteMutation;
type GlobalStagedMutation =                       // conversation assignment 的 staged 写（含回来源投递）
  | GlobalStagedBase
  | { kind: "delivery-enqueue"; request: DeliveryRequestDto };
type JobGlobalStagedMutation =                    // job assignment 的 staged 写——投递目标**类型层只有 explicit**：
  | GlobalStagedBase                              // job 无 turn 来源，turn-origin 分支在本联合中不存在（非 guard 兜底）
  | { kind: "delivery-enqueue"; request: { target: Extract<DeliveryRequestDto["target"], { kind: "explicit" }>;
      content: DeliveryRequestDto["content"] } };
// DeliveryIntentDto 恒由锚点发布时构造，DeliveryItem 仅为投影；executor 零队列字段。反序列化按 assignment 的 ExecutionScope 选型：
// conversation 收 SessionStagedMutation | GlobalStagedMutation，job 只收 JobGlobalStagedMutation。

interface GlobalStatePort {
  read(q: GlobalQuery, ctx: AuthorityCallContext): Promise<GlobalReadResult>;
  mutate(m: GlobalControlMutation | GlobalStagedMutation, ctx: AuthorityCallContext): Promise<{ revision: number }>;
}
```

联合按现有入口收录；新的资产 / 配置域随其模块的 S 节点增加分支（联合演进走 `v` 升版）。guidance、渠道注册、模型档位 / 策略等无远程调用方的非秘密期望配置统一经 `ConfigAssetRecord`（域键控、版本化）承载：锚点本地配置 adapter（文件 + reload → `config-asset-write`，host principal）写入权威，经既有资产同步机制分发——不逐域造 bespoke schema；该族随 §七权威覆盖表的"全局状态与期望配置"行参与转移 / 删除 / 保留 / 备份。

### 3.8 mutation 守卫表（guard 逐 kind 验 principal；类型组先封死大边界，本表管组内细分）

| kind | 允许 principal | 附加守卫 |
|---|---|---|
| session: task-list-op / session-meta / window-op | surface；host | busy 时 window-op 拒绝；expectedRevision |
| session: advancement-event | host（owner-services） | — |
| session: conversation-delete | surface | busy 拒绝；连带 §七会话状态行删除语义 |
| session staged: task-list-op / segment-append | assignment（capability 绑本对话） | 经 staged overlay，永不直接落权威 |
| global: memory-append / schedule-* / trust-* / skill-* / rubric-* / workscene-* | surface；host | update / set-state / delete 类分支携 revision CAS（字段必填，类型层保证） |
| global: config-asset-write | host（锚点配置 adapter） | revision 单调 |
| global staged: 全部 | assignment | 经 staged overlay；capability.methods 含对应方法；job scope 只收 JobGlobalStagedMutation（类型层无 turn-origin 投递） |
| internal: content-asset-index | 无入口——仅 owner CAS 事务内产生 | 出现在任何 mutate 调用即拒绝 |

### 3.2b DeferredGlobalIntentPort（随对话 owner 装配——流跟对话走，端口跟流走）

```ts
interface DeferredGlobalIntentPort {             // 离线全局意向的唯一读写入口
  record(conversationId: string, mutation: DeferredGlobalIntent["mutation"], timeSensitive: boolean,
         ctx: AuthorityCallContext): Promise<{ intentId: string }>;   // **仅本地域 owner 可执行**——锚点在线时全局写直走
                                                                       // GlobalStatePort，锚点域 record 一律 invalid（意向只在离线产生）
  list(conversationId: string, ctx: AuthorityCallContext): Promise<DeferredGlobalIntent[]>;
  decide(intentId: string, decision: "confirmed"|"discarded", ctx: AuthorityCallContext): Promise<void>;
  // list / decide 由**该对话当前 owner** 执行：收编前 = 本地域 owner（离线可查可撤）；收编后 = 锚点（复核 UI 的应答入口，
  // confirmed 即经锚点 ControlRequestJournal 重校验执行，timeSensitive 必经用户再确认）
}
```

intent 流按 conversation 落**该对话 owner** 的 `intent:<conversationId>` 逻辑流（§4.1，本地域与锚点域流枚举均含）——随 AuthorityTransfer freeze / checkpoint 一并导出导入，收编零遗漏、归属零歧义。类型层只接 schedule 与 Rubric 两族（`DeferredGlobalIntent.mutation` 已封）。双拓扑测试随 S8。

### 3.3 EnvironmentPort（executor 本地）

```ts
interface EnvironmentPort {
  resolveWorkspace(bindingRef: string): Promise<{ absolutePath: string; workspaceBindingRevision: number }>;
  probePath(p: string): Promise<"directory"|"missing"|"non_directory"|"inaccessible"|"error">;
  capabilitySnapshot(): Promise<CapabilityDescriptor>;
  versionInventory(): Promise<ExecutorVersionInventory>;
}
```

### 3.4 ResourceReservationPort（达所属域 governor；只在域内进程装配，不经 mesh 暴露——跨设备只流转签名 lease 与 UsageReport。anchor 域根 lease 随派发到 executor 后，run 内 `acquireChild / consume` 由 **executor 本地 governor 凭根 lease 的 delegation 就地履约**：以设备密钥签有界子租约、扣账落本机 governor 流并防超卖，周期以签名 `UsageReport` 上报锚点账本按 `usageId` 幂等收敛——两域同一租约合同与 guard，接口在任一拓扑都可履约）

```ts
type ReservationOrigin =
  | { admissionClass: "interactive"; entry: "conversation-input" }
  | { admissionClass: "advancement"; entry: "advancement-control" }
  | { admissionClass: "scheduler"; entry: "schedule-trigger" }
  | { admissionClass: "orchestration"; entry: "orchestration" };  // 装配期注入的可信入口派生器提供
type SystemJobReservationOrigin = Extract<ReservationOrigin, { entry: "schedule-trigger" }>;
interface ResourceReservationPort {
  enqueueRoot(reservationId: string, workload: RootResourceWorkload,
              origin: ReservationOrigin, ctx: AuthorityCallContext): Promise<void>;             // 根候选先耐久入队；独立方法身份，不借用 prepare 权限
  prepareAssignmentRoot(req: AssignmentReservationRequest,
                        origin: ReservationOrigin, ctx: AuthorityCallContext): Promise<AssignmentResourceLease>;   // 只签候选、零租约日志副作用；排他签发权为进程内占用态，候选生命周期见 §十
  prepareSystemJobRoot(req: SystemJobReservationRequest,
                       origin: SystemJobReservationOrigin, ctx: AuthorityCallContext): Promise<SystemJobResourceLease>; // 只签 scheduler 候选；由 6.2b 原子激活
  acquireRoot(w: ImmediateRootWorkload, budget: ResourceLease["budget"],
              origin: ReservationOrigin, ctx: AuthorityCallContext): Promise<ImmediateRootResourceLease>;          // control 根租约即时写 reserve 后返回
  acquireChild(parent: ResourceLease, w: ChildResourceLease["workload"], budget: ResourceLease["budget"],
               ctx: AuthorityCallContext): Promise<ChildResourceLease>;
  reserveUsage(lease: ResourceLease, usage: { usageId: string; tokens?: number; calls?: number; costMinor?: number },
               ctx: AuthorityCallContext): Promise<void>;                                        // 真实外调前耐久预占；独立方法身份
  consume(lease: ResourceLease, usage: { usageId: string; tokens?: number; calls?: number; costMinor?: number },
          ctx: AuthorityCallContext): Promise<void>;
  settle(lease: ResourceLease, ctx: AuthorityCallContext): Promise<void>;
  release(lease: ResourceLease, ctx: AuthorityCallContext): Promise<void>;
}   // 全部方法携 ctx 过同一 guard——"每次权威端口调用必验权"无例外
```

### 3.5 ControlCompletionPort / AdvancementReviewerPort（达 owner 设备模型运行时）

```ts
interface ControlCompletionPort {
  complete(req: { role: "main"|"light"; messages: Message[]; schemaToolName?: string;
    lease: ResourceLease; abort: AbortSignal; deadlineAt: IsoTime }):
    Promise<{ ok: true; text: string; toolCall?: { name: string; input: object }; usage: { inputTokens: number; outputTokens: number } }
           | { ok: false; error: AuthorityError }>;
}
interface AdvancementReviewerPort {      // 输入输出沿 advancement 模块 reviewRun 契约（符号引用）
  review(input: AdvancementSnapshot, lease: ResourceLease, abort: AbortSignal): Promise<AdvancementControlEvent[]>;
}
```

### 3.6 RunExecutorPort（owner-kernel → 执行体）

```ts
interface LedgerSnapshot { assignmentId: string; lastSeq: number;   // = assignment 流最新 recordSeq（§4.3）
  phase: "unknown"|"received"|"dispatch-rejected"|"supersede-fenced"|"started"|"failed"|"halted"|"sealed"|"acked";
  sealedBundleRef?: ArtifactRef; acknowledgedCommitRevision?: number; cancelProof?: CancelProofBody;
  failure?: { reason: string; usageFinal: { reportDigest: Digest; upToUsageSeq: number } } }
interface LedgerEvidencePage {                   // uncertain 裁决与审计的可核验账本页；executor 签名
  assignmentId: string; fromSeq: number; toSeq: number;
  entries: Array<{ recordSeq: number; body: AssignmentRecord | { ref: ArtifactRef } }>;  // 大内容经 ArtifactRef
  chainDigest: Digest; executorId: string; signature: Signature }

type DispatchResult =
  | { accepted: true }
  | { accepted: false; outcome: "rejected-before-received"; error: AuthorityError; proof: DispatchRejectionProof }
  | { accepted: false; outcome: "conflicting-redelivery"; error: DispatchConflictError; proof: DispatchConflictProof };
interface RunExecutorPort {
  dispatch(e: DispatchEnvelope, activation: AssignmentActivationProof,
           ctx: AuthorityCallContext /* principal 必为 owner-control */):
    Promise<DispatchResult>;
  cancel(assignmentId: string, fence: { fenceSeq: number; requestId: string },
         ctx: AuthorityCallContext /* principal 必为 owner-control */): Promise<void>;   // 幂等
  supersede(assignmentId: string, fence: { fenceSeq: number; requestId: string },
            ctx: AuthorityCallContext): Promise<SupersedeProof>;   // 重派栅栏（§4.3）：幂等；fence 先到无 assignment 即落 tombstone 后返回 not-started-fenced
  queryLedger(assignmentId: string, ctx: AuthorityCallContext,
              range?: { fromSeq: number; limit: number }): Promise<LedgerSnapshot | LedgerEvidencePage>;
}
```

派发回执纪律：assigned outbox 只选择“当前 state=dispatched、存在 assigned、且无 dispatch-acked / assignment-superseded”的 assignment，每次发送同一 `DispatchEnvelope` + 对同一 `AssignmentActivationPayload` 的有效签名 proof；载荷由原子提交确定性重建，重启可重新签名。executor 先按 §1.2 复算 envelope 对象身份及全部内嵌自摘要/引用摘要并验签，再验证 proof 当前 owner/epoch 签名与 `validateAssignmentActivation`（ref / assignment / executor / dispatchRef / manifestDigest / permissionLeaseDigest / capIds 全集 / reservation / commit 摘要全匹配，其中 permissionLeaseDigest 必须等于信封内确切 permissionLease 的规范摘要）、`validateDispatchBinding`、`matchManifest` 与权限引用资产按 lease digest 的验签命中（§5.3 两层语义），全部通过后才 fsync `received(envelope, activation)` 并返回 `accepted:true`；本地 capability / permission / resource guard 只采信该耐久 received proof，禁止在线回查 owner。重复 assignment 若 proof 签名有效且规范载荷与已耐久 `received.activation` 全等，回放原结果，signature 字节不同本身不构成冲突；若载荷不同，返回签名 `DispatchConflictProof` 与 `DispatchConflictError(retryable=false)`，不得追加 executor `dispatch-rejected`、不得改变 executor assignment 状态。该 proof 固定绑定唯一 `received` 记录的 recordSeq / 前缀链摘要与新旧 dispatch / payload 摘要，可由原账本重建，不受 started / sealed 等后续记录影响；proof.error 只含固定 code / retryable，response.error 的这两项必须全等，message 仅作诊断、不入证明身份。

首次派发的控制身份采用两级门禁：只有 `validateDispatchControlBinding` 已验 envelope / ControlLease 签名、assignment / executor 及二者 owner key 绑定后，才可在 `received` 前写 `control-lease-renewed`；authority 与 owner 身份不得从未验证 activation 派生。随后完整派发校验失败仍耐久写 `dispatch-rejected`，且 ActivationProof signer 必须等于 envelope signer。

owner 只在当前仍为上述未 ACK dispatched assignment 时消费 conflict：先验 executor / assignment / signature / received 前缀链，要求 accepted / conflicting 两份 ActivationPayload 摘要不等，再要求 proof.conflictingDispatchRef / conflictingActivationDigest 等于本次实际发送二元组。随后从本地耐久 assigned + 所指 CommitEnvelope / DispatchEnvelope 重算期望 acceptedDispatchRef / acceptedActivationDigest：① accepted 侧全等期望，证明 executor 已接收原权威派发——同一 CommitEnvelope 写 `dispatch-conflict(acked-original) + dispatch-acked`，停止 outbox；② accepted 侧任一不等，说明 executor 接收事实与 owner 权威派发不一致——同一 CommitEnvelope 原子写 `dispatch-conflict(opened-uncertain) + state(uncertain) + UncertainResolutionFact(cause=dispatch-conflict) + cancel-fence + assigned.capIds / 活跃 tickets 的 revoked 记录`，停止派发 outbox与该 assignment 的 ControlLease 续期；fsync 后以该 cancel-fence 重驱 executor 止损，禁止仅凭 conflict proof 自动提交迟到 bundle或重派。资源租约此时不提前 settle / release（世界副作用与最终 usage 尚未证实），只在取得既有终结证明或用户裁决时按 §十收束。proof 无效、两侧摘要相等、conflicting 侧不对应本次发送或 response.error 的 code / retryable 与 proof.error 不等时零写入，走既有超时 / fence 路径；assignment 已 ACK、已离开 dispatched 或已终态时，迟到 conflict 不得再改变权威状态。`DispatchConflictProof` 永非 `AssignmentTerminationProof`，任何分支都不能据它重派。

`dispatch-conflict` 止损 outbox 的唯一谓词为：存在当前打开的 `dispatch-conflict(opened-uncertain)` 与其同 envelope `cancel-fence`，且尚无同 openFactDigest 的 `dispatch-conflict-contained`、`assignment-superseded` 或用户 resolution。满足时按有界退避并在 executor 重连时重发**同一 fence**（每次可重签短期 OwnerControlGrant，不得换 requestId / fenceSeq）；executor 若因取消新结束 pending interaction 或已有 finished 尚未镜像，必须先以 §3.7 的签名连续审计批次在该耐久 cancel-fence 下完成 audit-only settlement，再重入同一取消原因形成唯一 `halted(proof)`，最后调用 `submitCancelProof`。该 mirror 例外只推进 owner 审计前缀，绝不恢复 revoked capability 的 started/bundle/session/global/resource 写权。任一取消源重入若已存在 halted 则读取并重提最先耐久的同一规范 proof、零追加。owner 必须接受严格后继 conflict received 前缀的两类 CancelProof：owner-fence proof 绑定当前耐久 fence；abort-ticket proof 在在线接收时重新鉴权 ticket、落入 owner 日志后由其签名 assignment / executor / epoch 绑定机械重放。不得要求 executor 为后到的 owner fence 生成第二个终态或替换先到的 abort-ticket proof。RPC 成功本身不停止，只有 owner 全验 proof 并耐久上述停止事实才停止，因此 executor 写 proof 后、提交前或响应前崩溃均可收敛。`not-started` proof 是总纲“事后证实未启动”的终结证明：CancelProof(not-started) 或已有 `supersede-requested` 所绑定的 SupersedeProof(not-started-fenced) 只在账本链严格后继于 conflict 的 received 前缀时，才可同一 CommitEnvelope 写**携同一规范 proof**的 contained + resolution + assignment-superseded + 旧租约终结；conversation 与仍 enabled 的 job 写 `proven-not-started-redispatched` 并转 queued，已禁用或删除的 job 写 `proven-not-started-cancelled` 并转 cancelled。任一项缺失或 proof 不同均拒绝；仅 queued 分支之后可建新 assignment。DispatchRejectionProof 只证明本次发送未接收，不能否定 conflict 已证明的另一 received 前缀，故不得解析该 conflict。`halted` proof 只写 contained、停止止损 outbox并作为用户核验与 usage 对账证据，状态仍 uncertain，禁止伪装成 cancelled。无 proof 时义务不丢弃、仅有界退避；capability / ticket 吊销仍由各自 revoked 记录重驱并以短 TTL 兜底。

首次接收在写 `received` 前校验失败才先写 `dispatch-rejected`，再返回 `rejected-before-received + DispatchRejectionProof`，响应 error 必须与 proof.error 全等。响应丢失时 owner 仅据上述 outbox 谓词重发；supersede fence 必须先写 `supersede-fenced`（无 received 时即耐久 tombstone）再返回证明。`SupersedeProof(already-started)` 在正常 dispatched 态等价于可信 started 上报，owner 转 running 并保留原 assignment，不得写 superseded；若同一 supersede 请求在响应丢失期间已因其他证据进入 uncertain，outbox 仍以原 fence 重驱，not-started 终结证明按既有原子解析转 queued，already-started 则写 `supersede-started-observed` 并保持 uncertain，重启后以该记录停止重驱，禁止降格回 running。owner 只有持 `AssignmentTerminationProof` 才可在同一 CommitEnvelope 写 `assignment-superseded`、吊销该 assignment 全部 capability 与未 revoked ticket、终结根租约并创建下一 assignment；query 快照、DispatchConflictProof 或超时本身绝不授权重派。

正常取消从 dispatched / running / cancel-requested 进入 cancelled 时，owner 必须在同一 CommitEnvelope 写 `cancel-proof-accepted + capability/ticket revoked + state(cancelled) + 租约终结`；`cancel-proof-accepted` 保留完整规范 CancelProofBody，是 owner 侧证明身份、usageFinal 对账与机械重放守卫。相同签名载荷（signature 可重签）幂等回放，异载荷不得被“已经 cancelled”短路为成功；queued 取消、用户 uncertain 裁决及 assignment-superseded 收束不伪造本记录。

取消与在途派发终结竞态按既有终结证明收束：若 owner 已耐久 `supersede-requested` 或 executor 已耐久 `dispatch-rejected` 后用户 cancel，cancel 不得覆盖或遗失该事实；supersede outbox 在 `cancel-requested` 中继续重驱，同 fence 的 not-started 证明原子写 `assignment-superseded + capability/ticket revoked + state(cancelled)`，already-started 则写 `supersede-started-observed` 停止 supersede outbox并继续原 cancel fence。executor 对已 `supersede-fenced` / `dispatch-rejected` 的 cancel 幂等零写入；owner 恢复看到 `dispatch-rejected` 时只重放同一耐久派发以取回原 `DispatchRejectionProof`，不得重新执行，随后按取消意图转 cancelled。这样任一响应丢失与两种调用顺序均有耐久出口。

owner 的取消恢复先读取一份 `LedgerSnapshot` 冻结 `lastSeq`，再从 1 起流式读取 `LedgerEvidencePage`；每页是请求范围内不超过 256 条且未签名规范载荷不超过 512 KiB 的最大连续前缀。每页严格校验 version / 未知字段 / assignment / executor / 连续范围 / 签名，artifact-ref 必须回读规范 JSON 并校验引用；逐条深验 `AssignmentEntry` 后，必须与 executor 重放共用同一个增量账本状态机推进器（记录顺序、交互/写入身份、effect 闭合、abort、halt/seal/ack 迁移全部同构），同时从 `AssignmentLedgerSeed` 复算完整链，页末摘要与冻结尾序均须闭合。记录正文缓冲上界为一页；跨页只保留精确验证投影（计数、水位、未闭合 effect 与唯一身份集合），不保留历史正文。冻结前缀已见 `abort-requested`、且无可接受 `halted` / `bundle_sealed` 时才写 `UncertainResolutionFact(cause=cancel-unproven) + state(uncertain)`；任一分页、签名、引用、迁移、链或快照矛盾均零写入。已进入 uncertain 的 assignment 不重复扫描同一证据前缀。**durable-started 是全部 AssignmentTerminationProof 的共同禁重派不变量**：当前/历史入边为 running，或已有 `supersede-started-observed`，任一 DispatchRejection / Supersede(not-started-fenced) / Cancel(not-started) 均不得写 assignment-superseded。首次矛盾时同 envelope 写 `not-started-rejected(proof)` + open resolution（Cancel 为 cancel-unproven，其余为 ledger-unknown）+ state(uncertain)；已 uncertain 时只幂等补写停止锚。停止锚的幂等键为 `(assignmentId, proofKind)`，三类 proof 各自只停止对应 cancel / supersede / dispatch-recovery 生产源，禁止一类矛盾误杀另一条仍可收敛的恢复链；相同 kind 异载荷拒绝。

sealed bundle 提交 outbox 只保留尚未取得 executor ACK 耐久回执的 assignment。`LedgerSnapshot.phase="acked"` 时 `sealedBundleRef` 与 `acknowledgedCommitRevision` 必须同时在场，分别全等 owner 已耐久 `committed` 的 bundle ref 与 job/run revision；owner 核对后写 `bundle-ack-observed(assignmentId,bundleRef,revision)` 并从 O(pending) 恢复索引移除。owner committed 后响应丢失则重提同一 sealed bundle，executor ACK 后 owner 再崩溃则只核对快照并补回执、不得再次提交；回执落定后的后续重启对该历史 assignment 零 query、零提交。错 ref / revision、acked 缺字段或无对应 committed 一律 fail-closed。

### 3.7 RunSubmissionPort（executor → owner；run 闭环的提交入口，进程内与 mesh adapter 同一接口同一 guard）

```ts
interface InteractionMirrorEntry { ordinal: number; seq: number; requestId: string; kind: "allow-once";
  outcome: { t: "answered";      authority: InteractionAnswerAuthority; decision: { allowed: boolean; reason?: string }; decisionDigest: Digest; by: string }
         | { t: "auto-resolved"; decision: "denied"; reason: "no-interactive-surface"|"policy-fail-closed" }
         | { t: "cancelled";     via: "cancel-fence"|"abort-ticket"|"run-end"|"backpressure" }
         | { t: "expired" };                     // 镜像 = finished 终态投影（审计面与账本同构，四类终结路径一致）
  at: IsoTime }
interface InteractionMirrorBatch { v: 1; assignmentId: string; executorId: string;
  previousDigest: Digest; entries: InteractionMirrorEntry[]; mirrorDigest: Digest; signature: Signature }
// entries 非空且至多 256 条，ordinal 连续、seq 严格递增；previousDigest / mirrorDigest 按 §1.2 M 链首尾闭合。
// signature 覆盖含 at 的完整批次；批次去 signature 的对象身份是 owner 侧 exact durable-request 幂等键。
// surface 对已终结确认的同请求重试(丢响应/重启)按 owner 侧 mirror 投影回放——单一事实源,禁止另建内存已终结账本;
// answered.decisionDigest 必须等于 D("ConfirmationDecision",1,{requestId,decision})；同一完整决定回放成功，任一 kind/pattern/note/reason/modifiedInput 差异稳定冲突；
// cancelled/expired/auto-resolved 非用户决策、不回放,保持 already-resolved-or-not-found。

interface RunSubmissionPort {
  reportStarted(assignmentId: string, ctx: AuthorityCallContext): Promise<void>;   // 幂等
  submitBundle(bundle: SealedBundle, ctx: AuthorityCallContext):
    Promise<{ committed: true; commitRevision: number } | { committed: false; error: AuthorityError }>;  // CAS；重复 / 迟到按幂等键返回原 revision
  submitCancelProof(assignmentId: string, proof: CancelProofBody, ctx: AuthorityCallContext): Promise<void>;  // 幂等
  mirrorInteractions(assignmentId: string, batch: InteractionMirrorBatch, ctx: AuthorityCallContext):
    Promise<{ mirroredUpTo: number; ordinal: number; mirrorDigest: Digest }>;   // 审计镜像（至少一次）；应答权威恒在 executor 侧 assignment 流
}

// 治理域自己的上报面（与 run 提交解耦——evidence 等无 assignment 负载同一入口）：
// anchor / 本地域 governor 各自装配服务端，跨机经 mesh、进程内 adapter 同一 guard；验权走 ResourceLease 链（报告内 reservationId 溯到本域根租约）
interface ResourceUsageIntake {
  submitUsageReport(report: UsageReport, ctx: AuthorityCallContext):
    Promise<{ ackedThroughSeq: number }>;   // 只推进无缺口水位；usageId 幂等，重发回放原 ack
}
```

提交面先做两级守卫，再在 owner journal 的串行投影前缀内按结果能力分四类，分类权只在 owner-kernel，wire 调用方与 adapter 不携也不得自报。第一级 `authenticate` 只验 capability 签名、方法、scope、assignment/executor 静态身份，必须先于 owner 状态读取、payload 深验和 ArtifactStore 访问；随后 owner 立即要求该 capability 确由对应耐久 assigned 激活。无 ArtifactStore 的 submission-guard 投影只消费 run 流内联事实：完整 assigned 记录快照（含 ownerEpoch / baseRevision / dispatchDigest 权威域三元组与 manifest / permissionLease / dispatchRef / capIds / reservation）及其提交身份（lsn / envelopeDigest / at，用于零读取重建 activation 与各历史栅栏）、attempt 当前映射与状态、dispatch acknowledgement、dispatch-conflict 的"已见"与"打开"两态、supersede request 与 started observation、cancel fence、accepted cancel proof、resolution 打开/关闭事实、durable-started（running 入边与 started observation 的单调并集）、capability revocation，以及 committed ref/revision 与同 envelope 状态/吊销/内容索引/final/publish sidecar 的紧凑绑定；授权相关记录在本投影内执行与完整 reducer 同一份共享谓词，仅做数据闭包适配；capId 是已验签 capability 的不可变身份，完整业务投影仍在 active/settlement 事务决定时复核 dispatch 中的规范 capability。`submitBundle` 先仅以 capability.assignmentId 和该 guard 做零 payload preflight：过期 ownerEpoch、历史/终态 attempt、打开的 dispatch-conflict 可直接稳定拒绝；已 committed 只解析 bundle artifact identity 并核对其内联 sidecar 绑定后判断 exact replay，冷启动亦不得解引用 dispatch/bundle closure 或其他 ArtifactStore 内容。

- **active**：请求可能产生新的非终态事实；必须是当前 `assignmentByRun/jobRun` 所指 attempt，capability 签名、当前 ownerEpoch、时限、激活、方法、scope、assignment/executor 绑定全部有效且未 revoked。
- **settlement**：只允许已完整验签/验摘要并绑定**当前 attempt** 的 `submitCancelProof`、非 dispatch-conflict uncertain 的合法迟到 `submitBundle`，以及当前已耐久 cancel-fence 下严格续接 owner 审计链的 `InteractionMirrorBatch`；事务决定已证明载荷只能 contained / cancelled / committed / 安全重派或推进 audit-only 前缀。它仍校验 capability 签名、当前 ownerEpoch、方法与全部身份绑定，但允许该 attempt 因进入 uncertain/止损而已 revoked；mirror settlement 不得用于 started/bundle/session/global/resource 新写，也不得在无 cancel-fence 或历史 attempt 上建立 fresh 批次。
- **durable-replay**：仅当同一规范 proof、bundle artifact、完整 mirror batch 对象身份已与 owner 耐久请求事实精确全等，或 started 通知已被同 assignment 的 running/committed 状态吸收时成立；必须零追加并返回原结果/ordinal/digest/revision。此时 capability 只证明该 assigned epoch 的历史调用身份，允许已 revoked/expired/旧 ownerEpoch，但签名、方法、scope、assignment/executor 与耐久 assigned 仍须全验；旧 epoch 不得因此恢复 active/settlement。结果水位覆盖、entries 子集、跨批拼接、异载荷、无耐久匹配、旧 A1 对 A2 的 fresh 请求均不得借此模式通过。
- **durable-rejection**：仅当 owner 已有的旧 ownerEpoch、attempt 当前性/终态栅栏或打开的 dispatch-conflict 已足以在不消费 payload 的前提下决定 `submitBundle` 必为 `fence-rejected` 时成立；必须零追加、不得泄露后继 attempt 内容。它允许已 revoked/expired/旧 ownerEpoch 的原 capability 取得该稳定拒绝，但绝不恢复写权，也不得覆盖异载荷对既有 committed bundle 的冲突校验。

`mirrorInteractions` 的 fresh batch 在 dispatched/running 走 active；在 current cancel-requested/uncertain 且存在该 attempt 的耐久 cancel-fence 时只可走上述 audit-only settlement，其他状态一律拒绝；生产决定与 replay reducer 必须执行同一状态/fence 守卫。owner 只接受 `previousDigest == 当前 mirrorDigest`、首 ordinal = 当前 ordinal+1 且批内连续、seq 严格递增、requestId 在该 assignment 全部已镜像批次中唯一的完整签名批次，并以批次对象身份耐久去重；回执三字段必须全等批次末项，executor 的 `mirrored` 记录也必须先命中对应 finished checkpoint。若合法旧批回执到达时后继连续水位已耐久覆盖它，则幂等 no-op；错 ordinal/seq/digest 仍拒绝，禁止稀疏水位越过旧结果。executor 的 `halted` / `bundle_sealed` 必须要求全部 `interaction-finished` 已被 owner 镜像并写入对应 `mirrored` 事实；正常 run-end 必先把 pending interaction 耐久结束为 cancelled/run-end，完成 mirror 后才可封包，封包事务本身不得再隐式生成 interaction 结果；取消若新产出 cancelled interaction，先只耐久 abort + finished，镜像成功后重入同一取消原因再形成唯一 proof。响应丢失重发原签名批次（可重签、对象身份不变），owner exact replay 零追加；executor 可用后继批次的累计 ordinal/digest 回执一次确认此前已耐久连续前缀。

## 四、耐久存储模型

### 4.1 AuthorityCommitLog（每权威域唯一物理日志）

每个权威域持**唯一** append-only 提交日志；同进程共存的域共用同一物理文件、按 `stream` 区分：

- 锚点进程（全局域 + 其默认 owner 会话域）：`control`、`run:<convId>`、`job:<taskId>`、`publish`、`transfer:<transferId>`、`governor`、`final-outbox`、`trust`、`exposure`、`delivery`、`pairing`、`intent:<convId>`（收编导入的离线意向，复核期落此）、`checkpoint`。
- executor 设备域：`assignment:<asgId>`、本地 governor 的 `governor`。
- 本地域 owner（executor 进程内）：`control`、`run:<local convId>`、`publish`、`final-outbox`、`intent:<convId>`（离线全局意向——落 owner 域随对话收编转移，经 DeferredGlobalIntentPort 读写，§3.2b）、`transfer:<transferId>`（收编源端：freeze 证明与导出进度的耐久落点）。
- 转移目标端（锚点收编 / 迁居目标）：staging 导入进度同落自己的 `transfer:<transferId>` 流——双端各持耐久 transfer 流，任意中断按各自日志重入。

```ts
interface CommitEnvelope { lsn: number; at: IsoTime; entries: LogicalRecord[]; envelopeDigest: Digest }   // envelopeDigest 按 §1.2 自摘要
interface LogicalRecord  { stream: string;
                           body: ControlRecord | RunJournalRecord | JobJournalRecord | AssignmentEntry
                               | PublishRecord | TransferRecord | GovernorRecord | FinalOutboxRecord
                               | TrustStreamRecord | ExposureStreamRecord | DeliveryStreamRecord
                               | IntentStreamRecord | PairingStreamRecord | CheckpointStreamRecord }   // assignment 流恒经 AssignmentEntry 携 recordSeq（§4.3）
```

**原子性规则**：一次逻辑提交 = 一条 CommitEnvelope、一次 fsync——"applied + 权威变更决定 + 响应"与"CAS 权威件全集"各自恒在同一 envelope 内落定。transcript 分片、conversation meta、内容资产索引、终态推送、mutation 物化、HomeTrustRecord 快照全部是**可由 log 幂等重建的投影**（重启按 lsn 重放未投影段）。坏尾 envelope 截断隔离。带 state 字段的记录（final-outbox / exposure / intent）以**追加新记录**表达状态推进，投影按键 latest-wins。

`publish` 与 `final-outbox` 是物理共享流，但其恢复热点必须按 `conversationId` 分区：`publish-decision` 从同 envelope 的 committed bundle 机械取得 conversation 绑定，待发布集合不得跨会话枚举；FinalOutbox 的 revision 唯一性与单调水位均为 `(conversationId, commitRevision)` 作用域，禁止把不同会话的同 revision 当冲突。终态压缩可丢弃 batch / decision 正文，但必须保留 assignment 身份 tombstone，防止历史 assignmentId 被二次接纳。

### 4.2 ArtifactStore（内容寻址，每设备一个）

```ts
interface ArtifactRef { digest: Digest; bytes: number }
```

- 承载：SealedBundle 本体、MutationBatch、窗口全量输入、run 产物与附件、超限请求 / 结果。内联阈值：≤ 32 KiB 的对象直接内联进 LogicalRecord，超限入 artifact 并以 `ArtifactRef` 引用（初值，S3 标定）。
- 写序纪律：artifact 先 fsync 落定，引用它的 log entry 后写——log 内引用恒指向已耐久对象。
- **依赖闭包通用规则（跨边界引用的在场保证）**：任何跨边界消息（SealedBundle / ControlEnvelope / DispatchEnvelope）按 schema 机械划分两类引用：① `rootArtifacts` = wire body 中直接出现的全部 `ArtifactRef`（含 SealedBundle 的 runRecord / mutationBatch / contentAssets、ControlRequest mutation 内的正文引用、Dispatch work 引用），它们已在 body 的 digest / 签名域内，**不重复**写入清单；② `dependencyArtifacts` = 对每个有注册 schema 的 root artifact 解引用并递归提取得到的传递闭包，减去 rootArtifacts 后的精确集合（opaque 内容资产是叶节点，不解析内部字节）。两集合均按 `(digest, bytes)` 升序规范化且禁止重复；跨层重复、非规范顺序、少列与多列均拒，无传递依赖时必为 `[]`。接收方使用同一版本化 schema 提取器对账，先验证消息 digest / 签名，再要求 `rootArtifacts ∪ dependencyArtifacts` 全部已耐久在场，CAS / control apply / dispatch 接受前缺任一件即拒（`missing-base` 族错误）。root / dependency 只是**传输清单分类，不改变资产语义**：成功生效后，每个 ref 由引用它的权威记录接管保留与 GC（如 contentAssets 归内容索引、skill / rubric content 归对应全局资产）；未被权威记录接管的临时件才按保留窗 GC。
- **绑定字段（payload 单源，算法统一见 §1.2）**：`ControlEnvelope.payloadDigest = D("ControlEnvelopePayload",1,{body,dependencyArtifacts})`；`DispatchEnvelope.signature` 按 §1.2 覆盖除 signature 外全部字段；`SealedBundle.digest = D("SealedBundle",1,{assignmentId,executorId,streamFinal,usage,usageFinal,dependencyArtifacts,body})`。rootArtifacts 因位于 body 已被覆盖，dependencyArtifacts 显式入域；任何集合替换、顺序变化（JCS 后）或内容篡改均失配。
- 传输分两级：**S5 最小 assignment 域传输协议**——对象为 WindowInput 全量、SealedBundle、MutationBatch 及 `rootArtifacts ∪ dependencyArtifacts` 全闭包，在 owner ↔ executor 之间按 digest 推拉，授权凭该 assignment 的 `AuthorityCapability`（越 assignment 拒绝），支持断点（range）与去重（已有 digest 跳过），上传恒先于引用它的提交；**S6 扩展**——用户内容资产的数据面消费（surface 下载授权、断点续传、生命周期治理）与 **surface 预上传授权**（control 写的 root / dependency 上传半边，凭已认证连接按 requestId 申请上传授权，上传完成才可提交该 control 写）。
- S5 每次资产传输还须携短时 `AssignmentArtifactTransferGrant`：以 owner 签发的 assigned/received 激活为授权根，绑定 assignment、executor、认证源/目标设备、方向、精确规范化 ref 集、聚合字节与有效期；owner→executor 由 owner 签发，executor→owner 由该激活指定的 executor 签发。接收端先验证签发权、方向、闭包与预算；已持有 assignment 的一侧还须命中本地耐久激活，资产先行的 executor 接收侧则以 owner 签名激活为可携带证明，并在 dispatch 接纳时写入 received。当前写同时要求 capability 未过期，历史读取只复用仍可证明的耐久激活。
- GC：引用计数以 log 保留窗为准；对话删除连带其资产引用，归零后物理回收。

### 4.3 各逻辑流记录

```ts
type ControlRecord =
  | { t: "received"; requestId: string; envelope: ControlEnvelope | { ref: ArtifactRef };
      ingress?: IngressContext } // 仅 input/job-run 必有：owner 首次接收事实与稳定请求摘要分层；received→applied 重试恒复用首次值
  | { t: "applied";  requestId: string; result: ControlResult | { ref: ArtifactRef }; authorityRevision: number };
type ControlResultBody =        // 回放载体：重复请求原样返回。allow-once 不在此联合——它不落 owner control 流，
                                // 终态权威与幂等回放归 executor assignment 流 interaction-finished 记录（重复 (assignmentId, interactionRequestId) 回放原 outcome）
  | { t: "input"; runId: string; queuedPosition: number }
  | { t: "cancel"; runState: ConversationRunState }
  | { t: "cancel-batch"; conversationId: string; runs: Array<{ runId: string; runState: ConversationRunState; source: TurnSource; ingressId: string }> }
  | { t: "session-write"; revision: number }
  | { t: "session-create"; conversationId: string }
  | { t: "global-write"; revision: number }
  | { t: "job-run"; jobRunId: string }
  | { t: "job-cancel"; runState: JobRunState }
  | { t: "uncertain-resolve"; state: "queued"|"cancelled"|"failed"; factDigest: Digest }
  | { t: "delivery-resolve"; applied: boolean };
type ControlResult = { status: "ok"; body: ControlResultBody } | { status: "rejected"; error: AuthorityError };

interface DispatchConflictRecord { t: "dispatch-conflict"; assignmentId: string; proof: DispatchConflictProof;
  handling: "acked-original"|"opened-uncertain" }
// owner 流内幂等键 = (assignmentId, proof.conflictingActivationDigest)；同键且 DispatchConflictPayload 全等则回放首条记录（signature 可不同），异载荷拒绝。
interface DispatchConflictContainmentRecord { t: "dispatch-conflict-contained"; assignmentId: string;
  openFactDigest: Digest; proof: CancelProofBody | Extract<SupersedeProof,{decision:"not-started-fenced"}> }
// 每个 openFactDigest 至多一条 contained；proof 必须全验、绑定当前 assignment / executor / epoch 或 durable supersede-requested，
// CancelProof(owner-fence) 绑定当前耐久 fence，CancelProof(abort-ticket) 在线重新鉴权 ticket；二者均须在账本链上严格后继于
// conflict 所证 received 前缀；not-started 分支必须与同 proof 的 resolution + assignment-superseded 原子出现。

type RunJournalRecord =
  | { t: "session-lifecycle"; mutation: "clear"|"delete"; domainRevision: number; requestId: string }
      // clear/delete 的 owner 权威事实；同 requestId 精确回放原 revision，异载荷拒绝。事实产生后禁止新 input，直到对应投影进度确认。
  | { t: "admitted"; ingressKey: string; runId: string; input: UserTurnInput | { ref: ArtifactRef };
      ingress: IngressContext; invocation: ConversationInvocation; queuedPosition: number }
      // 来源与执行语义随准入一起耐久化：重启后普通、推进代理与多视角任务不得互相降级或变形；ingress 仍是票据签发、final / 渠道路由的权威数据源
  | { t: "assigned"; runId: string; assignmentId: string; executorId: string;
      ownerEpoch: number; baseRevision: number;     // 派发时权威域快照（由已验 DispatchEnvelope 派生，reducer 反绑 artifact 全等）——
      dispatchDigest: Digest;                       // 使无 ArtifactStore 的 submission guard 能零读取机械复算 activation、DispatchRejection 与 committed 的完整历史栅栏
      manifestDigest: Digest;
      dispatchRef: ArtifactRef;                     // 指向已先行 fsync 的 DispatchEnvelope artifact——**耐久 assigned 驱动至少一次发送**：
                                                    // 发送器严格按 §3.6 outbox 谓词重驱，绝无"无日志执行"或 uncertain 后继续发送
      permissionLeaseDigest: PermissionLeaseDigest; // 唯一激活的权限租约实例；不得以同 assignment 的另一张有效租约替换
      capIds: string[];                             // assignment capability 的唯一激活清单；票据在 received 后以 ticket-issued 单独耐久
      reservation: { reservationId: string; attempt: number } }   // 与同 CommitEnvelope 的 governor reserve 共同激活 AssignmentResourceLease；重派 attempt+1
  | { t: "dispatch-acked"; assignmentId: string }                 // accepted=true 或 conflict 的 accepted 侧全等 assigned；写入即停止 outbox
  | DispatchConflictRecord
  | DispatchConflictContainmentRecord
  | { t: "cancel-contained"; assignmentId: string; openFactDigest: Digest; proof: CancelProofBody }
      // 非 conflict uncertain（ledger-unknown / cancel-unproven）收到 halted CancelProof 的耐久证据锚：停止 cancel 止损 outbox、
      // 保留打开 fact 待用户裁决——与 dispatch-conflict-contained 同构，每 openFactDigest 至多一条；not-started proof 不落此记录，
      // 直接走 resolution(proven-not-started-redispatched) + assignment-superseded 原子收束
  | { t: "cancel-proof-accepted"; assignmentId: string; proof: CancelProofBody }
      // 正常 CancelProof 驱动 assigned run 转 cancelled 的 owner 侧耐久锚；必须与 cap/ticket revoked、state(cancelled)
      // 及租约终结同 envelope，按去 signature 的规范 proof 载荷精确幂等，供重放守卫与 usageFinal 对账。
  | { t: "not-started-rejected"; assignmentId: string; proof: AssignmentTerminationProof }
      // owner 已耐久见 started（或 DispatchRejection 与 conflict 的 received 事实矛盾）时的耐久停止锚：首次与 open fact/state 原子写，
      // 已 uncertain 时幂等补写；键=(assignmentId,proofKind)，每类只停止自己的恢复源，不覆盖其他 proofKind。
  | { t: "supersede-requested"; assignmentId: string; fenceSeq: number; requestId: string }
      // owner 侧重派栅栏的耐久载体：先记再下发（与 cancel-fence 同构）；outbox 恒以同一 fence 重驱，不得换 requestId / fenceSeq（§3.6）；
      // 仅 state=dispatched 时可记，每 assignment 至多一条
  | { t: "supersede-started-observed"; assignmentId: string; proof: Extract<SupersedeProof,{decision:"already-started"}> }
      // supersede 响应丢失期间 run 已因其他证据进入 uncertain 或用户 cancel 进入 cancel-requested 时，仍以原 supersede-requested
      // fence 重驱；迟到 already-started 不得把 uncertain 降格回 running，也不得覆盖 cancel，须耐久本停止锚并保持当前状态。
      // 每 assignment 至多一条，重启后据此停止 supersede outbox。
  | { t: "assignment-superseded"; assignmentId: string; proof: AssignmentTerminationProof }   // 重派前置：同 envelope 吊销能力/活跃票据、终结旧租约
  | { t: "cancel-fence"; assignmentId: string; fenceSeq: number; requestId: string }
      // fence 序单源：cancel-fence / supersede-requested 的 fenceSeq = 本记录所在 CommitEnvelope 的 lsn（owner 日志单调序，天然防回退）
  | { t: "ticket-issued"; ticket: DataPlaneTicket }              // owner 重启后仍可枚举、续期与吊销全部活跃票据
  | { t: "ticket-revoked"; ticketId: string }
  | { t: "capability-revoked"; capId: string; assignmentId: string }   // §2.2 capability 吊销的耐久落点
  | { t: "interaction-mirror"; assignmentId: string; batch: InteractionMirrorBatch }   // 签名连续审计批次；去 signature 的对象身份是 exact replay 键
  | { t: "state"; runId: string; assignmentId?: string; state: ConversationRunState; statusRevision: number }
  | { t: "committed"; runId: string; assignmentId: string; bundle: { ref: ArtifactRef }; commitRevision: number }
  | { t: "bundle-ack-observed"; assignmentId: string; bundleRef: ArtifactRef; commitRevision: number }
  | { t: "resolution"; runId: string; fact: UncertainResolutionFact }
  | ConversationChannelChallengeRecord;   // conversation 渠道确认的 challenge outbox（重启按 prepared−closed 重驱渠道消息，语义与 job relay 同构）

type ConversationProjectionProgressRecord =
  | { kind: "conversation-commit-projection"; assignmentId: string; runId: string; commitRevision: number; digest: Digest }
  | { kind: "conversation-lifecycle-projection"; mutation: "clear"|"delete"; domainRevision: number; requestId: string };
// 进度记录与其权威事实同属 run 逻辑流，只能由幂等投影消费者在真实物化成功后追加；重放必须逐字段反绑唯一待办。
// clear 完成 transcript/视图/内存窗口换代，delete 完成目录和运行时投影清理。普通缓存驱逐不得删除待办、恢复代际、能力或 scheduler claim；
// 只有进度确认或 delete 权威终结且投影收束后才能退休。启动 readiness 与运行期持续恢复共用同一消费者。

type ConversationChannelChallengePreparedRecord =
  { t: "channel-challenge-prepared"; ref: Extract<ExecutionRef, { execution: "conversation" }>; assignmentId: string; frameSeq: number;
      token: ConversationChannelChallengeToken; responder: ChannelResponderRef;
      toolName: string; display: { title: string; lines: string[] } };
type JobChannelChallengePreparedRecord =
  { t: "channel-challenge-prepared"; ref: Extract<ExecutionRef, { execution: "job" }>; assignmentId: string; frameSeq: number;
      token: JobChannelChallengeToken; responder: ChannelResponderRef;
      toolName: string; display: { title: string; lines: string[] } };
type ChannelChallengeLifecycleRecord =               // 不承载 pending 或应答权威；challengeId 在对应流内唯一
  | { t: "channel-challenge-delivered"; challengeId: string;
      receipt: { acceptedAt: IsoTime; platformMessage?: ChannelMessageRef } }
  | { t: "channel-challenge-closed"; challengeId: string;
      outcome: "allowed"|"denied"|"cancelled"|"expired"; at: IsoTime };
type ConversationChannelChallengeRecord = ConversationChannelChallengePreparedRecord | ChannelChallengeLifecycleRecord;
type JobChannelChallengeRecord = JobChannelChallengePreparedRecord | ChannelChallengeLifecycleRecord;
type ChannelChallengeRecord = ConversationChannelChallengeRecord | JobChannelChallengeRecord;
type ChannelInteractionRelayRecord =                 // job 独有：owner-relay 耐久游标与 grant 落点
  | JobChannelChallengeRecord
  | { t: "channel-relay-cursor"; jobRunId: string; assignmentId: string; upToSeq: number }
  | { t: "channel-challenge-granted"; jobRunId: string; challengeId: string; grant: ChannelInteractionGrant };

type JobJournalRecord =    // 键位 (taskId, jobRunId)
  | { t: "occurrence"; occ: JobOccurrence }
  | { t: "task-revision"; taskId: string; taskRevision: number;
      state: TaskDefinition["state"]; kind: TaskDefinition["definition"]["kind"];
      def: TaskDefinition | { ref: ArtifactRef } } // 超限 definition 先落 artifact；紧凑域供零解引用 guard，full reducer 回读后逐字段反绑
  | { t: "system-miss-coalesced"; requestedJobRunId: string; scheduledFor: IsoTime; coalescedJobRunId: string } // system missed 批次的耐久幂等别名；响应丢失后原触发恒回放同一批
  | { t: "system-started"; jobRunId: string; fence: SystemJobFence }   // 6.2b 行 2 的耐久落点（system job 无 assignment，fence 落本流）
  | { t: "system-result"; jobRunId: string; fence: SystemJobFence; outcome: "committed"|"failed";
      detail: { summary?: string; error?: string } | { ref: ArtifactRef } } // 超限结果先落 artifact；与 governor 终结记录及 terminal state 同 envelope
  | { t: "admitted"; jobRunId: string; taskId: string; scheduledFor: IsoTime;
      ingress?: IngressContext }   // 手动 job-run 携发起 surface（interact 票据签发依据）；定时触发无
  | { t: "assigned"; taskId: string; jobRunId: string; assignmentId: string; executorId: string;
      anchorEpoch: number; taskRevision: number; deliveryPlanDigest: Digest; dispatchDigest: Digest;   // 与 run 流同构的权威域快照（job 侧权威纪元为 anchorEpoch）；occurrence 冻结域反绑取 taskRevision / deliveryPlanDigest——即 JobCommitFence 的冻结事实，job 无 conversation 的 baseRevision 链
      manifestDigest: Digest;
      dispatchRef: ArtifactRef; permissionLeaseDigest: PermissionLeaseDigest; capIds: string[];
      reservation: { reservationId: string; attempt: number } }   // 与 run 流同构：capability 激活清单 + 同 envelope reserve 的租约激活锚
  | { t: "dispatch-acked"; assignmentId: string }
  | DispatchConflictRecord
  | DispatchConflictContainmentRecord
  | { t: "cancel-contained"; assignmentId: string; openFactDigest: Digest; proof: CancelProofBody }   // 与 run 流同构（语义见 run 流注释）
  | { t: "cancel-proof-accepted"; assignmentId: string; proof: CancelProofBody }                     // 与 run 流同构：正常 proof→cancelled 的耐久锚
  | { t: "not-started-rejected"; assignmentId: string; proof: AssignmentTerminationProof } // 与 run 流同构：按 proofKind 隔离的 started 矛盾停止锚
  | { t: "supersede-requested"; assignmentId: string; fenceSeq: number; requestId: string }           // 与 run 流同构（fenceSeq = envelope lsn）
  | { t: "supersede-started-observed"; assignmentId: string; proof: Extract<SupersedeProof,{decision:"already-started"}> } // 与 run 流同构：uncertain 中的耐久停止锚
  | { t: "assignment-superseded"; assignmentId: string; proof: AssignmentTerminationProof }
  | { t: "cancel-fence"; assignmentId: string; fenceSeq: number; requestId: string }
  | { t: "ticket-issued"; ticket: DataPlaneTicket }
  | { t: "ticket-revoked"; ticketId: string }                     // 手动 job-run 的 interact / abort 票据吊销，与 run 流同构
  | { t: "capability-revoked"; capId: string; assignmentId: string }   // 与 run 流同构：job assignment 的 capability 吊销落点
  | { t: "interaction-mirror"; assignmentId: string; batch: InteractionMirrorBatch }
  | { t: "state"; jobRunId: string; assignmentId?: string; state: JobRunState; statusRevision: number }
  | { t: "committed"; jobRunId: string; assignmentId: string; bundle: { ref: ArtifactRef }; jobRevision: number }
  | { t: "bundle-ack-observed"; assignmentId: string; bundleRef: ArtifactRef; jobRevision: number }
  | { t: "resolution"; jobRunId: string; fact: UncertainResolutionFact }
  | ChannelInteractionRelayRecord;

`state.assignmentId` 是 attempt 栅栏而非诊断字段：从无状态进入 queued，以及 queued 在尚无 assignment 时被取消/失败/过期，字段必须省略；queued→dispatched 及其后所有由 assignment 触发的 running/cancel-requested/uncertain/committed/cancelled/failed/queued 转换必须携触发该转换的 assignmentId。reducer 必须要求它等于该 run/job 当前反向索引；若同 envelope 的 resolution/assignment-superseded 已先关闭并删除索引，只允许携同一 closing assignmentId 的后续 state 记录。旧 A1 的任意迟到事件在 A2 建立后不得写出绑定 A2 的无身份 state，也不得借同 runId 改变 A2；run/job 两流同构执行。

// relay 记录约束：每个 (assignmentId, interactionRequestId) 恰有一个 prepared / challengeId；conversation 以 prepared.frameSeq 作为 ACK 水位，
// job 的 cursor 只增不减且不得越过尚未同 envelope 耐久接管的帧；delivered 可重放更新回执但不改变 challenge；granted 每 challenge 至多一条，写入后重复 callback 回放同一 grant；
// closed 只由对应 interaction finished 投影推进。owner 重启按 prepared−closed 差集重驱渠道 outbox，绝不据 relay 差集推导 executor pending。

// assignment 流的每条 LogicalRecord.body 为 AssignmentEntry：recordSeq 逐记录 +1，是 assignment 级线性化的**唯一全序**——
// LedgerSnapshot.lastSeq、InteractionMirrorEntry.seq、取消 / 封包胜负比较、LedgerEvidencePage 全部引用它
interface AssignmentEntry { recordSeq: number; body: AssignmentRecord }
interface DispatchRejectionProof {               // accepted=false 的签名、耐久证明；与普通 AuthorityError 响应分离
  assignmentId: string; executorId: string; dispatchDigest: Digest; error: AuthorityError;
  lastRecordSeq: number; ledgerDigest: Digest; signature: Signature }
interface DispatchConflictProof {                // 已 received 后的异载荷重投证明；只证明冲突，不是未开跑证明
  assignmentId: string; executorId: string;
  acceptedDispatchRef: ArtifactRef; conflictingDispatchRef: ArtifactRef;
  acceptedActivationDigest: Digest; conflictingActivationDigest: Digest;   // 各自 = D("AssignmentActivationPayload",1,AssignmentActivationPayload)
  receivedRecordSeq: number; receivedLedgerDigest: Digest;
  error: { code: "idempotency-conflict"; retryable: false };
  signature: Signature } // 绑定唯一 received 事实的前缀链；冲突响应零追加，后续账本可继续推进
type DispatchConflictPayload = Omit<DispatchConflictProof, "signature">;
// 重建 / 重试等价规则 = JCS(DispatchConflictPayload) 字节全等；executor 可重新签名，owner 不以 signature 字节制造第二个冲突事实。
type SupersedeProof =                            // 普通 queryLedger 快照**不算**重派证明（查询后仍可开跑，TOCTOU）
  | { assignmentId: string; executorId: string; fence: { fenceSeq: number; requestId: string };
      decision: "not-started-fenced"; lastRecordSeq: number; ledgerDigest: Digest; signature: Signature }
  | { assignmentId: string; executorId: string; fence: { fenceSeq: number; requestId: string };
      decision: "already-started"; lastRecordSeq: number; ledgerDigest: Digest; signature: Signature };
type AssignmentTerminationProof =
  | DispatchRejectionProof
  | Extract<SupersedeProof, { decision: "not-started-fenced" }>
  | NotStartedCancelProof;
/*
  重派安全的唯一证明：dispatch rejection、supersede fence 先于 started，或取消账本证明 not-started。already-started / halted 只证明不能直接重派，不得单独写 assignment-superseded。
*/

type AssignmentRecord =    // executor 设备域
  | { t: "control-lease-renewed"; lease: ControlLease }       // 首次 owner-control 与每次续期的耐久绑定；可先于 received / fence
  | { t: "received"; envelope: { ref: ArtifactRef }; activation: AssignmentActivationProof }
  | { t: "dispatch-rejected"; dispatchDigest: Digest; reason: AuthorityError }   // 拒收终态——先耐久并生成 DispatchRejectionProof 再返回，
                                                          // 此后同 assignment 永不执行，owner 可安全重派
  | { t: "supersede-fenced"; fenceSeq: number; requestId: string }   // 重派栅栏：此后 started / 一切新动作拒绝；
                                                          // fence 先于 dispatch 到达时本记录即首个 assignment 状态事实（可前置 control-lease-renewed）= tombstone，迟到 dispatch 永久拒
  | { t: "started" }
  | { t: "interaction-requested"; requestId: string; kind: "allow-once"; toolName: string;
      display: { title: string; lines: string[] } | { ref: ArtifactRef }; // 规范 JSON ≤8KiB；超限外置，重放必须解析并校验引用内容
      issuedAt: IsoTime; ttlMs: number; expiresAt: IsoTime } // executor 时钟，expiresAt = issuedAt + ttlMs（不等即拒）；恢复按 expiresAt，跨机按 issuedAt + TTL
                                                       // pending = requested 无同 requestId 的 finished
  | { t: "interaction-finished"; requestId: string; kind: "allow-once";
      outcome: { t: "answered";      authority: InteractionAnswerAuthority; decision: { allowed: boolean; reason?: string }; decisionDigest: Digest; by: string }
             | { t: "auto-resolved"; decision: "denied"; reason: "no-interactive-surface"|"policy-fail-closed" }  // 非交互兜底恒 deny（不降防御）
             | { t: "cancelled";     via: "cancel-fence"|"abort-ticket"|"run-end"|"backpressure" }
               // 取消栅栏 / abort 止损 / run 终止（含 halted / sealed）/ 队列满即拒（≙ 现 broker.ts:173 backpressure 语义）连带收束
             | { t: "expired" } }
      // 终结路径全枚举（对齐现有确认终结的全部 5 条 resolved 路径：resolve / cancel / expire / 非交互兜底 / backpressure——
      // `ResolvedListener` 注释明示其为"请求终结的唯一真源"，confirmation/types.ts:369-374）——
      // 任一在途确认恰经上述四类之一收束；恢复补写规则：恢复扫描发现 requested 无 finished 时，
      // run 已终态 → 补写 cancelled(run-end)；now > expiresAt → 补写 expired；两者皆非 → 恢复为真实 pending（重新投影下发）。
      // 补写幂等（同 requestId 唯一 finished），重放零伪 pending。
  | { t: "staged-mutation"; seq: number; domain: "session"|"global";
      mutation: SessionStagedMutation | GlobalStagedMutation | JobGlobalStagedMutation;   // 反序列化按 assignment 的 ExecutionScope 选型（§3.2）
      requestId: string;
      expected?: { anchorEpoch: number } }   // global 域必填 anchorEpoch；对象级 revision CAS 已是各变更分支的必填字段（类型层），
                                             // append / create 类凭 requestId 幂等可合并——本字段只承载域 epoch
  | { t: "side-effect-started";   effectSeq: number; kind: "tool-mutation"|"external-call"; toolName: string;
      summary: string /* 脱敏操作摘要，供 uncertain 呈现"该核验什么" */; target: "workspace-file"|"external-service"|"device-system" }
  | { t: "side-effect-completed"; effectSeq: number; status: "ok"|"failed"|"aborted"; resultDigest?: Digest }
  | { t: "abort-requested"; via: "owner-fence"|"abort-ticket"; refId: string }
  | { t: "halted"; proof: CancelProofBody }
  | { t: "execution-failed"; reason: string;
      usageFinal: { reportDigest: Digest; upToUsageSeq: number } } // clean started 前缀的失败终态；同 envelope 收束 executor 租约
  | { t: "bundle_sealed"; bundle: { ref: ArtifactRef }; mutationBatch?: { ref: ArtifactRef } }   // = completed；封包胜负点
  | { t: "acked"; commitRevision: number }
  | { t: "mirrored"; upTo: number; ordinal: number; mirrorDigest: Digest };
type CancelProofCommon = {
  assignmentId: string; executorId: string; authority: AuthorityEpochRef;
  lastRecordSeq: number; usageFinal: { reportDigest: Digest; upToUsageSeq: number };   // 取消路径的扣账对账锚（§十终结表）
  ledgerDigest: Digest; issuedAt: IsoTime; signature: Signature };
type CancelProofCause =
  | { cause: "owner-fence"; fence: { fenceSeq: number; requestId: string }; ticketDigest?: never; surfacePrincipal?: never } // 收束的正是这道取消栅栏
  | { cause: "abort-ticket"; ticketDigest: Digest; surfacePrincipal: string; fence?: never };                               // owner 失联止损：绑定预签 abort 票据与发起 surface
type CancelProofDecision =
  | { decision: "not-started"; lastEffectSeq?: never }                                // received 后、started 前止损；类型层禁止伪报 effect 水位
  | { decision: "halted"; lastEffectSeq: number };                                    // 0 = 尚无 effect；否则为已闭合的最后 effectSeq
type NotStartedCancelProof = CancelProofCommon & CancelProofCause & Extract<CancelProofDecision, { decision: "not-started" }>;
type HaltedCancelProof = CancelProofCommon & CancelProofCause & Extract<CancelProofDecision, { decision: "halted" }>;
type CancelProofBody = NotStartedCancelProof | HaltedCancelProof;                      // 来源 × 决策正交封闭；空/双决策与错字段组合不可构造
// owner 接受守卫：owner-fence 分支逐字段对当前 cancel-fence、assignment 归属、epoch 与账本链头校验；
// abort-ticket 分支验票据摘要对应本 assignment 的有效 abort 票据 + 全部 side-effect 已闭合——owner 失联期间
// executor 凭票据 halt 并封存 proof，owner 按账本 recordSeq 裁决（cancel-requested 竞态：6.1 行 17-19 / 6.2 行 19-21；
// owner 恢复：6.1 行 28-33 / 6.2 行 30-35），任一不符即拒。
```

终态闭合纪律：每次真实副作用必为配对的 `side-effect-started / side-effect-completed`（同 effectSeq）；`halted` 与 `bundle_sealed` 之前全部 effect 必已闭合（completed，status 可为 aborted），pending interaction 必先结束，全部 `interaction-finished` 也必须已由 owner 耐久镜像并以 `mirrored` 水位确认。崩溃恢复发现未闭合 effect 时**不得补写** `halted`，只能如实上报账本 → owner 判 uncertain，未闭合 effect 即证据链；仅有 pending / 未镜像 interaction 时先完成确定性的终结结果并按 §3.7 重驱同一 mirror batch，成功后才允许重入形成终态。

```ts
type PublishRecord =       // mutation 发布进度（owner 侧）
  | { t: "publish-decision"; assignmentId: string; batch: { ref: ArtifactRef }; sessionCount: number; globalCount: number;
      outcomes: Array<{ seq: number;                               // 逐条终审（同一 batch 可部分 granted 部分 conflicted）：
        outcome: { t: "granted"; targetRevision: number }          // granted = CAS 前已校验、分配目标 revision——不可拒绝的权威决定
                | { t: "conflicted"; error: AuthorityError } }> }  // conflicted = 逐条终态，随 FinalFrame 计入并经控制事件呈现
  | { t: "publish-progress"; assignmentId: string; domain: "session"|"global"; upToSeq: number;
      state: "pending"|"settled" };                                // 只管 granted 项的幂等物化进度（暂时性失败重试、重启续发）

interface FinalOutboxRecord { t: "final"; conversationId: string; runId: string; commitRevision: number;
  digest: Digest; state: "pending"|"published"|"expired" }

type GovernorRecord =
  | { t: "queued";  reservationId: string; admissionClass: AdmissionClass; workload: RootResourceWorkload }   // 公平队列入队事实；workload 是业务终态与队列项的耐久绑定
  | { t: "dequeue"; workload: RootResourceWorkload; reason: "cancelled"|"failed"|"expired" }  // workload attempt 终态 tombstone：与同因业务终态原子提交；已有队列项即移除，无队列项也阻断同 attempt 的迟到 enqueue；已 reserve 后禁止，改走租约终结表
  | { t: "reserve"; lease: ReservableResourceLease }                          // **本记录才是租约激活事实**，仅有签名候选一律无效；assignment/system-job 还须同 envelope 存在对应 assigned/SystemJobFence
  | { t: "usage-reserved"; rootReservationId: string; reservationId: string; usageId: string; tokens?: number; calls?: number; costMinor?: number }   // 外部调用前的耐久预占（字段值=上限）——先落盘再外调；由同 usageId 的 consume 收束（差额即释放），恢复扫描未收束预占按上限保守补 consume
  | { t: "consume"; usageSeq: number; rootReservationId: string; reservationId: string; usageId: string; tokens?: number; calls?: number; costMinor?: number }   // usageSeq 按根 reservation 连续分配——UsageReport 连续性的凭据
  | { t: "settle"|"release"|"reclaim"; reservationId: string };
// 在线预检与 anchor / executor 重放必须先调用同一运行时 validator：按 t 精确封闭顶层字段并校验嵌套 workload / lease / usage；未知判别值、缺失字段和额外字段一律 fail-closed。
// 幂等键：reserve=reservationId；dequeue=workload(kind+id+attempt)（重复同因幂等返回，异因拒绝）；usage-reserved/consume=usageId；settle/release/reclaim=reservationId+t（重复即幂等返回）

type TransferRecord =      // 物理流固定 transfer:<transferId>；prepared 后各记录校验 scope / subject / epoch 不变；源 / 目标两端各自落流
  | { t: "prepared";   transferId: string; scope: "conversation"|"anchor"; subject: string; sourceEpoch: number }
  | { t: "frozen";     transferId: string; proof: SourceFreezeProof }
  | { t: "imported";   transferId: string; checkpointDigest: Digest }
  | { t: "committed";  transferId: string; commit: AnchorTransferCommit | ConversationTransferCommit; targetEpoch: number }
  | { t: "tombstoned"; transferId: string }
  | { t: "aborted";    transferId: string; abort: { decidedBy: string; reason: string; signature: Signature } };

type TrustStreamRecord    = { t: "trust-event"; event: HomeTrustEvent };
type PairingStreamRecord  =
  | { t: "pairing-attempt-started"; offerId: Ulid; offerDigest: Digest; attemptId: Ulid; ordinal: number; at: IsoTime; retryNotBefore: IsoTime }
  | { t: "pairing-attempt-failed"; offerId: Ulid; attemptId: Ulid }
  | { t: "pairing-attempt-succeeded"; offerId: Ulid; attemptId: Ulid; offerDigest: Digest;
      acceptance: PairingAcceptance; trustEventDigest: Digest };   // 爆破限次、单次消费与响应丢失重放的耐久载体（§2.1）
type ExposureStreamRecord = { t: "exposure"; record: CredentialExposureRecord };
type DeliveryEndpointDto =
  | { kind: "channel"; target: DeliveryTargetDto }
  | { kind: "webhook"; endpoint: SecretRef };       // endpoint 仍只含引用，发送时由锚点 SecretStore 解引用
type DeliveryEnqueueKeyBody =                         // idempotencyKey 的唯一字段单源；持久化后可独立复算，六域组合在类型层封死
  | { kind: "job-result-delivery"; taskId: string; jobRunId: string; planDigest: Digest }
  | { kind: "staged-delivery"; assignmentId: string; mutationSeq: number }
  | { kind: "conversation-final-delivery"; conversationId: string; runId: string; commitRevision: number }
  | { kind: "conversation-status-delivery"; conversationId: string; runId: string; statusRevision: number }
  | { kind: "job-status-delivery"; taskId: string; jobRunId: string; statusRevision: number }
  | { kind: "conversation-control-response-delivery"; conversationId: string; requestId: string };
                                                      // 控制回执：一个控制决定恰一条回执 item，以 canonical requestId 幂等；
                                                      // 伴随断言逐字段绑定同 envelope 的 applied cancel-batch 事实（requestId + result.conversationId）；当前唯一生产者 = 空批次渠道回执
interface DeliveryIntentDto {                        // enqueued 的不可变权威输入；不携任何生命周期字段
  endpoint: DeliveryEndpointDto; content: OutboundContentDto | { ref: ArtifactRef };
  priority: "low"|"normal"|"high";
  source?: { kind: "scheduler"; taskId: string; taskName: string; createdInTurn?: string }
         | { kind: "agent"; conversationId: string }
         | { kind: "system"; reason: string };
  createdAt: IsoTime; maxAttempts: number }           // createdAt = 产生该 intent 的权威 CommitEnvelope.at；重放读取原值，禁止取当前时间
// inline content 的规范 JSON 必须 ≤8KiB，超限先外置；scheduler taskName 是冻结 spec.name 的 Unicode-safe 有界展示投影：≤480 UTF-16 code unit，超限以“…”结尾。
interface DeliveryFailure { code: string; message: string /* 脱敏文案，禁止响应体 / URL / header */; retryable: boolean }
interface DeliveryResolutionFact {
  itemId: string; attempt: number; openedAnchorEpoch: number; resolvedAnchorEpoch: number; openFactDigest: Digest;
  decision: "user-verified-sent"|"abandon"|"retry-risk-ack";
  by: string; at: IsoTime; factDigest: Digest }
type DeliveryItemState = "queued"|"attempting"|"retry-wait"|"uncertain"
  | "sent"|"failed"|"verified-sent"|"abandoned";  // sent=外部回执；verified-sent=用户核验，二者绝不混写
type DeliveryStreamRecord =                      // delivery 流 = 投递生命周期的**唯一事实源**；现有 DeliveryItem / 队列文件均为可重建投影
  | { t: "enqueued";        itemId: string; keyBody: DeliveryEnqueueKeyBody; idempotencyKey: string; intentDigest: Digest;
      intent: DeliveryIntentDto; statusRevision: number } // itemId=`dlv-<Ulid>` 以本 envelope.at 与域分离熵在首次权威提交时生成并耐久；重放读取原值，不从 key 重造。idempotencyKey 仅此处分配；intentDigest=`D("DeliveryIntentDto",1,intent)`
  | { t: "attempt-started"; itemId: string; attempt: number;
      authorization: { kind: "automatic" } | { kind: "manual"; resolutionFactDigest: Digest };
      startedAt: IsoTime;
      unknownOutcome: { kind: "idempotent-redrive"; redriveUntil: IsoTime } | { kind: "manual-resolution" };
      statusRevision: number }                    // **发送前先 fsync**；adapter 能力与有界 redrive 截止点一并冻结
  | { t: "sent";            itemId: string; attempt: number; receipt?: { digest: Digest; platformMessage?: ChannelMessageRef }; statusRevision: number }  // 外部回执事实，非用户核验
  | { t: "retry-scheduled"; itemId: string; attempt: number; retryAt: IsoTime; error: DeliveryFailure; statusRevision: number }
  | { t: "failed";          itemId: string; attempt: number; error: DeliveryFailure; statusRevision: number }            // 永久失败（可重试类走 retry-scheduled）
  | { t: "delivery-uncertain"; itemId: string; attempt: number; openedAnchorEpoch: number; openedAt: IsoTime; openFactDigest: Digest; statusRevision: number }
  | { t: "delivery-resolved"; fact: DeliveryResolutionFact; statusRevision: number };                                   // 用户裁决不可变，**绝不伪造外部 sent**
// enqueued 只能由六类权威生产者的内部构造器生成；目标态删除公开生产接口 IDeliveryPipeline.enqueue(EnqueueParams)（现状字段见 §1.3 源码引用），wire DTO 与 mutation
// 均不得携 itemId / keyBody / idempotencyKey / intentDigest / createdAt / maxAttempts，反序列化遇这些自报字段即拒绝。内部构造器从同 envelope 的权威事实派生 keyBody，
// 以 D("DeliveryEnqueueKeyBody",1,keyBody) 生成 idempotencyKey，以 D("DeliveryIntentDto",1,intent) 生成 intentDigest；
// committed 结果与非 committed 状态使用不同 kind，后者以 journal.statusRevision 定位；迁居 / 重放不改键，不同 revision 不得合并为同一 item。
// priority：staged/维护通知默认 normal；job 取冻结 task priority，urgent 映射 high。maxAttempts 是**自动发送次数上限**，取锚点当时版本化投递策略
// 并冻结为正整数；幂等 redrive 的 deadline 同由该策略在 attempt-started 时冻结。attempt 序号、automaticAttemptsUsed 与待消费手动授权分别投影；
// 用户每次 retry-risk-ack 可额外授权恰一次 next attempt，该 attempt 以 resolutionFactDigest 耐久绑定且不消耗自动预算，不修改 maxAttempts，后续配置变化也不改旧 item。
// openFactDigest = D("DeliveryOpenFact",1,{itemId,attempt,openedAnchorEpoch,startedAt,unknownOutcome,idempotencyKey})；迁居不改写打开事实。
// transport 响应（成功 / 失败 / 迟到）归属"当前开放 attempt"恒以 D("DeliveryResponseBinding",1,{itemId,attempt,startedAt}) 绑定——
// 不含 anchorEpoch、迁居不变，anchor 迁居后合法迟到响应仍归属原开放 attempt；openFactDigest 仅用于 uncertain 用户裁决的 fencing，二者不得混用。
// resolution.factDigest = D("DeliveryResolutionFact",1,{itemId,attempt,openedAnchorEpoch,resolvedAnchorEpoch,openFactDigest,decision,by,at})。resolvedAnchorEpoch 必为提交时当前 epoch，
// by 只取已认证 principal；完整重放须将 fact 的 itemId / attempt / resolvedAnchorEpoch / openFactDigest / decision / by 与成功 applied 所属的耐久 delivery-resolve 请求及认证 principal 逐字段绑定；重复响应 / 旧裁决按 itemId+attempt 幂等吸收或拒绝。
// DeliveryItem adapter 只从 enqueued intent + 后续事实投影 id / attempts / nextAttemptAt / lastError；这些可变字段不得反写权威流。
type IntentStreamRecord   = { t: "intent"; intent: DeferredGlobalIntent };
type RecoveryActivationPlan =
  | { kind: "establish"; rootEvent: HomeTrustEvent & { body: Extract<HomeTrustEventBody,{t:"recovery-root";op:"establish"}> } }
  | { kind: "rotate"; rootEvent: HomeTrustEvent & { body: Extract<HomeTrustEventBody,{t:"recovery-root";op:"rotate"}> } }
  | { kind: "domain-reset-establish";
      resetEvent: HomeTrustEvent & { body: Extract<HomeTrustEventBody,{t:"domain-reset"}> };
      rootEvent: HomeTrustEvent & { body: Extract<HomeTrustEventBody,{t:"recovery-root";op:"establish"}> } };
interface RecoveryCheckpointVerification {       // 引导端（持新恢复主秘密）**实际回读解封**后签发——"有备份"升级为"验证过能恢复的备份"
  checkpointId: Ulid; recipientKeyId: string; targetId: string;   // targetId = 独立存放目标（配对设备 / 用户指定位置）
  purpose: { kind: "periodic" } | { kind: "root-activation"; activationDigest: Digest };
  envelopeDigest: Digest; nonceDigest: Digest;   // = B(解封后自加密载荷读出的 verificationNonce 原始 256-bit 字节)——不真解封拿不到，伪造不了
  verifiedAt: IsoTime; signature: Signature }    // periodic 由当前恢复根签；root-activation 由候选新根签
type CheckpointStreamRecord =
  | { t: "checkpoint-created"; checkpointId: Ulid; recipientKeyId: string;
      purpose: RecoveryCheckpointVerification["purpose"]; envelopeRef: ArtifactRef; upToLsn: number; envelopeDigest: Digest }
  | { t: "checkpoint-replicated"; checkpointId: Ulid; recipientKeyId: string;
      purpose: RecoveryCheckpointVerification["purpose"]; targetId: string; envelopeDigest: Digest; at: IsoTime }
  | { t: "checkpoint-verified"; checkpointId: Ulid; recipientKeyId: string;
      purpose: RecoveryCheckpointVerification["purpose"]; targetId: string; envelopeDigest: Digest; verification: RecoveryCheckpointVerification }
  | { t: "checkpoint-verify-failed"; checkpointId: Ulid; recipientKeyId: string;
      purpose: RecoveryCheckpointVerification["purpose"]; targetId: string; envelopeDigest: Digest; reason: string; at: IsoTime }
  | { t: "checkpoint-superseded"; checkpointId: Ulid; supersededBy: Ulid; at: IsoTime };
// verified guard：created / replicated / verification 的 checkpointId、recipientKeyId、purpose、targetId、envelopeDigest 必须逐字段一致；
// envelope 签名有效且 recipientKeyId 等于候选根 recoveryBackupPublicKey.keyId；nonceDigest 必须由该 envelope 真解封所得 nonce 复算；
// root-activation 时 manifest 内必须含完整 RecoveryActivationPlan，D("RecoveryActivationPlan",1,plan) 必须等于 purpose.activationDigest，原子激活只能提交该计划内事件；
// establish/rotate 计划恰含匹配 op 的一条 root event；domain-reset-establish 恰含连续的 reset + establish 两事件，reset 的 coSign 与新根 rootProof 各自全验。
// 激活时还要以 CAS 验首事件 seq / prevEventDigest 仍接当前 trust 链头且计划内 seq / digest 连续；期间链头变化即整份候选失效并重新创建、复制、验证，不得改写已验证 envelope。
// RecoveryReadinessProjection：由 trust + checkpoint 两流派生（HomeTrustRecord 保持纯 trust 投影）——
// ready ⇔ 当前有效根存在 且 ≥1 个独立目标对**当前根封装**的检查点持有合法 verification；未 ready 在引导流与 /status 如实呈现。

type UncertainResolutionOutcome = {
  kind: "late-bundle-committed"|"proven-not-started-redispatched"|"proven-not-started-cancelled"
      | "user-verified-side-effects"|"user-abandoned"|"user-retry-acknowledged";
  by: string; at: IsoTime; factDigest: Digest };
type UncertainResolutionFact =                    // 工作域、主体与 cause 同一判别，run/job 双填或空填在类型层不存在
  | { subject: Extract<ExecutionRef, { execution: "conversation" }> & { assignmentId: string };
      openedAt: IsoTime; cause: "ledger-unknown"|"cancel-unproven"|"dispatch-conflict"; openFactDigest: Digest;
      resolution?: UncertainResolutionOutcome }
  | { subject: Extract<ExecutionRef, { execution: "job" }> & { assignmentId: string };
      openedAt: IsoTime; cause: "ledger-unknown"|"job-cancel-unknown"|"dispatch-conflict"; openFactDigest: Digest;
      resolution?: UncertainResolutionOutcome };
// openFactDigest = D("UncertainOpenFact",1,{subject,openedAt,cause})；裁决请求绑定本摘要，resolution 不入摘要域。
// resolution.factDigest = D("UncertainResolutionDecision",1,{openFactDigest,kind,by,at})——纯决定字段、重放可机械复算；
// 解析证据（迟到 bundle / 终结 proof）不入本摘要，其绑定由 resolution 与 committed / superseded 记录的同 envelope 原子性承载。
interface DeferredGlobalIntent {         // 本地域离线期间的全局写候选（非事实）；落本地域 owner 的 intent:<convId> 流（§3.2b，随对话收编转移）
  intentId: string; localDomainId: string; conversationId: string;
  mutation: ScheduleWriteMutation
          | Extract<RubricWriteMutation, { kind: "rubric-save-own"|"rubric-update-own" }>;
  // 只承载能力矩阵允许离线留意向的两域：schedule 注册 / 修改；Rubric 沉淀（本地 advancement 契约确认的"保存到全局库"半边——
  // 契约本身以快照落会话 owner 立即生效、不依赖全局 rubricId，见 §九；update 的 rubricId + expectedRevision 引自同步缓存，
  // 收编后经 GlobalStatePort 重校验、冲突交用户裁决）。memory / delivery / trust / 技能与配置写离线禁产——类型层封死，不靠运行时检查
  recordedAt: IsoTime; timeSensitive: boolean;
  status: "pending"|"confirmed"|"discarded"; reviewedAt?: IsoTime;   // 收编后重校验；timeSensitive 必须用户再确认
}
```

#### delivery 生命周期（逐行生成测试）

| # | 当前态 | 触发 | 守卫 | 次态 | 动作 |
|---|---|---|---|---|---|
| 1 | —（无 item） | conversation committed CAS / job committed CAS / staged publish / conversation 状态入队 / job 状态入队 | 按对应权威事实（含其 `CommitEnvelope.at`）复算 keyBody、idempotencyKey 与 intentDigest；intent 引用全在场；原子唯一索引确认 key 不存在 | queued | 同一 CommitEnvelope 写 `enqueued(statusRevision=1)` |
| 2 | queued | drain 取得发送资格 | endpoint ready；存在尚未消费的前一 attempt `retry-risk-ack`，否则 automaticAttemptsUsed<maxAttempts | attempting | **外部调用前** fsync `attempt-started(nextAttempt, authorization, unknownOutcome, statusRevision+1)`；有手动授权时 authorization 绑定其 resolutionFactDigest 且不增加 automaticAttemptsUsed，否则记 automatic 并加一；幂等 endpoint 冻结 redriveUntil，非幂等用 manual-resolution |
| 3 | attempting | 外部返回成功 | 响应属于当前开放 attempt | sent | 写 `sent(statusRevision+1)`；回执仅作外部事实 |
| 4 | attempting | 外部返回明确失败 | retryable 且 automaticAttemptsUsed<maxAttempts | retry-wait | 写 `retry-scheduled(retryAt, error, statusRevision+1)` |
| 5 | attempting | 外部返回明确失败 | 非 retryable 或 automaticAttemptsUsed≥maxAttempts | failed | 写 `failed(statusRevision+1)`，终态 |
| 6 | attempting | 恢复发现 started 无结果 | unknownOutcome=idempotent-redrive 且 now≤redriveUntil | attempting | 由原 started 记录有界重驱**同一 attempt / idempotencyKey**；不追加 lifecycle 记录、不增 revision |
| 7 | attempting | 恢复发现 started 无结果 | unknownOutcome=manual-resolution，或幂等 redrive 已过 redriveUntil | uncertain | 写 `delivery-uncertain(openFactDigest, statusRevision+1)`；禁止盲发或无限重驱 |
| 8 | retry-wait | retryAt 到期 | 当前记录仍是该 item 最新非终态，且 automaticAttemptsUsed<maxAttempts | attempting | fsync 自动授权的 `attempt-started(attempt+1, authorization, unknownOutcome, statusRevision+1)` 后复用原 idempotencyKey 发送 |
| 9 | uncertain | 当前 attempt 的迟到成功回执 | openFactDigest 仍打开且响应可验证 | sent | 写 `sent(statusRevision+1)`，自动关闭 uncertain；不伪造用户裁决 |
| 10 | uncertain | 当前 attempt 的迟到明确失败 | openFactDigest 仍打开；retryable 且 automaticAttemptsUsed<maxAttempts | retry-wait | 写 `retry-scheduled(statusRevision+1)`，自动关闭 uncertain |
| 11 | uncertain | 当前 attempt 的迟到明确失败 | openFactDigest 仍打开；非 retryable 或 automaticAttemptsUsed≥maxAttempts | failed | 写 `failed(statusRevision+1)`，自动关闭 uncertain |
| 12 | uncertain | 用户裁决 user-verified-sent | 已认证用户 + 当前 anchorEpoch + itemId/attempt/openFactDigest 全验 | verified-sent | 同 envelope 写 `delivery-resolved(openedAnchorEpoch, resolvedAnchorEpoch=当前值)` + control applied；该事实绝不投影成外部 `sent` |
| 13 | uncertain | 用户裁决 abandon | 同 12 | abandoned | 同 envelope 写 `delivery-resolved` + control applied，终态 |
| 14 | uncertain | 用户裁决 retry-risk-ack | 同 12 | queued | 同 envelope 写 `delivery-resolved` + control applied；产生仅供 nextAttempt 消费一次的手动授权 |
| 15 | sent / failed / verified-sent / abandoned | 任意发送、响应或裁决迟到 | — | 原终态 | 相同幂等键回放原结果；其余拒绝且不追加 lifecycle 记录，状态与 revision 不变 |

**入队前置裁决（不是 lifecycle 状态转移，不占表行）**：AuthorityCommitLog 在同一串行 append 临界区内原子执行“唯一索引查 key → 校验 → 追加整个来源 CommitEnvelope → 更新索引”，禁止先查后写的 TOCTOU。key 已存在且 `intentDigest` 相同，直接返回原 itemId、当前 state 与 statusRevision，零追加、零状态变化；digest 不同返回 `idempotency-conflict(retryable=false)`，整个来源 envelope 零写入。唯一索引与 envelope 在同一次 fsync 生效：fsync 前任一点崩溃均无新事实，fsync 后响应丢失按原 key 回放；并发同 key 由日志串行化后恰一创建、其余走上述重复裁决。

| 入队承诺 | 唯一承载 |
|---|---|
| 六类身份及字段组合不可混用 | `DeliveryEnqueueKeyBody` 判别联合；`enqueued.keyBody / idempotencyKey` |
| 同键载荷必须一致 | `enqueued.intent / intentDigest`；前置裁决的同 digest 回放、异 digest 拒绝 |
| 调用方不能自报权威字段 | `DeliveryRequestDto` / `JobCommitBundle` 白名单 + enqueued 内部构造器规则 |
| 时间与策略重放稳定 | `DeliveryIntentDto.createdAt = CommitEnvelope.at`、冻结 `maxAttempts`；重放读取原 enqueued |
| 查重、来源事实与入队零半提交 | §4.1 单 envelope / 单 fsync + 本节串行唯一索引；生命周期表行 1 只承载“无 key → queued” |

投影纪律：每次 lifecycle append 都以 `(itemId, currentAnchorEpoch, latestState, statusRevision, currentAttempt, automaticAttemptsUsed, pendingManualAuthorization)` 做 CAS，失败即重读；迁居只换 currentAnchorEpoch、不换 itemId / revision 序，故同一 item 任一时刻至多一个开放 attempt。`delivery-resolved(user-verified-sent)` → verified-sent，`abandon` → abandoned，`retry-risk-ack` → queued；只有 `sent` 记录投影外部 sent。任何不属于**当前开放 attempt** 的响应均拒绝且不得追加 lifecycle 记录或改变状态，即使 item 因 retry-risk-ack 已回到 queued（非权威诊断日志可选）。每次表内实际状态转移严格写 `statusRevision+1`；幂等回放与行 15 不增号。验收从空日志重建状态，并在 enqueued / started / 外部调用 / 结果落盘 / retryAt / 三种裁决及 anchor 迁居前后逐点崩溃注入，断言零静默丢失、可证明路径零重复、maxAttempts 与单次手动授权不越界、旧 epoch 拒绝、unknown 零永久悬空。

内存投影与其日志 cursor 是一个原子快照：增量重放和事务决定只在隔离副本上执行，成功后整体发布；任一校验、reducer、append 或 cursor 故障保留最后已知良好快照，需要全量重建时从全新空投影开始，禁止把旧投影与空 cursor 组合。

发送前资格纪律：一次 drain 只解析一次已 ready 的 endpoint adapter，并以该稳定快照完成 outcome policy 与 send；registry 后续变化只影响尚未取得资格的 attempt。新 attempt 在 fsync 前先物化内容：瞬态本地 I/O 失败零追加、零 attempt；已确认的永久内容错误以同一 CommitEnvelope 原子写 `attempt-started + failed`，不得暴露中间开放 attempt。指数退避与 redrive window 统一在 canonical timestamp 定义域内做饱和运算，合法策略值不得因时间溢出改写明确结果分类。

### 4.4 MutationBatch 与发布收敛

staged 写按序落 executor 域 log（`staged-mutation` 记录），run 内经内存 overlay 读己之写、外界只见 provisional。封包时导出不可变 `MutationBatch { assignmentId, records: staged-mutation[], count, digest }`（digest 按 §1.2 自摘要）为 artifact，**先于提交上传**至 owner 侧 ArtifactStore；bundle 引用其 `ArtifactRef + 分域计数`。**发布收敛（可保证终态）**：owner CAS 前对 batch 内 global 域逐条全量校验——anchorEpoch 当前、CAS 类 expectedRevision 匹配、业务预检通过（global staged 只存在于锚点域 run，owner 即锚点，同进程校验结构性可行）；校验结果由同一 envelope 的 `publish-decision.outcomes` **逐条终审**：granted 分配目标 revision，自此为不可拒绝的权威决定，发布仅是幂等物化（暂时性失败重试，重启续发）；conflicted 即逐条终态——run 照常 committed（run 结果不为全局写冲突陪葬），冲突计数随 `FinalFrame.publishConflicts` 到达 surface、明细以 `PublishConflictNotice` 经 owner 控制事件通道（`scope:"control"`）投递同会话 observer，由用户重发对应 control 写或放弃，绝不无限 pending。

```ts
interface PublishConflictNotice {                 // 冲突明细的机械合同：surface 可识别失败项、原因与重试对象
  conversationId: string; runId: string; commitRevision: number;
  conflicts: Array<{ seq: number; mutation: GlobalStagedMutation; error: AuthorityError }> }  // 携原 mutation 本体——"重试"= 以其内容重发 control 写
```

session 域按序直接投影。失败 / 取消整体丢弃 batch；uncertain 随裁决收束。

### 4.5 保留与 GC

committed / settled / conflicted / tombstoned / expired 的记录与其 artifact 保留 27 天后由所属权威维护 sweep 回收；delivery 仅在当前投影为 sent / failed / verified-sent / abandoned 时进入 27 天终态保留窗，`delivery-resolved(retry-risk-ack)` 投影 queued、**不得**按 resolved 回收；queued / attempting / retry-wait / uncertain 与 run/job 未裁决 uncertain 一律不回收。FinalOutbox `published` 后 24h 过期；spool（§5.6）按逐消费方水位回收（surface 票据 + job owner-relay），严格服从该节终态 / pending / 24h 条件。

## 五、协议与消息（全部判别联合）

### 5.1 控制请求

```ts
interface ControlEnvelope { requestId: string;
  principal: { surfacePrincipal: string; deviceId: string; connectionId: string };
  dependencyArtifacts: ArtifactRef[];    // 必填（无传递依赖 = []）：仅列 body 直接 root 引用解引用后的传递闭包，不重复 root（§4.2）；
                                         // root + dependency 经 S6 预上传授权先行上传，绑定本 requestId
  payloadDigest: Digest; at: IsoTime; body: ControlRequest }

type IngressContext =                            // **owner 派生**的耐久来源上下文——自已认证连接 / 渠道认证事实构造，调用方不可自报；
  | { kind: "first-party"; surfacePrincipal: string; deviceId: string; ingressId: string;   // 随 admitted 落盘、随派发传递、
      turnOrigin?: TurnOrigin; receivedAt: IsoTime }                                        // 终态与渠道投递按它路由，崩溃恢复零丢失
  | { kind: "channel";
      surfacePrincipal: string;                  // **规范化派生** = `"channel:" + D("ChannelResponderRef",1,responder)`——tenant 在摘要域内且无分隔符歧义；非自由字段，guard 复算校验
      responder: ChannelResponderRef;            // 渠道适配器自已认证入站派生——conversation 渠道确认的应答者身份锚
      replyTarget: DeliveryTargetDto;            // 默认回复路由（现 turnOrigin.target 语义的结构化形态）
      deviceId: string /* 渠道宿主所在设备 = 锚点 */; ingressId: string;
      turnOrigin?: TurnOrigin; receivedAt: IsoTime };

type ConversationInvocation =                    // 排队任务的耐久执行快照；进入 input 摘要与 admitted，响应丢失、重启与三选重试均复用原值
  | { kind: "agent"; source: TurnSource; advancement?: RunRecordAdvancementMetadata }
  | { kind: "perspectives"; source: "interactive"|"channel"; question: string };
// agent 仅在 source="advancement" 时允许且必须携 advancement；perspectives.question 必须非空、UTF-8 ≤8KiB，且不得使用 scheduler / advancement 来源。
// interaction 应答中的 note/reason UTF-8 ≤8KiB；所有入口、wire validator、账本与重放共用该预算。

type ControlRequest =
  | { t: "input";      conversationId: string; ingress: { ingressId: string; source: IngressContext["kind"] };
      input: UserTurnInput; invocation: ConversationInvocation; ownerEpoch: number }
      // 完整 IngressContext 由 owner 派生（channel 分支的 responder / replyTarget 取自渠道认证事实）；同 ingress / requestId 改写 invocation 必须 idempotency-conflict
      // 调度前预准入必须有稳定 ingressId；后续执行只可消费 input + invocation 全等的同一准入，禁止以内存准备态把另一调用挂到已耐久 run
  | { t: "cancel";     conversationId: string; runId: string; ownerEpoch: number }
  | { t: "cancel-batch"; conversationId: string; ownerEpoch: number;     // 批量取消的唯一线性化点：候选集在权威 apply 时刻由 owner 以
      response?: { replyTarget: DeliveryTargetDto } }                    // 取消控制面的单源谓词冻结；结果携逐 run 终态；重放消费 applied 原批次、零重新枚举。
                                                                         // response 为渠道回执绑定——空批次时同一权威决定产出恰一条 control-response 投递 item
  | { t: "session-create"; requestedName?: string; sceneId?: string }    // 路由到目标 owner（默认锚点；离线本地新会话就地）
  | { t: "session-write"; conversationId: string; mutation: SessionControlMutation; ownerEpoch: number; domainRevision: number }
  | { t: "global-write";  mutation: GlobalControlMutation; anchorEpoch: number; domainRevision: number }
  | { t: "job-run";    taskId: string; anchorEpoch: number }             // 手动立即执行：稳定请求身份不含接收事实；完整 ingress 取首次耐久 ControlRecord.received 并写 admitted
  | { t: "job-cancel"; taskId: string; jobRunId: string; anchorEpoch: number }
  | { t: "allow-once"; assignmentId: string; interactionRequestId: string;
      response: { via: "surface-ticket"; ticketId: string; decision: { allowed: boolean; reason?: string } }
              | { via: "channel-grant"; grant: ChannelInteractionGrant } }
  | { t: "uncertain-resolve"; ref: ExecutionRef; openFactDigest: Digest;   // 总纲三选裁决的 wire 入口——绑定打开中的 resolution fact，
      decision: "user-verified-side-effects"|"user-abandoned"|"user-retry-acknowledged" }   // 旧 fact / 已关闭 fact / 旧 epoch 一律拒绝
  | { t: "delivery-resolve"; itemId: string; attempt: number; anchorEpoch: number; openFactDigest: Digest;   // 投递 uncertain 的用户裁决（§4.3 delivery 流）
      decision: "user-verified-sent"|"abandon"|"retry-risk-ack" };
```

路由由 `t` 静态决定：`input / cancel / cancel-batch / session-create / session-write` → 对话 owner；`global-write / job-run / job-cancel / delivery-resolve` → 锚点；`uncertain-resolve` 按 `ref.execution` → conversation owner / 锚点。job-run / job-cancel 的 guard 校验目标 task：`TaskDefinitionBody.kind:"system"` 一律 unauthorized——system 任务的触发与取消只属锚点时钟与 host principal（6.2b 行 1）。两类 resolve 均验已认证用户、当前 epoch、仍打开的 subject / attempt 与 `openFactDigest`，重复 requestId 回放原结果，旧 fact / 已关闭 fact 拒绝。`allow-once` → executor 的 assignment 事务域：surface 分支验 run-interact 票据的 assignment / surfacePrincipal，channel 分支对 grant 与其内嵌 challenge token 分别验锚点签名，并验 job ref、assignment / interaction / challenge、route / responder、decision 与 expiry 全绑定，且 channel grant 禁用于 conversation / 手动 surface；成功后记录的 authority / decision / by 全由已验凭证派生，镜像 owner 仅审计。配对与秘密录入不走本信封（mesh / SecretStore 专用流程）。非法组合（字段与 `t` 不匹配）在反序列化层拒绝。

**准入与本地调度交接**：`input` 已耐久后即返回稳定 runId；在线 scheduler 以显式 `scheduling → accepted/active` claim 接管，只有真实入队/占位成功才确认接纳并消费恢复代际。任务构造、排队或进程内竞态失败时，原 owner 必须先把该 run 交还持续恢复再释放容量，禁止以普通拒绝否定已成立的准入，也禁止布尔 claim 吞掉恢复唤醒。取消以 runId 逐项线性化：每个权威取消后立即停止同一 run 的本地任务并返回含 runId、原 invocation source、稳定 ingressId 与本地处置的结构化结果；第一方 RPC 强制明确 runId。批量取消是一个以外层 surface requestId 线性化的 `cancel-batch` 权威决定：候选选择、逐 run 裁决与空批次回执 item 在同一 authority apply 内定格，候选谓词与 `cancellableRuns` 投影单源，重放消费 applied 原批次、零重新枚举、零追加；非空批次的用户反馈由逐 run 权威状态投递单源承担，运行时按耐久结果逐 run 幂等止损。控制写发生响应丢失时，调用端必须以同一信封精确重放；已成立的取消、uncertain 裁决或 session-write 不得被后置调度、投影或通知失败改写。advancement 代理只可由 ingressId 与当前 outstanding proxy 身份全等的取消结果收束，禁止仅凭 source 推断；恢复调度前必须按 `(source, ingressId)` 查询耐久 run 所有权，仅无 claim 时建立新任务，非关闭 run 保留原 owner，cancelled / failed / expired 才幂等关闭代理待办。无关通知投影在本地止损之后；关停总预算从开始计时，单项 I/O 不得绕过。

**会话生命周期交接**：clear/delete 的成功回执必须等待 `session-lifecycle` 对应旧存储与内存视图完成并追加投影进度；同 conversation 的在线与恢复消费者共用一项覆盖“物化→进度确认”的 claim，禁止在确认前释放或重复并发物化。新 requestId 仅在 owner 已有耐久身份或旧目录/活动会话确实存在时写入；精确 request replay 直接复用原事实，不依赖已被 delete 清除的派生存在性。权威事实之后的投影失败只保留待办并由同进程/重启恢复重驱，不得回滚权威 revision。delete 的权威 tombstone 可先成立，但目录与运行时资源仅在投影完成后对外确认并退休。

### 5.2 派发（conversation / job 分支）

```ts
type DispatchEnvelope =                          // 按 execution 判别的**单一闭合合同**——一份派发只有一个域分支，
  | { execution: "conversation"; assignmentId: string; executorId: string;   // 主体 / 基线 / epoch / 全部凭证在类型层完全同域
      manifest: ExecutionManifest & { baseRef: { execution: "conversation" } };
      controlLease: ControlLease & { authority: { execution: "conversation" } };
      permissionLease: PermissionSnapshotLease & { binding: { execution: "conversation" } };
      capabilities: Array<Extract<AuthorityCapability, { scope: { execution: "conversation" } }>>;
      resourceLease: Extract<AssignmentResourceLease, { workload: { kind: "run" } }>;
      dependencyArtifacts: ArtifactRef[];        // 必填（无传递依赖 = []）：work 直接 root 引用解引用后的传递闭包，不重复 root；
                                                 // executor 接受前对 root ∪ dependency 逐一验在场（§4.2），缺件即 missing-base 拒收
      issuedAt: IsoTime; signature: Signature; work: ConversationDispatch }
  | { execution: "job"; assignmentId: string; executorId: string;
      manifest: ExecutionManifest & { baseRef: { execution: "job" } };
      controlLease: ControlLease & { authority: { execution: "job" } };
      permissionLease: PermissionSnapshotLease & { binding: { execution: "job" } };
      capabilities: Array<Extract<AuthorityCapability, { scope: { execution: "job" } }>>;
      resourceLease: Extract<AssignmentResourceLease, { workload: { kind: "job" } }>;
      dependencyArtifacts: ArtifactRef[];
      issuedAt: IsoTime; signature: Signature; work: JobDispatch };
// S1 在 contracts 以泛型参数落地上述收窄（spec 的交叉类型仅表达约束语义）；executorId 在签名域内，与全部凭证的 executorId 同值。
// **域一致性唯一校验 `validateDispatchBinding`**——owner 派发构造器与 executor 准入 guard 共用同一实现（进程内与 mesh 同一函数）：
// 逐字段校验 manifest.baseRef、work（runId / jobRunId、baseRevision / fence、epoch）、ControlLease 的 authority / assignmentId、全部 capability 的 scope / assignmentId、
// permissionLease.binding / controlLeaseId、resourceLease 的 workload / scopeBinding / audience.executorId / activation.assignmentId 与信封 execution / assignmentId /
// executorId **同域同值**；resourceLease.domain 结构按判别联合封闭（anchor / local 逐变体 exact-keys 与值域），job 信封另须
// domain.kind="anchor" 且 domain.anchorEpoch === scopeBinding.anchorEpoch === work.fence.anchorEpoch（类型层专型不替代 wire 运行时强制），
// conversation 信封保留 anchor / local 两变体的结构合法性（本地域会话语义）。任何缺字段、跨域、错基线、错 epoch / assignment / executor、数组混入异域 capability →
// executor 在写 `received`、签发数据面票据与 started **之前**以 `dispatch-rejected` 耐久拒收（禁止降级执行）；
// owner 按既有 AssignmentTerminationProof 路径关闭旧 assignment、吊销凭证、终结租约后重排。
// **owner 派发原子流水线（顺序冻结）**：① `matchManifest` 先行，失败不创建任何候选；② `prepareAssignmentRoot` 与凭证签发器只在内存构造
// AssignmentResourceLease / AuthorityCapability / ControlLease / PermissionSnapshotLease 候选；③ 组装 DispatchEnvelope 并过 `validateDispatchBinding`；④ artifact 先 fsync；
// ⑤ AuthorityCommitLog 在一个串行临界区复验 governor 配额与 assignment 当前性，再以**同一 CommitEnvelope / 单次 fsync**写 governor `reserve` + run/job `assigned`。
// 第⑤步是 owner 侧三类 assignment 凭证的唯一激活点：resource guard 要求 reserve 与 assigned.reservationId/attempt/activation.assignmentId 全等；capability guard
// 要求自身 capId 位于 assigned.capIds 且 assignmentId / executorId 全等；permission guard 要求自身规范摘要等于 assigned.permissionLeaseDigest，且 assignmentId / executorId 全等。owner 随后从该 CommitEnvelope
// 确定性构造 `AssignmentActivationPayload` 后签发 proof；assigned outbox 发送 DispatchEnvelope + proof。executor 侧唯一激活点是两者全验后 fsync 的 `received.activation`，本地三类 guard 只读该证明。
// 第⑤步前失败或崩溃只留下可按保留窗 GC 的未引用 artifact，零有效凭证、零 reservation；第⑤步后任一点崩溃均由 assigned outbox 重建 proof 并重驱。

interface ConversationDispatch { t: "conversation"; runId: string; conversationId: string;
  ownerEpoch: number; baseRevision: number;
  ingress: IngressContext;                       // 随派发传递——StreamFrame.meta.turnOrigin 与工具执行期来源语义取自此，不另立来源
  windowInput: WindowInput;
  controlContext: Array<{ source: string; block: string }> }    // owner 侧 run 瞬态贡献，经 injectUserContext 注入

interface JobDispatch { t: "job"; jobRunId: string; taskId: string;
  fence: JobCommitFence; instruction: JobExecutionInstruction }  // job 无 conversation 语义字段

interface JobExecutionInstruction { kind: "agent-turn"; prompt: string; model?: string; tools?: string[] }
// 派发只携去敏执行指令：自 TaskDefinition.definition 的 agent-turn action 派生（model / tools 原样约束执行），
// 零投递字段、零路径与秘密。system action 任务不派发——内置维护 handler 恒在锚点本地执行；
// 投递（channel / webhook）恒由锚点按冻结 deliveryPlan 在提交后执行，url / headers（SecretRef）不上派发 wire。

type WindowInput =
  | { t: "full";  windowEpoch: number; messages: Message[] | { ref: ArtifactRef } }
  | { t: "delta"; baseEpoch: number; baseDigest: Digest; targetEpoch: number; targetDigest: Digest;
      appended: Message[] };
// executor 在 started 之前原子校验 delta 基线：本地缓存 (conversationId, baseEpoch, baseDigest) 命中才应用，
// 应用后校验 targetDigest；任一不符返回 missing-base 拒收（此时必未 started）——owner 据账本证明未启动，
// 以【新 assignment】改发 full。appended 超过内联阈值（§4.2）时 owner 直接改发 full。
```

```ts
interface JobCommitFence { taskId: string; jobRunId: string; scheduledFor: IsoTime; taskRevision: number;
  deliveryPlanDigest: Digest; anchorEpoch: number; assignmentId: string; executorId: string; digest: Digest }   // digest 按 §1.2 JobCommitFence 自摘要
type TaskDefinitionBody =
  | { kind: "user";   spec: ScheduleTaskSpecDto;
      origin?: DeliveryTargetDto; interactionResponder?: ChannelResponderRef; createdInTurn?: string }
          // 三者均为只读来源字段：创建时锚点自 IngressContext / 渠道认证结果生成；interactionResponder 仅渠道入口存在，
          // 与 origin 共同约束定时 job 的确认应答者；schedule-update 不得覆盖，wire 白名单外
  | { kind: "system"; handler: SystemHandlerId; params?: JsonValue };      // host-only：仅锚点装配注册；不经 mutation、不进用户 schedule-list
interface TaskDefinition { taskId: string; taskRevision: number; definition: TaskDefinitionBody; state: "enabled"|"disabled"|"deleted" }
interface JobOccurrence  { taskId: string; jobRunId: string; scheduledFor: IsoTime; taskRevision: number;
  deliveryPlan: { planDigest: Digest; delivery: TaskDeliveryDto };   // 触发时刻冻结的投递配置快照（类型层已 secret-free）；仅锚点持有，不上派发 wire——
  state: JobRunState }                                               // DeliveryIntentDto 由锚点按此快照 + 结果内容在 CAS 内构造
// plan 生成规则（触发时刻、锚点纯函数）：spec.delivery 显式且非 none → 用之；否则 definition.origin（`DeliveryTargetDto`，§1.3b）
// 存在 → { kind:"channel", channel: origin.channelId, to: origin.to, threadId: origin.threadId }
//（"默认回发创建入口"的既有语义，线程语境保真）；两者皆无 → { kind:"none" }（结果仅入任务状态，不外发）。
```

### 5.3 能力、版本与匹配

```ts
interface CapabilityDescriptor {         // 稳定能力，低频变化
  executorId: string; revision: number; protocolVersion: string;
  workspaces: Array<{ bindingRef: string; workspaceBindingRevision: number; displayName: string }>;
  tools: string[]; mcpServers: string[];
  credentialBindings: CredentialBindingDescriptor[];
  evidenceCapabilities: EvidenceKind[]; at: IsoTime; signature: Signature }

interface ExecutorVersionInventory {     // 高频版本清单，绑定 capabilityRevision
  executorId: string; inventoryRevision: number; capabilityRevision: number;
  configVersions: { runtimeConfigRev: number; modelProfileRev: number; policyRev: number };
  assetVersions: { skillsRev: number; rubricsRev: number; promptAssetsRev: number };
  permissionSnapshotHighWater: number;   // 已就绪权限快照序列的单调高水位（见下"版本匹配两层语义"）——非当前唯一权限态；
                                         // 与 manifest 的精确引用语义不同，类型层刻意不同名，禁止并入任何等值比较谓词
  credentialBindingRevisions: Array<{ bindingId: string; revision: number }>;
  at: IsoTime; signature: Signature }

interface CredentialBindingDescriptor { bindingId: string; service: string; resource?: string;
  principalFingerprint?: Digest; tenant?: string; scopes?: string[];
  verification: "service-verified"|"user-alias"; revision: number }

interface ExecutionManifest {
  baseRef: { execution: "conversation"; conversationId: string; baseRevision: number }      // 派发时刻冻结的会话基线，与 work / 提交栅栏同值
         | { execution: "job";          taskId: string; jobRunId: string; taskRevision: number };   // 判别化——空 base / 双 base 类型层不可构造
  protocolVersion: string;
  requires: ExecutorVersionInventory["configVersions"] & ExecutorVersionInventory["assetVersions"]
          & { permissionSnapshotVersion: number };
  // 六类继承字段是签发时冻结的设备当前代际，按当前值相等匹配；permissionSnapshotVersion 是本次 assignment 冻结引用的
  // 权限快照版本（恒等于 permissionLease.snapshotVersion），按 version ≤ inventory.permissionSnapshotHighWater + digest 命中
  // 匹配——与 inventory 侧高水位刻意不同名，类型层杜绝再次被统一进等值循环（见下"版本匹配两层语义"）
  tools: string[]; mcpServers: string[];
  environment: EnvironmentRequirement;
  credentialBindings: Array<{ service: string; bindingId: string; revision: number }>; digest: Digest }   // digest 按 §1.2 ExecutionManifest 自摘要

interface EnvironmentRequirement { deviceId?: string;
  workspace?: { deviceId: string; bindingRef: string; workspaceBindingRevision: number };
  // workspace 存在时其 deviceId 为目标设备单源；顶层 deviceId 若同时出现必须与之相等，否则反序列化拒绝
  // 真实路径永不上 wire；revision 由 owner 在**选机时刻冻结**（取自最近 CapabilityDescriptor.workspaces）——一次执行从选机到
  // started 恒用同一 binding revision：executor 在 started 前重新 resolveWorkspace + probePath 复验，revision 漂移（绑定已改路）
  // 或状态失效（missing 之外的硬拒态）→ 以未启动拒收（dispatch-rejected，revision-conflict 族），owner 重排或询问用户
  credentialBindings?: Array<{ service: string; bindingId: string }>; evidenceKinds?: EvidenceKind[] }

// 跨机目录探测协议（workscene 管理面"目录探测在目标 executor"的可调用承载——远程 setWorkdir 由此履约）：
interface EnvironmentControlGrant { grantId: string; deviceId: string; bindingRef: string;
  methods: ["environment.probe"]; requestId: string; issuedAt: IsoTime; expiry: IsoTime; signature: Signature }  // 锚点签发、短租约、越设备 / 绑定 / 时限拒绝
interface WorkspaceProbeRequest { requestId: string; deviceId: string; bindingRef: string;
  grant: EnvironmentControlGrant; at: IsoTime }
interface WorkspaceProbeResult  { requestId: string; bindingRef: string; workspaceBindingRevision: number;
  probe: "directory"|"missing"|"non_directory"|"inaccessible"|"error";   // 沿 workscene 既有五态；结果幂等（重复 requestId 回放）
  executorId: string; signature: Signature }     // absolutePath 永不出现在任何 wire 对象
// workscene-create / set-workdir 准入：锚点先经 probe 取目标设备结果，按 workscene 既有策略裁决（missing 软提示"下次进入自动创建"、
// non_directory / inaccessible / error 硬拒），通过才提交逻辑绑定（{deviceId, bindingRef}，revision 由目标设备探测时递增维护）。
```

**匹配函数唯一**：`matchManifest(manifest, descriptor, inventory) → ok | AuthorityError("revision-conflict"|"capability-gap")`——owner 选机用最近 inventory 预判、executor 开跑前原子复验，两处共用同一实现；任一失配拒绝执行，owner 重排或排队。职责分界：matchManifest 只管**版本与能力**匹配；派发的**域一致性**归 `validateDispatchBinding`（§5.2）；权限引用资产的实际命中是账本步骤（见下）。owner 为避免产生无用候选，顺序固定为 `matchManifest → 构造候选 → validateDispatchBinding → 原子激活`；executor 已收到完整信封与证明，顺序固定为 `validateAssignmentActivation → validateDispatchBinding → matchManifest → 权限引用资产按 digest 验签命中 → received`。两端使用同一 match/binding 函数，远端只额外验证 owner 激活证明。

**版本匹配两层语义**：matcher 按执行时真实消费的对象把 manifest 需求分为两层，归层判据唯一——执行体消费 executor **当前装配值**的字段进设备代际层，消费 assignment **自带冻结引用**的字段进引用层；未来新增版本字段必须按同一判据归层，禁止把引用层字段并入当前值相等谓词。

- **设备代际层**（protocolVersion、tools、mcpServers、runtimeConfigRev、modelProfileRev、policyRev、skillsRev、rubricsRev、promptAssetsRev、workspace binding revision、凭据 binding revision）：执行体将使用 executor 当前装配的这些事实，故必须与当前 descriptor/inventory 逐项相等；任何真实变化使在途 assignment 拒收、owner 按新基线重排——这是预期 fail-safe，不是误杀。
- **权限引用层**（`requires.permissionSnapshotVersion`）：它与 `permissionLease` 的 `snapshotVersion/snapshotDigest` 从签发时刻的同一 `TrustRuleSnapshot` 派生，标识本次 assignment 自带冻结的不可变权限资产；执行期安全判定只消费该引用资产，不消费设备"当前"权限。matcher 对它判定**引用有效**：版本不高于 `inventory.permissionSnapshotHighWater` 即通过，不要求与当前值相等；版本高于高水位判 `capability-gap`——executor 尚未就绪该资产，属可恢复缺口，排队等待资产同步或 inventory 推进后唤醒重试，不判 `revision-conflict`、不触发换基线重排。executor 在 received 前必须按 lease 的 `snapshotDigest` 实际取到本地保留的该历史快照并验签命中：资产缺失判 `capability-gap` 拒收，digest 不符或验签失败按完整性破坏硬拒。received 前的任何拒收都是 executor 账本的耐久终态——owner 据拒收证明关闭原 assignment（superseded）并重新排队，资产补齐或 inventory 推进后以**新 assignment** 重派，绝不复用已拒收的 assignment；重派是新的签发时刻，权限引用按重派时刻的当次语境快照重新投影（规则未变时经同内容幂等自然复用原引用）。

由此单 executor 同时承载多个会话各自冻结的权限快照：任一会话的权限变化只发布新快照并推进高水位，既不影响其它在途 assignment 的引用有效性，也不得抬升设备代际层任何版本。

**能力快照同步纪律**：`CapabilityDescriptor` 与 `ExecutorVersionInventory` 作为同一设备签名的元数据快照发布，必须同 executor、同签名设备且 `descriptor.revision === inventory.capabilityRevision`；`EnvironmentRequirement.deviceId` 与该签名设备身份匹配，不与可独立命名的 executor 身份混同。manifest 的独立 `protocolVersion`、tools、MCP、凭据与七类版本均由同一 matcher 按上述两层语义核对，协议版本为 uint64 范围内的规范正十进制字符串并与 mesh 协商共用同一校验谓词；job instruction 的 tools 必为 manifest.tools 子集。所有集合型字段按规范 JSON 字符串码元序冻结排序；credential bindingId 在每个集合内全局唯一，workspace binding revision 为正整数。

owner 目录耐久绑定 executorId 与获授权设备谱系，只接受原版本语义重放或 `inventoryRevision` 严格前进的更新，拒绝同版本内容改写、任一配置/资产/权限/凭据 revision 回退。凭据 bindingId 的同 revision 语义身份不可改写，删除后保留高水位墓碑，重建必须提高 revision。目录恢复时状态缺失或损坏 fail-closed；版本源显式耐久“首次引导未完成/目录已建立”标记，只有前者可建立空目录，目录接受首份快照后才将标记推进为已建立，故任一崩溃点可恢复且已建立目录丢失绝不静默重建。查询时复核当前设备信任，撤销或角色移除立即失效，换设备只经显式谱系迁移。`at` 与签名可在语义内容不变时刷新。

executor 仅在对应配置、资产与真实签名 `TrustRuleSnapshot` 已本地就绪后发布 inventory；`inventory.permissionSnapshotHighWater` 声明该 executor 已就绪权限快照序列的**单调高水位**——每份新快照由权限快照目录单调分配版本，同内容（规范化后同 digest）幂等复用已发布的版本与快照、只有规则内容变化才分配新版本；高水位只供 owner 预选粗筛，引用资产的权威判定恒是 received 前的 digest 验签命中。manifest requirement 与 `PermissionSnapshotLease` 的 version/digest 恒从签发时刻的同一快照派生，双域派发在 received 前按该 digest 实际验证引用资产。inventory 任一字段（含权限高水位）变化都必须以严格前进的 `inventoryRevision` 重发。规则按 id 规范排序并投影为 `PortableTrustRule`：缺省可选字段省略，移除本机展示路径与 `lastMatchedAt` / `matchCount` 可变命中统计；已被在途 assignment 引用的历史签名快照必须耐久保留并可在重启后按 digest 补读——本节先按全保留执行，权限租约激活登记在途引用后收敛为引用感知保留，跨机补读由资产同步协议承载。目录不承载内容与秘密，跨机内容传输仍归资产同步协议。

单机最小发布器以当前非秘密运行配置、可执行版本、已装配能力与 binding 元数据及 SecretStore 当前提交代际共同形成聚合快照摘要——**权限规则不进入该摘要**：权限内容变化只经权限快照目录发布新快照并推进 `permissionSnapshotHighWater`，不得抬升设备代际层任何 revision；反之设备代际变化也不重签已发布的权限快照。凭据内容与该不透明代际必须在 SecretStore 同一协调快照内原子读取，凭据代际只是本地非秘密不透明标识，秘密内容及其摘要均不进入该摘要或任何协议面。未经服务核验的 `user-alias` bindingId 必须绑定发布设备身份；只有用户显式确认的别名映射才能建立跨设备等价。同摘要重启复用原 revision 与生成时刻，任一输入变化（包括恢复到历史内容或同 binding 下凭据轮换）均分配新的单调 revision，再以该 revision 发布当前设备代际层配置、资产与能力基线。版本源与能力目录仅允许二者均缺失的首次初始化；任一已建立而另一方缺失均 fail-closed，只有明确标记的首次建档中断可续建。后续按类别细分同步源时只细化设备代际层各字段 revision 的生产者；权限引用层合同（独立单调版本序列、高水位声明与 digest 命中判定）与 inventory、目录、matcher 的两层匹配合同保持不变。

### 5.4 提交（conversation / job 两套 CAS 事务模板，只共享栅栏验证、幂等键与 artifact 在场检查）

```ts
interface SealedBundle { assignmentId: string; executorId: string; digest: Digest;
  streamFinal: { finalSeq: number; streamDigest: Digest };   // epoch 不入终态对账——它只是连接 fencing（§5.6），对账凭 seq + 链头
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
  usageFinal: { reportDigest: Digest; upToUsageSeq: number };   // 最终 UsageReport 锚：锚点账本据此对账收敛，缺报可催
  dependencyArtifacts: ArtifactRef[];   // 必填（无传递依赖 = []）：body 直接 root（runRecord / mutationBatch / contentAssets）
                                        // 解引用后的传递闭包，减去 root 后恰等对账；contentAssets 不重复入列且仍保留自身治理语义；
                                        // root ∪ dependency 上传恒先于提交，CAS 逐一验在场（§4.2）
  body: ConversationCommitBundle | JobCommitBundle }

interface ConversationCommitBundle { t: "conversation"; runId: string; conversationId: string;
  ownerEpoch: number; baseRevision: number;
  runRecord: TranscriptRunRecord | { ref: ArtifactRef };
  windowCompact?: WindowCompactInstruction;                     // 幂等缓存更新指令，非权威件
  contentAssets: ContentAssetRef[];
  mutationBatch?: { ref: ArtifactRef; sessionCount: number; globalCount: number } }

interface JobCommitBundle { t: "job"; jobRunId: string; taskId: string; fence: JobCommitFence;
  outcome: { status: "completed"|"failed"; summary: string };   // executor 只交结果内容——零投递目标、零队列状态字段
  contentAssets: ContentAssetRef[];
  mutationBatch?: { ref: ArtifactRef; sessionCount: 0; globalCount: number } }

type ContentAssetRef = ArtifactRef & { kind: "image"|"file"|"tool-output"|"window-snapshot" };
```

- **conversation CAS**：先按 §1.2 复算 `SealedBundle.digest` 与全部引用目标，再验栅栏全字段（ownerEpoch / assignmentId / baseRevision / executorId / digest）；该 assignment 有打开的 `dispatch-conflict(opened-uncertain)` fact 则 fence-rejected（不属于“合法 bundle”）→ 按 §4.2 提取并验 `rootArtifacts ∪ dependencyArtifacts` 全闭包已耐久在场（缺件拒绝）→ 同一 CommitEnvelope 原子写入：run 流 `committed`、会话元数据变更、内容资产索引、`publish-decision`、`FinalOutboxRecord(pending)`；仅当本 run 的耐久 `ingress.kind === "channel"` 时，再构造 `DeliveryIntentDto.endpoint = { kind: "channel", target: ingress.replyTarget }`，向 delivery 流写一条使用 §1.1 `conversation-final-delivery` 键的 `enqueued`。CAS 即不可回滚的返回线性化点；transcript/window、staged publishing 与实时 final 均为耐久待办驱动的派生步骤，失败不得把 committed 重分类为失败，必须进入同进程持续恢复及重启重放。final 只在 transcript 历史可读后发布；消费者仍须对历史暂未就绪和瞬时读取失败有界退避重试。`windowCompact` 投影失败由 transcript 重建。
- **job CAS**：先按 §1.2 复算 `SealedBundle.digest`、`JobCommitFence.digest` 与全部引用目标，再验 fence 全字段（含 `deliveryPlanDigest` 与 occurrence 冻结 plan 一致）；该 assignment 有打开的 `dispatch-conflict(opened-uncertain)` fact 则 fence-rejected → 按 §4.2 验 `rootArtifacts ∪ dependencyArtifacts` 全闭包在场 → 同一 CommitEnvelope 原子写入：job 流 `committed`、任务投影变更、`delivery` 流逐项 `enqueued`——**由锚点按 occurrence 冻结的 `deliveryPlan` + bundle 结果构造不可变 `DeliveryIntentDto`，并在此唯一分配 itemId / idempotencyKey**（executor 对投递目标与生命周期零写权；job 权威与 delivery 流同属锚点物理 log，单 envelope 原子结构性成立）、`publish-decision`（仅 global 计数；conflicted 明细入该 occurrence 的观测投影并经维护通知呈现——job 无 FinalFrame 载体）。现有 DeliveryItem / 队列只由 delivery 流投影，不参与 CAS；job 不产生 FinalOutbox（结果经投递队列通知）。
- 重复 / 迟到提交按幂等键返回原 `commitRevision` / `jobRevision`。

### 5.5 终态与状态投递

RunJournal 为最终事实源；FinalOutbox 是"权威提交 → 实时通知"的有界桥：以 `(conversationId, runId, commitRevision, digest)` 向发布时刻已认证的同会话 observer 幂等推送 `FinalFrame`，不维护逐 surface 耐久确认；外部渠道按 `turnOrigin` 走 DeliveryOutbox，禁止跨渠道广播。渠道 turn-slot 在对应权威 final/status item 耐久接管后只能由 DeliveryAuthority 的 fill 或明确空终态关闭，入口 `finally` 不得提前 abandon；从而所有 `afterSlot` 消息恒在 final/status 之后。断线重连与新 surface 以 last-seen `commitRevision` 从 owner 历史对账补终态。

**第一方 RPC 耐久身份与重连合同**：客户端须在调用前分配稳定 operationId（当前 wire 的 `turnId`），响应丢失只允许以完全相同的请求参数重试；受理响应必须返回 owner 分配的权威 `runId`，后续 abort、status、final 与历史补读均以该 `runId` 为主体，禁止用 operationId 代替。连接断开只撤销 observer 与在线能力，不隐式取消已准入 run；取消只能由携新 requestId 与明确 runId 的耐久控制请求触发。重连时先恢复订阅，再从各 run 的 last-seen revision 分页补读至续读游标为空并去重；实时通知与补读共同决定本地 waiter 的唯一终态。

**非 committed 状态的通知与裁决闭环**（committed 之外的每个终态 / 挂起态都可实时获知、断线补读、合法裁决恰一次）：

```ts
type ResolutionActionSet = ["verify-side-effects", "abandon", "retry-risk-ack"];
interface StatusNoticeBase<R, S, A extends [] | ResolutionActionSet> {
  ref: R; state: S; reason?: string; statusRevision: number; actions: A; at: IsoTime }
type ConversationUncertainClosure =
  | { closedBy: "late-bundle-committed"; resultingState: "committed" }
  | { closedBy: "proven-not-started-redispatched"; resultingState: "queued" }
  | { closedBy: "user-verified-side-effects"; resultingState: "failed" }
  | { closedBy: "user-abandoned"; resultingState: "cancelled" }
  | { closedBy: "user-retry-acknowledged"; resultingState: "queued" };
type JobUncertainClosure = ConversationUncertainClosure
  | { closedBy: "proven-not-started-cancelled"; resultingState: "cancelled" };
type ConversationStatusNotice =
  | (StatusNoticeBase<Extract<ExecutionRef, { execution: "conversation" }>, "uncertain", ResolutionActionSet> &
     { openFactDigest: Digest })
  | (StatusNoticeBase<Extract<ExecutionRef, { execution: "conversation" }>, "uncertain-closed", []> &
     { openFactDigest: Digest } & ConversationUncertainClosure)
  | StatusNoticeBase<Extract<ExecutionRef, { execution: "conversation" }>, Exclude<ConversationRunState, "committed"|"uncertain">, []>;
type JobStatusNotice =
  | (StatusNoticeBase<Extract<ExecutionRef, { execution: "job" }>, "uncertain", ResolutionActionSet> &
     { openFactDigest: Digest })
  | (StatusNoticeBase<Extract<ExecutionRef, { execution: "job" }>, "uncertain-closed", []> &
     { openFactDigest: Digest } & JobUncertainClosure)
  | StatusNoticeBase<Extract<ExecutionRef, { execution: "job" }>, Exclude<JobRunState, "committed"|"uncertain">, []>;
type DeliveryStatusRef = { execution: "delivery"; itemId: string }; // attempt / anchorEpoch 均不参与身份；迁居前后 revision 序属于同一稳定 item
type DeliveryStatusNotice =
  | (StatusNoticeBase<DeliveryStatusRef, "delivery-uncertain", ResolutionActionSet> &
     { attempt: number; anchorEpoch: number; openFactDigest: Digest })
  | (StatusNoticeBase<DeliveryStatusRef, "delivery-failed", []> & { attempt: number; anchorEpoch: number })
  | (StatusNoticeBase<DeliveryStatusRef, "delivery-resolved", []> & {
      attempt: number; anchorEpoch: number; openFactDigest: Digest; decision: DeliveryResolutionFact["decision"] })
  | (StatusNoticeBase<DeliveryStatusRef, "delivery-uncertain-closed", []> &
     { attempt: number; anchorEpoch: number; openFactDigest: Digest } &
     ({ closedBy: "late-sent" | "late-retry-scheduled" }
      | { closedBy: "late-failed"; error: DeliveryFailure })); // 迟到结果自动关闭 uncertain（4.3 行 9/10/11）——撤销裁决号召；纯投影，由 sent / retry-scheduled / failed 权威记录确定性投影，零新增权威记录。late-failed 独家承载终态与脱敏失败信息（error = failed 记录的 error），不另发 delivery-failed
type ExecutionStatusNotice = ConversationStatusNotice | JobStatusNotice | DeliveryStatusNotice;
```

- **实时**：状态转移落 journal 的同一 CommitEnvelope 内写可确定投影 notice 的全部字段；surface 经 owner 控制事件收全部状态 notice。run/job 为渠道来源时，仅**非 committed 终态与 uncertain 挂起态**的转移在同 envelope 按 §1.1 的 conversation/job status 分支以本次 `statusRevision` 向原渠道 DeliveryOutbox 入队——committed 由结果投递承载，queued / dispatched / running / cancel-requested 等中间转移不外发渠道（仅 surface 可见）；job `missed` 虽为终态亦不逐条外发，由 scheduler 接入时的 missed 汇总通知承载（执行计划第 26 项）。delivery 自身失败/unknown 不递归向同一 item 入队，而是推送当前已认证维护 surface 并由 server.info 持久补读；因此通知路径失败不会制造第二个投递事实。
- **版本**：每个 `ExecutionRef` 的 run / job journal `state.statusRevision` 与每个稳定 `DeliveryStatusRef(itemId)` 的 `statusRevision` 均从 1 开始、每次实际状态转移严格 `+1`；初始 queued 与 admitted / occurrence、delivery enqueued 与其权威输入各在同一 envelope 写入。attempt 与 anchorEpoch 变化均不换 delivery revision 序；notice 另携当前 anchorEpoch 供控制请求 fencing。幂等重放同一转移不增号，notice 与补读投影只能取该耐久值，不得另行计数；每条状态转移恒投影至多一条 notice（同一 `statusRevision` 不得产生多条），保证标量 last-seen 游标补读与实时等价、零跳失。
- **补读**：`server.info` 与历史查询按 `statusRevision` 提供状态投影——断线重连以 last-seen statusRevision 对账，与 FinalFrame 补读同构。
- **裁决**：`uncertain-resolve` / `delivery-resolve` 控制请求（§5.1）由对应工作权威处理；guard 验已认证用户 + 当前 epoch + subject / attempt + `openFactDigest` 等于打开中的 fact 摘要——重复请求回放原结果，旧 epoch / 旧 fact / 已关闭 fact 拒绝；resolution fact、状态转移与 control `applied` 合入同一原子提交（6.1 行 24-26 / 6.2 行 26-28 / delivery 流的 wire 承载）。

- **可执行通知**：携 `ResolutionActionSet` 的 notice 必须独立提供对应控制请求除新建 `requestId` 与已认证 principal 外的全部字段；conversation / job 从 `ref` 取得主体与当前 epoch，delivery 从 `ref + attempt + anchorEpoch` 取得，三域均直接携当前打开 fact 的 `openFactDigest`，surface 不得查询私有投影或自行复算摘要。action 到 decision 的映射固定为：conversation / job 的 `verify-side-effects / abandon / retry-risk-ack` → `user-verified-side-effects / user-abandoned / user-retry-acknowledged`；delivery 的同三 action → `user-verified-sent / abandon / retry-risk-ack`。
- **run / job 关闭配对**：uncertain 的任一合法出边均以同一 `openFactDigest` 产生恰一 `uncertain-closed` notice；`closedBy` 取耐久 resolution kind，`resultingState` 取同 envelope 的权威后继状态。该 notice 替代该 revision 的普通状态 notice，故每个 `statusRevision` 仍至多一条；即使后继为 committed 也不得因 committed 平时由 FinalFrame / 结果投递承载而省略本关闭通知。history 与 live 必须从同一耐久 resolution + state 事实投影。
- **关闭配对**：`delivery-uncertain` 打开的 fact 一旦关闭，恰产生一个关闭通知——用户裁决产生 `delivery-resolved`，迟到结果自动关闭产生 `delivery-uncertain-closed`（`closedBy` 指明去向）；未裁决且无迟到结果的 fact 合法地保持打开（§4.5 不回收）。`sent` / `retry-scheduled` / `failed` 记录的 notice 投影判定单源：关闭打开中 uncertain 的（4.3 行 9/10/11）投影为对应 `closedBy` 的 `delivery-uncertain-closed`（`late-failed` 独家承载脱敏失败信息）；非关闭路径中 `failed`（行 5）投影 `delivery-failed`，`sent` / `retry-scheduled`（行 3/4）零 notice——送达以消息本体为通知、内部重试不打扰用户。同一 `statusRevision` 恒至多一条 notice，标量 last-seen 游标补读零跳失。补读以 `openFactDigest` 配对打开与关闭；收到关闭通知后对应裁决动作作废，迟到裁决请求按旧 fact 拒绝（既有裁决 guard 承载）。

**渠道外发文案模板（冻结；外发状态必须在本表有模板行，新增状态先补表后外发）**：`{reason}` 取 notice.reason 的脱敏摘要、缺失时省略整个冒号子句；`{taskName}` 取冻结任务定义 spec.name 的上述有界展示投影；模板为最终产品文案，实现不得另造或改写。

| 外发状态 | conversation 渠道文案 | job 渠道文案 |
|---|---|---|
| cancelled | 本次运行已取消。 | 定时任务「{taskName}」已取消。 |
| failed | 本次运行失败：{reason}。 | 定时任务「{taskName}」运行失败：{reason}。 |
| expired | 本次请求未能开始执行，已过期。你可以重新发送。 | 定时任务「{taskName}」本次未能开始执行，已过期；后续计划不受影响。 |
| uncertain | 本次运行结果不确定，需要你裁决处理方式。 | 定时任务「{taskName}」结果不确定，需要你裁决处理方式。 |
| 控制回执（空批量取消） | 当前没有正在处理的任务。 | —（job 无渠道批量取消面） |

### 5.6 run stream

```ts
// 带外事件白名单投影：封闭判别联合（判别符 = 事件名），白名单外事件不上 wire、验证端拒绝未知判别符。
// 透传组 payload 即 AgentEventMap 对应事件的小 payload 原样；两个裁剪组显式列字段（诊断级大 payload 永不上 wire）。
type ProjectedPassthroughEvent =
  | "agent:run_start" | "agent:run_end" | "context:tokens_snapshot"
  | "retry:attempt" | "retry:success" | "retry:exhausted"
  | "segment:transition_start" | "segment:emergency_floor" | "segment:transition_failed"
  | "interrupt:warn" | "interrupt:fired"
  | "security:steward_review" | "security:rule_sedimented"
  | "lifecycle:hook_failed" | "lifecycle:warning" | "lifecycle:prompt_rebuilt"
  | "orchestration:validation_failed" | "orchestration:run_start" | "orchestration:node_start"
  | "orchestration:node_end" | "orchestration:run_end";
type SessionEventProjection =
  | { [K in ProjectedPassthroughEvent]: { event: K; payload: AgentEventMap[K] } }[ProjectedPassthroughEvent]
  | { event: "llm:request_start";   payload: { model: string; messageCount: number; hasTools: boolean } }
  | { event: "segment:new_started"; payload: { segmentId: string; bufferTurns: number; tokensBefore: number; tokensAfter: number } };

type StreamFramePayload =
  | { kind: "agent-yield"; yield: AgentYield }
  | { kind: "agent-event"; event: SessionEventProjection }
  | { kind: "interaction"; event:                            // 确认交互的数据面下行——总纲"确认交互就近传输"的载体半边：
        { t: "requested"; requestId: string; toolName: string;
          display: { title: string; lines: string[] } | { ref: ArtifactRef };
          issuedAt: IsoTime; ttlMs: number; expiresAt: IsoTime }
      | { t: "finished";  requestId: string; outcome: "allowed"|"denied"|"cancelled"|"expired" } }
      // assignment 流 interaction-requested / interaction-finished 落盘后的确定性投影，复用同一 seq / spool / 续流纪律；
      // 全部 observer 可见（旁观面只读呈现"确认进行中 / 已解决"）；allow-once 仅接受原始 surface ticket 或定时 job 的 owner 签名 channel grant；
      // 单机形态下既有 ConfirmationBridge 即本分支的进程内适配器。验收（随 S6）：直连 / 中继 / 重放零伪 pending、旁观越权拒绝、取消竞态收束。
  | { kind: "provisional-final"; finalSeq: number; streamDigest: Digest };
interface StreamFrame { ref: ExecutionRef; assignmentId: string; streamEpoch: number; seq: number;
  payload: StreamFramePayload;   // ref 统一 conversation / job 两域——job 帧同样可观察（现状任务确认与进度回渠道的能力不退化）
  meta: { lineage?: string; turnOrigin?: TurnOrigin } }
interface FinalFrame  { conversationId: string; runId: string; commitRevision: number; digest: Digest;
  publishConflicts?: number }   // 本 run 全局写冲突条数（§4.4 逐条终审）；>0 时 surface 提示、明细经控制事件
type StreamConsumerAuth =
  | { kind: "surface-ticket"; ticketId: string }
  | { kind: "owner-relay"; authority: Extract<AuthorityEpochRef, { execution: "job" }>; controlLeaseId: string }; // 只认证本次操作；relay 水位身份是 assignment + authority，不随 lease 轮换
interface StreamSubscribe { ref: ExecutionRef; assignmentId: string; consumer: StreamConsumerAuth; afterSeq: number }
interface StreamAck       { assignmentId: string; consumer: StreamConsumerAuth; ackSeq: number }
```

消费方守卫与耐久中继：`surface-ticket` 验票据的 ref / assignment / principal / expiry；`owner-relay` 仅适用 job，且只允许当前 assignment 的 owner-control principal，`authority` 必须与 ref epoch 同构、`controlLeaseId` 对应当前有效 ControlLease。owner-relay 的逻辑水位键固定为 `(assignmentId, authority)`，ControlLease 续签 / 换连接不重置；owner 重连先以新 lease **幂等重发** job 流最新 `channel-relay-cursor.upToSeq` 的 StreamAck（覆盖“本地已 fsync、ACK 丢失”窗口），executor 接受后才允许 `afterSeq = upToSeq + 1` 的订阅；任一消费方请求跳过未 ACK seq 均拒绝。owner 收到 interaction requested 帧时，先验 `expiresAt = issuedAt + ttlMs`，再按 §1.1 把 `issuedAt + TTL` 换算为本地单调 deadline，token expiry 不得更晚；并必须在**同一 CommitEnvelope**写 `channel-challenge-prepared` 与推进后的 `channel-relay-cursor`，fsync 成功后才回 StreamAck。此后渠道发送失败 / owner 崩溃只重驱 challenge outbox，不再依赖 executor spool；重复外发携同一签名 token，任一 callback 最终只产生一份 grant。finished 帧同理先写 `channel-challenge-closed + cursor` 再 ACK；其他帧至少先推进耐久 cursor（需要渠道呈现时同时落对应投影）再 ACK。上述 relay 记录只是投影运输与 callback 关联，pending / finished 权威仍唯一在 executor assignment 流。

游标与回收语义（机械口径）：`seq` 在 **assignment 全生命周期绝对单调且逐帧连续**（跨重连、跨路径切换不重置）；`streamEpoch` 只作旧连接 fencing（重连 +1，旧 epoch 帧被拒），不参与去重——路径切换零丢帧零重帧由单调 seq 单独保证。`provisional-final` 是该 assignment 的最后一帧，固定占用 `seq = lastDataSeq + 1`（无数据帧时为 1），其 payload.finalSeq 必须等于自身 `StreamFrame.seq`；此后禁止再产帧。`SealedBundle.streamFinal.finalSeq` 与该值相等，ACK / 重放 / spool 水位均包含这张收尾帧。
**streamDigest 摘要域（冻结）**：增量哈希链**只覆盖数据帧**（payload kind = agent-yield / agent-event / interaction）——`D0 = H("zhixing:stream:v1" || assignmentId)`，每个数据帧按实际 seq 计算 `Dnext = H(Dprev || JCS({ seq, payload, meta }))`（JCS 沿 §1.2）；`provisional-final` 虽占用 seq 并参与 ACK / 重放，却是**链外收尾帧**，携带最后数据帧链头（空流即 D0）、自身不入链，循环定义结构性不存在。**显式排除** `streamEpoch`、`ref`、传输层头与连接态字段——同一逻辑帧换路径 / 换 epoch 摘要不变，收尾帧与 `SealedBundle.streamFinal` 可跨端机械核对。executor 在 spool 持久保存当前链头（崩溃恢复续算不重扫）。验收：路径切换前后摘要不变、数据帧逐字段篡改必失配、空流 finalSeq=1、收尾帧 seq / payload.finalSeq / bundle.finalSeq 三者不等即拒、收尾帧 ACK 后方可回收（随 S6）。executor 先写有界耐久 event spool（上限 64 MiB / assignment，超限背压至 run 暂停产帧；初值，S6 标定）再发送；重放恒从该消费方水位 +1 起。回收：assignment 终态且全部有效 surface 票据已 ack 至 finalSeq 或已失效，并且 owner-relay 已 ack 至 finalSeq 后，进入 24h 回收窗；owner-relay 不因 ControlLease 轮换 / 短暂过期丢失逻辑水位。owner 长期不可达时，只有在 assignment 已终态、assignment 流全部 interaction 均 finished 且 24h 回收窗届满后才可关闭未完成 relay——此后 owner 以 queryLedger / interaction mirror 恢复终态，不会遗失可应答 pending。滞后超过有界窗（初值 spool 上限的 1/2，S6 标定）的 surface observer 不再续票、明确降级到 owner 终态对账（§5.5 last-seen revision 路径），**禁止拖停 run 或阻塞快 observer**。大对象不入帧、经 ArtifactRef 引用。

interaction requested 的 `display` 在写 assignment 流前由共享 preparation 原语一次性确定 inline-or-ref 形态；assignment 记录、StreamFrame 与摘要链复用同一规范对象，任何执行点不得再次内联或独立重算表示。

### 5.7 取证与止损

```ts
interface EvidenceRequest { requestId: string; reviewId: string; runId: string; conversationId: string;
  ownerEpoch: number; executorId: string;
  workspace: { bindingRef: string; workspaceBindingRevision: number };
  items: Array<{ kind: EvidenceKind; locator: EvidenceLocator; digestHint?: Digest }>;
  lease: ResourceLease;                  // workload.kind="evidence"、workload.id=requestId、parentId=review lease、
                                         // audience 绑本 executor——入口统一 lease guard 先行
  issuedAt: IsoTime; expiry: IsoTime; signature: Signature }
interface ObservationToken { observedAt: IsoTime; preStateFingerprint: Digest; postStateFingerprint: Digest; consistent: boolean }
interface EvidenceBundle { requestId: string; requestDigest: Digest; observation: ObservationToken;
  items: Array<{ kind: EvidenceKind; locator: EvidenceLocator; contentDigest: Digest; summary: string; source: "independent" }>;
  executorId: string; signature: Signature }
interface ExecutionAbortRequest { assignmentId: string; ref: ExecutionRef;
  ticket: Extract<DataPlaneTicket, { kind: "abort" }>; reason: string; at: IsoTime }
```

取证语义：executor 以有界幂等 journal 按 requestId 回放同一 bundle；`consistent=false` → `typed-stale`，重试 ≤ 2 次后保持 deferred；无快照文件系统只承诺"当前状态可核验观测"，要求历史精确快照判 `capability-gap`。

## 六、状态机转移表（一行一当前态一触发一次态；逐行生成测试，禁止合并）

### 6.1 conversation run

```ts
type ConversationRunState = "queued"|"dispatched"|"running"|"cancel-requested"
  |"committed"|"cancelled"|"failed"|"expired"|"uncertain";
```

| # | 当前态 | 触发 | 守卫 | 次态 | 动作 |
|---|---|---|---|---|---|
| 1 | queued | 派发决定 | `matchManifest` 通过 → 候选 lease / capability / permission 组装完毕 → `validateDispatchBinding` 通过 | dispatched | DispatchEnvelope artifact 先 fsync；随后**同一 CommitEnvelope**原子写 governor `reserve` + run `assigned`（dispatchRef / permissionLeaseDigest / capIds / reservation）并激活 owner 侧凭证；assigned outbox 确定性重建 ActivationPayload、签发 proof，驱动二元组至少一次发送 |
| 2 | queued | owner 选机预判 revision-conflict / busy | 存在其他候选或可等待 | queued | 重排 / 排队并告知（尚未创建 assignment） |
| 3 | queued | owner 选机预判 capability-gap 且无候选 | 用户放弃或不可恢复 | failed | 告知缺口（尚未创建 assignment） |
| 4 | queued | cancel | — | cancelled | owner 原子取消 |
| 5 | queued | 排队超策略时限或所需能力永久消失 | 无用户干预 | expired | 通知发起面，可一键重发（重发 = 新 run；expired 为终态） |
| 6 | dispatched | executor 上报 started / 返回 `SupersedeProof(already-started)` | started 记录或证明验签并绑定当前 assignment / 账本链头 | running | 保留原 assignment，禁止重派 |
| 7 | dispatched | 合法 bundle CAS 通过（started 上报丢失 / 乱序） | 栅栏全验 + artifact 在场 | committed | 发布 mutation、落 FinalOutbox |
| 8 | dispatched | executor 签发 `DispatchRejectionProof`（如 missing-base / revision-conflict） | 证明逐字段验签且对应账本 `dispatch-rejected` | queued | 同 envelope 写 `assignment-superseded` + 吊销 capIds 与活跃 tickets + 终结旧租约（§十）；按原因重选或以新 assignment 改发 full |
| 9 | dispatched | 派发超时，supersede fence 取得 `SupersedeProof(not-started-fenced)` | 证明验签 + 账本链头（queryLedger 快照**不算**——查询后仍可开跑） | queued | 同 envelope 写 superseded + 吊销 capIds 与活跃 tickets + 终结旧租约；新 assignment 重派（fence 先于 dispatch 到达 = tombstone，迟到 dispatch 永久拒） |
| 10 | dispatched | 派发超时，fence 无响应 / 返回不可验证证据 | — | uncertain | 开 resolution（cause: ledger-unknown）；**禁止新 assignment** |
| 11 | dispatched | cancel | — | cancel-requested | 记 cancel-fence 并下发 |
| 12 | running | CAS 通过 | 栅栏全验 + artifact 在场 | committed | 发布 mutation、落 FinalOutbox |
| 13 | running | cancel | — | cancel-requested | 记 cancel-fence 并下发 |
| 14 | running | executor 崩溃 / 失联 | 账本 started 无 sealed | uncertain | cause: ledger-unknown |
| 15 | cancel-requested | CancelProof(owner-fence, not-started) | 逐字段验：签名 + assignment / executor / epoch / 当前 fence / 账本链头；cancel-requested 入边来自 dispatched（来自 running 则与已见 started 矛盾） | cancelled | 按 §十终结表结算租约 |
| 16 | cancel-requested | CancelProof(owner-fence, halted) | 同 15 逐字段验，且全部 effect 已闭合 | cancelled | 同上 |
| 17 | cancel-requested | CancelProof(abort-ticket, not-started) | 验签 + 票据归属 + assignment / epoch / 账本链头全验；cancel-requested 入边来自 dispatched | cancelled | 双取消源竞态收束；按 §十终结表结算 |
| 18 | cancel-requested | CancelProof(abort-ticket, halted) | 同 17，且 abort-requested 先于 bundle_sealed、全部 effect 闭合 | cancelled | 双取消源竞态收束；按 §十终结表结算 |
| 19 | cancel-requested | 账本见 abort-ticket abort-requested 但无可接受 halted | abort / sealed 序不可证或存在未闭合 effect | uncertain | cause: cancel-unproven |
| 20 | cancel-requested | bundle_sealed 先于全部已观察 abort-requested（owner-fence / abort-ticket） | 账本 recordSeq 可证 | committed | 封包赢，照常提交 |
| 21 | cancel-requested | 证明与 cancel-requested 入边历史矛盾 / 超时 / 失联 | — | uncertain | cause: cancel-unproven |
| 22 | uncertain | 迟到合法 bundle 到达 | CAS 全验（打开的 dispatch-conflict fact 会 fence-rejected，故不属于本行“合法”） | committed | 自动解析，与总纲“合法 bundle 自动提交”一致 |
| 23 | uncertain | 事后取得 `AssignmentTerminationProof` | 证明验签并绑定当前 assignment / executor / dispatch digest、supersede fence 或 cancel fence/ticket 及账本链头；owner 全部 durable-started 投影均为 false；dispatch-conflict 仅接受严格后继 received 前缀的 Cancel(not-started) / Supersede(not-started-fenced)，拒绝 DispatchRejection | queued | 同 envelope superseded + 吊销全部 capability / ticket + 终结旧租约；dispatch-conflict 分支另写携同一 proof 的 contained + resolution(`proven-not-started-redispatched`)；自动重派（新 assignment） |
| 24 | uncertain | 用户裁决：已核验副作用 | 经 `uncertain-resolve` 控制请求（§5.5：已认证用户 + epoch + openFactDigest 全验，重复回放） | failed | 同 envelope 记 fact、以 `fact.subject.assignmentId` 关闭旧提交栅栏、吊销其 capability/ticket、终结租约、转状态并 applied；解锁对话 |
| 25 | uncertain | 用户裁决：放弃本次 | 同 24 | cancelled | 同 24 收束旧 assignment，解锁对话 |
| 26 | uncertain | 用户裁决：明示风险后重试 | 同 24 | queued | 同 24 收束旧 assignment 后，才以新 attempt 创建 assignment |
| 27 | queued | 显式目标设备离线 / 暂无在线匹配候选 | 缺口可恢复（非永久 capability-gap） | queued | 耐久等待；首次进入时一次性提示"目标电脑离线，任务已排队，开机后继续"；设备上线或 CapabilityDescriptor / inventory 变化即唤醒重试派发；出口 = 行 4 取消 / 行 5 过期 |
| 28 | dispatched | owner 恢复，账本见 CancelProof(abort-ticket, not-started) | 验签 + 票据归属 | cancelled | 记 fact（surface 止损）；按 §十终结表结算 |
| 29 | dispatched | owner 恢复，账本见 CancelProof(abort-ticket, halted) | 验签 + 票据归属；abort-requested 先于 bundle_sealed 且全 effect 闭合 | cancelled | 记 fact（覆盖 started 上报丢失）；按 §十终结表结算 |
| 30 | dispatched | owner 恢复，账本见 abort-requested 但无可接受 halted | abort / sealed 序不可证或存在未闭合 effect | uncertain | cause: cancel-unproven（sealed 先于 abort 则走行 7 照常提交——封包赢） |
| 31 | running | owner 恢复，账本见 CancelProof(abort-ticket, halted) | 验签 + 票据归属；abort-requested 先于 bundle_sealed 且全 effect 闭合 | cancelled | 记 fact（surface 止损）；按 §十终结表结算 |
| 32 | running | owner 恢复，账本见 CancelProof(abort-ticket, not-started) | owner 已耐久见 started，证明与当前态矛盾 | uncertain | cause: cancel-unproven |
| 33 | running | owner 恢复，账本见 abort-requested 但无可接受 halted | abort / sealed 序不可证或存在未闭合 effect | uncertain | cause: cancel-unproven（sealed 先于 abort 则走行 12 照常提交——封包赢） |
| 34 | dispatched | 收到 `DispatchConflictProof` | proof 全验；conflicting 侧全等本次发送；accepted 侧全等本地 assigned 重算值 | dispatched | 同一 CommitEnvelope 写 `dispatch-conflict(acked-original) + dispatch-acked`；停止 outbox，原 assignment 继续；重复 proof 幂等回放 |
| 35 | dispatched | 收到 `DispatchConflictProof` | proof 全验；conflicting 侧全等本次发送；accepted 侧与本地 assigned 重算值任一不等 | uncertain | 同一 CommitEnvelope 写 conflict + uncertain fact/state + cancel-fence + cap/ticket revoked；停止派发与 ControlLease 续期，fsync 后重驱 cancel/吊销止损；通知用户，仅凭 conflict proof 禁止提交/重派；后续 not-started 证明或用户裁决按行 23–26 收束 |
| 36 | uncertain | dispatch-conflict 止损取得 `CancelProof(halted)` | proof 全验并绑定当前 fence 或有效 abort-ticket；账本链严格后继于 conflict 的 received 前缀；全部 interaction / effect 闭合，finished interaction 已按 §3.7 签名连续批次完成 audit settlement | uncertain | 写 `dispatch-conflict-contained`，停止 cancel outbox；保留打开 fact 与提交 fence，向用户呈现证据，租约待裁决时按 §十收束 |

附加规则：uncertain 存在未裁决 → 该对话禁止正常续跑（行 22/23 的自动解析除外）。行 8/9/15/17/23/28/32 的任何 not-started 证据一旦与 owner durable-started 投影矛盾，统一留在 uncertain 并写按 proofKind 隔离的 `not-started-rejected`，不得因恢复重放降格为 queued/cancelled。

### 6.2 job run（本表仅适用 `TaskDefinitionBody.kind:"user"`；system 任务走 6.2b，两表互斥）

```ts
type JobRunState = "queued"|"dispatched"|"running"|"cancel-requested"
  |"committed"|"cancelled"|"failed"|"expired"|"missed"|"uncertain";
```

| # | 当前态 | 触发 | 守卫 | 次态 | 动作 |
|---|---|---|---|---|---|
| 1 | —（触发） | 到点 / 手动 job-run | task enabled 且无同 task 在途 occurrence（现役 queued 由行 8 过期让位后照常入队） | queued | 写 occurrence（绑当时 taskRevision / 冻结 deliveryPlan） |
| 2 | —（触发） | 到点触发 | 同 task 存在未裁决 uncertain 或已派发在途 occurrence（dispatched / running / cancel-requested） | missed | 只记 missed，不补跑 |
| 3 | queued | 派发决定 | `matchManifest` 通过 → 候选 lease / capability / permission 组装完毕 → `validateDispatchBinding` 通过 | dispatched | 与 6.1 行 1 同构：artifact 先 fsync；同一 CommitEnvelope 原子写 governor `reserve` + job `assigned`（含 permissionLeaseDigest）；重建 ActivationPayload、签发 proof 后发送二元组 |
| 4 | queued | 锚点选机预判 revision-conflict / busy | 存在候选或可等待 | queued | 重排 / 排队（尚未创建 assignment） |
| 5 | queued | 锚点选机预判 capability-gap 且无候选 | 不可恢复 | failed | 告知缺口（尚未创建 assignment，经维护通知） |
| 6 | queued | task 删除 / 禁用 | — | cancelled | — |
| 7 | queued | job-cancel | — | cancelled | 锚点原子取消 |
| 8 | queued | 排队超策略时限（如下一次 occurrence 已到点） | — | expired | 记录；后续 occurrence 照常（system 任务的合并规则在 6.2b） |
| 9 | dispatched | executor 上报 started / 返回 `SupersedeProof(already-started)` | started 记录或证明验签并绑定当前 assignment / 账本链头 | running | 保留原 assignment，禁止重派 |
| 10 | dispatched | 合法 bundle CAS 通过（started 上报丢失 / 乱序） | JobCommitFence 全验 + artifact 在场 | committed | 锚点按冻结 plan 构造 delivery `enqueued` intent，同 envelope 原子入流 |
| 11 | dispatched | 取得 `DispatchRejectionProof` 或 `SupersedeProof(not-started-fenced)` | 证明验签并绑定当前 assignment / executor / digest 或 fence / 账本链头（快照不算；CancelProof 不走本行） | queued | 同 envelope写 superseded + 吊销全部 capability / ticket + 终结旧租约；新 assignment 重派 |
| 12 | dispatched | 派发超时，fence 无响应 / 返回不可验证证据 | — | uncertain | cause: ledger-unknown；暂停该 task 触发；禁止新 assignment |
| 13 | running | CAS 通过 | JobCommitFence 全验 + artifact 在场 | committed | 锚点按冻结 plan 构造 delivery `enqueued` intent，同 envelope 原子入流 |
| 14 | running | executor 崩溃 / 失联 | 账本 started 无 sealed | uncertain | 暂停该 task 触发 |
| 15 | dispatched | task 删除 / job-cancel | — | cancel-requested | 记 cancel-fence 并下发 |
| 16 | running | task 删除 / job-cancel | — | cancel-requested | 记 cancel-fence 并下发 |
| 17 | cancel-requested | CancelProof(owner-fence, not-started) | 逐字段验：签名 + assignment / executor / epoch / 当前 fence / 账本链头；cancel-requested 入边来自 dispatched | cancelled | 按 §十终结表结算租约 |
| 18 | cancel-requested | CancelProof(owner-fence, halted) | 同 17 逐字段验，且全部 effect 已闭合 | cancelled | 同上 |
| 19 | cancel-requested | CancelProof(abort-ticket, not-started) | 验签 + 票据归属 + assignment / epoch / 账本链头全验；cancel-requested 入边来自 dispatched | cancelled | 双取消源竞态收束；按 §十终结表结算 |
| 20 | cancel-requested | CancelProof(abort-ticket, halted) | 同 19，且 abort-requested 先于 bundle_sealed、全部 effect 闭合 | cancelled | 双取消源竞态收束；按 §十终结表结算 |
| 21 | cancel-requested | 账本见 abort-ticket abort-requested 但无可接受 halted | abort / sealed 序不可证或有未闭合 effect | uncertain | cause: job-cancel-unknown；暂停该 task 触发 |
| 22 | cancel-requested | bundle_sealed 先于全部已观察 abort-requested（owner-fence / abort-ticket） | 账本 recordSeq 可证 | committed | 封包赢，照常提交 |
| 23 | cancel-requested | 证明与 cancel-requested 入边历史矛盾 / 超时 / 失联 | — | uncertain | cause: job-cancel-unknown；暂停该 task 触发 |
| 24 | uncertain | 迟到合法 bundle 到达 | CAS 全验（打开的 dispatch-conflict fact 会 fence-rejected） | committed | 自动解析，恢复该 task 触发；与总纲“合法 bundle 自动提交”一致 |
| 25 | uncertain | 事后取得 `AssignmentTerminationProof` | 证明验签并绑定当前 assignment / executor / dispatch digest、supersede fence 或 cancel fence/ticket 及账本链头；锚点全部 durable-started 投影均为 false；dispatch-conflict 仅接受严格后继 received 前缀的 Cancel(not-started) / Supersede(not-started-fenced)，拒绝 DispatchRejection | queued / cancelled | 同 envelope superseded + 吊销全部 capability / ticket + 终结旧租约；dispatch-conflict 分支另写携同一 proof 的 contained；task 仍 enabled 时 resolution(`proven-not-started-redispatched`) 后自动重派，已禁用或删除时 resolution(`proven-not-started-cancelled`) 后终结 |
| 26 | uncertain | 用户裁决：已核验副作用 | 经 `uncertain-resolve` 控制请求（§5.5，同 6.1 行 24 守卫） | failed | 同 envelope 记 fact、以 `fact.subject.assignmentId` 关闭旧提交栅栏、吊销其 capability/ticket、终结租约并 applied；恢复触发 |
| 27 | uncertain | 用户裁决：放弃本次 | 同 26 | cancelled | 同 26 收束旧 assignment；恢复触发 |
| 28 | uncertain | 用户裁决：明示风险后重试 | 同 26 | queued | 同 26 收束旧 assignment 后，才以新 attempt 创建 assignment；恢复触发 |
| 29 | queued | 显式目标设备离线 / 暂无在线匹配候选 | 缺口可恢复（非永久 capability-gap） | queued | 耐久等待；一次性维护通知；设备上线或能力 / inventory 变化即唤醒重试派发；出口 = 行 6/7 取消 / 行 8 过期 |
| 30 | dispatched | 锚点恢复，账本见 CancelProof(abort-ticket, not-started) | 验签 + 票据归属 | cancelled | 记 fact；按 §十终结表结算 |
| 31 | dispatched | 锚点恢复，账本见 CancelProof(abort-ticket, halted) | 验签 + 票据归属；abort 先于 sealed 且全 effect 闭合 | cancelled | 记 fact（覆盖 started 上报丢失）；按 §十终结表结算 |
| 32 | dispatched | 锚点恢复，账本见 abort-requested 但无可接受 halted | abort / sealed 序不可证或有未闭合 effect | uncertain | cause: job-cancel-unknown（sealed 先于 abort 走行 10 照常提交） |
| 33 | running | 锚点恢复，账本见 CancelProof(abort-ticket, halted) | 验签 + 票据归属；abort 先于 sealed 且全 effect 闭合 | cancelled | 记 fact；按 §十终结表结算 |
| 34 | running | 锚点恢复，账本见 CancelProof(abort-ticket, not-started) | 锚点已耐久见 started，证明与当前态矛盾 | uncertain | cause: job-cancel-unknown |
| 35 | running | 锚点恢复，账本见 abort-requested 但无可接受 halted | abort / sealed 序不可证或有未闭合 effect | uncertain | cause: job-cancel-unknown（sealed 先于 abort 走行 13 照常提交） |
| 36 | dispatched | 收到 `DispatchConflictProof` | proof 全验；conflicting 侧全等本次发送；accepted 侧全等本地 assigned 重算值 | dispatched | 同一 CommitEnvelope 写 `dispatch-conflict(acked-original) + dispatch-acked`；停止 outbox，原 job 继续；重复 proof 幂等回放 |
| 37 | dispatched | 收到 `DispatchConflictProof` | proof 全验；conflicting 侧全等本次发送；accepted 侧与本地 assigned 重算值任一不等 | uncertain | 同一 CommitEnvelope 写 conflict + uncertain fact/state + cancel-fence + cap/ticket revoked；停止派发与 ControlLease 续期，fsync 后重驱 cancel/吊销止损；暂停 task、维护通知；仅凭 conflict proof 禁止提交/重派，后续 not-started 证明或用户裁决按行 25–28 收束 |
| 38 | uncertain | dispatch-conflict 止损取得 `CancelProof(halted)` | proof 全验并绑定当前 fence 或有效 abort-ticket；账本链严格后继于 conflict 的 received 前缀；全部 interaction / effect 闭合，finished interaction 已按 §3.7 签名连续批次完成 audit settlement | uncertain | 写 `dispatch-conflict-contained`，停止 cancel outbox；保留打开 fact 与提交 fence，向用户呈现证据，租约待裁决时按 §十收束 |

任务定义规则：更新只影响后续 occurrence；旧 occurrence 永不覆盖或复活 TaskDefinition。外层 `TaskDefinition.state` 是任务启停的唯一权威；user definition 复用的 `spec.enabled` 仅作兼容投影，必须与外层状态严格一致（enabled 对应 true，disabled / deleted 对应 false），矛盾定义在落盘前拒绝。禁用取消尚未派发的 queued occurrence，但不取消已派发 occurrence；删除取消全部在途 occurrence——queued 原子转 cancelled；dispatched / running 同 envelope 写 cancel-fence + cancel-requested；**uncertain 占用**若其当前 assignment 尚无停止栅栏，同一 task-revision CommitEnvelope 原子建立唯一 cancel fence（`requestId="task-revision:<rev>"`）、状态保持 uncertain、打开的 resolution fact 保留（删除不伪装成已证明取消），已有栅栏则幂等复用零追加；其后 bundle / proof 仍按账本顺序裁决，not-started 在 deleted 定义下按上句关闭为 cancelled。每 task 任一时刻至多一个非终态 occurrence：到点时现役 occurrence 仍在 queued 则按行 8 过期让位，已派发（dispatched / running / cancel-requested）则只记 missed、不补跑。uncertain 解析前该 task 持续暂停，期间到期只记 missed；若取得 not-started 证明时任务已禁用或删除，同 envelope 以 `proven-not-started-cancelled` 关闭 fact 并转 cancelled，不得重新排队。行 9/10/17/19/25/30/34 的任何 not-started 证据一旦与锚点 durable-started 投影矛盾，统一留在 uncertain 并写按 proofKind 隔离的 `not-started-rejected`，不得自动重派或取消。

### 6.2b system job（`kind:"system"` 内置维护任务——锚点本地执行，不进派发协议 / 数据面 / uncertain 三分）

```ts
interface SystemJobFence { taskId: string; jobRunId: string; scheduledFor: IsoTime; taskRevision: number;
  anchorEpoch: number; handler: SystemHandlerId; paramsDigest: Digest;
  reservationId: string; attempt: number }       // 持租身份入 fence——租约终结与重驱语义的锚
```

| # | 当前态 | 触发 | 守卫 | 次态 | 动作 |
|---|---|---|---|---|---|
| 1 | —（触发） | 锚点时钟到点 / host principal 的内部触发 | task enabled；**surface 的 job-run / job-cancel 对 system 定义一律 unauthorized**（固定 id 可猜不构成入口） | queued | 写 occurrence；错过按"至多合并一批"记 missed |
| 2 | queued | 本地执行开始 | `prepareSystemJobRoot` 候选通过 scheduler-class 准入复验（不变量 18 无例外） | running | **同一 CommitEnvelope 原子写：governor `reserve` + job 流 running 态 + `SystemJobFence`**（lease.activation.jobRunId、workload.id、fence.jobRunId / reservationId 全等）——该提交才激活租约，不存在无归属窗口 |
| 3 | running | handler 完成 | handler 为封闭枚举内的幂等实现 | committed | 同一 CommitEnvelope 原子写：job 状态 + governor `settle` + `release`；结果入 `lastSummary` 类观测投影（isInternal，不进用户视图） |
| 4 | running | handler 抛错 | — | failed | 同一 CommitEnvelope：job 状态 + `settle` + `release`；记错误；下一 occurrence 照常触发 |
| 5 | running | 锚点崩溃恢复发现 running 无终态 | fence 所记租约仍有效 → 复用续跑；已过期 → `reclaim` 后重取新租约、attempt+1、写新 fence | running | 同 `jobRunId` 幂等重驱（handler 幂等是 `SystemHandlerId` 准入契约），不进 uncertain |
| 6 | queued | task 删除 / 禁用（host 路径） | — | cancelled | —（queued **恒不持租约**——reserve 与 running 同 envelope 落定，行 2；无租约可释放） |

system job 无 assignment、无 manifest / capability、无 CancelProof——执行体与权威同进程，fence 兼作幂等、审计与持租锚；资源准入经锚点 governor 的 scheduler-class 租约，与 user job 共用同一治理面。资源协调器必须向在线生产端与完整/轻量重放端提供同一纯绑定断言：初次 activation 精确绑定 reserve 与新 fence，替换精确绑定旧 fence reclaim + 新 fence reserve，terminal 精确绑定当前 fence、outcome、settle + release；任意 foreign record 的存在不能替代逐字段验证，缺协调器时含 system 执行记录的重放 fail-closed。**全部租约终结动作（settle / release / reclaim）幂等且随所属状态转移同 envelope 落定，正常路径零"依赖过期回收"**。

### 6.3 AuthorityTransfer

| # | 当前态 | 触发 | 守卫 | 次态 | 动作 |
|---|---|---|---|---|---|
| 0a | —（无 transfer） | 收编发起（重连）/ 计划迁居发起（用户） | subject 无进行中 transfer；发起方为当前权威 | prepared | 双端各写 `prepared` |
| 0b | —（无 transfer） | 灾难恢复发起（恢复根授权，源端已丢失） | 无进行中 transfer；恢复根签名有效 | prepared | 仅目标端写 `prepared`（无源端） |
| 1 | prepared | 源端准入关闭 + 在途收束完毕（仅 planned / 收编） | 在途 run 全部终态或已裁决 | frozen | 源端签 `SourceFreezeProof` 落流 |
| 2 | prepared | TransferAbort | 当前权威（DR 为恢复根）签发 | aborted | 源端（如在）原 epoch 恢复准入 |
| 3a | frozen | 目标导入校验通过（planned / 收编） | 与 FreezeProof 的计数 + digest 一致 | imported | 幂等导入（目标端 staging 落流） |
| 3b | prepared | 目标导入校验通过（disaster-recovery） | CheckpointEnvelope 解封成功 + manifest / 分块摘要全验 | imported | 幂等导入（无 frozen 前置——源端不存在） |
| 4 | frozen | TransferAbort | 当前权威签发 | aborted | 源端恢复准入；目标 staging 隔离并幂等清理 |
| 5a | imported | `AnchorTransferCommit(planned)` / `ConversationTransferCommit`（收编）签发 | 当前签发者签名有效；绑定 freezeProofDigest（+ 迁居绑 trustTransitionDigest） | committed | epoch 原子提升；旧端 fencing 生效 |
| 5b | imported | `AnchorTransferCommit(disaster-recovery)` 签发 | 恢复根签名有效；绑定 checkpointEnvelopeDigest、trustTransitionDigest 与 ready 证明 | committed | epoch 原子提升；安全域换代（凭据轮换 + 信任重建）随之启动 |
| 6 | imported | TransferAbort | 当前权威（DR 为恢复根）签发 | aborted | 源端（如在）恢复准入；目标 staging 隔离并幂等清理 |
| 7 | committed | 旧端清理完成（DR 为旧设备隔离 / 擦除确认） | — | tombstoned | 旧端拒写并重定向 |
| 8 | committed | TransferAbort 迟到 | —（不可中止） | committed | 拒绝并记录（逐边可测）；只允许更高 epoch 正向再迁居，epoch 永不回滚 |

### 6.4 设备状态与 UncertainResolution

| # | 当前态 | 触发 | 守卫 | 次态 | 动作 |
|---|---|---|---|---|---|
| 1 | unpaired | 配对完成（offer + join 双向验证） | enroll 事件入 trust 链 | paired | — |
| 2 | paired | 目标角色配置补齐 | — | configured | — |
| 3 | configured | 预检全过 | provider / MCP / channel 就绪 + SecretStore unlocked + protocolVersion 兼容 | ready | — |
| 4 | ready | 预检项失效（如 SecretStore 不可解锁） | — | degraded | 明示缺失项 |
| 5 | degraded | 预检恢复 | — | ready | — |
| 6 | paired | 撤销 | revoke 事件入链（签发者或恢复根） | revoked | 终态；触发 §2.4 收束 |
| 7 | configured | 撤销 | 同上 | revoked | 同上 |
| 8 | ready | 撤销 | 同上 | revoked | 同上 |
| 9 | degraded | 撤销 | 同上 | revoked | 同上 |
| 10 | paired / configured / ready / degraded | domain-reset 生效 | 非签发设备 | pending-reenroll | 连接终止；成员态随 trust 链投影 |
| 11 | pending-reenroll | 重新配对完成（reenroll 事件入链，transcript 验证通过） | 该设备处于 pending-reenroll | paired | 角色与配置经预检恢复走既有行 2-3 |

迁居只接受 ready 目标。UncertainResolution：`open → closed`，出边即 6.1 行 22–26 / 6.2 行 24–28，每次写不可变 fact，绝不伪造 TranscriptRunRecord。

## 七、权威覆盖表（六类 × 转移 / 删除 / 保留 / 备份）

| 类别 | AuthorityTransfer | 删除 | 保留 | 检查点备份 |
|---|---|---|---|---|
| 全局状态与期望配置 | 迁居全量复制（唯一路径） | 各模块既有删除语义（任务删除 = 禁触发 + 取消在途） | 各模块既有 GC；log 记录 27 天（§4.5） | 全量入检查点 |
| 会话状态 | 收编 = 整对话导出导入；迁居随全量 | 对话删除连带（advancement 日志、run 逻辑流、投影，沿既有先例） | transcript 沿模块 27 天分片 GC；log 记录 §4.5 | 全量入检查点 |
| 会话内容资产 | 索引与 artifact 随所属对话转移 | 随对话删除，引用归零物理回收 | 随对话保留窗 | 索引 + artifact 全量入（内容寻址去重） |
| 环境事实与本地秘密 | **永不转移** | 设备移除时本地清退（总纲 §10 三路径） | 设备本地自治 | **永不入** |
| 执行资产 | 迁居随全量（锚点权威侧） | 各资产模块既有语义 | 各资产模块既有语义 | 权威侧入；设备缓存不入 |
| 非权威缓存 | 不转移（目标重建） | 随时可清 | 无承诺 | 不入 |

检查点封装合同（加密面机械可执行，替代"恢复根公钥加密"的模糊表述——签名键不做加密，见 §2.1 双键派生）：

```ts
interface CheckpointEnvelope { v: 1; checkpointId: Ulid; createdAt: IsoTime;
  alg: { kem: "X25519-HKDF-SHA256"; aead: "AES-256-GCM" };   // 默认；S2 供应链评审可替换（alg 显式随信封）
  recipientKeyId: string;                        // 当前备份封装根（recoveryBackupPublicKey）的 keyId
  enc: string;                                   // KEM encapsulated key（发送方临时公钥封装输出）——解封 = enc + 收件私钥 → KEK
  wrappedDek: string;                            // DEK 经 KEK AEAD 封装，nonce 确定性专用：nonceBase 前 64 bit || 0xFFFFFFFF（保留 counter 极值）
  nonceBase: string;                             // 96-bit 基底：逐块 nonce = nonceBase 前 64 bit || uint32(chunk.seq)——
                                                 // 每块唯一且与 DEK 封装 nonce 不相交；块数上限 seq < 0xFFFFFFFF 由校验拒绝
  manifest: { scope: string[]; domainRevisions: Record<string, number>; upToLsn: number;
    purpose: { kind: "periodic" } | { kind: "root-activation"; plan: RecoveryActivationPlan } };
  chunks: Array<{ seq: number; digest: Digest; bytes: number }>;   // 分块内容寻址，断点续传
  digest: Digest; signature: Signature }         // digest 按 §1.2 CheckpointEnvelope 自摘要；当前锚点签发者签名（真实性与保密性分属两键）
// 加密载荷首块内含一次性 `verificationNonce`（随机 256-bit）——只有真解封才能读出，是 RecoveryCheckpointVerification 的防伪锚（§4.3）。
```

创建即写 `checkpoint` 流记录（§4.3）；周期每日一次 + 迁居前强制一次。**根激活原子边界**：首次 establish / rotate 先生成一条已签名但未生效的 root event；恢复包丢失则先生成连续且均已签名的 `domain-reset + establish` 计划，reset 不得提前单独入链。以候选 `recoveryBackupPublicKey` 生成包含该计划的全量 `CheckpointEnvelope`，耐久写 created，复制到 ≥1 个独立目标；持候选主秘密的引导端必须从该目标实际回读、解封、校验 envelope / manifest / 分块摘要并签 `RecoveryCheckpointVerification`。只有 created→replicated→verification 全链逐字段通过后，锚点才在**同一 CommitEnvelope**原子写入计划内全部 trust event、`checkpoint-verified` 与旧检查点 `checkpoint-superseded`；该提交是新根唯一激活点。rotate / domain-reset 在此之前旧 trust 状态不变，首次 establish 在此之前仍为 no-root / not-ready，任何网格能力不得提前开放。任一前置步骤失败或崩溃只留下未激活候选，可按 checkpointId 幂等续做或 GC，不改变当前根；原子提交后投影必同时得到“当前根 + 对应已验证独立备份”，不存在链上有效新根而备份未验证的窗口。提交响应丢失时，权威端按 checkpointId 从同一日志重建提交与当前 trust 投影并幂等返回，不要求调用方保留旧链头；异内容重试拒绝。旧根封装备份激活后标记不可用，**不假设可 rewrap**。恢复 = 用户主秘密派生封装私钥解 DEK → 校验 manifest / 分块摘要并应用已绑定的 activation plan → 安全域换代（总纲 §9）；恢复端到端验收随 S9（候选创建 / 复制 / 回读 / 签证 / 原子激活各点崩溃注入，伪造 verification、错 checkpoint / key / digest / target / nonce、计划断链、目标不可达重试、新旧根选择）。

## 八、落点矩阵（入口 / 操作 × 落点）

单源生成：本矩阵行集由入口单源清单对账生成——RPC registry（`buildBuiltinRegistry` 全部方法）、命令 registry（cli 各域 `registerXxxCommands` + 技能动态命令，命令最终落到 RPC 或本地渲染）、生命周期注册表（AgentRuntimeLifecycle 四点、SegmentTransitionHook 三点、CleanupRegistry）、渠道入站、执行侧写权威工具。S1 起以覆盖 lint 对账：维护一份机器可读映射表（`registry 方法 / 命令 → 矩阵行 id` 或 `→ 显式"本地渲染、无权威写"排除项`），每个入口**恰好命中一次**——无映射、双映射、映射到不存在的行均 lint 失败；纯本地命令（如 /help、渲染类）只能落排除项、不得缺席。`auth / health` 属连接层，不入本矩阵。

| 操作 | 现有入口 | 准入 / 记账 | 执行 | 权威落点 |
|---|---|---|---|---|
| 会话输入 send | session.send；渠道入站 | 对话 owner（入口幂等 + 串行） | executor（完整 run） | owner CAS |
| run 取消 | session.abort | 对话 owner（cancel-fence） | executor（线性化收束） | owner 落终态 |
| uncertain / 投递裁决 | `uncertain-resolve` / `delivery-resolve` 控制请求（三选呈现经 ExecutionStatusNotice，§5.5） | 工作所属权威（conversation→owner，job / delivery→锚点） | — | resolution fact + 状态转移 + applied 同一原子提交 |
| allow-once 确认 | confirmation.resolve（原始 surface 携 run-interact 票据直连；定时 job 经 owner-relay 耐久游标 + ChannelChallengeToken 回调，携 ChannelInteractionGrant 中继） | executor assignment 事务域 | executor 安全管线 | executor；owner 只持 relay / challenge outbox 与审计镜像 |
| 确认状态读 | confirmation.list | executor assignment 流（pending = `interaction-requested` − `interaction-finished` 差集；经数据面票据直读或 owner 转发） | — | —（读；owner 镜像仅审计，不承载 pending） |
| 事件订阅 / 退订 | session.subscribe / session.unsubscribe | 对话 owner（observer 名册登记 / 注销，连接级） | — | —（连接态，非权威） |
| 全局域列表读 | schedule.list / workscene.list / skill.list；/skills 候选 | 锚点 GlobalQuery 读（与 memory 读行同构） | — | —（读） |
| 持久授权（allow-session / global） | confirmation.resolve 升级路径 | 锚点 control 流 | — | 锚点 permissionStore |
| 信任规则管理 | trust.list / trust.revoke；/trust | 锚点（global-write；读） | — | 锚点 permissionStore |
| 对话创建 / 列表 / 切换 | session.new / session.list / session.resume；/new /resume | owner（session-create；读） | owner 就地 | owner |
| 清空 / 压缩 | session.clear / session.compact；/clear /compact | 对话 owner（session-write window-op） | owner 就地（压缩经 ControlCompletionPort） | owner |
| 改名 / 删除 | session.rename / session.delete；/name | 对话 owner（session-write） | owner 就地 | owner |
| 会话读（历史 / 用量 / 安全 / 预算） | session.history / usage / security / contextBudget；/usage /context | 对话 owner 读（SessionStatePort） | — | —（读） |
| task-list 读写 | session.taskList / taskListUpdate；task_list 工具；/task /tasklist | run 内 staged / run 外 owner session-write | — | 对话 owner |
| 推进闭环（确认 / 修订 / 取消 / 详情） | session.advancement*；/advancement | 对话 owner 控制面 | owner（Completion / ReviewerPort） | owner advancement 日志 |
| workscene 注册管理 | workscene.create / rename / setWorkdir / delete；workscene_* 工具 | 锚点（global-write workscene-*；run 内工具经 staged） | 目录探测在目标 executor（经 WorkspaceProbeRequest + EnvironmentControlGrant，§5.3） | 锚点注册表 |
| workscene 进出 | workscene.enter / exit；/work /exit | 对话 owner（session-meta sceneId） | owner 就地 | owner（会话域绑定） |
| schedule CRUD | schedule.create / update / delete；schedule 工具 | 锚点（global-write）；run 内 staged、离线 DeferredGlobalIntent | — | 锚点 TaskDefinition |
| schedule 手动触发 / 中止 | schedule.run / abortRun；schedule 工具 run | 锚点 job 逻辑流（job-run / job-cancel） | executor（job run） | 锚点 fence CAS |
| schedule 定时触发 | 锚点时钟 | 锚点 job 逻辑流 | executor（job run） | 锚点 fence CAS |
| memory 写 | memory 工具；段切换 flush 钩子 | run 内 staged → 提交后经锚点发布 | — | 锚点记忆域 |
| memory 读 / 统计 | memory.journalStats / peopleList；/journal /people；检索 | 锚点 GlobalQuery | — | —（读） |
| 技能管理 | skill.setState / archive；save_skill / admit_skill 工具；/skills | 锚点（global-write skill-*；run 内 staged create / update / admit） | — | 锚点资产库 |
| 技能使用记录 | 运行时内部 | run 内 staged（skill-usage） | — | 锚点资产库 |
| 段切换与段元数据 | 段钩子（beforeSummarize / afterSummarize / beforeNewSegmentStart） | run 内 staged（segment-append；flush 见 memory 写行） | executor 运行时 | 对话 owner |
| 运行体生命周期钩子（onWindowOpen / onBeforeRun / onAfterRun / onWindowClose） | 运行时装配 | 只读注入，不落权威；写类动作必经端口走对应行 | executor / owner 各自 | —（约束行） |
| 取证 | owner 发起 EvidenceRequest | AdvancementStore 请求态 + lease guard | 目标 executor（只读 provider） | owner 采信入 review |
| 编排子节点 | 执行侧 runtime Task 工具 | 随父 run（子 lease） | executor 进程内 | 随父 run bundle |
| 渠道入站 | feishu `im.message.receive_v1`（message_id 幂等） | 锚点（入口幂等）→ 路由 | 按路由派发 | 对话 owner |
| 渠道出站投递 | DeliveryOutbox drain | 锚点投递队列（delivery 流） | 锚点渠道 adapter | 锚点投递队列 |
| 状态查询 | server.info；/status、zz status | 只读（按 run / job / delivery 的 statusRevision 补读） | 锚点聚合 | —（快照非权威） |
| 轻推理 | llm.complete | owner / 锚点 ControlCompletionPort + control-class lease | owner 设备 | —（不产权威事实） |
| 停机 | server.shutdown（immediate / drain / cancel）；系统信号 | 设备服务生命周期（三路径收束，总纲 §10） | 双端 | 权威保留或转移 |
| 运行配置管理 | /config、/mcp（本地编辑 + reload） | 设备本地配置面；全局期望配置项经锚点资产同步（S4） | 本设备 | 设备本地 / 锚点（按配置类别） |
| 配对 / 迁居 / 撤销 | zz pair；引导流 | mesh / 锚点专用流程（trust 流） | 双端 | HomeTrustRecord / transfer 流 |

## 九、能力矩阵（锚点域会话 × 本地域会话）

| 能力 | 锚点域会话 | 本地域会话（锚点不可达） |
|---|---|---|
| 对话 / run / 取消 / 确认 | 可用 | 可用（owner 就地） |
| task-list、segment、advancement 闭环 | 可用 | 可用（owner-services 同装配；裁判用本机凭据 + 本地域 lease）。**Rubric 契约确认两半拆开**：本任务采用 = 契约快照（snapshotId / contentDigest）落会话 owner 立即生效，不依赖全局 rubricId；保存到全局库 = rubric 型 DeferredGlobalIntent（提示"已用于本任务，连接值班设备后保存"），收编后重校验、冲突交用户裁决 |
| memory 读 | 可用（经锚点） | 资产缓存只读；无缓存明示不可用 |
| memory 写 / 蒸馏 | 可用 | 禁产——收编后由锚点补蒸馏 |
| schedule 注册 / 修改 | 可用 | DeferredGlobalIntent（经 §3.2b 端口落 `intent:<convId>` 流、随对话收编；重校验，timeSensitive 再确认） |
| workscene 注册管理 | 可用（锚点 workscene-* 写） | 不可用（明示；不产生 DeferredGlobalIntent——离线禁产，intent 类型层仅限 schedule 与 rubric 沉淀两域） |
| 技能 / Rubric / prompt 资产 | 可用 | 同步缓存版本只读 |
| 渠道 / 全局名录 / 迁居 | 可用 | 不可用（明示） |
| 内容资产 | owner 治理 ArtifactStore | 本地 owner 治理，随收编转移 |
| 资源治理 | anchor + executor 双半边 | executor 半边 + 本地 governor 签发本地域 lease（不扣全局预算） |
| 锚点域既有对话 | 读写 | 不可写；只读副本可选（无副本明示"需连接值班设备"） |

## 十、资源治理规格

- 层级：顶层 run / job = 根 lease；编排子节点 = 父的有界子 lease（预算 ≤ 父剩余）；推进准入 / 裁判 / 收场 = 独立 control-class 根 lease；取证 = 所属 review lease 的 executor 侧子 lease（EvidenceRequest 直接携带，§5.7）。
- 结算：`consume(usageId)` 幂等累计 → `settle` 单次结算 → `release` 归还余额；expiry 未 settle 由 governor `reclaim`（按已 consume 记账、余额归还）；全部动作落 GovernorRecord（§4.3）。**计量线性化点是每次真实外部调用的响应边界**，协议冻结为"耐久预占 → 消费收束"：①外调前以稳定 `usageId` 落盘 `usage-reserved`（calls 恒占 1，tokens/cost 按请求上限；并发调用各自预占，租约剩余额度不足即拒绝调用）——外部调用是真实副作用，先落盘再外调（§6 纪律）；②每次真实响应以同 `usageId` consume 实际用量，预占差额随之归还；③结果未知（超时、崩溃恢复扫描到未收束的 `usage-reserved`）按预占上限**保守 consume 计终值**，不设事后修正通道——宁多勿少，敞口以预占上限为界。失败、abort 与非 completed 路径先落盘已知 consume 再按终结表收束；run/job 最终水位载体：committed 走 SealedBundle `usageFinal` 对账，其余终态以已落盘 consume 与 UsageReport 水位为准（无可核验水位则 reclaim）。禁止以工具调用计数替代 provider 调用计量，禁止只在成功终态汇总补记。
- **全 workload 租约终结表**（每个 workload kind 的每个终态都有显式终结动作，正常路径零"依赖过期回收"；全部动作幂等）：

| workload | 终结触发 | 动作 |
|---|---|---|
| run / job | committed | owner 收到 SealedBundle `usageFinal` 对账收敛后，settle + release 与 `committed` 记录同 envelope |
| run / job | cancelled **且从未 assigned** | 零租约终结动作——禁止伪造 CancelProof；以 workload 为键的 `dequeue(cancelled)` 与取消记录同 envelope 落盘，移除已有队列项并阻断迟到 enqueue |
| run / job | cancelled **且曾 assigned** | 有合法 CancelProof / usage 水位 → 对账后 settle + release；用户裁决等无可核验水位路径 → reclaim（按已上报 consume 记账、余额归还） |
| run / job | failed / expired **且从未 assigned** | 零租约终结动作——派发前无激活租约；以 workload 为键的 `dequeue(failed|expired)` 与对应终态记录同 envelope 落盘，移除已有队列项并阻断迟到 enqueue |
| run / job | failed / expired **且曾 assigned** | executor 先以 `execution-failed + usageFinal + settle + release` 同 envelope 关闭 clean started assignment；owner 恢复读取该耐久失败事实，核验水位后原子写 capability 吊销、failed 与 anchor settle + release（无可核验水位的失联 / 旧日志才 reclaim） |
| run / job | uncertain → committed / cancelled / failed（裁决） | 按裁决出的终态行执行；迟到 bundle / proof 有水位则对账，无可核验水位则 reclaim，禁止猜测 settle |
| run / job | uncertain → queued（证实未 started 重派） | **旧 assignment 租约先终结**（未 consume 全额 release；失联无对账则 reclaim），新 assignment 以 attempt+1 重取新租约 |
| run / job | uncertain 未裁决 | 挂起不终结；executor 失联超期由 `reclaim` 兜底 |
| system job | committed / failed / cancelled | 见 6.2b（同 envelope settle / release，已冻结） |
| control（准入 / 裁判 / 收场） | 调用返回（成功 / 失败 / abort） | 调用方 finally 内 settle + release——ControlCompletionPort / AdvancementReviewerPort 的调用合同 |
| evidence | EvidenceBundle 交付 / typed-stale 保持 deferred 的终态 | executor 侧子租约 settle + release，随 intake 上报对账 |
| orchestration-node | 节点终态（completed / failed / aborted） | 子租约终结；父租约随所属 run 的行走 |
- 启动与周期恢复按业务归属单一终结：assignment / system-job 根及其子租约只由对应业务恢复所有者在同轮收敛 anchor / executor 双半边，先把未收束预占按上限保守 consume，再写业务终态与资源终结；通用 governor 扫描只回收无业务归属的 control 根及孤儿资源。回收顺序子先于父，重复扫描零重复记账。
- 公平准入：anchor governor 按 `admissionClass` 维护加权队列，调度算法固定为加权差额轮询（WDRR），权重 interactive : advancement : scheduler : orchestration = 8 : 4 : 2 : 1（初值，S7 压测标定）；`queued / dequeue / reserve` 记录承载入队、出队与准入顺序，持续满载场景验证各类均有界获得配额、交互类恒不被自动类饿死。executor 半边做本机硬容量与背压，瞬时容量经独立短租约公告、不进 CapabilityDescriptor。
- **根 lease 候选生命周期**（适用 `prepareAssignmentRoot / prepareSystemJobRoot`。两者在资源端口内按调用 deadline 有界等待 WDRR 候选；瞬时 pending 只触发重试，deadline 到达则返回可识别的延期结果并保留耐久 queued，由所属 run / job 恢复重驱，绝不写业务失败或单独 dequeue。control 类 `acquireRoot` 同样入队、共用同一公平治理面——它是"排队至准入并原子激活"的便捷接口：调用方同步等待，出队即原子 `reserve` 返回激活租约，无候选阶段；排队中放弃或超时以 `dequeue(cancelled|expired)` 单独落盘（无伴随业务终态），激活后终结走 finally 行。"即时激活"仅指其 `reserve` 无需第二个归属事实，不豁免准入）：
  1. **候选身份与重试**：签名候选恒为零权内存对象，prepare 不落租约日志、只对 WDRR 当前可调度队首授予；排他签发权是 governor 进程内**占用态** `(reservationId, 完整候选, expiry)`。同一 workload attempt 的 assignment / reservation 身份必须可稳定重建，禁止因重启或响应丢失改用随机新身份遗弃旧队列项；占用未过期时重复 prepare **幂等返回同一候选**，不重签；workload 重派提高 `attempt` 后才进入新身份。
  2. **过期**：占用短 TTL，过期即释放签发权，队首可重新授予（新候选替换占用、旧候选随之失效）。占用态是可丢弃的调度运行态而非权威事实：reservation 端口只在域内进程装配（§3.4），候选持有者与 governor 同崩溃域、崩溃同灭，恢复 reducer 仅凭耐久流重建 `queued → reserved | dequeued` 投影。
  3. **激活与出队竞争**：`queued` 的耐久出边恰有两条。assignment / system-job 的 `reserve` 提交必须匹配当前未过期候选；control 根在同一 governor 事务内完成队首选择、容量复验、签发和 `reserve`，不得产生候选窗口。业务终态按 workload 身份原子写 `dequeue` tombstone——队列项尚未产生时仍阻断其迟到入队，已 reserve 后则拒绝并改走租约终结表。两者由同一物理日志 append 顺序线性化，先落盘定局。
  4. **调度语义**：占用中的队首使其 admissionClass **类内推进暂驻**、其它类照常调度；占用过期、出队或晋升后类内立即推进——TTL 有限加出队即时，机械保证队首失联后后继有界获准且不外溢阻塞他类。**公平状态（各类差额与队列内容）由 `queued / reserve / dequeue` 耐久序列确定性重建**——恢复后以重建差额继续调度即无漂移；占用暂驻等瞬时决策是运行态、不落日志也不重放（占用窗口内他类先行不消耗队首类差额，无公平损失），公平性由满载与恢复测试共同验收。
- 分域：锚点域根 lease 由 anchor governor 签发；本地域根 lease 由设备本地耐久 governor 签发（绑 `localDomainId / localGovernorEpoch`），只消费本机额度、不授权全局预算；两域同一租约合同与 guard；收编不追认本地消费为锚点预算；双拓扑测试随 S4 / S8 验收。
- 租约时间与重放授权：首次耐久 `reserve` 所在 envelope 的 `at` 是本地域接收时刻；接收端按 §1.1 校验签发者区间并冻结剩余 TTL，进程内只用本地单调 deadline。assignment 资源调用的 capability 同样以 `assigned / received` 所在 envelope 的 `at` 冻结单调 deadline，任一 deadline 到期即拒绝 fresh 写。重启从耐久接收时刻与剩余 TTL 恢复，墙钟回拨不得延长或复活租约/能力。exact durable replay 仍必须通过 principal×method guard、凭证签名、capId 曾在对应 `assigned / received` 中耐久接纳，以及 scope / assignment / executor / lease 静态绑定；只豁免当前激活、吊销和 deadline，命中后零追加返回原结果。
- 状态保留：租约与 capability 的进程内单调 deadline 缓存随所属根终结清退；热投影只保留 active 状态、水位与 §4.5 保留窗内的终态幂等索引，窗外终态根及其子租约、usage、预占与 dequeue tombstone 一并压缩。冷启动与增量重放使用单份事务隔离候选，禁止逐记录复制累计投影；大量终态工作下投影有界、重放近线性，保留窗内 exact replay 语义不变。
- 跨机对账：anchor 域工作在 executor 上的动态子租约与扣账由本地 governor 凭根 lease `delegation` 就地履约（§3.4），`usageSeq` 按根 reservation 一序、随 consume 连续分配；周期 `UsageReport` 经 `ResourceUsageIntake`（§3.7）提交、只推进无缺口水位——run / job 由 SealedBundle `usageFinal` 绑定最终水位收束，evidence 等无 assignment 负载以 intake ack 收束；`usageId` 重复上报零重复计费；delegation 上限即离线窗口的最大敞口，超限本机 guard 直接拒绝。

## 十一、产品旅程脚本（零术语，文案为验收锚）

- **开箱**：安装 → `zz` 即用。零新概念、零恢复概念、零网络配置。
- **扩展**：①新设备装同一个包；②值班候选设备 `zz pair` 出码 → 新设备扫码 / 输码；③首次配对触发恢复包引导——"这是你的恢复码，抄下来放在安全的地方"→ 回读验证 → 通过才继续；④补齐该设备凭据——"知行需要在这台设备上登录模型服务"→ ready；⑤指定值班——"哪台设备长期开机？让它值班"。一条引导线，无分叉。
- **日常**：`/status`："知行在 NUC 值班；这台电脑在场，任务就地执行"。目标离线→"目标电脑离线，任务已排队，开机后继续"；上线续跑→"电脑已开机，继续处理排队的任务"，完成 / 失败通知严格回到发起接入面（绑原 `turnOrigin`，同一任务幂等投递一次，禁止跨渠道广播）；值班失联→"暂时联系不上值班设备。你可以继续在这台电脑上工作（新对话）；以下功能暂不可用：…"；重连→"已恢复连接：离线期间的 2 个新对话已合并，1 个提醒待你确认后生效"。
- **异常**：结果不明→"有一件工作结果待确认"+ 三选："我已核验，结果有效 / 放弃这次结果 / 我了解风险，重新执行"；期间被暂停任务的到期只记跳过，`/status` 可见"有 N 次定时任务因待确认暂停被跳过"，裁决后汇总呈现。设备丢失→"撤销该设备"引导流：撤销 → 列出暴露的外部账号（CredentialExposureRecord）→ 逐项"去 ×× 平台更换密钥"。provisional 输出恒有"待确认"标注，final 后消失。

## 十二、不变量测试口径（总纲 §13 十八条 → 验收形态）

| # | 测试形态 | 判定 |
|---|---|---|
| 1 | 集成：双 owner 并发写同一对话 | 第二写者 fence-rejected |
| 2 | 单元 + 集成：重复 / 迟到提交（两域） | 返回原 commitRevision / jobRevision，记录数不变 |
| 3 | 单元：两域栅栏字段逐一污染 | 任一不符即拒 |
| 4 | 结构 lint：executor 包 import 与实例扫描 | 零全局域 Store 写实例 |
| 5 | 进程级：按角色配置启动 + 端口扫描 | 未启用角色零监听零加载 |
| 6 | wire 审计：全 DTO 模糊采样 + SecretRef 扫描（含 ConfigAssetRecord.value 按 schemaId 校验、TaskDeliveryDto webhook endpoint 仅 SecretRef） | 零秘密明文 |
| 7 | 集成：直连中断切中继；conversation 渠道宿主在 prepared fsync / ACK / 发送、定时 job owner-relay 在 prepared+cursor fsync / ACK / 发送各点崩溃 | seq 连续、零丢零重；frameSeq / cursor 单调，challenge 可重驱且 pending 权威不分叉；两域 token 不可交叉使用 |
| 8 | 单元：id 前缀生成 + transfer 后写入 | 空间不相交；旧 owner 拒写 |
| 9 | 集成：6.1/6.2 uncertain 各入边（含 dispatch-conflict） | 无自动重执行；打开的 dispatch-conflict fact 使 bundle fence-rejected，其他合法迟到 bundle 仍自动提交；对话锁定 / task 暂停 |
| 10 | 单元：matchManifest × inventory 失配矩阵；validateDispatchBinding 类型测试 + wire 逐字段污染（空 / 双 base、跨域、错基线 / epoch / assignment / executor、`resourceLease.audience.executorId` 或 `activation.assignmentId` 缺失 / 错值、混入异域 capability）；ReservableResourceLease 类型负例（裸 run/job、根带 parent、child 冒充 run/job）；AssignmentActivationProof 逐字段篡改、错 owner/epoch、permissionLeaseDigest 缺失 / 错值、capIds 少列/多列/乱序/重复、错 commit 摘要；同 payload 的另一份有效签名；已 received 后重投异载荷，逐字段篡改 / 重放错对象 / 两侧摘要相等的 DispatchConflictProof；以同 assignment / executor 下除 signature 外任一签名载荷字段不同的另一张合法权限租约替换 | 首次坏载荷耐久拒收；同 payload 重签幂等回放原结果；conflict code 恒 idempotency-conflict、retryable 恒 false 且与 response 对齐，message 变化不改变 proof 身份；accepted 侧匹配 assigned 时原子 conflict+ACK、有限次停止派发 outbox；不匹配时 conflict+uncertain+cancel-fence+revocations 原子全有或全无，派发/ControlLease 立即停止；cancel 按同 fence 有界退避至 contained / assignment 关闭，not-started 原子解析并重派，halted 只停止损且保留用户裁决；租约不早释、打开 conflict 时迟到 bundle 不自动提交；无效 proof 零写入并走超时/fence；ConflictProof 永不授权重派；非法组合类型层不可构造；conversation / job 在两种 adapter 下各跑合法派发 |
| 11 | 双拓扑测试套：同套件跑单机 / 分布式 | 全绿 |
| 12 | 结构：AST / 依赖图规则（领域内核零拓扑模式读取）+ 同一 contract conformance 套件分别驱动进程内与 mesh adapter | 规则零违例；两种 adapter 下权威状态与外部事件等价 |
| 13 | 类型 + 集成：ExecutionStatusNotice 非法 ref/state/actions 组合；final 前后 UI；逐个 run/job 非 committed 入边（白名单内原渠道恰一次投递且按冻结文案模板、白名单外零投递、notice 全量可补读）；run / job / delivery 的 actionable uncertain notice 均能独立构造对应 resolve 请求，全部自动与用户关闭出边携同一 openFactDigest 且每个打开 fact 恰一关闭（含 run/job committed 后继）；delivery failed / uncertain / resolved / uncertain-closed；迟到裁决按旧 fact 拒、每 statusRevision 至多一条 notice 且断线重连补读零跳失；attempt / anchor 迁移（迁居后迟到响应按 DeliveryResponseBinding 仍归属原开放 attempt）；五类入队生产者；同一 execution 连续 statusRevision 与 committed 结果交错重放；同 key 注入相同 / 不同 intent；并发同 key；唯一索引查验前 / 查验后 fsync 前 / fsync 后响应前崩溃；重放时推进本地时钟；wire 注入六个禁止自报字段 | 非法组合无法构造；provisional 标注恒在、final 后转正；notice 实时 + 稳定 item statusRevision 单调补读、原渠道唯一投递；仅凭 notice + 新 requestId 即可提交当前裁决，旧 epoch / 旧 fact / 已关闭 fact 拒绝；五类 keyBody 跨 kind / revision 零碰撞且可由 enqueued 独立复算；createdAt 保持来源 envelope 原值；同 key 同 digest 只回放原 item 当前态、异 digest 返回 idempotency-conflict 且整个来源 envelope 零写入；并发 / 崩溃后恰一 item；自报字段全拒；两类 uncertain 三选恰一次生效（重放 / 旧 epoch / 旧 fact 拒） |
| 14 | 依赖图 lint | server ↔ executor 零互 import |
| 15 | 集成：staged 写后 run 失败 / 取消 / uncertain | 外界零可见、零残留；崩溃注入下 publish 可续 |
| 16 | 对抗：越权方法 / 资源 / 过期 capability；五类 principal 各自越权（含非 owner 设备伪造 owner-control、伪造 usage-reporter）；owner-relay 错 authority / lease；渠道 token / grant 伪签、错 challenge / responder / route / assignment / interaction / displayDigest、改 decision、过期与跨域重放；EnvironmentControlGrant 越设备 / 绑定 / 时限 | 全部 unauthorized，进程内同 guard；token / grant 审计记录可独立验签，重复 callback 只回放原结果 |
| 17 | 集成 + 崩溃注入：重投 / 重连 / 权威重启；派发候选签发后、artifact fsync 前后、原子 `reserve+assigned`（含 permissionLeaseDigest）fsync 前后、ActivationProof 生成前后、executor `control-lease-renewed / received` fsync 前后、send / ACK / rejection / conflict response / owner conflict 裁决单 envelope fsync 前后 / containment cancel 发送、executor proof fsync、owner contained / resolution 原子提交与吊销发送前后 / fence 各点，含 ControlLease 旧代 / 错绑定 / 断线未续 / 时钟偏差与墙钟回拨、OwnerControlGrant 错设备 / scope / requestId / 请求正文、重启后同 payload 重签、两类 conflict 响应丢失重试、fence 先到、查询后抢跑与重复 dispatch；system-job 候选与 `reserve+running+SystemJobFence` 同样逐点注入 | 原子提交前零有效凭证、零 reservation，孤立 artifact 可 GC；提交后 ActivationPayload 可由日志确定性重建且权限租约实例不漂移，重签可幂等接受；owner-control 只接受当前派发 owner 对确切请求的授权，控制与权限租约按本地单调 deadline 失效且不可因回拨复活；conflict 两分支重启后分别收敛到唯一 ACK 或唯一 uncertain+止损事实，派发/ControlLease 立即停止；cancel 无 proof 时义务保留且有界退避，not-started 时 contained+resolution+superseded+租约终结全有或全无并安全重派，halted 时唯一 contained、停止 cancel 且仍待用户裁决；零半提交，ConflictProof 永不授权重派；received 前 executor 本地凭证无效、received 后离线可验；reserve 与归属事实恒同时存在并由 assigned/system fence 重驱；至多一次准入、零无日志执行、零双活、零凭证 / 租约泄漏 |
| 18 | 对抗：无 lease / 伪造 / 复用 / 超额 / 重复 usageId / 伪报 admissionClass / 越 delegation 上限的子租约 / 全 workload kind；仅有签名候选、assignment reserve 无同 envelope assigned、capId 未列入 assigned、权限租约摘要未激活或以同 assignment 的另一张有效租约替换、executor 无 received activation / 伪造 activation、system-job reserve 无匹配 SystemJobFence；queued 取消与 uncertain 无水位裁决 | 未激活凭证全部拒绝，其余拒绝或幂等；executor 断开 owner 后仍凭已耐久 proof 正常验权，未要求在线回查；queued 取消只写与业务终态同 envelope 的 workload dequeue tombstone、零租约终结动作，无水位只 reclaim；WDRR 满载下各类有界获得配额，交互不被饿死 |

状态机逐边测试：4.3 delivery 十五行、6.1 三十六行、6.2 三十八行、6.2b 六行、6.3 十二行、6.4 十一行——每行一用例，禁止合并；其中 6.1 行 15–21 / 6.2 行 17–23 必跑 owner-fence × abort-ticket × sealed 三方竞态排列。签名与摘要域验收（§1.2）：逐字段篡改、错误包含自摘要/signature、引用错目标、跨 schema/version 重放、进程内/mesh 固定向量一致性，随 S2。

## 十三、模块文档影响清单（随对应节点修订，不提前改写）

| 文档 | 节点 | 修改内容 |
|---|---|---|
| transcript-persistence-and-attention-window-architecture.md | S3 | TranscriptRunRecord（现 RunRecord）增 runId 唯一键；接受协议改 SealedBundle 整包；windowCompact 明确为幂等缓存指令；写路径经对话 owner 的 AuthorityCommitLog，分片文件成为可由 log 幂等重建的投影（append-only 与"原文唯一权威"性质不变，原子性单元下移一层） |
| 同上 | S7 | MemoryFlush 挂点改为权威提交后经 GlobalStatePort 发布 |
| scheduler-architecture.md（及实现 spec） | S3/S7 | TaskDefinition / JobOccurrence 拆分（definition 分 user 白名单 Dto / system host-only 两族；webhook endpoint 整体 SecretRef；origin / interactionResponder / createdInTurn / system 恒锚点生成）、JobCommitFence（绑 deliveryPlanDigest）、派发用去敏 JobExecutionInstruction、system 任务与投递恒锚点本地执行、job uncertain 暂停语义、定时 job 的 owner-relay / channel challenge outbox、手动触发走 job-run 控制请求；S7 随 scheduler 接入 JobJournal 删除其对 IDeliveryPipeline.enqueue 的直接生产依赖（在此之前旧投递路径保持行为不变），job 结果此后只由锚点 CAS 写 delivery 流 |
| workscene-management-architecture.md | S7 | workdir 升级为稳定设备域引用 `{deviceId, bindingRef}`；每次派发由 ExecutionManifest 冻结当次 `workspaceBindingRevision`（不回写 workscene）；目录探测在目标 executor（WorkspaceProbeRequest / EnvironmentControlGrant 协议）；enter / exit 定性为会话域绑定（session-meta sceneId），注册管理留锚点 |
| task-advancement-rubric-architecture.md | S7 | EvidenceRequest / EvidenceBundle / ObservationToken 替换第一级取证实现描述；裁判经 ControlCompletionPort；review 子 lease；AdvancementSnapshot / AdvancementControlEvent 类型化落点；契约确认拆"快照采用（会话域）/ 库沉淀（全局写，离线转 DeferredGlobalIntent）"两半——confirmDraft 的 saveOwn / updateOwn 归后者。**类型合同（目标形态在此冻结，S7 按此改型）**：`ConfirmedRubricSnapshot` 的库身份改判别 `source: { kind: "library"; rubricId; rubricVersion } \| { kind: "local-draft"; snapshotId: Ulid; contentDigest: Digest }`——现类型（advancement/types.ts:143）强制 rubricId / rubricVersion，离线确认在类型层不可实现；local-draft 分支使契约不依赖全局 id 即可生效，收编沉淀成功后经修订 link 回库 |
| unified-core-and-access-surfaces.md | S1 | 宿主内部拓扑更新为角色装配（五包抽取） |
| message-outbox.md（顺序层） | S3 | delivery-origin OutboxEntry 必带 delivery 流既有 idempotencyKey（其他非耐久消息仍可选），只承接 per-target 顺序，不再承担权威去重 / 生命周期；同 item 重驱复用原键 |
| persistent-service.md（delivery 模块） | S3/S7 | S3 新增 AuthorityCommitLog delivery 流的权威投影 / drain 组件（与既有 queue/pipeline 并存，conversation 域切换后承接渠道回复与状态通知），落实 keyBody/key/intentDigest、串行唯一索引与十五行状态机，同步事件、stats、server RuntimeControlAdapter、CLI setup-delivery 与测试；S7 随 scheduler 接入删除公开生产接口 `IDeliveryPipeline.enqueue(EnqueueParams)` 并退役旧 queue/pipeline——旧 JSON 队列至此退出事实源 |
| agent-runtime-lifecycle.md | S3/S7 | 生命周期写类钩子生效时点对齐"权威提交后触发" |
| 权限模块（permission-architecture-evolution.md） | S4 | TrustRule / TrustRuleSnapshot 类型落地（自现有 PermissionRule 演化）、资产化分发、PermissionSnapshotLease、fail-closed 语义 |
| **本文** | S6 | 回填：用户内容资产的数据面消费协议（surface 下载授权、断点续传、生命周期治理）与 **surface 预上传授权**（control 写依赖闭包的上传半边，绑定 requestId——assignment 域传输已在 §4.2 随 S5 落定）及验收项（含嵌套引用、root / dependency 跨层重复、非规范顺序、少列 / 多列、断点续传、缺件拒绝） |
| **本文** | S10 | 回填：三路径停机收束协议的字段级（新增章节）与验收项 |

## 十四、S1 开工清单（顺序即依赖）

1. **行为快照（golden）基线先行**：S1 第一个交付物是 golden 生成器与比较器——对当前代码采集并规范化（剔除时间戳 / 随机 id）：RPC 全部方法的请求 / 响应形态、`session.delta / session.complete / session.event` 事件序列、确认往返（pending / resolved）、transcript 分片 / snapshot / conversation meta 持久化产物、取消路径、生命周期触发顺序、`server.shutdown` 三策略收束。迁移前生成、每步迁移后比对零差异。
2. **符号导出前置**：按 §1.3b 冻结合同建立纯类型导出（TaskListOp、TrustRuleSnapshot、MemoryAppendPayload、SkillUsageRecord、SessionEventProjection——字段全部已冻结，S1 零字段发明）；`AdvancementControlEvent ≙ AdvancementStoreEvent`、`AdvancementSnapshot ≙ AdvancementSession`、`SegmentRecord ≙ SegmentMeta`、`TrustRule ≙ PermissionRule` 为现有类型的别名导出；contracts 独立 typecheck 作门禁。
3. **建包骨架**：contracts（core 内模块）、rpc、mesh（占位）、owner-kernel、owner-services、runtime-host、executor；依赖图 lint（不变量 14）与 AST 拓扑规则脚手架（不变量 12）先行。
4. **contracts 落地**：§三全部端口 + §一 / §二 / §五全部 DTO（纯类型零实现，外部符号按 §1.3 引用）。
5. **按逐依赖迁移表等价抽取**（内核 → adapter → 组合根，每步过 golden）：

   | 组件（现址） | 去向 |
   |---|---|
   | ConversationManager + run-turn + runtime/types + ephemeral-run-buffer（server/src/runtime） | owner-kernel |
   | ConfirmationHub（server/src/confirmation） | owner-kernel（S1 行为等价迁移；**终态语义降为 owner 侧中继 / 审计聚合与持久授权承接**——pending 权威随 S6 移至 executor assignment 流，§4.3/§5.6，两者不冲突：单机形态 Hub 即 interaction 分支的进程内适配器） |
   | session-turn-stream / session-broadcast / session-events / confirmation-bridge / event-bridge（server/src/rpc） | rpc（传输投影层） |
   | RPC methods registry（server/src/rpc/methods） | server 组合（注册面） |
   | advancement 域：controller / review-dispatch / proxy-scheduler / recovery-maintenance（server/src/advancement） | owner-services |
   | RuntimeHost + builtin-extra-tools + segment-deps + workmode-tools + session-adapter（cli/src/runtime、cli/src/serve） | runtime-host（session-adapter 即 runtime-host ↔ owner-kernel 的正式契约边界） |
   | serve 装配主干：command.ts / access-surfaces.ts 的共享单例 + 双发放 + 存储回调注入 | cli 组合根（收敛为装配层） |
   | InboundRouter 与渠道宿主（server/src/channels） | server 组合（锚点渠道宿主） |
   | 存储绑定（ShardedTranscriptStore / SnapshotStore / ConversationRepository 注入点） | owner-kernel 的 SessionStatePort 进程内实现 |

   既有接缝即切面：存储 = 回调注入；执行 = SessionRuntime / RuntimeFactory；确认 = ConfirmationHub attach / detach；advancement = onTurnCommitted + admitTurn 两条软缝。
6. **角色装配**：单机装配改为 anchor + executor 同进程角色装配，不变量 5 / 12 验收脚手架同步建立。
7. **双拓扑测试套骨架**（先单机一份，S5 起同套跑分布式）。AuthorityCommitLog 与 ArtifactStore 的实现归 S3，S1 不做。

## 十五、执行计划拆分

拆分标准：先枚举架构不变量，提交边界不得切开任何不变量；一次提交必须形成可独立理解、构建、测试、回滚的终态子集，可以缺能力但不得存在半升级语义或需要靠后续提交修复的中间债务。

执行纪律：同一 S 节点需要多个提交时，前置提交只能增加未启用的纯合同、基础设施或兼容适配，既有生产路径保持单一且行为不变；只有该节点的权威链、异常链、安全守卫、消费者和验收全部闭环后，才在节点最后一个提交切换能力开关。任何提交不得把“旧路径已拆、新路径未闭环”作为可合并状态。

**S3→S4 过渡授权合同（锚点本征签发）**：conversation 域生产切换（第 15B 项）发生在 S4 正式治理（第 16~18 项）之前，而派发 wire 合同已强制 Manifest、AuthorityCapability、PermissionSnapshotLease、ResourceLease 完整在场且签名有效。过渡期授权不是旁路，而是终态签发权的保守子集，按以下不变量执行：

- **签发者恒为锚点**：单机装配中全部派发凭证由锚点以设备密钥真实签发；凭证结构、摘要、签名、激活与吊销记录走与终态完全相同的 wire validator 与权威日志——零测试票据、零验证豁免、零旁路 authorizer。
- **保守固定值域**：admissionClass 按签发入口派生（既有合同）；budget 取锚点版本化资源策略的默认上限（正整数，禁无限）；audience 恒绑定本机 executorId；不签发 delegation 子租约；lease 时效随 assignment 生命周期终结。ExecutionManifest 以锚点自身 inventory 快照构造，进程内 executor 恒匹配。
- **凭证来源冻结（执行者零安全裁量）**：AuthorityCapability 的 methods 取该 assignment 派发与执行账本合同所需方法的最小闭包、resources 限定该 assignment 的 conversation/run 域，per-assignment 签发；PermissionSnapshotLease 取锚点当时权限规则配置的版本化快照；ExecutionManifest 的 inventory 取锚点进程自身的包版本与已装配能力清单，派发时快照；签发密钥取 S2 设备身份密钥（经 SecretStore），不新建密钥体系；expiry 随派发时冻结的 assignment 生命周期上限（禁无限）；过渡期不提供独立吊销入口——凭证收束完全走 assignment 终结、取消与 uncertain 裁决的既有路径，零新增机制。
- **唯一签发接缝**：过渡签发器实现与 S4 治理相同的签发端口，是装配期唯一注入点；第 16~18 单元启用 = 同端口替换实现（签发前增加 matchManifest、principal×方法矩阵与 ResourceGovernor 裁决），wire 合同、验证面、日志形态与重放语义不变，历史凭证零迁移。启用后过渡签发器整体移除，不得双路径并存。
- **S4 切换栅栏**：治理签发器替换以“零活跃过渡凭证”为前置——先停止新派发，在途过渡 assignment 按既有终结、取消与 uncertain 裁决路径自然收束（不夺权、不静默失效），确认零活跃后原子替换签发器再恢复派发；禁止建立凭证迁移机制，禁止两代签发器并行签发。
- **不跨机**：过渡凭证仅对进程内 executor 有效（由 audience 绑定承载）；跨机派发属 S5，届时 S4 治理已在场。

本模块提交边界必须守住以下不变量（§十二的 18 条机械口径全部继续适用）：

- 单机与分布式共用同一 contracts、状态机与执行内核；单机只是 anchor + executor 同进程装配，不得产生第二套业务路径。
- 每个对话任一时刻恰有一个 owner；全局域恒归锚点；旧 epoch、旧 owner、旧 assignment 永远不能恢复写权。
- 控制面必经工作所属权威；数据面安全可直连时就近传输、不可达时只换传输路径，不改变权威与功能语义。
- 任何真实执行必须先有耐久 assignment 激活事实；任何提交必须经过完整栅栏 CAS；未启动证明、迟到合法 bundle 与结果不明三条路径不得混写。
- AuthorityCommitLog 是权威事实源，投影均可重建；跨流原子事实必须处于同一 CommitEnvelope / 单次 fsync，提交边界不得制造双事实源。
- run 内 staged 写在 committed 前对外不可见；失败、取消与未裁决 uncertain 不得残留发布结果；发布决定一旦 granted 必须可幂等收敛。
- 协议摘要、签名、MAC、引用目标与 schema/version 使用 §1.2 单一合同；任何耐久写、能力激活、CAS、对账与恢复均先验证后生效，失败恒 fail-closed。
- 秘密只进 SecretStore、协议与日志只见 SecretRef；设备身份、能力、权限快照、资源租约和数据面票据分层验权，不得互相替代。
- artifact 必须先耐久、再写引用；跨边界 root / dependency 闭包必须完整在场，缺件不得激活、提交或发布。
- capability、permission lease、resource lease 与 ticket 的“签名候选”不等于激活；激活、吊销、结算和回收都必须有唯一耐久锚。
- server 与 executor 零互相 import；未启用角色零加载、零监听；cli 始终是单一产品入口和组合根。
- 用户只感知“值班 / 干活”；既有单机行为、入口响应、事件顺序和持久化结果在对应能力正式启用前必须通过 golden 保持等价。

| 提交 | 边界 | 目标 | 验收 |
|---|---|---|---|
| 1（S1） | 行为 golden 与结构门禁 | 建立 RPC 请求/响应、事件序列、确认往返、持久化产物、取消和三类 shutdown 的规范化 golden；同时建立依赖图与拓扑 AST 门禁 | 当前全量测试通过；迁移前 golden 可重复生成；随机 id / 时间剔除后结果稳定；门禁只报告现状、不改变运行行为 |
| 2（S1） | contracts 与冻结符号 | 按 §1.3b 建唯一类型导出；落 §一/§二/§五 DTO、§三端口及其传递依赖；建立 contracts 独立 typecheck 与 schema/version lint | contracts 独立编译；外部符号全部来自一手导出；冻结区零业务 `unknown`；现有运行路径与 golden 不变 |
| 3（S1） | owner-kernel 与 rpc 等价抽取 | 将 ConversationManager、run-turn、ephemeral buffer、ConfirmationHub 抽入 owner-kernel，将 session stream/broadcast/events/confirmation bridge 抽入 rpc；旧入口只作兼容转发 | server、cli 定向测试与 golden 全绿；同一 owner 实例、observer、确认和持久化行为不分叉；回滚只需恢复旧装配引用 |
| 4（S1） | owner-services 与 runtime-host 等价抽取 | 将 advancement 控制服务抽入 owner-services，将 RuntimeHost、工具与 session adapter 抽入 runtime-host；明确 runtime-host ↔ owner-kernel 正式端口边界 | core/orchestrator/server/cli 定向测试通过；完整 runtime 能力不降级；owner-services 不持全局拓扑分支；golden 零差异 |
| 5（S1） | 角色组合与双拓扑骨架 | cli 组合根按配置装配 anchor + executor；单机使用进程内 adapter；建立同一 conformance 套件的单机拓扑基线，移除迁移期兼容转发 | `pnpm build` 与全量测试通过；不变量 5/12/14 门禁生效；未启用角色零加载零监听；单机 golden 零差异；S1 到此才启用新装配 |
| 6（S2） | 设备身份与认证 mesh 基座 | 建 mesh 包、设备密钥身份、协议握手、双向认证连接、出站隧道与盲中继；不挂载任何业务端口 | 认证、版本偏斜、重放、断线重连和未授权连接测试通过；业务 registry 为空；单机路径不加载 mesh listener |
| 7（S2） | 配对、信任链与 root-activation 检查点 | 落 pairing 流、QR/PAKE、HomeTrustEvent/Record、撤销与 issuer-transition；同时落 CheckpointEnvelope 的 root-activation 最小闭环，使首次网格启用完成恢复包回读、独立复制、真解封验证和原子激活 | 离线字典、在线爆破、MITM、降级、重放、乱序、single-use 并发及激活各崩溃点通过；未验证恢复备份前网格能力保持关闭 |
| 8（S2） | SecretStore、凭据迁移与 ready 状态 | 落统一 SecretStore 后端、`credentials.json` 校验后清退、CredentialExposureRecord、paired→configured→ready/degraded 状态与一次引导流 | 明文扫描为零；迁移逐条回读与失败回滚通过；设备撤销能列出暴露账号；目标未 ready 时不得承担对应角色；S2 安全矩阵全绿 |
| 9（S3） | AuthorityCommitLog 与 ArtifactStore | 建单物理日志/逻辑流、CommitEnvelope 原子追加、坏尾隔离、投影重放、内容寻址存储、先 artifact 后引用及保留/GC 基座；尚不切换 run | WAL 崩溃注入、跨流原子性、投影重建、坏尾、引用在场与 GC 测试通过；旧 run 路径仍是唯一生产路径 |
| 10（S3） | 控制请求与准入幂等 | 落 ControlEnvelope、received→applied、入口 `(surfacePrincipal, ingressId)` 与 requestId 幂等、原结果回放；先覆盖 session-create 与 input 准入的进程内影子验证 | 并发重投、响应丢失、权威重启和渠道至少一次重投均只产生一次准入/变更；影子结果与旧入口 golden 等价，尚不接管执行 |
| 11（S3） | conversation assignment 与执行账本 | 落 run journal、assignment 流、received/started/bundle_sealed/acked、交互 requested/finished、派发 outbox、ActivationProof 与幂等重投；仍由进程内 adapter 驱动 | 无日志执行、重复 assignment、重签同载荷、异载荷 conflict、started 上报丢失、交互恢复与账本链测试通过；新路径仍受开关保护 |
| 12（S3） | conversation 提交、staged 发布与最终性 | 落 SealedBundle、conversation 栅栏 CAS、MutationBatch/publish-decision、内容索引、FinalOutbox、状态通知与历史补读；提交后投影替换旧写路径 | CAS 字段污染、重复/迟到提交、artifact 缺件、publish 崩溃续做、final 响应丢失和 provisional→final 测试通过；旧新提交结果逐条等价 |
| 13（S3） | 取消、重派与 uncertain 收束 | 一次落完整 cancel-requested、双取消源、SupersedeProof、DispatchConflictProof、containment、三分续跑和用户三选裁决；不得先开放自动重派 | 6.1 全 36 行及三方竞态、各 fsync 崩溃点、未闭合副作用、无证明禁重派、迟到合法 bundle 自动提交测试通过 |
| 14（S3） | user/system job 耐久协议 | 落 TaskDefinition/Occurrence、JobJournal、JobCommitFence、user job 同构派发与 system job 锚点本地幂等路径；旧 scheduler 只作兼容投影 | 6.2 全 38 行、6.2b 全 6 行、任务更新/删除/错过/暂停与 system handler 重驱测试通过；system 入口不可由 surface 构造 |
| 15A（S3） | delivery 权威流合同 | 落五类 keyBody、唯一索引、十五行 delivery 生命周期、用户裁决、权威投影与 drain 消费（作为并存新组件），以及 conversation/job 结果原子入流的 owner 接线与测试；新权威流零生产流量，既有 DeliveryPipeline/queue 与生产路径（渠道回复、scheduler 投递）原样不动，公开生产入口保留 | delivery 15 行、五类生产者、并发同键、外部调用前后崩溃、unknown 三选与投影重建通过；全量测试/build 通过；既有投递行为逐字节等价，旧路径仍是唯一生产路径 |
| 15B（S3） | conversation 域耐久协议切换 | 按“S3→S4 过渡授权合同”装配锚点签发器；cli 组合根装配控制准入、conversation owner journal 与执行账本、delivery participant 与 delivery 控制面，将 conversation 执行路径（控制准入、run journal、派发、提交、final）整体切换到进程内耐久协议——含渠道回复经权威流耐久投递、状态通知按 §5.5 经权威流入队，并接通恢复链。scheduler 投递显式保留旧路径且行为不变（接管与退役归 scheduler 接入 JobJournal 的那次提交，见第 26 项） | 外部可观察对话行为（RPC 流、事件序、确认往返）按第 1 项 golden 等价，提交与持久化结果按第 10~12 项影子/逐条等价基线核对；渠道回复零丢失、零重复、零变形；状态通知按 §5.5 外发白名单与冻结文案模板验收（白名单外零投递、零占位文案上线）；崩溃恢复续投；conversation 旧直连路径零残留调用；过渡凭证全走统一 validator；全量测试/build 通过；S3 到此接管 conversation 域单机生产路径 |
| 16（S4） | Manifest、能力描述与最小资产同步 | 落 ExecutionManifest、CapabilityDescriptor、VersionInventory、CredentialBindingDescriptor、EnvironmentRequirement、`matchManifest`，以及配置/资产/权限快照的最小版本同步 | 版本/能力失配矩阵、秘密扫描、快照版本回退和同机/跨机 matcher conformance 通过；失配只排队/拒收、不产生 assignment 候选 |
| 17（S4） | AuthorityCapability 与权限租约激活 | 落五类 principal×方法矩阵、统一 guard、AuthorityCapability、PermissionSnapshotLease、assigned/received 双侧激活与吊销重驱 | 全方法×principal 允许/拒绝矩阵、错 scope/resource/epoch/assignment/executor、候选未激活、替换租约和离线验权测试通过 |
| 18（S4） | ResourceGovernor 与资源租约闭环 | 落 anchor/executor 双半边、根/子租约、WDRR、consume/settle/release/reclaim、delegation、UsageReport 连续水位；将全部工作入口接入治理，并以同端口替换 S3 过渡签发器（wire 合同与既有凭证日志不变） | 不变量 18 对抗矩阵、全 workload kind、重复 usageId、超额/越 delegation、无水位 reclaim、满载公平性和双拓扑测试通过；过渡签发器零残留；S4 能力整体启用 |
| 19（S5） | assignment 资产传输与 mesh adapter | 落 owner↔executor 的 WindowInput/Dispatch/MutationBatch/SealedBundle 及依赖闭包按摘要推拉、断点续传、去重；实现 RunExecutorPort/RunSubmissionPort mesh adapter | root/dependency 少列、多列、乱序、跨层重复、缺件、断点和错 assignment 授权全部拒绝；进程内/mesh contract conformance 等价 |
| 20（S5） | 跨机控制面启用 | 先以前置提交按 §2.5 落生产 bootstrap（角色装配的链授权校验、`zz pair` 引导流、端点交付/耐久/更新、控制面连接建立与中继会合、拨号方重连所有权），生产路径保持不变；再将派发、started、提交、cancel/supersede/queryLedger、usage intake 上网格；以完整 S3/S4 守卫和 assigned outbox 为唯一远端入口，最后开放跨机执行 | §2.5 验收项全绿（单机默认→建链迁移、链外角色拒、配对两形态会合、中继撮合合同、revision 回退拒、双 NAT 建连、拨号方唯一重连）；双拓扑复跑 6.1/6.2/6.2b、断网/重连/重投/owner 与 executor 崩溃矩阵全绿；跨机零无日志执行、零双活；S5 到此才启用业务 mesh |
| 21（S6） | run stream、spool 与摘要链 | 落统一 StreamFrame、assignment 级 seq、streamEpoch fencing、数据帧摘要链、provisional-final、耐久 spool、逐消费方 ACK/回收和背压 | 直连/中继路径切换、空流、逐字段篡改、final 三值核对、ACK 丢失、慢 observer 隔离、崩溃续流零丢零重 |
| 22（S6） | 数据面票据与确认/止损 | 落 observe/interact/abort 票据的签发、续期、吊销；interaction 下行投影、第一方直连 allow-once、owner 失联 abort 与旁观只读 | 越权 observer、非原始 surface 应答、票据过期/吊销、交互取消竞态、断线重连和 abort 证明测试通过；pending 权威只在 assignment 流 |
| 23（S6） | surface 内容资产数据面 | 回填并实现 surface 预上传授权、下载授权、断点续传、生命周期治理；control 写与 committed 内容都执行依赖闭包在场检查 | S6 回填验收全部通过；缺件不得 control apply/CAS；上传中断可续、重复 digest 去重、越 requestId/assignment 拒绝 |
| 24（S6） | 中继、渠道确认与最终性整合 | 落 job owner-relay 水位、conversation/job challenge outbox、token/grant、status/final 合并和路径降级；最后启用无损数据面 | 不变量 7、13、16 对应集成/对抗用例全绿；prepared/cursor/ACK/发送各崩溃点可收敛；渠道与第一方确认能力等价；S6 到此启用 |
| 25（S7） | Environment 与 workscene 接入 | 落 EnvironmentPort、WorkspaceProbeRequest/Grant、设备域 workspace 引用及 revision 复验；workscene 注册留锚点、进出留会话 owner | 目录五态、路径不出 wire、错设备/绑定/revision、远程 setWorkdir、离线能力矩阵和现有 workscene 回归通过 |
| 26（S7） | scheduler 与 job 产品闭环 | 将 scheduler CRUD/run/cancel/定时触发、冻结 delivery plan、渠道来源与维护通知接入 JobJournal/Delivery 流；随后排空旧队列残留投递，删除公开生产入口与旧 DeliveryPipeline/queue 组件——旧投递生产路径至此整体退役 | 任务定义/occurrence 隔离、线程路由保真、job uncertain 暂停/missed 汇总、投递唯一性、system 不进用户视图测试通过；旧生产入口与旧队列零残留调用 |
| 27（S7） | advancement 与独立取证 | 接入 AdvancementSnapshot/Event、ControlCompletion/Reviewer、review 子租约、EvidenceRequest/Bundle/ObservationToken、local-draft rubric 快照 | stale 有限重试、缺证据不判通过、PathGuard/binding revision、离线契约立即生效与全局沉淀延后测试通过 |
| 28（S7） | 编排、memory、技能与生命周期接入 | 编排节点使用父 run 子租约；memory/skill/workscene/task-list/segment 的所有写按落点矩阵进入 staged/control；写类 lifecycle 只在权威提交后触发 | 各模块既有测试 + 双拓扑 adapter 套件通过；failed/cancelled/uncertain 零外泄；executor 零全局 Store 写实例 |
| 29（S7） | 入口覆盖 lint 与模块文档同步 | 建机器可读“registry/命令→落点行或排除项”单源，补齐 §十三列出的模块文档与公开契约，清除旧入口和兼容适配 | 每个 RPC、命令、渠道、生命周期钩子和执行侧写工具恰命中一次；无映射/双映射失败；依赖 lint、全量测试/build 通过 |
| 30（S8） | 本地域 owner 同构装配 | executor 内装配 owner-kernel + owner-services + 本地 governor；本地域不装配 GlobalStatePort；对话 id/ownerEpoch 空间隔离 | 本地域 conversation 的 run/取消/确认/advancement 双拓扑测试通过；全局写实例扫描为零；锚点域既有会话离线时不可写 |
| 31（S8） | DeferredGlobalIntent 与离线能力矩阵 | 落 intent 流/端口，只允许 schedule 与 rubric 沉淀；收编前可查可撤，timeSensitive 收编后必须再确认 | 非法 mutation 类型不可构造；锚点域 record 拒绝；重放、撤销、重校验冲突与用户文案测试通过 |
| 32（S8） | conversation 收编与离线能力启用 | 落 conversation AuthorityTransfer 双端 transfer 流、freeze/checkpoint/import/commit/tombstone；收编携完整会话域与 intent，最后开放离线新建/收编旅程 | 6.3 conversation 各边、任意步崩溃重入、旧 owner fencing、资产/意向零遗漏、收编复核和双拓扑产品旅程通过；S8 到此启用 |
| 33（S9） | 全量一致性检查点与周期备份 | 在 S2 的 root-activation 检查点合同上扩展完整权威 scope、分块资产、readiness 投影、周期/迁居前强制检查点及保留策略，不新造第二种信封 | 分块篡改、错 key/nonce/target/digest、复制/回读中断、链头变化与当前根 readiness 测试通过；秘密与环境事实不入备份 |
| 34（S9） | planned anchor 迁居 | 落 SourceFreezeProof、authority catalog、TrustTransition、ready proof、planned AnchorTransferCommit 与旧端 tombstone | 6.3 planned 全边、准入关闭/在途收束、导入校验、提交前后崩溃、旧签发者/旧 epoch 拒绝和迁居回滚边界通过 |
| 35（S9） | 灾难恢复与安全域换代 | 落 recovery-root 解封、disaster-recovery commit、domain-reset+establish 原子计划、设备 pending-reenroll、凭据轮换清单；开放恢复旅程 | 无源端恢复、伪造 verification、计划断链、旧根/旧锚点拒绝、逐设备 reenroll、双重灾难窗口和零认知恢复演练通过；S9 到此启用 |
| 36（S10） | 托管服务与角色自恢复 | 单一安装包按启用角色注册跨平台服务；anchor 崩溃/重启自恢复，executor 按选择上线；纯 surface/按需单机不额外常驻 | 安装、重启、崩溃拉起、角色关闭、未启用零进程/零监听及单机开箱零新增概念测试通过 |
| 37（S10） | 三路径停机、移除与卸载 | 回填并实现临时停机、executor 移除、anchor 永久卸载协议；本地权威先转移或用户确认销毁，账本/outbox/租约/身份依序收束 | 三路径逐阶段崩溃恢复、失控设备诚实告知、未收编本地会话阻断移除、迁移/销毁后清退与 `server.shutdown` 三策略测试通过 |
| 38（S10） | 升级兼容、发布与最终验收 | 落 schema/protocol 兼容门、升级/回滚纪律、诊断与发布检查；执行全部不变量、故障、安全、双拓扑和四时刻产品旅程，移除所有能力开关与迁移兼容层 | `pnpm lint`、`pnpm test`、`pnpm build` 全绿；18 条不变量与故障/对抗矩阵逐项通过；单机 golden、配对、日常、离线、uncertain、撤销/恢复零认知验收通过 |

执行顺序不可重排为会产生中间债务的形态：

- 1–5 是所有后续节点的结构前提；S1 未完成前不得在旧 server/cli 结构上旁挂第二套分布式业务实现。
- 6–8 必须先于任何业务 mesh；未完成信任链、恢复根与 SecretStore 闭环前，19–24 的跨机能力只能用于隔离测试，不能面向用户启用。
- 9–15 必须先在进程内把耐久协议、取消/uncertain、job 与 delivery 跑通；16–20 不得用网络重试替代尚未成立的本地事务语义。
- 16–18 必须先于 19–20；跨机派发不得早于 capability、permission lease、resource lease 的双侧激活与吊销守卫。
- 19–20 的控制面必须先于 21–24 的数据面正式启用；数据面只优化路径，不得反向成为权威或绕过控制面准入。
- 25–29 各模块只能接入已经稳定的 S3–S6 合同；不得为迁就旧模块重开第二套提交、投递、确认或资源治理语义。
- 30–32 必须先证明本地域 owner 与锚点域 owner 同构，再开放离线会话；DeferredGlobalIntent 与收编必须同在可验收路径中，不能只产意向而没有归宿。
- 33–35 必须先有可真解封的检查点，才能提交 planned/DR 权威切换；恢复演练未通过前不得把备份存在等同于可恢复。
- 36–38 只能在 S1–S9 已闭环后处理常驻、卸载与发布；任何移除/卸载不得先撤身份、后发现仍有本地权威。
- 每个提交至少运行受影响包的定向测试与构建；每个 S 节点最后一个提交运行该节点全量矩阵与 `pnpm build`，S10 最后提交再运行仓库级 `pnpm lint / pnpm test / pnpm build`。
