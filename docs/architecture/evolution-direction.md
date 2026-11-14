# 架构演进方向

**随模型能力提升可能被吸收的部分做轻，支撑部分做重。**

贴近模型的 Harness 隐含着对当前模型能力局限的假设，会随模型进步而过时；应将其与会话状态、执行环境解耦，让 Harness 保持可演进、可替换，把稳定接口与耐久运行支撑沉淀为长期底座。

> "Harnesses encode assumptions about what Claude can’t do on its own. However, those assumptions need to be frequently questioned because they can go stale as models improve."
>
> — Anthropic, [*Scaling Managed Agents: Decoupling the brain from the hands*](https://www.anthropic.com/research/managed-agents)

**稳固受控的内核底座与隔离开放的可塑外层。**

静态固化的架构难以适应千差万别的场景与智能体运行期自主组装，无边界的全盘插件化又会动摇安全与可靠根基；应将内外两层解耦，把安全边界、核心状态与耐久运行收归受控升级的内核，将外围能力与界面置于权限受限、故障隔离的扩展层，支持组件动态生成、装配与替换而不波及底座。

---

> 编写说明：本文收录连接产品愿景与具体设计的全局架构演进判断——不写功能场景、交互流程或底层实现细节，也不以空泛口号或外在能力表现代替使之成立的系统结构。提炼时，剥离具体例证、剔除伪命题，从真实诉求中找准常规做法难以兼顾的根本矛盾，再切换至系统内部视角，确立各结构部分承接诉求所需的固有定性、职责边界或取舍关系。核心命题独立成行，省去铺垫套话、运行过程与动作表象，简明凝练地点明这一结构判断，不堆砌生僻术语、条件状语或补充解释。紧随其后用一两句话说清矛盾成因、内部边界与约束，以及由此成立的演进与保障机制；确有直接启发或关键印证时再附权威引文。
