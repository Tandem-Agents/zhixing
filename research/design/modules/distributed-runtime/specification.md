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
- epoch 规则（uint64、单调、永不回退）：`anchorEpoch`（迁居 / 换代 +1）、`trustEpoch`（issuer-transition +1）、`ownerEpoch`（对话权威转移 +1）、`localGovernorEpoch`（设备级治理域 epoch，仅本地域整体重置时 +1；单个对话被收编不改变它，对话级 fencing 由该对话自己的 `ownerEpoch` 承担）、`streamEpoch`（assignment 数据面重连 +1）。`localDomainId = "local:"+deviceId`。
- 时钟：协议时间戳恒为签发者时钟；跨设备只用 `issuedAt + TTL` 换算单调 deadline；`maxClockSkewMs = 120_000`（初值，S2 标定）。
- 幂等键单源表：入口 `(surfacePrincipal, ingressId)`；控制写 `requestId`；allow-once 应答 `(assignmentId, interactionRequestId)`；渠道 challenge 外发 / grant `challengeId`；提交 `(conversationId, runId)` / `(taskId, jobRunId)`；派发 `assignmentId`；扣账 `usageId`；结算 `reservationId + 动作`。DeliveryOutbox 入队键统一为 `D("DeliveryEnqueueKeyBody",1,keyBody)`，`keyBody` 的唯一字段合同是 §4.3 `DeliveryEnqueueKeyBody`；同一权威事实重放必须复用原键，不得以当前 epoch、attempt 或投递目标另造身份；同键仅在 `intentDigest` 相同时回放原 item，否则拒绝为 `idempotency-conflict`。

### 1.2 规范化字节与签名域分离（全部签名 / digest 对象共用）

- 规范化：wire 与签名输入采用 UTF-8 的 RFC 8785（JCS）规范化 JSON；uint64 一律以规范十进制字符串上 wire，避免跨语言精度分歧。
- 签名输入固定为 `"zhixing:<schemaId>:v<version>" + 0x00 + canonicalPayload`，覆盖除 `signature` 外的全部字段；`schemaId + version` 与 DTO 顶层版本一致（域分离，杜绝跨类型/版本重放）。
- 验证端拒绝未知字段；字段演进只经顶层 `v` 升版（本文全部跨 wire DTO 顶层带 `v: 1`，行文省略不重复标注）。
- 摘要域单源：`D(schemaId, v, payload) = H(UTF8("zhixing:" + schemaId + ":v" + v) || 0x00 || JCS(payload))`；原始内容摘要记为 `B(bytes) = H(bytes)`。两者输出均为 §1.1 `Digest`。`D` 用于协议对象/子对象身份，`B` 只用于不可变原始字节；禁止以裸 `H(JCS(...))` 新造协议摘要。
- 有密钥认证域单源：`K(schemaId,v,key,payload) = MAC(key, UTF8("zhixing:" + schemaId + ":v" + v) || 0x00 || JCS(payload))`，输出 §1.1 `KeyConfirmation`；字段自身及同层 finished/authenticator 集合不得进入 payload。当前仅注册 `PairingJoin.confirmation` 与 `PairingFinished.*.keyConfirm`，不得以 `Digest` 代替或把无密钥 `D` 当作密钥确认。
- **自摘要**：先从完整对象排除 `signature` 与正在计算的自摘要字段，再计算 `D`；随后签名覆盖**含已计算摘要**在内、仅排除 `signature` 的完整对象。当前自摘要注册表唯一包含：`TrustRuleSnapshot.digest`、`ResourceLease.digest`、`UsageReport.digest`、`ConfigAssetRecord.digest`、`CommitEnvelope.envelopeDigest`、`MutationBatch.digest`、`ExecutionManifest.digest`、`JobCommitFence.digest`、`SealedBundle.digest`、`CheckpointEnvelope.digest`。未登记的字段不得被解释为“包含它的对象之摘要”。
- **无自摘要字段的对象/子对象身份**：签名 DTO 被其他对象按摘要引用时，身份统一为 `D(schemaId, v, 对象去 signature)`，重签不改变身份；当前目标包括 `HomeTrustEvent`、`DispatchEnvelope`、`EvidenceRequest`、`DataPlaneTicket`、`SourceFreezeProof` 与 `PermissionSnapshotLease`，其中 `PermissionLeaseDigest = D("PermissionSnapshotLease",1,PermissionSnapshotLease 去 signature)`。无签名子对象按其命名 schema 直接计算；`AssignmentActivationDigest = D("AssignmentActivationPayload",1,AssignmentActivationPayload)`。
- **链摘要**：home 信任链的 `prevEventDigest / chainHead.eventDigest` 引用上条 `HomeTrustEvent eventDigest`。assignment 账本固定 `L0 = D("AssignmentLedgerSeed",1,{assignmentId})`，`Ln = D("AssignmentLedgerStep",1,{previous: L(n-1), entry: AssignmentEntry_n})`；`LedgerEvidencePage.chainDigest`、`DispatchRejectionProof.ledgerDigest`、`DispatchConflictProof.receivedLedgerDigest`、`SupersedeProof.ledgerDigest` 与 `CancelProofBody.ledgerDigest` 均引用对应 `recordSeq` 的 `Ln`。`streamDigest` 使用 §5.6 的独立链公式，不混用本规则。
- **内容与引用摘要**：`ArtifactRef.digest`、`ContentAssetRef.digest`、`CheckpointEnvelope.chunks[].digest`、`EvidenceRequest.items[].digestHint`、证据 `contentDigest`、副作用 `resultDigest`、投递回执 `receipt.digest` 与恢复验证 `nonceDigest` 恒为各自所指不可变原始字节的 `B(bytes)`；`PairingOffer.issuer.keyFingerprint = B(规范公钥字节)`。`manifestDigest / snapshotDigest / parentDigest / reportDigest / envelopeDigest / requestDigest` 等引用字段必须等于目标对象按本表得到的摘要，不得对引用字段所在对象再哈希。`FinalOutboxRecord.digest / FinalFrame.digest` 固定引用 `SealedBundle.digest`；`AssetIndexEntry.digest` 固定引用对应资产 artifact 的 `ArtifactRef.digest`。
- **派生子对象摘要**：`ControlEnvelope.payloadDigest`、challenge `displayDigest`、delivery 的 key / `intentDigest` / open / resolution 摘要、uncertain `openFactDigest / factDigest`、system job `paramsDigest`、`TaskDefinitionBody.deliveryPlan.planDigest` 与恢复计划 `activationDigest` 均以各自命名 schemaId 调用 `D`；其中 `paramsDigest = D("SystemJobParams",1,params ?? null)`、`planDigest = D("JobDeliveryPlan",1,{delivery})`。`CredentialExposureRecord.principalFingerprint / CredentialBindingDescriptor.principalFingerprint = D("CredentialPrincipal",1,{service,canonicalProviderPrincipal})`，只允许来自 service-verified 身份核验，`user-alias` 必须省略；`ObservationToken.preStateFingerprint / postStateFingerprint = D("EvidenceObservationState",1,{items})`，items 按请求顺序承载 `{kind,locator,state:{kind:"missing"}|{kind:"present",contentDigest}}`。各节只列 payload 字段，不再另立算法。新增或升版任何 `Digest` 类型字段必须先登记为“自摘要 / 对象身份 / 链 / 内容 / 引用 / 派生”之一；有密钥认证值必须用 `KeyConfirmation`，contracts lint 未命中或多重命中即失败。
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

