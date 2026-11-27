# 智能体运行核心优化

> **[临时前置准备 · 任务开启时清空重写]**
>
> - **状态**：尚未开启（本文当前**不是**正式任务文档，不套用正式任务范本结构）。
> - **用途**：临时留存 `2026-11-27` 基于 `develop@637bdf3a` 对知行运行核心所做的一次源码级前置审查、横向对比与问题定位，避免后续立项时重复摸排。
> - **处置规则**：**当本任务正式开启时，本文现有临时内容全部丢弃清空**，重新依据当时的最新生产源码按正式任务流程开展现状核查、一流调研与体系设计，不得将本临时记录直接当作正式现状权威或方案限制。

---

## 一、核查范围与总体判断（`develop@637bdf3a`）

- **知行核查源码范围**：
  - 循环与流式执行：`packages/core/src/loop/agent-loop.ts`、`llm-call.ts`、`tool-executor.ts`、`turn-end.ts`、`prefix-projection.ts`
  - 中断与看门狗：`packages/core/src/interrupt/*`
  - 容错与重试熔断：`packages/core/src/resilience/*`
  - 运行体装配与安全执行包装：`packages/orchestrator/src/runtime/create-agent-runtime.ts`、`system-prompt.ts`、`lifecycle.ts`、`packages/orchestrator/src/security/secure-executor.ts`
- **横向对照基线**：
  - Pi Agent Harness（`main@2509b5c`，见[调研报告](../../research/knowledge-base/pi-agent-harness-architecture-research.md)）
  - DeepSeek Harness（`v0.1.0-rc.7@99f6f02`，见[调研报告](../../research/knowledge-base/deepseek-harness-architecture-research.md)）
  - 同标尺成熟度天花板参照：OpenAI Codex `codex-core`（`main@711a5f8` ≈ `9.0 / 10`，见[调研报告](../../research/knowledge-base/openai-codex-architecture-research.md)）
- **总体定性**：知行运行核心综合得分 **`8.3 / 10`**，与 Pi（`8.4`）、DeepSeek Harness（`8.5`）同处第一梯队——在流式中断自愈、多协议加密推理态与缓存前缀保真、流前重试熔断及资源容量治理上已较扎实；与 `9.0+` 世界一流卓越水准的差距集中在**上层运行体结构臃肿与特判耦合、运行中交互引导粒度、OS 级命令执行沙箱及局部信号透传缺陷**。

---

## 二、六维审查标尺与横向对比

