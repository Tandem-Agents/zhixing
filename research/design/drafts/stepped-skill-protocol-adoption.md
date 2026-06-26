# Stepped Skill Protocol（SSP）采纳记录

> **性质**：知行侧采纳记录与集成入口；SSP 协议规范以独立协议仓库为准。
>
> **状态**：草案。知行当前尚未实现 SSP 原生 runtime 支持。
>
> **协议仓库**：[HJSunDev/stepped-skill-protocol](https://github.com/HJSunDev/stepped-skill-protocol)。

## 1. 文档目的

SSP 是一种基于 Agent Skills 的增强协议，目标是在保持普通 Skill 兼容性的前提下，让 Skill 支持静态分布读取、阶段化执行和更稳定的任务聚焦。

本文件记录知行对 SSP 的采纳策略和未来集成边界。它不定义 SSP 协议本身，也不维护协议规范副本。

本文件用于回答：

- SSP 与知行是什么关系；
- 知行当前是否支持 SSP；
- 知行未来如果接入 SSP，应从哪个边界开始；
- 哪些内容属于独立协议仓库，哪些内容属于知行实现。

## 2. 协议定位

SSP 的产品定位是：

> 将用户手动分多次交给 agent 的阶段化工作方式，定义为一种兼容 Agent Skills、支持静态分布读取、可由模型自驱执行、未来可由 runtime 原生增强的协议。

SSP 不改变普通 Skill 的基本外形。一个 SSP Skill 应保留普通 Skill 的可读性和 fallback 能力；支持 SSP 的 agent 或 runtime 可以进一步利用协议结构实现分步读取、handoff 和更强的执行追踪。

## 3. 单一事实源

SSP 的协议规范、包结构、metadata、step 契约、manifest、示例、conformance、validator、作者 Skill、公开 README、release 与治理规则，统一由 SSP 协议仓库维护。

知行仓库不维护这些内容的副本。

原因：

1. **避免双源漂移**：协议仓库更新后，知行副本容易过期。
2. **保持职责清晰**：SSP 是可外部使用的协议，知行是潜在实现方和贡献方。
3. **降低文档债务**：知行只记录采纳关系、集成边界和本项目实现决策。

因此：

- SSP 协议如何定义，以协议仓库为准；
- 知行是否支持 SSP、支持到哪一层、如何接入，以知行侧实现文档和代码为准；
- 知行侧文档只记录与本项目相关的采纳状态、实现边界和设计决策。

## 4. 知行采纳策略

知行暂不将 SSP 内化为私有功能，而是将其视为外部可复用协议。

该策略的目标是：

- 保持与 Agent Skills 生态兼容；
- 让协议可被其他 agent 或 runtime 使用；
- 避免知行内部实现细节污染协议设计；
- 为知行未来 runtime-native 支持保留清晰边界。

## 5. 支持层级

知行未来可以按层级支持 SSP。

### 5.1 L0：普通 Skill 兼容

把 SSP Skill 当作普通 Skill 使用，只读取 `SKILL.md` 中的普通 Skill 内容和 fallback 说明。

该层级不需要知行 runtime 识别 SSP 结构。

### 5.2 L1：模型自驱分步读取

模型按照 SSP Skill 中声明的 `Next` 指针读取 step 文件，并在当前 step 完成后进入下一 step。

该层级依赖模型遵循协议文本，不提供 runtime 级可见性隔离。

### 5.3 L2：Runtime 原生支持

知行 runtime 原生识别 SSP，提供更强的执行控制能力，例如：

- 识别 SSP metadata；
- 加载并索引 step manifest；
- 只向 agent 暴露当前 step 所需内容；
- 捕获 handoff；
- 在 run / turn / message / trace 中记录 step execution；
- 在失败时 fallback 到普通 Skill 行为。

L2 是知行侧最有价值的长期集成方向，但需要单独设计和实现。

## 6. 未来集成边界

如果知行实现 SSP runtime 支持，应另起实现架构文档，例如：

```text
research/design/drafts/stepped-skill-runtime-integration.md
```

该文档应只描述知行如何集成 SSP，不重复 SSP 协议本体。

重点问题包括：

- Skill loader 如何识别 SSP Skill；
- Skill 索引如何展示普通 Skill 与 SSP Skill；
- agent loop 如何触发 step 读取；
- runtime 是否提供 current-step scoped access；
- handoff 如何记录、传递和展示；
- run / turn / message / trace 中如何表达 step execution；
- 上下文裁剪是否参与 SSP 执行；
- L0 / L1 / L2 的能力边界如何对用户说明；
- 失败时如何 fallback 到普通 Skill；
- 安全边界如何避免被误解为强隔离。

## 7. 不在知行维护的内容

以下内容统一由 SSP 协议仓库维护，知行仓库不建立副本：

- SSP 完整协议定义；
- SSP manifest schema；
- SSP step schema；
- SSP conformance fixtures；
- SSP validator 实现；
- SSP 作者 Skill；
- SSP public README；
- SSP release / governance / changelog。

## 8. 维护规则

本文件只在以下情况更新：

- 知行对 SSP 的采纳状态发生变化；
- 知行开始实现 SSP runtime 支持；
- SSP 协议仓库的公共入口或稳定命名发生变化；
- 知行侧新增与 SSP 相关的实现架构文档。

本文件不记录过程性讨论，不保存协议规范副本。

## 9. 当前状态

截至本文档当前版本：

- SSP 已作为独立协议项目维护；
- 知行尚未实现 L1 / L2 SSP 支持；
- 知行可在未来以协议消费者身份接入 SSP；
- 知行侧 runtime 集成需要另行设计。