- 验证边界：任何会改变耐久状态或激活能力的消费者，必须依序完成 DTO/version/未知字段校验 → 按注册类别复算摘要 → 验签（如有）→ 逐项核对引用目标；未知摘要域、缺摘要、前像缺字段、复算不等或引用错目标均在落盘、激活、CAS、对账或恢复前 fail-closed，禁止按字段名猜测或兼容性回退。
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
| `TrustRule` | ≙ 现有 `PermissionRule` @ `packages/core/src/security/types.ts:232`（S4 如需演化走 `v` 升版，不预改） | 信任规则 |
| `TrustRuleSnapshot` | 本文冻结（§1.3b） | 签名规则快照 |
| `ScheduleTaskSpec` | ≙ 现有 `TaskSpec` @ `packages/core/src/scheduler/facade.ts`（完整型 `ScheduledTask`；进程内领域类型，**不上 wire**——wire 用 §3.2 `ScheduleTaskSpecDto` 显式白名单：action 仅 agent-turn、webhook endpoint 整体 `SecretRef`、origin / system 等权威字段锚点生成） | 调度任务定义源类型（派发另用 §5.2 `JobExecutionInstruction`） |
| `TaskSchedule` / `TaskPriority` | 现有同名 @ `packages/core/src/scheduler/types.ts`（进程内领域类型，**不上 wire**——wire 用 §1.3b `TaskScheduleDto` / `TaskPriorityDto` 快照） | 调度周期与优先级 |
| `DeliveryTarget` | 现有同名 @ `packages/core/src/channels/types.ts:48`（进程内领域类型，**不上 wire**——wire 用 §1.3b `DeliveryTargetDto` 快照） | 任务来源投递目标（锚点生成，只读） |
| `MemoryAppendPayload` | 本文冻结（§1.3b；自三域现有写入签名——memory=`SaveOptions`、journal=`append(content, date?)`、people=`save(id, PersonMeta, content)`——机械归一） | 记忆 / journal / people 追加载体 |
| `MemoryEntry` / `PersonEntry` / `JournalEntry` | 现有同名 @ `packages/core/src/memory/` | 记忆域实体（读结果载体） |
| `MemoryCategory` / `PersonMeta` | 现有同名 @ `packages/core/src/memory/`（进程内领域类型，**不上 wire**——wire 用 §1.3b `MemoryCategoryDto` / `PersonMetaDto` 快照） | 记忆分类与人物元数据 |
| `DeliveryItem` | 现有同名 @ `packages/core/src/delivery/types.ts:31`（由 delivery 流投影生成，不上权威日志） | 渠道发送器兼容投影 |
| `EnqueueParams` / `IDeliveryPipeline.enqueue` | 现有同名 @ `packages/core/src/delivery/types.ts:100 / :110`；现实现于 `pipeline.ts:199`，唯一生产调用 @ `scheduler.ts:519` | S3 删除公开生产入口；改由五类权威生产者内部构造 enqueued |
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
interface TrustRuleSnapshot { snapshotVersion: number; rules: TrustRule[];
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
  | { t: "issuer-transition"; nextTrustEpoch: number; fromIssuerKeyId: string; toIssuerKeyId: string;
      toDeviceId: string; reason: "migration"|"disaster-recovery"; signedBy: "issuer"|"recovery-root" };
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
  attempts: { max: number /* 初值 3 */; onExhaust: "expire" } }   // 失败限次**仅按 offerId** 持久计数（§下方 pairing 流）+ 指数退避，超限 offer 即刻作废——不按来源计数（来源可伪造）
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
// 失败计数的耐久载体：签发端锚点域 log 新增 `pairing` 逻辑流，记 { t: "pairing-attempt"; offerId; outcome: "failed"|"succeeded" }——
// 计数键**仅 offerId**（不按来源设备——来源身份可伪造，换伪身份即重置计数；offer 是用户手势产生的稀缺物，单键限次不可绕过），
// 失败达 attempts.max 即写作废、offer 永久失效。
// 原子规则：acceptance 全验通过后，`pairing-attempt(succeeded)` 与 trust 流 `enroll` / `reenroll` **同一 CommitEnvelope 原子写**
//（同锚点进程同物理 log，§4.1）——"offer 已耗尽而设备未入链"与"已入链而 offer 仍可用"两种半提交态不存在；
// 失败路径先耐久写 `pairing-attempt(failed)` 再向对端返回失败（计数不可丢）；offer 的使用 / 作废状态**只由 pairing 流投影**，
// 无独立可变状态。验收（随 S2）补：原子点前后崩溃注入、succeeded 重放幂等、并发双 join 的 singleUse 仲裁（恰一胜出）。
// 验收（随 S2 安全对抗矩阵）：离线字典（截获全部 wire 消息后枚举短码 → 无可校验物）、在线爆破（offerId 单键限次 + 退避 +
// 超限作废 + 换伪身份不重置）、MITM / 降级（transcript 失配）、重放（singleUse + chainHead）、乱序 / 跳轮各有对抗用例。
```

信任事实的唯一形态是签名、单调、哈希链接的 `HomeTrustEvent`（enroll / role-change / revoke / recovery-root / domain-reset / issuer-transition），落锚点域 AuthorityCommitLog 的 `trust` 逻辑流；`HomeTrustRecord` 只是带链头摘要的签名快照投影（含恢复根——投影链上当前有效根，无独立写路径），任何设备可凭事件链重放验证成员、撤销与恢复根的对象、顺序与当前水位。配对 = offer + join（短码分支另经 PakeRound 通道交替多轮）+ **acceptance 收尾**（transcript 摘要双方一致、双向 finished——设备签名绑身份 + PAKE 密钥确认证共享短码、单次 acceptance 绑链头——离线字典 / 在线爆破 / MITM / 降级 / 重放 / 乱序各有机械拒绝点，随 S2 安全对抗矩阵验收）→ 签发者写 `enroll`（reset 后重入写 `reenroll`）事件入链，事件绑定 pairingTranscriptDigest。恢复根在首次启用网格能力（首次配对 / 加密备份 / 迁居）的同一引导流建立：展示恢复包 → 用户保存 → 回读验证（重输校验段）→ 先完成新根检查点的独立复制与真解封验证，再原子激活 `recovery-root(establish)` 并开放该能力（§七）；轮换（主动换 / 泄露置换）走同一用户仪式与原子激活，切换前旧根持续有效；泄露且暂不换新由旧根签 `invalidate`（灾难恢复随之不可用，直至新根建立）；**丢失恢复包走 `domain-reset + establish` 原子计划**（字段合同与守卫见上——issuer 发起 + 第二设备共签恒必填，计划激活后新根与已验证备份同时生效、全设备逐台重新配对回 active；单设备 home 无链上补救，走重建 home 仪式）；单机开箱不生成。验收（随 S2）：issuer 签 rotate / invalidate 必被拒；无 coSign 或共签设备 = issuer 设备的 domain-reset 必被拒（含单设备 home）；已失效旧根签发 issuer-transition / rotate 必被拒；轮换、丢失 reset、泄露、离线设备追赶（含跨 reset 追赶）各有链重放用例。

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
interface ChannelMessageRef { channelId: string; messageId: string; threadId?: string } // 平台发送回执，仅审计 / 展示，不充当授权
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
  | "reservation.prepareAssignmentRoot" | "reservation.prepareSystemJobRoot" | "reservation.acquireRoot"
  | "reservation.acquireChild" | "reservation.consume" | "reservation.settle" | "reservation.release"
  | "submission.reportStarted" | "submission.submitBundle" | "submission.submitCancelProof" | "submission.mirrorInteractions"
  | "governor.submitUsageReport"
  | "executor.dispatch" | "executor.cancel" | "executor.supersede" | "executor.queryLedger";
// 五类 principal 各持**封闭方法子集**——凭证签发器与 guard 共用同一矩阵，非法 principal×方法组合在类型层不存在；
// 验收 = 自动生成"全部方法 × 五类 principal"允许 / 拒绝矩阵，进程内与 mesh adapter 等价（不变量 16 的机械承载）：
type AssignmentMethodId = Extract<AuthorityPortMethodId,
  | "session.readSessionMeta" | "session.readTranscriptTail" | "session.readTaskList" | "session.readAdvancementState" | "session.mutate"
  | "global.read" | "global.mutate"
  | "reservation.acquireChild" | "reservation.consume" | "reservation.settle" | "reservation.release"
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
// 两者都只在 capId 被激活清单收录且 assignmentId / executorId / scope 全等时放行。事实/证明不存在、未列 capId或已 superseded / revoked 均拒绝。
// 吊销：owner 在对应流写 `capability-revoked`（按 capId / assignmentId）并推送通告，guard 立即拒绝；
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
  Omit<ResourceLease, "parentId"|"parentDigest"|"workload"|"scopeBinding"|"domain"> & { parentId?: never; parentDigest?: never;
    workload: Extract<AssignmentWorkload, { kind: "job" }>;
    scopeBinding: Extract<ResourceLease["scopeBinding"], { kind: "job" }>;
    domain: Extract<ResourceLease["domain"], { kind: "anchor" }>;
    activation: { kind: "system-job"; jobRunId: string } };
type ImmediateRootResourceLease =                   // control-class 根租约：reserve 记录即时激活
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
  issuedAt: IsoTime; expiry: IsoTime /* 短 TTL，签发 owner 经控制连接心跳滚动续签 */; signature: Signature }
type ExecutionRef =                               // conversation / job 统一工作身份——主体与权威 epoch 一体判别，
  | { execution: "conversation"; runId: string; conversationId: string; ownerEpoch: number }   // "job 主体 × conversation epoch"类
  | { execution: "job"; jobRunId: string; taskId: string; anchorEpoch: number };               // 非法凭证在类型层不存在；
                                                  // 贯穿权限租约、数据面票据、StreamFrame、abort 请求与交互路由（#确认能力两域等价）
interface PermissionSnapshotLease { snapshotVersion: number; snapshotDigest: Digest;
  binding: ExecutionRef; assignmentId: string; executorId: string;
  controlLeaseId: string;                // fail-closed 的机械判定锚：绑定的 ControlLease 过期 / 断线未续 →
                                         // 快照即失效，安全管线拒绝规则放行，仅合法 allow-once 单次授权（surface ticket / channel grant）可逐次放行
  issuedAt: IsoTime; expiry: IsoTime; signature: Signature }
type PermissionLeaseDigest = Digest;      // = D("PermissionSnapshotLease",1,PermissionSnapshotLease 去 signature)；标识确切租约实例而非其 snapshot 资产
// 快照本体权威恒在锚点（信任规则全局域）；本地域会话使用锚点签发的最近快照缓存 + 本地域对话的 ControlLease（owner 就在本机，心跳恒可续），过期同样 fail-closed。
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
type SecretRef = { kind: "provider"|"channel"|"mcp"|"device-key"|"webhook"; bindingId: string };
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
  callerDeviceId: string; requestId: string; issuedAt: IsoTime; expiry: IsoTime; signature: Signature }
interface AuthorityCallContext { principal: AuthorityPrincipal; requestId: string;
  expectedRevision?: number; deadlineAt: IsoTime }
```

一切权威端口调用（含读）必携 `AuthorityCallContext` 过同一 guard：assignment 验 capability 的 scope / 方法与资源 / expiry；surface 验连接认证与会话归属；host 验装配期白名单；owner-control 由 executor 验签名设备是该 assignment 的派发 owner、epoch 当前、expiry 未过；usage-reporter 由 governor 验设备连接身份与报告签名、lease 链溯根——进程内与跨机同一实现。

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
interface ReservationOrigin { admissionClass: AdmissionClass;
  entry: "conversation-input"|"advancement-control"|"schedule-trigger"|"orchestration" }  // 装配期注入的可信入口派生器提供
interface ResourceReservationPort {
  prepareAssignmentRoot(req: AssignmentReservationRequest,
                        origin: ReservationOrigin, ctx: AuthorityCallContext): Promise<AssignmentResourceLease>;   // 只签候选、零日志副作用
  prepareSystemJobRoot(req: SystemJobReservationRequest,
                       origin: ReservationOrigin, ctx: AuthorityCallContext): Promise<SystemJobResourceLease>;      // 只签候选；由 6.2b 原子激活
  acquireRoot(w: ImmediateRootWorkload, budget: ResourceLease["budget"],
              origin: ReservationOrigin, ctx: AuthorityCallContext): Promise<ImmediateRootResourceLease>;          // control 根租约即时写 reserve 后返回
  acquireChild(parent: ResourceLease, w: ChildResourceLease["workload"], budget: ResourceLease["budget"],
               ctx: AuthorityCallContext): Promise<ChildResourceLease>;
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
  phase: "unknown"|"received"|"dispatch-rejected"|"supersede-fenced"|"started"|"halted"|"sealed"|"acked";
  sealedBundleRef?: ArtifactRef; cancelProof?: CancelProofBody }
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

派发回执纪律：assigned outbox 只选择“当前 state=dispatched、存在 assigned、且无 dispatch-acked / assignment-superseded”的 assignment，每次发送同一 `DispatchEnvelope` + 对同一 `AssignmentActivationPayload` 的有效签名 proof；载荷由原子提交确定性重建，重启可重新签名。executor 先按 §1.2 复算 envelope 对象身份及全部内嵌自摘要/引用摘要并验签，再验证 proof 当前 owner/epoch 签名与 `validateAssignmentActivation`（ref / assignment / executor / dispatchRef / manifestDigest / permissionLeaseDigest / capIds 全集 / reservation / commit 摘要全匹配，其中 permissionLeaseDigest 必须等于信封内确切 permissionLease 的规范摘要）、`validateDispatchBinding`、`matchManifest`，全部通过后才 fsync `received(envelope, activation)` 并返回 `accepted:true`；本地 capability / permission / resource guard 只采信该耐久 received proof，禁止在线回查 owner。重复 assignment 若 proof 签名有效且规范载荷与已耐久 `received.activation` 全等，回放原结果，signature 字节不同本身不构成冲突；若载荷不同，返回签名 `DispatchConflictProof` 与 `DispatchConflictError(retryable=false)`，不得追加 executor `dispatch-rejected`、不得改变 executor assignment 状态。该 proof 固定绑定唯一 `received` 记录的 recordSeq / 前缀链摘要与新旧 dispatch / payload 摘要，可由原账本重建，不受 started / sealed 等后续记录影响；proof.error 只含固定 code / retryable，response.error 的这两项必须全等，message 仅作诊断、不入证明身份。