| 审查维度（权重） | 知行核心 | Pi 核心 | DeepSeek Harness 核心 | 核查依据与关键差异 |
| --- | :---: | :---: | :---: | --- |
| **1. 边界纯粹度与可演进性（20%）** | **7.4** | **9.3** | **8.8** | 下层 `agent-loop.ts` 虽无持久化逻辑，但直接承载了 `SegmentLedger`、`TokenAnchor` 及专为推进功能定制的 `exclusiveInitialControl`；上层 `create-agent-runtime.ts` 膨胀为 **2,482 行（约 108 KB）巨型闭包**，对外 `AgentRuntime` 接口暴露 13 个方法，将窗口双层持有、文件化编排、子 Agent、安全管家与诊断混装一处。Pi 靠 `transformContext / convertToLlm` 与薄包分层保持极高纯粹度；DSH `dsh-agent-loop` 极薄，靠可逆插件解耦（代价是 Cordis 概念与双程序编译复杂度）。 |
| **2. 执行控制、中断与并发确定性（20%）** | **8.9** | **8.5** | **8.4** | 知行具备 `wrapStreamWithWatchdog`（Promise.race 破 SDK 流挂死 + 空闲超时）、`finalizeRun` 单点 `abort` 优先覆盖、`finally` 捕获 `generator.return()` 补发 `run_end`、工具中断自动补齐未执行 `tool_use` 占位防下一轮 API `400`、串行已完成工具结果不丢失及只读工具真并发保序回传；扣分在 `with-retry.ts` 退避睡眠漏传当次请求中断信号。 |
| **3. 运行中交互与动态引导（15%）** | **7.8** | **9.0** | **8.2** | Pi 原生拆分 `Steering`（当前工具结束后立即转向纠偏）与 `Follow-up`（待本轮自然结束后续接）双队列；知行虽有 `inputPort` Turn 边界追加输入，但仅有单一追加语义，不支持“工具批次中途紧急转向并跳过同批剩余慢工具”与“忙时排尾续接”的区分。 |
| **4. 模型协议保真与缓存亲和性（15%）** | **9.0** | **8.6** | **8.2** | 完整保真多段思考签名与 OpenAI Responses 加密推理块，具备 `AppendOnlyTurnContextState` 追加式前缀代际投影、`validatePreSendCompatibility` 发送前跨协议/跨连接私有推理态防串校验，以及双层 epoch 窗口前缀锁定。 |
| **5. 容错恢复与资源/预算治理（15%）** | **8.6** | **7.8** | **8.3** | 具备“未流出内容自动重试、一旦流出内容或流中断严禁重放”的 `withRetry` + 熔断器、基于 API 真值的 `TokenAnchor + EMA` 校准、人工确认等待期间不占设备执行槽位的容量包装，以及子任务深优先租约结算；Pi 核心层基本不内建重试熔断与多级预算治理。 |
| **6. 工具准入与安全隔离纵深（15%）** | **8.2** | **6.5** | **8.6** | 知行内建 7 级确定性安全管线、敏感路径硬保护、耐久执行验权与串行确认桥，显著强于默认无权限防线的 Pi；但 DSH（及 Codex）为本地命令接入了平台原生 OS 沙箱（macOS Seatbelt、Linux Landlock/bubblewrap、Windows restricted token），知行放行后的子进程仍直接运行在宿主用户权限下。 |
| **加权总分（满分 10）** | **8.3** | **8.4** | **8.5** | 同处第一梯队，距 `9.0+` 卓越标准尚有明确收敛与能力提升空间。 |

---

## 三、已查实的具体问题清单（供后续开启时核对）

1. **运行体装配巨型闭包与循环层特判耦合**
   - `packages/orchestrator/src/runtime/create-agent-runtime.ts` 单函数闭包达 2,482 行，`AgentRuntime` 接口（第 342–415 行）同时暴露核心 `run` 与手动压缩、单发文本调用、DAG 编排、子任务用量解析、安全快照等 13 项方法，职责边界过宽。
   - `packages/core/src/loop/agent-loop.ts`（第 201–211、325–345、697–708 行）与 `packages/core/src/loop/tool-executor.ts`（第 154–186 行）在最底层循环内直接硬编码了段切换台账、`TokenAnchor` 与服务于特定上层推进功能的 `exclusiveInitialControl` 排他控制门。
2. **运行中输入缺少 `Steer` 与 `Follow-up` 双语义分离及批次内转向**
   - `packages/core/src/loop/agent-loop.ts`（第 564、710 行）的 `inputPort.receive` 仅在整批工具跑完后的 Turn 边界拉取单一队列，无法区分用户“立即打断剩余慢工具并转向”与“不打扰当前思路、待本轮收尾后紧接执行”两类高频运行中交互意图。
3. **本地命令与工具执行缺少操作系统级沙箱兜底**
   - `packages/orchestrator/src/security/secure-executor.ts` 与 `packages/core/src/security/` 仅在应用层做命令参数分析与策略/确认拦截；获准放行后的子进程缺少跨平台原生文件/进程/网络沙箱限制，无法约束脚本内部派生的越界系统调用。
4. **重试退避等待期间漏绑当次请求中断信号（代码级缺陷）**
   - `packages/core/src/resilience/with-retry.ts` 第 127 行在重试退避等待时调用 `await sleep(delayMs, config.abortSignal)`，并在中断 catch 分支 `yield { type: "error", ... }`（第 130–134 行）；而 `packages/orchestrator/src/runtime/create-agent-runtime.ts` 第 1467 行构造 `withRetry(callProvider, { eventBus })` 时并未传入静态 `config.abortSignal`，真实单次运行中断信号位于 `request.abortSignal`（第 105、176 行均读 `request.abortSignal`）。这导致模型请求遇限流或瞬时网络错误进入退避等待期间，用户触发中断无法立即打断该 `sleep`。
