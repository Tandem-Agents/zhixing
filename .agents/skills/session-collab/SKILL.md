---
name: session-collab
description: 跨会话共同分析、分工实施、独立审查或协调共享资源时使用，明确职责并核验交付；单纯传话或查询接收入口无需调用。
---

# 跨会话协作

1. **明确目标与分工。** 各方从用户原始需求及有效变更确认目标、范围和完成条件；说明谁协调、谁实施、谁审查。协调者可以把实施交给另一方。需要取舍的决策按[决策分级](../../../docs/workbench/cross-session-collaboration.md#311-决策门与协作模式)判断是否须先共同分析。
2. **选择工作方式。** 开放问题按[共同分析](scenarios/multi-perspective.md)独立思考后交叉质询；已有成果按[独立复核](scenarios/review.md)检查；既定方案的具体疑问按[咨询与交接](scenarios/general-collaboration.md)处理。在独立分析或复核中，对方形成判断前不提供自己的猜测或推荐；原始需求、已知故障和被审对象必须完整提供。输入规则见[任务书保真](../../../docs/workbench/cross-session-collaboration.md#312-任务书保真中继失真防护)。
3. **据证据推进。** 各方根据质询重新判断，再由实施方完成实际成果。记录结论、依据和未解决的分歧；意见一致不能替代交付。没有新信息时转向查证或验证。
4. **各自验收。** 双方分别亲自检查实际成果，先记录达标依据或具体缺口，再交换判断。任一方未通过，就修复缺口并复核受影响部分；双方均有依据确认满足原始需求后结束。不得为迁就成果缩减目标。完成与受阻的判据见[状态与推进](../../../docs/workbench/cross-session-collaboration.md#35-状态与推进)。

## 交接与记录

首次交接给足完成任务所需的背景、材料和预期结果；后续只交新事实、变化和行动。接收方明确回复结果、无法承担的原因或阻碍；需要等待时，协调者如实向用户说明交付事项与当前状态。

复用现有任务文档与工具的消息记录。需要单独保存供恢复、交审或接续的材料时，使用 `collab/threads/<thread-id>/` 和[消息文件模板](templates/message-file.md)；长材料只留一份。持续协作的身份和未完成事项按[角色模板](templates/role-file.md)维护。

已有原生工具可直接投递；需要查找或适配接收入口时使用 [cross-agent-communication](../cross-agent-communication/SKILL.md)。按实际通知、等待和忙闲能力推进，不假定发信必能唤醒对方；等待规则见[等待与恢复](../../../docs/workbench/cross-session-collaboration.md#36-等待与恢复)。

## 按需处理

- **修改共享文件、构建或重型验证前**：按[资源协调](../../../docs/workbench/cross-session-collaboration.md#四资源协调)核对写权与资源槽；[租约模板](templates/lease-claim.md)用于记录持有和释放。审查方对被审产物只读。
- **重大或不可逆决策及其成果**：按[终审质量门](../../../docs/workbench/cross-session-collaboration.md#313-终审质量门唯一门禁清单)补充独立终审；不得用日常双人复核代替所要求的冷读或冷执行。
- **结束或交接任务时**：保留未完成事项和必要证据，按[资源与记录生命周期](../../../docs/workbench/cross-session-collaboration.md#73-运行态与生命周期)释放用完的临时资源。

共用规则以[协作文档](../../../docs/workbench/cross-session-collaboration.md)为准；宿主指令和用户授权优先。