owner 只在当前仍为上述未 ACK dispatched assignment 时消费 conflict：先验 executor / assignment / signature / received 前缀链，要求 accepted / conflicting 两份 ActivationPayload 摘要不等，再要求 proof.conflictingDispatchRef / conflictingActivationDigest 等于本次实际发送二元组。随后从本地耐久 assigned + 所指 CommitEnvelope / DispatchEnvelope 重算期望 acceptedDispatchRef / acceptedActivationDigest：① accepted 侧全等期望，证明 executor 已接收原权威派发——同一 CommitEnvelope 写 `dispatch-conflict(acked-original) + dispatch-acked`，停止 outbox；② accepted 侧任一不等，说明 executor 接收事实与 owner 权威派发不一致——同一 CommitEnvelope 原子写 `dispatch-conflict(opened-uncertain) + state(uncertain) + UncertainResolutionFact(cause=dispatch-conflict) + cancel-fence + assigned.capIds / 活跃 tickets 的 revoked 记录`，停止派发 outbox与该 assignment 的 ControlLease 续期；fsync 后以该 cancel-fence 重驱 executor 止损，禁止仅凭 conflict proof 自动提交迟到 bundle或重派。资源租约此时不提前 settle / release（世界副作用与最终 usage 尚未证实），只在取得既有终结证明或用户裁决时按 §十收束。proof 无效、两侧摘要相等、conflicting 侧不对应本次发送或 response.error 的 code / retryable 与 proof.error 不等时零写入，走既有超时 / fence 路径；assignment 已 ACK、已离开 dispatched 或已终态时，迟到 conflict 不得再改变权威状态。`DispatchConflictProof` 永非 `AssignmentTerminationProof`，任何分支都不能据它重派。

`dispatch-conflict` 止损 outbox 的唯一谓词为：存在当前打开的 `dispatch-conflict(opened-uncertain)` 与其同 envelope `cancel-fence`，且尚无同 openFactDigest 的 `dispatch-conflict-contained`、`assignment-superseded` 或用户 resolution。满足时按有界退避并在 executor 重连时重发**同一 fence**（每次可重签短期 OwnerControlGrant，不得换 requestId / fenceSeq）；executor 必须先在 assignment 流 fsync `halted(proof)` 再调用 `submitCancelProof`，同 fence 重入若已存在 halted 则读取并重提同一规范 proof、零追加。RPC 成功本身不停止，只有 owner 全验 proof 并耐久上述停止事实才停止，因此 executor 写 proof 后、提交前或响应前崩溃均可收敛。`not-started` proof 是总纲“事后证实未启动”的终结证明：同一 CommitEnvelope 写 contained + resolution(`proven-not-started-redispatched`) + assignment-superseded + 旧租约终结并转 queued，之后才可建新 assignment；`halted` proof 只写 contained、停止止损 outbox并作为用户核验与 usage 对账证据，状态仍 uncertain，禁止伪装成 cancelled。无 proof 时义务不丢弃、仅有界退避；capability / ticket 吊销仍由各自 revoked 记录重驱并以短 TTL 兜底。

首次接收在写 `received` 前校验失败才先写 `dispatch-rejected`，再返回 `rejected-before-received + DispatchRejectionProof`，响应 error 必须与 proof.error 全等。响应丢失时 owner 仅据上述 outbox 谓词重发；supersede fence 必须先写 `supersede-fenced`（无 received 时即耐久 tombstone）再返回证明。`SupersedeProof(already-started)` 等价于可信 started 上报，owner 转 running 并保留原 assignment，不得写 superseded。owner 只有持 `AssignmentTerminationProof` 才可在同一 CommitEnvelope 写 `assignment-superseded`、吊销该 assignment 全部 capability 与未 revoked ticket、终结根租约并创建下一 assignment；query 快照、DispatchConflictProof 或超时本身绝不授权重派。

### 3.7 RunSubmissionPort（executor → owner；run 闭环的提交入口，进程内与 mesh adapter 同一接口同一 guard）

```ts
interface InteractionMirrorEntry { seq: number; requestId: string; kind: "allow-once";
  outcome: { t: "answered";      authority: InteractionAnswerAuthority; decision: { allowed: boolean; reason?: string }; by: string }
         | { t: "auto-resolved"; decision: "denied"; reason: "no-interactive-surface"|"policy-fail-closed" }
         | { t: "cancelled";     via: "cancel-fence"|"abort-ticket"|"run-end"|"backpressure" }
         | { t: "expired" };                     // 镜像 = finished 终态投影（审计面与账本同构，四类终结路径一致）
  at: IsoTime }

interface RunSubmissionPort {
  reportStarted(assignmentId: string, ctx: AuthorityCallContext): Promise<void>;   // 幂等
  submitBundle(bundle: SealedBundle, ctx: AuthorityCallContext):
    Promise<{ committed: true; commitRevision: number } | { committed: false; error: AuthorityError }>;  // CAS；重复 / 迟到按幂等键返回原 revision
  submitCancelProof(assignmentId: string, proof: CancelProofBody, ctx: AuthorityCallContext): Promise<void>;  // 幂等
  mirrorInteractions(assignmentId: string, entries: InteractionMirrorEntry[], ctx: AuthorityCallContext):
    Promise<{ mirroredUpTo: number }>;   // 审计镜像（至少一次）；应答权威恒在 executor 侧 assignment 流
}

// 治理域自己的上报面（与 run 提交解耦——evidence 等无 assignment 负载同一入口）：
// anchor / 本地域 governor 各自装配服务端，跨机经 mesh、进程内 adapter 同一 guard；验权走 ResourceLease 链（报告内 reservationId 溯到本域根租约）
interface ResourceUsageIntake {
  submitUsageReport(report: UsageReport, ctx: AuthorityCallContext):
    Promise<{ ackedThroughSeq: number }>;   // 只推进无缺口水位；usageId 幂等，重发回放原 ack
}
```

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

### 4.2 ArtifactStore（内容寻址，每设备一个）

```ts
interface ArtifactRef { digest: Digest; bytes: number }
```

- 承载：SealedBundle 本体、MutationBatch、窗口全量输入、run 产物与附件、超限请求 / 结果。内联阈值：≤ 32 KiB 的对象直接内联进 LogicalRecord，超限入 artifact 并以 `ArtifactRef` 引用（初值，S3 标定）。
- 写序纪律：artifact 先 fsync 落定，引用它的 log entry 后写——log 内引用恒指向已耐久对象。
- **依赖闭包通用规则（跨边界引用的在场保证）**：任何跨边界消息（SealedBundle / ControlEnvelope / DispatchEnvelope）按 schema 机械划分两类引用：① `rootArtifacts` = wire body 中直接出现的全部 `ArtifactRef`（含 SealedBundle 的 runRecord / mutationBatch / contentAssets、ControlRequest mutation 内的正文引用、Dispatch work 引用），它们已在 body 的 digest / 签名域内，**不重复**写入清单；② `dependencyArtifacts` = 对每个有注册 schema 的 root artifact 解引用并递归提取得到的传递闭包，减去 rootArtifacts 后的精确集合（opaque 内容资产是叶节点，不解析内部字节）。两集合均按 `(digest, bytes)` 升序规范化且禁止重复；跨层重复、非规范顺序、少列与多列均拒，无传递依赖时必为 `[]`。接收方使用同一版本化 schema 提取器对账，先验证消息 digest / 签名，再要求 `rootArtifacts ∪ dependencyArtifacts` 全部已耐久在场，CAS / control apply / dispatch 接受前缺任一件即拒（`missing-base` 族错误）。root / dependency 只是**传输清单分类，不改变资产语义**：成功生效后，每个 ref 由引用它的权威记录接管保留与 GC（如 contentAssets 归内容索引、skill / rubric content 归对应全局资产）；未被权威记录接管的临时件才按保留窗 GC。
- **绑定字段（payload 单源，算法统一见 §1.2）**：`ControlEnvelope.payloadDigest = D("ControlEnvelopePayload",1,{body,dependencyArtifacts})`；`DispatchEnvelope.signature` 按 §1.2 覆盖除 signature 外全部字段；`SealedBundle.digest = D("SealedBundle",1,{assignmentId,executorId,streamFinal,usage,usageFinal,dependencyArtifacts,body})`。rootArtifacts 因位于 body 已被覆盖，dependencyArtifacts 显式入域；任何集合替换、顺序变化（JCS 后）或内容篡改均失配。
- 传输分两级：**S5 最小 assignment 域传输协议**——对象为 WindowInput 全量、SealedBundle、MutationBatch 及 `rootArtifacts ∪ dependencyArtifacts` 全闭包，在 owner ↔ executor 之间按 digest 推拉，授权凭该 assignment 的 `AuthorityCapability`（越 assignment 拒绝），支持断点（range）与去重（已有 digest 跳过），上传恒先于引用它的提交；**S6 扩展**——用户内容资产的数据面消费（surface 下载授权、断点续传、生命周期治理）与 **surface 预上传授权**（control 写的 root / dependency 上传半边，凭已认证连接按 requestId 申请上传授权，上传完成才可提交该 control 写）。
- GC：引用计数以 log 保留窗为准；对话删除连带其资产引用，归零后物理回收。

### 4.3 各逻辑流记录

```ts
type ControlRecord =
  | { t: "received"; requestId: string; envelope: ControlEnvelope | { ref: ArtifactRef } }
  | { t: "applied";  requestId: string; result: ControlResult | { ref: ArtifactRef }; authorityRevision: number };
type ControlResultBody =        // 回放载体：重复请求原样返回。allow-once 不在此联合——它不落 owner control 流，
                                // 终态权威与幂等回放归 executor assignment 流 interaction-finished 记录（重复 (assignmentId, interactionRequestId) 回放原 outcome）
  | { t: "input"; runId: string; queuedPosition: number }
  | { t: "cancel"; runState: ConversationRunState }
  | { t: "session-write"; revision: number }
  | { t: "session-create"; conversationId: string }
  | { t: "global-write"; revision: number }
  | { t: "job-run"; jobRunId: string }
  | { t: "job-cancel"; runState: JobRunState }
  | { t: "uncertain-resolve"; state: ConversationRunState | JobRunState }
  | { t: "delivery-resolve"; applied: boolean };
type ControlResult = { status: "ok"; body: ControlResultBody } | { status: "rejected"; error: AuthorityError };

interface DispatchConflictRecord { t: "dispatch-conflict"; assignmentId: string; proof: DispatchConflictProof;
  handling: "acked-original"|"opened-uncertain" }
// owner 流内幂等键 = (assignmentId, proof.conflictingActivationDigest)；同键且 DispatchConflictPayload 全等则回放首条记录（signature 可不同），异载荷拒绝。
interface DispatchConflictContainmentRecord { t: "dispatch-conflict-contained"; assignmentId: string;
  openFactDigest: Digest; proof: CancelProofBody }
// 每个 openFactDigest 至多一条 contained；proof 必须全验、绑定当前 assignment / executor / epoch，并在账本链上严格后继于 conflict 所证 received 前缀。

type RunJournalRecord =
  | { t: "admitted"; ingressKey: string; runId: string; input: UserTurnInput | { ref: ArtifactRef };
      ingress: IngressContext; queuedPosition: number }   // 来源上下文随准入耐久化——票据签发（原始 surface）、final / 渠道路由的权威数据源
  | { t: "assigned"; runId: string; assignmentId: string; executorId: string; manifestDigest: Digest;
      dispatchRef: ArtifactRef;                     // 指向已先行 fsync 的 DispatchEnvelope artifact——**耐久 assigned 驱动至少一次发送**：
                                                    // 发送器严格按 §3.6 outbox 谓词重驱，绝无"无日志执行"或 uncertain 后继续发送
      permissionLeaseDigest: PermissionLeaseDigest; // 唯一激活的权限租约实例；不得以同 assignment 的另一张有效租约替换
      capIds: string[];                             // assignment capability 的唯一激活清单；票据在 received 后以 ticket-issued 单独耐久
      reservation: { reservationId: string; attempt: number } }   // 与同 CommitEnvelope 的 governor reserve 共同激活 AssignmentResourceLease；重派 attempt+1
  | { t: "dispatch-acked"; assignmentId: string }                 // accepted=true 或 conflict 的 accepted 侧全等 assigned；写入即停止 outbox
  | DispatchConflictRecord
  | DispatchConflictContainmentRecord
  | { t: "assignment-superseded"; assignmentId: string; proof: AssignmentTerminationProof }   // 重派前置：同 envelope 吊销能力/活跃票据、终结旧租约
  | { t: "cancel-fence"; assignmentId: string; fenceSeq: number; requestId: string }
  | { t: "ticket-issued"; ticket: DataPlaneTicket }              // owner 重启后仍可枚举、续期与吊销全部活跃票据
  | { t: "ticket-revoked"; ticketId: string }
  | { t: "capability-revoked"; capId: string; assignmentId: string }   // §2.2 capability 吊销的耐久落点
  | { t: "interaction-mirror"; assignmentId: string; entries: InteractionMirrorEntry[] }   // 审计镜像落点
  | { t: "state"; runId: string; state: ConversationRunState; statusRevision: number }
  | { t: "committed"; runId: string; assignmentId: string; bundle: { ref: ArtifactRef }; commitRevision: number }
  | { t: "resolution"; runId: string; fact: UncertainResolutionFact }
  | ConversationChannelChallengeRecord;   // conversation 渠道确认的 challenge outbox（重启按 prepared−closed 重驱渠道消息，语义与 job relay 同构）

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
  | { t: "occurrence"; occ: JobOccurrence } | { t: "task-revision"; def: TaskDefinition }
  | { t: "system-started"; jobRunId: string; fence: SystemJobFence }   // 6.2b 行 2 的耐久落点（system job 无 assignment，fence 落本流）
  | { t: "admitted"; jobRunId: string; taskId: string; scheduledFor: IsoTime;
      ingress?: IngressContext }   // 手动 job-run 携发起 surface（interact 票据签发依据）；定时触发无
  | { t: "assigned"; jobRunId: string; assignmentId: string; executorId: string; manifestDigest: Digest;
      dispatchRef: ArtifactRef; permissionLeaseDigest: PermissionLeaseDigest; capIds: string[];
      reservation: { reservationId: string; attempt: number } }   // 与 run 流同构：capability 激活清单 + 同 envelope reserve 的租约激活锚
  | { t: "dispatch-acked"; assignmentId: string }
  | DispatchConflictRecord
  | DispatchConflictContainmentRecord
  | { t: "assignment-superseded"; assignmentId: string; proof: AssignmentTerminationProof }
  | { t: "cancel-fence"; assignmentId: string; fenceSeq: number; requestId: string }
  | { t: "ticket-issued"; ticket: DataPlaneTicket }
  | { t: "ticket-revoked"; ticketId: string }                     // 手动 job-run 的 interact / abort 票据吊销，与 run 流同构
  | { t: "capability-revoked"; capId: string; assignmentId: string }   // 与 run 流同构：job assignment 的 capability 吊销落点
  | { t: "interaction-mirror"; assignmentId: string; entries: InteractionMirrorEntry[] }
  | { t: "state"; jobRunId: string; state: JobRunState; statusRevision: number }
  | { t: "committed"; jobRunId: string; assignmentId: string; bundle: { ref: ArtifactRef }; jobRevision: number }
  | { t: "resolution"; jobRunId: string; fact: UncertainResolutionFact }
  | ChannelInteractionRelayRecord;

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
  | { t: "received"; envelope: { ref: ArtifactRef }; activation: AssignmentActivationProof }
  | { t: "dispatch-rejected"; dispatchDigest: Digest; reason: AuthorityError }   // 拒收终态——先耐久并生成 DispatchRejectionProof 再返回，
                                                          // 此后同 assignment 永不执行，owner 可安全重派
  | { t: "supersede-fenced"; fenceSeq: number; requestId: string }   // 重派栅栏：此后 started / 一切新动作拒绝；
                                                          // fence 先于 dispatch 到达时本记录即该 assignment 流首记录 = tombstone，迟到 dispatch 永久拒
  | { t: "started" }
  | { t: "interaction-requested"; requestId: string; kind: "allow-once"; toolName: string;
      display: { title: string; lines: string[] };    // 脱敏且足以决策的结构化展示载荷（≙ 现 ConfirmationDisplay 投影）
      issuedAt: IsoTime; ttlMs: number; expiresAt: IsoTime } // executor 时钟，expiresAt = issuedAt + ttlMs（不等即拒）；恢复按 expiresAt，跨机按 issuedAt + TTL
                                                       // pending = requested 无同 requestId 的 finished
  | { t: "interaction-finished"; requestId: string; kind: "allow-once";
      outcome: { t: "answered";      authority: InteractionAnswerAuthority; decision: { allowed: boolean; reason?: string }; by: string }
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
  | { t: "bundle_sealed"; bundle: { ref: ArtifactRef }; mutationBatch?: { ref: ArtifactRef } }   // = completed；封包胜负点
  | { t: "acked"; commitRevision: number }
  | { t: "mirrored"; upTo: number };
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

副作用起止纪律：每次真实副作用必为配对的 `side-effect-started / side-effect-completed`（同 effectSeq）；`halted` 与 `bundle_sealed` 之前全部 effect 必已闭合（completed，status 可为 aborted）；崩溃恢复发现未闭合 effect 时**不得补写** `halted`，只能如实上报账本 → owner 判 uncertain，未闭合 effect 即证据链。

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
  | { t: "queued";  reservationId: string; admissionClass: AdmissionClass }   // 公平队列入队事实
  | { t: "reserve"; lease: ReservableResourceLease }                          // **本记录才是租约激活事实**，仅有签名候选一律无效；assignment/system-job 还须同 envelope 存在对应 assigned/SystemJobFence
  | { t: "consume"; usageSeq: number; rootReservationId: string; reservationId: string; usageId: string; tokens?: number; calls?: number; costMinor?: number }   // usageSeq 按根 reservation 连续分配——UsageReport 连续性的凭据
  | { t: "settle"|"release"|"reclaim"; reservationId: string };
// 幂等键：reserve=reservationId；consume=usageId；settle/release/reclaim=reservationId+t（重复即幂等返回）

type TransferRecord =      // 物理流固定 transfer:<transferId>；prepared 后各记录校验 scope / subject / epoch 不变；源 / 目标两端各自落流
  | { t: "prepared";   transferId: string; scope: "conversation"|"anchor"; subject: string; sourceEpoch: number }
  | { t: "frozen";     transferId: string; proof: SourceFreezeProof }
  | { t: "imported";   transferId: string; checkpointDigest: Digest }
  | { t: "committed";  transferId: string; commit: AnchorTransferCommit | ConversationTransferCommit; targetEpoch: number }
  | { t: "tombstoned"; transferId: string }
  | { t: "aborted";    transferId: string; abort: { decidedBy: string; reason: string; signature: Signature } };

type TrustStreamRecord    = { t: "trust-event"; event: HomeTrustEvent };
type PairingStreamRecord  = { t: "pairing-attempt"; offerId: Ulid; outcome: "failed"|"succeeded" };   // 爆破限次的耐久计数载体（§2.1）
type ExposureStreamRecord = { t: "exposure"; record: CredentialExposureRecord };
type DeliveryEndpointDto =
  | { kind: "channel"; target: DeliveryTargetDto }
  | { kind: "webhook"; endpoint: SecretRef };       // endpoint 仍只含引用，发送时由锚点 SecretStore 解引用
type DeliveryEnqueueKeyBody =                         // idempotencyKey 的唯一字段单源；持久化后可独立复算，五域组合在类型层封死
  | { kind: "job-result-delivery"; taskId: string; jobRunId: string; planDigest: Digest }
  | { kind: "staged-delivery"; assignmentId: string; mutationSeq: number }
  | { kind: "conversation-final-delivery"; conversationId: string; runId: string; commitRevision: number }
  | { kind: "conversation-status-delivery"; conversationId: string; runId: string; statusRevision: number }
  | { kind: "job-status-delivery"; taskId: string; jobRunId: string; statusRevision: number };
interface DeliveryIntentDto {                        // enqueued 的不可变权威输入；不携任何生命周期字段
  endpoint: DeliveryEndpointDto; content: OutboundContentDto | { ref: ArtifactRef };
  priority: "low"|"normal"|"high";
  source?: { kind: "scheduler"; taskId: string; taskName: string; createdInTurn?: string }
         | { kind: "agent"; conversationId: string }
         | { kind: "system"; reason: string };
  createdAt: IsoTime; maxAttempts: number }           // createdAt = 产生该 intent 的权威 CommitEnvelope.at；重放读取原值，禁止取当前时间
interface DeliveryFailure { code: string; message: string /* 脱敏文案，禁止响应体 / URL / header */; retryable: boolean }
interface DeliveryResolutionFact {
  itemId: string; attempt: number; openedAnchorEpoch: number; resolvedAnchorEpoch: number; openFactDigest: Digest;
  decision: "user-verified-sent"|"abandon"|"retry-risk-ack";
  by: string; at: IsoTime; factDigest: Digest }
type DeliveryItemState = "queued"|"attempting"|"retry-wait"|"uncertain"
  | "sent"|"failed"|"verified-sent"|"abandoned";  // sent=外部回执；verified-sent=用户核验，二者绝不混写
type DeliveryStreamRecord =                      // delivery 流 = 投递生命周期的**唯一事实源**；现有 DeliveryItem / 队列文件均为可重建投影
  | { t: "enqueued";        itemId: string; keyBody: DeliveryEnqueueKeyBody; idempotencyKey: string; intentDigest: Digest;
      intent: DeliveryIntentDto; statusRevision: number } // itemId=`dlv-...` 与 idempotencyKey 仅此处分配；intentDigest=`D("DeliveryIntentDto",1,intent)`
  | { t: "attempt-started"; itemId: string; attempt: number; startedAt: IsoTime;
      unknownOutcome: { kind: "idempotent-redrive"; redriveUntil: IsoTime } | { kind: "manual-resolution" };
      statusRevision: number }                    // **发送前先 fsync**；adapter 能力与有界 redrive 截止点一并冻结
  | { t: "sent";            itemId: string; attempt: number; receipt?: { digest: Digest; platformMessage?: ChannelMessageRef }; statusRevision: number }  // 外部回执事实，非用户核验
  | { t: "retry-scheduled"; itemId: string; attempt: number; retryAt: IsoTime; error: DeliveryFailure; statusRevision: number }
  | { t: "failed";          itemId: string; attempt: number; error: DeliveryFailure; statusRevision: number }            // 永久失败（可重试类走 retry-scheduled）
  | { t: "delivery-uncertain"; itemId: string; attempt: number; openedAnchorEpoch: number; openedAt: IsoTime; openFactDigest: Digest; statusRevision: number }
  | { t: "delivery-resolved"; fact: DeliveryResolutionFact; statusRevision: number };                                   // 用户裁决不可变，**绝不伪造外部 sent**
// enqueued 只能由五类权威生产者的内部构造器生成；目标态删除公开生产接口 IDeliveryPipeline.enqueue(EnqueueParams)（现状字段见 §1.3 源码引用），wire DTO 与 mutation
// 均不得携 itemId / keyBody / idempotencyKey / intentDigest / createdAt / maxAttempts，反序列化遇这些自报字段即拒绝。内部构造器从同 envelope 的权威事实派生 keyBody，
// 以 D("DeliveryEnqueueKeyBody",1,keyBody) 生成 idempotencyKey，以 D("DeliveryIntentDto",1,intent) 生成 intentDigest；
// committed 结果与非 committed 状态使用不同 kind，后者以 journal.statusRevision 定位；迁居 / 重放不改键，不同 revision 不得合并为同一 item。
// priority：staged/维护通知默认 normal；job 取冻结 task priority，urgent 映射 high。maxAttempts 是**自动发送次数上限**，取锚点当时版本化投递策略
// 并冻结为正整数；幂等 redrive 的 deadline 同由该策略在 attempt-started 时冻结。用户每次 retry-risk-ack 可额外授权恰一次 attempt，不修改 maxAttempts，后续配置变化也不改旧 item。
// openFactDigest = D("DeliveryOpenFact",1,{itemId,attempt,openedAnchorEpoch,startedAt,unknownOutcome,idempotencyKey})；迁居不改写打开事实。
// resolution.factDigest = D("DeliveryResolutionFact",1,{itemId,attempt,openedAnchorEpoch,resolvedAnchorEpoch,openFactDigest,decision,by,at})。resolvedAnchorEpoch 必为提交时当前 epoch，
// by 只取已认证 principal；重复响应 / 旧裁决按 itemId+attempt 幂等吸收或拒绝。
// DeliveryItem adapter 只从 enqueued intent + 后续事实投影 id / attempts / nextAttemptAt / lastError；这些可变字段不得反写权威流。
type IntentStreamRecord   = { t: "intent"; intent: DeferredGlobalIntent };
type RecoveryActivationPlan =
  | { kind: "establish"|"rotate"; rootEvent: HomeTrustEvent }
  | { kind: "domain-reset-establish"; resetEvent: HomeTrustEvent; rootEvent: HomeTrustEvent };
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
  kind: "late-bundle-committed"|"proven-not-started-redispatched"
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
| 2 | queued | drain 取得发送资格 | endpoint ready；nextAttempt=1 或 prior+1；nextAttempt≤maxAttempts，或存在尚未消费的前一 attempt `retry-risk-ack` | attempting | **外部调用前** fsync `attempt-started(nextAttempt, unknownOutcome, statusRevision+1)`；幂等 endpoint 冻结 redriveUntil，非幂等用 manual-resolution；消费手动授权（若有）后发送 |
| 3 | attempting | 外部返回成功 | 响应属于当前开放 attempt | sent | 写 `sent(statusRevision+1)`；回执仅作外部事实 |
| 4 | attempting | 外部返回明确失败 | retryable 且 attempt<maxAttempts | retry-wait | 写 `retry-scheduled(retryAt, error, statusRevision+1)` |
| 5 | attempting | 外部返回明确失败 | 非 retryable 或 attempt≥maxAttempts | failed | 写 `failed(statusRevision+1)`，终态 |
| 6 | attempting | 恢复发现 started 无结果 | unknownOutcome=idempotent-redrive 且 now≤redriveUntil | attempting | 由原 started 记录有界重驱**同一 attempt / idempotencyKey**；不追加 lifecycle 记录、不增 revision |
| 7 | attempting | 恢复发现 started 无结果 | unknownOutcome=manual-resolution，或幂等 redrive 已过 redriveUntil | uncertain | 写 `delivery-uncertain(openFactDigest, statusRevision+1)`；禁止盲发或无限重驱 |
| 8 | retry-wait | retryAt 到期 | 当前记录仍是该 item 最新非终态，且 attempt+1≤maxAttempts | attempting | fsync `attempt-started(attempt+1, unknownOutcome, statusRevision+1)` 后复用原 idempotencyKey 发送 |
| 9 | uncertain | 当前 attempt 的迟到成功回执 | openFactDigest 仍打开且响应可验证 | sent | 写 `sent(statusRevision+1)`，自动关闭 uncertain；不伪造用户裁决 |
| 10 | uncertain | 当前 attempt 的迟到明确失败 | openFactDigest 仍打开；retryable 且 attempt<maxAttempts | retry-wait | 写 `retry-scheduled(statusRevision+1)`，自动关闭 uncertain |
| 11 | uncertain | 当前 attempt 的迟到明确失败 | openFactDigest 仍打开；非 retryable 或 attempt≥maxAttempts | failed | 写 `failed(statusRevision+1)`，自动关闭 uncertain |
| 12 | uncertain | 用户裁决 user-verified-sent | 已认证用户 + 当前 anchorEpoch + itemId/attempt/openFactDigest 全验 | verified-sent | 同 envelope 写 `delivery-resolved(openedAnchorEpoch, resolvedAnchorEpoch=当前值)` + control applied；该事实绝不投影成外部 `sent` |
| 13 | uncertain | 用户裁决 abandon | 同 12 | abandoned | 同 envelope 写 `delivery-resolved` + control applied，终态 |
| 14 | uncertain | 用户裁决 retry-risk-ack | 同 12 | queued | 同 envelope 写 `delivery-resolved` + control applied；产生仅供 nextAttempt 消费一次的手动授权 |
| 15 | sent / failed / verified-sent / abandoned | 任意发送、响应或裁决迟到 | — | 原终态 | 相同幂等键回放原结果；其余拒绝且不追加 lifecycle 记录，状态与 revision 不变 |

**入队前置裁决（不是 lifecycle 状态转移，不占表行）**：AuthorityCommitLog 在同一串行 append 临界区内原子执行“唯一索引查 key → 校验 → 追加整个来源 CommitEnvelope → 更新索引”，禁止先查后写的 TOCTOU。key 已存在且 `intentDigest` 相同，直接返回原 itemId、当前 state 与 statusRevision，零追加、零状态变化；digest 不同返回 `idempotency-conflict(retryable=false)`，整个来源 envelope 零写入。唯一索引与 envelope 在同一次 fsync 生效：fsync 前任一点崩溃均无新事实，fsync 后响应丢失按原 key 回放；并发同 key 由日志串行化后恰一创建、其余走上述重复裁决。

| 入队承诺 | 唯一承载 |
|---|---|
| 五类身份及字段组合不可混用 | `DeliveryEnqueueKeyBody` 判别联合；`enqueued.keyBody / idempotencyKey` |
| 同键载荷必须一致 | `enqueued.intent / intentDigest`；前置裁决的同 digest 回放、异 digest 拒绝 |
| 调用方不能自报权威字段 | `DeliveryRequestDto` / `JobCommitBundle` 白名单 + enqueued 内部构造器规则 |
| 时间与策略重放稳定 | `DeliveryIntentDto.createdAt = CommitEnvelope.at`、冻结 `maxAttempts`；重放读取原 enqueued |
| 查重、来源事实与入队零半提交 | §4.1 单 envelope / 单 fsync + 本节串行唯一索引；生命周期表行 1 只承载“无 key → queued” |

投影纪律：每次 lifecycle append 都以 `(itemId, currentAnchorEpoch, latestState, statusRevision, currentAttempt)` 做 CAS，失败即重读；迁居只换 currentAnchorEpoch、不换 itemId / revision 序，故同一 item 任一时刻至多一个开放 attempt。`delivery-resolved(user-verified-sent)` → verified-sent，`abandon` → abandoned，`retry-risk-ack` → queued；只有 `sent` 记录投影外部 sent。任何不属于**当前开放 attempt** 的响应均拒绝且不得追加 lifecycle 记录或改变状态，即使 item 因 retry-risk-ack 已回到 queued（非权威诊断日志可选）。每次表内实际状态转移严格写 `statusRevision+1`；幂等回放与行 15 不增号。验收从空日志重建状态，并在 enqueued / started / 外部调用 / 结果落盘 / retryAt / 三种裁决及 anchor 迁居前后逐点崩溃注入，断言零静默丢失、可证明路径零重复、maxAttempts 与单次手动授权不越界、旧 epoch 拒绝、unknown 零永久悬空。

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

type ControlRequest =
  | { t: "input";      conversationId: string; ingress: { ingressId: string; source: IngressContext["kind"] };
      input: UserTurnInput; ownerEpoch: number }   // 完整 IngressContext 由 owner 派生（channel 分支的 responder / replyTarget 取自渠道认证事实）
  | { t: "cancel";     conversationId: string; runId: string; ownerEpoch: number }
  | { t: "session-create"; requestedName?: string; sceneId?: string }    // 路由到目标 owner（默认锚点；离线本地新会话就地）
  | { t: "session-write"; conversationId: string; mutation: SessionControlMutation; ownerEpoch: number; domainRevision: number }
  | { t: "global-write";  mutation: GlobalControlMutation; anchorEpoch: number; domainRevision: number }
  | { t: "job-run";    taskId: string; anchorEpoch: number }             // 手动立即执行：写 occurrence，与定时触发同构
  | { t: "job-cancel"; taskId: string; jobRunId: string; anchorEpoch: number }
  | { t: "allow-once"; assignmentId: string; interactionRequestId: string;
      response: { via: "surface-ticket"; ticketId: string; decision: { allowed: boolean; reason?: string } }
              | { via: "channel-grant"; grant: ChannelInteractionGrant } }
  | { t: "uncertain-resolve"; ref: ExecutionRef; openFactDigest: Digest;   // 总纲三选裁决的 wire 入口——绑定打开中的 resolution fact，
      decision: "user-verified-side-effects"|"user-abandoned"|"user-retry-acknowledged" }   // 旧 fact / 已关闭 fact / 旧 epoch 一律拒绝
  | { t: "delivery-resolve"; itemId: string; attempt: number; anchorEpoch: number; openFactDigest: Digest;   // 投递 uncertain 的用户裁决（§4.3 delivery 流）
      decision: "user-verified-sent"|"abandon"|"retry-risk-ack" };
```

路由由 `t` 静态决定：`input / cancel / session-create / session-write` → 对话 owner；`global-write / job-run / job-cancel / delivery-resolve` → 锚点；`uncertain-resolve` 按 `ref.execution` → conversation owner / 锚点。job-run / job-cancel 的 guard 校验目标 task：`TaskDefinitionBody.kind:"system"` 一律 unauthorized——system 任务的触发与取消只属锚点时钟与 host principal（6.2b 行 1）。两类 resolve 均验已认证用户、当前 epoch、仍打开的 subject / attempt 与 `openFactDigest`，重复 requestId 回放原结果，旧 fact / 已关闭 fact 拒绝。`allow-once` → executor 的 assignment 事务域：surface 分支验 run-interact 票据的 assignment / surfacePrincipal，channel 分支对 grant 与其内嵌 challenge token 分别验锚点签名，并验 job ref、assignment / interaction / challenge、route / responder、decision 与 expiry 全绑定，且 channel grant 禁用于 conversation / 手动 surface；成功后记录的 authority / decision / by 全由已验凭证派生，镜像 owner 仅审计。配对与秘密录入不走本信封（mesh / SecretStore 专用流程）。非法组合（字段与 `t` 不匹配）在反序列化层拒绝。

### 5.2 派发（conversation / job 分支）

```ts
type DispatchEnvelope =                          // 按 execution 判别的**单一闭合合同**——一份派发只有一个域分支，
  | { execution: "conversation"; assignmentId: string; executorId: string;   // 主体 / 基线 / epoch / 全部凭证在类型层完全同域
      manifest: ExecutionManifest & { baseRef: { execution: "conversation" } };
      permissionLease: PermissionSnapshotLease & { binding: { execution: "conversation" } };
      capabilities: Array<Extract<AuthorityCapability, { scope: { execution: "conversation" } }>>;
      resourceLease: Extract<AssignmentResourceLease, { workload: { kind: "run" } }>;
      dependencyArtifacts: ArtifactRef[];        // 必填（无传递依赖 = []）：work 直接 root 引用解引用后的传递闭包，不重复 root；
                                                 // executor 接受前对 root ∪ dependency 逐一验在场（§4.2），缺件即 missing-base 拒收
      issuedAt: IsoTime; signature: Signature; work: ConversationDispatch }
  | { execution: "job"; assignmentId: string; executorId: string;
      manifest: ExecutionManifest & { baseRef: { execution: "job" } };
      permissionLease: PermissionSnapshotLease & { binding: { execution: "job" } };
      capabilities: Array<Extract<AuthorityCapability, { scope: { execution: "job" } }>>;
      resourceLease: Extract<AssignmentResourceLease, { workload: { kind: "job" } }>;
      dependencyArtifacts: ArtifactRef[];
      issuedAt: IsoTime; signature: Signature; work: JobDispatch };
// S1 在 contracts 以泛型参数落地上述收窄（spec 的交叉类型仅表达约束语义）；executorId 在签名域内，与全部凭证的 executorId 同值。
// **域一致性唯一校验 `validateDispatchBinding`**——owner 派发构造器与 executor 准入 guard 共用同一实现（进程内与 mesh 同一函数）：
// 逐字段校验 manifest.baseRef、work（runId / jobRunId、baseRevision / fence、epoch）、全部 capability 的 scope / assignmentId、
// permissionLease.binding、resourceLease 的 workload / scopeBinding / audience.executorId / activation.assignmentId 与信封 execution / assignmentId /
// executorId **同域同值**。任何缺字段、跨域、错基线、错 epoch / assignment / executor、数组混入异域 capability →
// executor 在写 `received`、签发数据面票据与 started **之前**以 `dispatch-rejected` 耐久拒收（禁止降级执行）；
// owner 按既有 AssignmentTerminationProof 路径关闭旧 assignment、吊销凭证、终结租约后重排。
// **owner 派发原子流水线（顺序冻结）**：① `matchManifest` 先行，失败不创建任何候选；② `prepareAssignmentRoot` 与凭证签发器只在内存构造
// AssignmentResourceLease / AuthorityCapability / PermissionSnapshotLease 候选；③ 组装 DispatchEnvelope 并过 `validateDispatchBinding`；④ artifact 先 fsync；
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
  assetVersions: { skillsRev: number; rubricsRev: number; promptAssetsRev: number; permissionSnapshotVersion: number };
  credentialBindingRevisions: Array<{ bindingId: string; revision: number }>;
  at: IsoTime; signature: Signature }

interface CredentialBindingDescriptor { bindingId: string; service: string; resource?: string;
  principalFingerprint?: Digest; tenant?: string; scopes?: string[];
  verification: "service-verified"|"user-alias"; revision: number }

interface ExecutionManifest {
  baseRef: { execution: "conversation"; conversationId: string; baseRevision: number }      // 派发时刻冻结的会话基线，与 work / 提交栅栏同值
         | { execution: "job";          taskId: string; jobRunId: string; taskRevision: number };   // 判别化——空 base / 双 base 类型层不可构造
  requires: ExecutorVersionInventory["configVersions"] & ExecutorVersionInventory["assetVersions"];
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

**匹配函数唯一**：`matchManifest(manifest, descriptor, inventory) → ok | AuthorityError("revision-conflict"|"capability-gap")`——owner 选机用最近 inventory 预判、executor 开跑前原子复验，两处共用同一实现；任一失配拒绝执行，owner 重排或排队。职责分界：matchManifest 只管**版本与能力**匹配；派发的**域一致性**归 `validateDispatchBinding`（§5.2）。owner 为避免产生无用候选，顺序固定为 `matchManifest → 构造候选 → validateDispatchBinding → 原子激活`；executor 已收到完整信封与证明，顺序固定为 `validateAssignmentActivation → validateDispatchBinding → matchManifest → received`。两端使用同一 match/binding 函数，远端只额外验证 owner 激活证明。

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

- **conversation CAS**：先按 §1.2 复算 `SealedBundle.digest` 与全部引用目标，再验栅栏全字段（ownerEpoch / assignmentId / baseRevision / executorId / digest）；该 assignment 有打开的 `dispatch-conflict(opened-uncertain)` fact 则 fence-rejected（不属于“合法 bundle”）→ 按 §4.2 提取并验 `rootArtifacts ∪ dependencyArtifacts` 全闭包已耐久在场（缺件拒绝）→ 同一 CommitEnvelope 原子写入：run 流 `committed`、会话元数据变更、内容资产索引、`publish-decision`、`FinalOutboxRecord(pending)`；仅当本 run 的耐久 `ingress.kind === "channel"` 时，再构造 `DeliveryIntentDto.endpoint = { kind: "channel", target: ingress.replyTarget }`，向 delivery 流写一条使用 §1.1 `conversation-final-delivery` 键的 `enqueued`。CAS 后应用 `windowCompact` 于窗口 / 快照，失败即弃、由 transcript 重建，不回滚已提交结果。
- **job CAS**：先按 §1.2 复算 `SealedBundle.digest`、`JobCommitFence.digest` 与全部引用目标，再验 fence 全字段（含 `deliveryPlanDigest` 与 occurrence 冻结 plan 一致）；该 assignment 有打开的 `dispatch-conflict(opened-uncertain)` fact 则 fence-rejected → 按 §4.2 验 `rootArtifacts ∪ dependencyArtifacts` 全闭包在场 → 同一 CommitEnvelope 原子写入：job 流 `committed`、任务投影变更、`delivery` 流逐项 `enqueued`——**由锚点按 occurrence 冻结的 `deliveryPlan` + bundle 结果构造不可变 `DeliveryIntentDto`，并在此唯一分配 itemId / idempotencyKey**（executor 对投递目标与生命周期零写权；job 权威与 delivery 流同属锚点物理 log，单 envelope 原子结构性成立）、`publish-decision`（仅 global 计数；conflicted 明细入该 occurrence 的观测投影并经维护通知呈现——job 无 FinalFrame 载体）。现有 DeliveryItem / 队列只由 delivery 流投影，不参与 CAS；job 不产生 FinalOutbox（结果经投递队列通知）。
- 重复 / 迟到提交按幂等键返回原 `commitRevision` / `jobRevision`。

### 5.5 终态与状态投递

RunJournal 为最终事实源；FinalOutbox 是"权威提交 → 实时通知"的有界桥：以 `(conversationId, runId, commitRevision, digest)` 向发布时刻已认证的同会话 observer 幂等推送 `FinalFrame`，不维护逐 surface 耐久确认；外部渠道按 `turnOrigin` 走 DeliveryOutbox，禁止跨渠道广播；断线重连与新 surface 以 last-seen `commitRevision` 从 owner 历史对账补终态。

**非 committed 状态的通知与裁决闭环**（committed 之外的每个终态 / 挂起态都可实时获知、断线补读、合法裁决恰一次）：

```ts
type ResolutionActionSet = ["verify-side-effects", "abandon", "retry-risk-ack"];
interface StatusNoticeBase<R, S, A extends [] | ResolutionActionSet> {
  ref: R; state: S; reason?: string; statusRevision: number; actions: A; at: IsoTime }
type ConversationStatusNotice =
  | StatusNoticeBase<Extract<ExecutionRef, { execution: "conversation" }>, "uncertain", ResolutionActionSet>
  | StatusNoticeBase<Extract<ExecutionRef, { execution: "conversation" }>, Exclude<ConversationRunState, "committed"|"uncertain">, []>;
type JobStatusNotice =
  | StatusNoticeBase<Extract<ExecutionRef, { execution: "job" }>, "uncertain", ResolutionActionSet>
  | StatusNoticeBase<Extract<ExecutionRef, { execution: "job" }>, Exclude<JobRunState, "committed"|"uncertain">, []>;
type DeliveryStatusRef = { execution: "delivery"; itemId: string }; // attempt / anchorEpoch 均不参与身份；迁居前后 revision 序属于同一稳定 item
type DeliveryStatusNotice =
  | (StatusNoticeBase<DeliveryStatusRef, "delivery-uncertain", ResolutionActionSet> & { attempt: number; anchorEpoch: number })
  | (StatusNoticeBase<DeliveryStatusRef, "delivery-failed", []> & { attempt: number; anchorEpoch: number })
  | (StatusNoticeBase<DeliveryStatusRef, "delivery-resolved", []> & {
      attempt: number; anchorEpoch: number; decision: DeliveryResolutionFact["decision"] });
type ExecutionStatusNotice = ConversationStatusNotice | JobStatusNotice | DeliveryStatusNotice;
```

- **实时**：状态转移落 journal 的同一 CommitEnvelope 内写可确定投影 notice 的全部字段；run/job 为渠道来源时，同 envelope 按 §1.1 的 conversation/job status 分支以本次 `statusRevision` 向原渠道 DeliveryOutbox 入队，surface 经 owner 控制事件收 notice。delivery 自身失败/unknown 不递归向同一 item 入队，而是推送当前已认证维护 surface 并由 server.info 持久补读；因此通知路径失败不会制造第二个投递事实。
- **版本**：每个 `ExecutionRef` 的 run / job journal `state.statusRevision` 与每个稳定 `DeliveryStatusRef(itemId)` 的 `statusRevision` 均从 1 开始、每次实际状态转移严格 `+1`；初始 queued 与 admitted / occurrence、delivery enqueued 与其权威输入各在同一 envelope 写入。attempt 与 anchorEpoch 变化均不换 delivery revision 序；notice 另携当前 anchorEpoch 供控制请求 fencing。幂等重放同一转移不增号，notice 与补读投影只能取该耐久值，不得另行计数。
- **补读**：`server.info` 与历史查询按 `statusRevision` 提供状态投影——断线重连以 last-seen statusRevision 对账，与 FinalFrame 补读同构。
- **裁决**：`uncertain-resolve` / `delivery-resolve` 控制请求（§5.1）由对应工作权威处理；guard 验已认证用户 + 当前 epoch + subject / attempt + `openFactDigest` 等于打开中的 fact 摘要——重复请求回放原结果，旧 epoch / 旧 fact / 已关闭 fact 拒绝；resolution fact、状态转移与 control `applied` 合入同一原子提交（6.1 行 24-26 / 6.2 行 26-28 / delivery 流的 wire 承载）。

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
        { t: "requested"; requestId: string; toolName: string; display: { title: string; lines: string[] };
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
| 23 | uncertain | 事后取得 `AssignmentTerminationProof` | 证明验签并绑定当前 assignment / executor / dispatch digest、supersede fence 或 cancel fence/ticket 及账本链头；若来自 dispatch-conflict 的 CancelProof，账本链必须严格后继于该 conflict 的 received 前缀 | queued | 同 envelope superseded + 吊销全部 capability / ticket + 终结旧租约；dispatch-conflict 分支另写 contained + resolution(`proven-not-started-redispatched`)；自动重派（新 assignment） |
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
| 36 | uncertain | dispatch-conflict 止损取得 `CancelProof(halted)` | proof 全验并绑定当前 fence；账本链严格后继于 conflict 的 received 前缀；全部 effect 闭合 | uncertain | 写 `dispatch-conflict-contained`，停止 cancel outbox；保留打开 fact 与提交 fence，向用户呈现证据，租约待裁决时按 §十收束 |

附加规则：uncertain 存在未裁决 → 该对话禁止正常续跑（行 22/23 的自动解析除外）。

### 6.2 job run（本表仅适用 `TaskDefinitionBody.kind:"user"`；system 任务走 6.2b，两表互斥）

```ts
type JobRunState = "queued"|"dispatched"|"running"|"cancel-requested"
  |"committed"|"cancelled"|"failed"|"expired"|"missed"|"uncertain";
```

| # | 当前态 | 触发 | 守卫 | 次态 | 动作 |
|---|---|---|---|---|---|
| 1 | —（触发） | 到点 / 手动 job-run | task enabled 且无同 task uncertain | queued | 写 occurrence（绑当时 taskRevision / 冻结 deliveryPlan） |
| 2 | —（触发） | 到点触发 | 同 task 存在未裁决 uncertain | missed | 只记 missed，不补跑 |
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
| 25 | uncertain | 事后取得 `AssignmentTerminationProof` | 证明验签并绑定当前 assignment / executor / dispatch digest、supersede fence 或 cancel fence/ticket 及账本链头；若来自 dispatch-conflict 的 CancelProof，账本链必须严格后继于该 conflict 的 received 前缀 | queued | 同 envelope superseded + 吊销全部 capability / ticket + 终结旧租约；dispatch-conflict 分支另写 contained + resolution(`proven-not-started-redispatched`)；自动重派 |
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
| 38 | uncertain | dispatch-conflict 止损取得 `CancelProof(halted)` | proof 全验并绑定当前 fence；账本链严格后继于 conflict 的 received 前缀；全部 effect 闭合 | uncertain | 写 `dispatch-conflict-contained`，停止 cancel outbox；保留打开 fact 与提交 fence，向用户呈现证据，租约待裁决时按 §十收束 |

任务定义规则：更新只影响后续 occurrence；旧 occurrence 永不覆盖或复活 TaskDefinition。uncertain 解析前该 task 持续暂停，期间到期只记 missed。

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

system job 无 assignment、无 manifest / capability、无 CancelProof——执行体与权威同进程，fence 兼作幂等、审计与持租锚；资源准入经锚点 governor 的 scheduler-class 租约，与 user job 共用同一治理面；**全部租约终结动作（settle / release / reclaim）幂等且随所属状态转移同 envelope 落定，正常路径零"依赖过期回收"**。

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

创建即写 `checkpoint` 流记录（§4.3）；周期每日一次 + 迁居前强制一次。**根激活原子边界**：首次 establish / rotate 先生成一条已签名但未生效的 root event；恢复包丢失则先生成连续且均已签名的 `domain-reset + establish` 计划，reset 不得提前单独入链。以候选 `recoveryBackupPublicKey` 生成包含该计划的全量 `CheckpointEnvelope`，耐久写 created，复制到 ≥1 个独立目标；持候选主秘密的引导端必须从该目标实际回读、解封、校验 envelope / manifest / 分块摘要并签 `RecoveryCheckpointVerification`。只有 created→replicated→verification 全链逐字段通过后，锚点才在**同一 CommitEnvelope**原子写入计划内全部 trust event、`checkpoint-verified` 与旧检查点 `checkpoint-superseded`；该提交是新根唯一激活点。rotate / domain-reset 在此之前旧 trust 状态不变，首次 establish 在此之前仍为 no-root / not-ready，任何网格能力不得提前开放。任一前置步骤失败或崩溃只留下未激活候选，可按 checkpointId 幂等续做或 GC，不改变当前根；原子提交后投影必同时得到“当前根 + 对应已验证独立备份”，不存在链上有效新根而备份未验证的窗口。旧根封装备份激活后标记不可用，**不假设可 rewrap**。恢复 = 用户主秘密派生封装私钥解 DEK → 校验 manifest / 分块摘要并应用已绑定的 activation plan → 安全域换代（总纲 §9）；恢复端到端验收随 S9（候选创建 / 复制 / 回读 / 签证 / 原子激活各点崩溃注入，伪造 verification、错 checkpoint / key / digest / target / nonce、计划断链、目标不可达重试、新旧根选择）。

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
- 结算：`consume(usageId)` 幂等累计 → `settle` 单次结算 → `release` 归还余额；expiry 未 settle 由 governor `reclaim`（按已 consume 记账、余额归还）；全部动作落 GovernorRecord（§4.3）。
- **全 workload 租约终结表**（每个 workload kind 的每个终态都有显式终结动作，正常路径零"依赖过期回收"；全部动作幂等）：

| workload | 终结触发 | 动作 |
|---|---|---|
| run / job | committed | owner 收到 SealedBundle `usageFinal` 对账收敛后，settle + release 与 `committed` 记录同 envelope |
| run / job | cancelled **且从未 assigned** | 零动作——queued 取消没有 reservation，禁止伪造 CancelProof 或治理记录 |
| run / job | cancelled **且曾 assigned** | 有合法 CancelProof / usage 水位 → 对账后 settle + release；用户裁决等无可核验水位路径 → reclaim（按已上报 consume 记账、余额归还） |
| run / job | failed / expired **且从未 assigned** | 零动作——reservation 随 `assigned` 才产生（§4.3），派发前终态无租约可终结 |
| run / job | failed / expired **且曾 assigned** | 按已 consume 水位 settle + release（无水位可得则 reclaim） |
| run / job | uncertain → committed / cancelled / failed（裁决） | 按裁决出的终态行执行；迟到 bundle / proof 有水位则对账，无可核验水位则 reclaim，禁止猜测 settle |
| run / job | uncertain → queued（证实未 started 重派） | **旧 assignment 租约先终结**（未 consume 全额 release；失联无对账则 reclaim），新 assignment 以 attempt+1 重取新租约 |
| run / job | uncertain 未裁决 | 挂起不终结；executor 失联超期由 `reclaim` 兜底 |
| system job | committed / failed / cancelled | 见 6.2b（同 envelope settle / release，已冻结） |
| control（准入 / 裁判 / 收场） | 调用返回（成功 / 失败 / abort） | 调用方 finally 内 settle + release——ControlCompletionPort / AdvancementReviewerPort 的调用合同 |
| evidence | EvidenceBundle 交付 / typed-stale 保持 deferred 的终态 | executor 侧子租约 settle + release，随 intake 上报对账 |
| orchestration-node | 节点终态（completed / failed / aborted） | 子租约终结；父租约随所属 run 的行走 |
- 公平准入：anchor governor 按 `admissionClass` 维护加权队列，调度算法固定为加权差额轮询（WDRR），权重 interactive : advancement : scheduler : orchestration = 8 : 4 : 2 : 1（初值，S7 压测标定）；`queued / reserve` 记录承载入队与准入顺序，持续满载场景验证各类均有界获得配额、交互类恒不被自动类饿死。executor 半边做本机硬容量与背压，瞬时容量经独立短租约公告、不进 CapabilityDescriptor。
- 分域：锚点域根 lease 由 anchor governor 签发；本地域根 lease 由设备本地耐久 governor 签发（绑 `localDomainId / localGovernorEpoch`），只消费本机额度、不授权全局预算；两域同一租约合同与 guard；收编不追认本地消费为锚点预算；双拓扑测试随 S4 / S8 验收。
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
| 13 | 类型 + 集成：ExecutionStatusNotice 非法 ref/state/actions 组合；final 前后 UI；逐个 run/job 非 committed 入边与 delivery failed / uncertain / resolved；attempt / anchor 迁移；五类入队生产者；同一 execution 连续 statusRevision 与 committed 结果交错重放；同 key 注入相同 / 不同 intent；并发同 key；唯一索引查验前 / 查验后 fsync 前 / fsync 后响应前崩溃；重放时推进本地时钟；wire 注入六个禁止自报字段 | 非法组合无法构造；provisional 标注恒在、final 后转正；notice 实时 + 稳定 item statusRevision 单调补读、原渠道唯一投递；五类 keyBody 跨 kind / revision 零碰撞且可由 enqueued 独立复算；createdAt 保持来源 envelope 原值；同 key 同 digest 只回放原 item 当前态、异 digest 返回 idempotency-conflict 且整个来源 envelope 零写入；并发 / 崩溃后恰一 item；自报字段全拒；两类 uncertain 三选恰一次生效（重放 / 旧 epoch / 旧 fact 拒） |
| 14 | 依赖图 lint | server ↔ executor 零互 import |
| 15 | 集成：staged 写后 run 失败 / 取消 / uncertain | 外界零可见、零残留；崩溃注入下 publish 可续 |
| 16 | 对抗：越权方法 / 资源 / 过期 capability；五类 principal 各自越权（含非 owner 设备伪造 owner-control、伪造 usage-reporter）；owner-relay 错 authority / lease；渠道 token / grant 伪签、错 challenge / responder / route / assignment / interaction / displayDigest、改 decision、过期与跨域重放；EnvironmentControlGrant 越设备 / 绑定 / 时限 | 全部 unauthorized，进程内同 guard；token / grant 审计记录可独立验签，重复 callback 只回放原结果 |
| 17 | 集成 + 崩溃注入：重投 / 重连 / 权威重启；派发候选签发后、artifact fsync 前后、原子 `reserve+assigned`（含 permissionLeaseDigest）fsync 前后、ActivationProof 生成前后、executor `received` fsync 前后、send / ACK / rejection / conflict response / owner conflict 裁决单 envelope fsync 前后 / containment cancel 发送、executor proof fsync、owner contained / resolution 原子提交与吊销发送前后 / fence 各点，含重启后同 payload 重签、两类 conflict 响应丢失重试、fence 先到、查询后抢跑与重复 dispatch；system-job 候选与 `reserve+running+SystemJobFence` 同样逐点注入 | 原子提交前零有效凭证、零 reservation，孤立 artifact 可 GC；提交后 ActivationPayload 可由日志确定性重建且权限租约实例不漂移，重签可幂等接受；conflict 两分支重启后分别收敛到唯一 ACK 或唯一 uncertain+止损事实，派发/ControlLease 立即停止；cancel 无 proof 时义务保留且有界退避，not-started 时 contained+resolution+superseded+租约终结全有或全无并安全重派，halted 时唯一 contained、停止 cancel 且仍待用户裁决；零半提交，ConflictProof 永不授权重派；received 前 executor 本地凭证无效、received 后离线可验；reserve 与归属事实恒同时存在并由 assigned/system fence 重驱；至多一次准入、零无日志执行、零双活、零凭证 / 租约泄漏 |
| 18 | 对抗：无 lease / 伪造 / 复用 / 超额 / 重复 usageId / 伪报 admissionClass / 越 delegation 上限的子租约 / 全 workload kind；仅有签名候选、assignment reserve 无同 envelope assigned、capId 未列入 assigned、权限租约摘要未激活或以同 assignment 的另一张有效租约替换、executor 无 received activation / 伪造 activation、system-job reserve 无匹配 SystemJobFence；queued 取消与 uncertain 无水位裁决 | 未激活凭证全部拒绝，其余拒绝或幂等；executor 断开 owner 后仍凭已耐久 proof 正常验权，未要求在线回查；queued 取消零治理记录，无水位只 reclaim；WDRR 满载下各类有界获得配额，交互不被饿死 |

状态机逐边测试：4.3 delivery 十五行、6.1 三十六行、6.2 三十八行、6.2b 六行、6.3 十二行、6.4 十一行——每行一用例，禁止合并；其中 6.1 行 15–21 / 6.2 行 17–23 必跑 owner-fence × abort-ticket × sealed 三方竞态排列。签名与摘要域验收（§1.2）：逐字段篡改、错误包含自摘要/signature、引用错目标、跨 schema/version 重放、进程内/mesh 固定向量一致性，随 S2。

## 十三、模块文档影响清单（随对应节点修订，不提前改写）

| 文档 | 节点 | 修改内容 |
|---|---|---|
| transcript-persistence-and-attention-window-architecture.md | S3 | TranscriptRunRecord（现 RunRecord）增 runId 唯一键；接受协议改 SealedBundle 整包；windowCompact 明确为幂等缓存指令；写路径经对话 owner 的 AuthorityCommitLog，分片文件成为可由 log 幂等重建的投影（append-only 与"原文唯一权威"性质不变，原子性单元下移一层） |
| 同上 | S7 | MemoryFlush 挂点改为权威提交后经 GlobalStatePort 发布 |
| scheduler-architecture.md（及实现 spec） | S3/S7 | TaskDefinition / JobOccurrence 拆分（definition 分 user 白名单 Dto / system host-only 两族；webhook endpoint 整体 SecretRef；origin / interactionResponder / createdInTurn / system 恒锚点生成）、JobCommitFence（绑 deliveryPlanDigest）、派发用去敏 JobExecutionInstruction、system 任务与投递恒锚点本地执行、job uncertain 暂停语义、定时 job 的 owner-relay / channel challenge outbox、手动触发走 job-run 控制请求；删除 Scheduler 对 IDeliveryPipeline.enqueue 的直接生产依赖，job 结果只由锚点 CAS 写 delivery 流 |
| workscene-management-architecture.md | S7 | workdir 升级为稳定设备域引用 `{deviceId, bindingRef}`；每次派发由 ExecutionManifest 冻结当次 `workspaceBindingRevision`（不回写 workscene）；目录探测在目标 executor（WorkspaceProbeRequest / EnvironmentControlGrant 协议）；enter / exit 定性为会话域绑定（session-meta sceneId），注册管理留锚点 |
| task-advancement-rubric-architecture.md | S7 | EvidenceRequest / EvidenceBundle / ObservationToken 替换第一级取证实现描述；裁判经 ControlCompletionPort；review 子 lease；AdvancementSnapshot / AdvancementControlEvent 类型化落点；契约确认拆"快照采用（会话域）/ 库沉淀（全局写，离线转 DeferredGlobalIntent）"两半——confirmDraft 的 saveOwn / updateOwn 归后者。**类型合同（目标形态在此冻结，S7 按此改型）**：`ConfirmedRubricSnapshot` 的库身份改判别 `source: { kind: "library"; rubricId; rubricVersion } \| { kind: "local-draft"; snapshotId: Ulid; contentDigest: Digest }`——现类型（advancement/types.ts:143）强制 rubricId / rubricVersion，离线确认在类型层不可实现；local-draft 分支使契约不依赖全局 id 即可生效，收编沉淀成功后经修订 link 回库 |
| unified-core-and-access-surfaces.md | S1 | 宿主内部拓扑更新为角色装配（五包抽取） |
| message-outbox.md（顺序层） | S3 | delivery-origin OutboxEntry 必带 delivery 流既有 idempotencyKey（其他非耐久消息仍可选），只承接 per-target 顺序，不再承担权威去重 / 生命周期；同 item 重驱复用原键 |
| persistent-service.md（delivery 模块） | S3 | 删除公开生产接口 `IDeliveryPipeline.enqueue(EnqueueParams)`；`packages/core/src/delivery/{types,index,queue,pipeline}` 改为 AuthorityCommitLog delivery 流的投影 / drain adapter，落实 keyBody/key/intentDigest、串行唯一索引与十五行状态机；同步事件、stats、server RuntimeControlAdapter、CLI setup-delivery、现有 queue/pipeline 测试；旧 JSON 队列不再是事实源 |
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
| 15（S3） | delivery 权威流与 S3 切换 | 落五类 keyBody、唯一索引、十五行 delivery 生命周期、用户裁决、现有 DeliveryItem/queue 投影；删除公开生产入口并将 conversation/job 结果原子入流，最后切换进程内耐久协议 | delivery 15 行、五类生产者、并发同键、外部调用前后崩溃、unknown 三选与投影重建通过；全量测试/build 通过；S3 到此才接管单机生产路径 |
| 16（S4） | Manifest、能力描述与最小资产同步 | 落 ExecutionManifest、CapabilityDescriptor、VersionInventory、CredentialBindingDescriptor、EnvironmentRequirement、`matchManifest`，以及配置/资产/权限快照的最小版本同步 | 版本/能力失配矩阵、秘密扫描、快照版本回退和同机/跨机 matcher conformance 通过；失配只排队/拒收、不产生 assignment 候选 |
| 17（S4） | AuthorityCapability 与权限租约激活 | 落五类 principal×方法矩阵、统一 guard、AuthorityCapability、PermissionSnapshotLease、assigned/received 双侧激活与吊销重驱 | 全方法×principal 允许/拒绝矩阵、错 scope/resource/epoch/assignment/executor、候选未激活、替换租约和离线验权测试通过 |
| 18（S4） | ResourceGovernor 与资源租约闭环 | 落 anchor/executor 双半边、根/子租约、WDRR、consume/settle/release/reclaim、delegation、UsageReport 连续水位；将全部工作入口接入治理 | 不变量 18 对抗矩阵、全 workload kind、重复 usageId、超额/越 delegation、无水位 reclaim、满载公平性和双拓扑测试通过；S4 能力整体启用 |
| 19（S5） | assignment 资产传输与 mesh adapter | 落 owner↔executor 的 WindowInput/Dispatch/MutationBatch/SealedBundle 及依赖闭包按摘要推拉、断点续传、去重；实现 RunExecutorPort/RunSubmissionPort mesh adapter | root/dependency 少列、多列、乱序、跨层重复、缺件、断点和错 assignment 授权全部拒绝；进程内/mesh contract conformance 等价 |
| 20（S5） | 跨机控制面启用 | 将派发、started、提交、cancel/supersede/queryLedger、usage intake 上网格；以完整 S3/S4 守卫和 assigned outbox 为唯一远端入口，最后开放跨机执行 | 双拓扑复跑 6.1/6.2/6.2b、断网/重连/重投/owner 与 executor 崩溃矩阵全绿；跨机零无日志执行、零双活；S5 到此才启用业务 mesh |
| 21（S6） | run stream、spool 与摘要链 | 落统一 StreamFrame、assignment 级 seq、streamEpoch fencing、数据帧摘要链、provisional-final、耐久 spool、逐消费方 ACK/回收和背压 | 直连/中继路径切换、空流、逐字段篡改、final 三值核对、ACK 丢失、慢 observer 隔离、崩溃续流零丢零重 |
| 22（S6） | 数据面票据与确认/止损 | 落 observe/interact/abort 票据的签发、续期、吊销；interaction 下行投影、第一方直连 allow-once、owner 失联 abort 与旁观只读 | 越权 observer、非原始 surface 应答、票据过期/吊销、交互取消竞态、断线重连和 abort 证明测试通过；pending 权威只在 assignment 流 |
| 23（S6） | surface 内容资产数据面 | 回填并实现 surface 预上传授权、下载授权、断点续传、生命周期治理；control 写与 committed 内容都执行依赖闭包在场检查 | S6 回填验收全部通过；缺件不得 control apply/CAS；上传中断可续、重复 digest 去重、越 requestId/assignment 拒绝 |
| 24（S6） | 中继、渠道确认与最终性整合 | 落 job owner-relay 水位、conversation/job challenge outbox、token/grant、status/final 合并和路径降级；最后启用无损数据面 | 不变量 7、13、16 对应集成/对抗用例全绿；prepared/cursor/ACK/发送各崩溃点可收敛；渠道与第一方确认能力等价；S6 到此启用 |
| 25（S7） | Environment 与 workscene 接入 | 落 EnvironmentPort、WorkspaceProbeRequest/Grant、设备域 workspace 引用及 revision 复验；workscene 注册留锚点、进出留会话 owner | 目录五态、路径不出 wire、错设备/绑定/revision、远程 setWorkdir、离线能力矩阵和现有 workscene 回归通过 |
| 26（S7） | scheduler 与 job 产品闭环 | 将 scheduler CRUD/run/cancel/定时触发、冻结 delivery plan、渠道来源与维护通知接入 JobJournal/Delivery 流；移除旧生产依赖 | 任务定义/occurrence 隔离、线程路由保真、job uncertain 暂停/missed 汇总、投递唯一性、system 不进用户视图测试通过 |
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
