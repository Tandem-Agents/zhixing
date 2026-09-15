# OpenClaw 的通用自主性：角色职责与提示设计

研究对象是：面对未预设的任务、陌生输入或现有能力不足，为什么智能体会自己寻找办法并推进结果，而不是等用户配置能力、指定模型或教授步骤。语音、视频只是例证，不是本研究的功能边界。

依据：[OpenClaw 官方仓库](https://github.com/openclaw/openclaw)，固定于 2026-09-15 的提交 [`6be1a9675da0`](https://github.com/openclaw/openclaw/commit/6be1a9675da07e4f1396daa1f3923abfed8d91b1)。以下区分公开提示的实际要求、源码可确认的支撑行为与研究推论；不把作者经历当成可复现测试，也不把当前实现倒推为早期案例的原因。

## 核心结论

公开材料支持的核心解释是：**OpenClaw 把模型置于“对结果负责、先自行解决困难、持续理解用户”的助手角色中，再通过各环节的具体指令维持这种行事方式。** 它不只告诉模型能调用什么，还告诉模型：什么事情由你负责、什么时候应当继续、什么情况下才能问用户、怎样才算完成。

在已核实的执行路径中，具体解法由模型生成，并根据实际反馈调整；程序没有预先枚举“未知任务应该怎么办”。工具和运行时决定办法是否可执行，角色职责与上下文指引则直接影响模型是否主动去想、去试、去继续。这两者不能互相替代，更不能用工具数量解释自主性。

这是一种跨场景的行为取向，不是一项新的媒体功能，也不是人格化措辞本身。源码能证明这些要求确实存在并进入运行路径；没有同模型、同环境的对照实验，不能进一步声称提示词独自解释了全部效果，或这些做法为 OpenClaw 独有。

## 一个真实来源揭示的关键区别

作者在公开访谈中描述：收到无扩展名音频后，智能体识别格式、转换文件；本地转写不可用，便改用云端转写，最后回答原问题。关键不是“有转写工具”，而是把“不理解这个输入”当成需要自行解决的中间问题。此处只有作者叙述，没有公开的完整执行轨迹；其中使用既有服务凭据的做法也不能直接作为安全范本。[访谈 00:15:16–00:16:56](https://lexfridman.com/peter-steinberger-transcript/)

## 自主性被写进了哪些职责

### 首先自己解决，而不是首先向用户索取解法

`SOUL.md` 的核心要求是 **“Be resourceful before asking.”** 随后的说明把它落到可观察行为：读文件、查上下文、搜索，带着答案回来；通过能力赢得信任，内部探索可以积极，外部动作应谨慎。这里规定的不是一种工具，而是遇到未知时的默认反应。[SOUL 模板](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/docs/reference/templates/SOUL.md#L14)

`AGENTS.md` 进一步要求：提出或构建定制方案前，先检查合适的已有项目、库、插件或平台；现有方案不适合时才自行构建。系统提示则明确要求：已有可用的专用工具，就自行调用，不把等价的命令操作交还用户。两者共同把“寻找和使用解决手段”纳入助手职责，而不是默认属于用户。[已有方案检查](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/docs/reference/templates/AGENTS.md#L68)、[工具使用要求](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/agents/system-prompt.ts#L1254)

由此得到的通用含义是：**缺少现成路径，不自动等于任务受阻；寻找路径本身也是任务的一部分。** 这不是要求模型无限尝试，更不授权它擅自付费、获取秘密或改变权限。

### 对任务的完成负责，而不是对一次答复负责

系统提示的 `Execution Bias` 把职责写得很具体：可执行的请求立即行动；工具仍能推进时不能只交计划；持续到完成或真实阻塞；结果为空或很弱时改变查询、路径、命令或来源；最终结论需要证据或明确的阻塞原因。这些要求分别约束开始、遇阻和结束，而非只在开头写一句“你是自主智能体”。[执行要求](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/agents/system-prompt.ts#L503)

`Promised Work` 又把责任延伸到当前轮次之后：承诺后台、委托或后续工作，就必须安排可用的完成或跟踪路径，保留原请求的责任，并主动带回结果或阻塞；没有后续路径便不能承诺稍后完成。“正在运行”不算完成。[后续工作责任](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/agents/promised-work-prompt.ts#L2)

这改变的是交付标准：找到工具、装好插件、启动子任务都只是中间进展，不能替代用户原本要的结果。上述要求属于模型行为指令，并不等于程序已经能够自动判定任意任务的语义完成。

### 让模型自己学会使用环境，而不是假定它事先知道一切

系统提示提供当前环境的工具、模型、工作目录、权限及产品文档和源码入口；关于 OpenClaw 本身的问题，要求先查文档，文档缺失或过时再查源码。技能则先提供简要索引，出现明确匹配才读取具体操作说明。模型因此既知道自身处境，也有途径补齐陌生能力的使用知识。[环境与自查指引](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/agents/system-prompt.ts#L677)、[技能读取指引](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/agents/system-prompt.ts#L258)、[运行时信息](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/agents/system-prompt.ts#L1568)

操作失败后的反馈也承担指导职责。例如，工具名不存在时返回可查找、查看定义、再调用的路径；把技能误当工具时，提示改为读取技能说明；参数错误时给出字段线索；工具已返回但输出不合约时，提醒先检查状态，不能盲目重复可能已经产生副作用的操作。[失败后的纠正指引](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/agents/tool-search-recovery.ts#L51)

重要的不是“有工具说明”，而是：**上下文足以让模型自行发现、学习和纠正操作，职责又要求它这么做。** 如何组合这些手段，仍由模型围绕目标决定。

### 把一次解决问题的经验变成下一次的行事依据

工作区提示要求：学到教训就更新相关操作规则或技能；稳定的用户偏好写成可遵循的指令；偏好改变时替换旧要求，不保留相互矛盾的有效规则。这不是只存聊天记录，而是让后续模型调用实际受到已有经验和用户要求的约束。[经验与用户指令](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/docs/reference/templates/AGENTS.md#L25)

当前版本还存在专门的经验复核提示：联系原需求、用户纠正、尝试和实际结果，提取已验证的恢复办法或可复用步骤；没有新经验就不改，不能把一次性任务变成永久要求，也不能保存猜测和泛泛建议。它改变的是将来可读取的操作知识，不是模型权重。[经验复核提示](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/skills/workshop/experience-review-prompt.ts#L97)

其自动模式当前默认开启，但后台复核还要求前台工作达到规定深度、运行时确有相应能力且系统进入空闲；不是每条消息都学习。`auto` 可以直接维护其所属技能，`propose` 留待审查，`off` 禁止自动学习。不能将这套当前实现当成早期即兴语音案例的必要原因，也不能把自动写入等同于学到的内容一定正确。[模式默认值](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/skills/workshop/config.ts#L16)、[触发条件](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/skills/workshop/experience-review-scheduler.ts#L159)

### 主动性包含判断何时做事、何时保持安静

工作区提示不仅要求例行检查，还规定值得联系用户的条件，以及夜间、用户忙碌、没有新信息时保持安静；可自行开展的内部整理与必须询问的外部动作分开。这使主动性指向有价值的行动，而不是频繁发消息。[主动与安静的条件](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/docs/reference/templates/AGENTS.md#L110)

当前心跳提示要求依据本次监控上下文判断，并明确禁止从旧对话自行推断、重做过往任务；没有需要关注的内容就不通知。调度器提供再次思考的机会，提示规定此次思考的责任和边界，模型决定具体动作及是否打扰用户。不能把“会定时调用模型”本身说成主动性。[当前心跳提示](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/auto-reply/heartbeat.ts#L7)、[按事件装配上下文](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/infra/heartbeat-runner-prompt.ts#L216)

### 像人交流，不等于像伙伴一样可靠办事

`SOUL.md` 还强调有判断、不奉承、不说套话，按需要简洁或深入；人格指南主要讨论语气、立场、幽默与边界。这些能改变交流感受，但不能单独解释在能力不足时自主解决问题。值得借鉴的是“有判断且对结果负责”，不是复制人设、口癖或拟人化故事。[人格指南](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/docs/concepts/soul.md#L13)

## 这些提示是否真的参与执行

已核对内置运行时的装配路径，而非只搜索到文件名：

1. 新工作区从模板生成角色与工作约定文件；实际运行读取工作区中的内容，因此用户修改后的文件才是该实例的输入。[模板生成与读取](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/agents/workspace.ts#L1154)
2. 每次准备执行时，收集适用的工作区上下文、技能、实际工具与运行信息，并解析模型提供方的提示贡献。[运行前装配](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/agents/embedded-agent-runner/run/attempt-system-prompt-prepare.ts#L133)
3. 提示构造器把角色文件正文和执行要求组成系统提示，经提供方变换后安装到会话；工具结果进入后续模型上下文，模型据此选择下一步。[角色正文注入](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/agents/system-prompt.ts#L211)、[提供方变换](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/agents/embedded-agent-runner/run/attempt-system-prompt.ts#L55)、[安装到会话](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/agents/embedded-agent-runner/system-prompt.ts#L40)、[结果反馈与继续](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/packages/agent-core/src/agent-loop.ts#L309)

因此它不是一份孤立的“性格文档”，而是角色、操作规则、即时事实、失败反馈和后续提醒共同构成的模型工作上下文。

必须保留以下适用边界：

- 普通完整提示、子任务的精简提示和原始模型调用不是同一组输入；工具受限、上下文预算、用户定制和提供方覆盖也会改变内容。不能说每次调用都完整加载全部文件。
- `AGENTS.default.md` 是可选的个人助手配置范本，不能当成自动加载的默认模板。[该文档的使用方式](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/docs/reference/AGENTS.default.md#L26)
- GPT-5 相关路径还注入完整交付、减少不必要求助、以工具证据校验等行为合同；这是特定提供方与模型的补充，不能解释所有模型上的表现。相关辅助文件虽标注 deprecated，当前 OpenAI 注册路径仍调用它。[提供方注册](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/extensions/openai/index.ts#L33)、[行为合同及生效条件](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/agents/gpt5-prompt-overlay.ts#L43)

## 运行支撑与错误归因的分界

运行支撑的价值是使模型能够履行职责，而不是替模型产生通用解法。例如当前支持的运行时，在插件变更后会保留已有结果、更新可用能力，并提示继续原任务、验证变更、不要重复已完成动作。这里的程序续接和模型责任是一致的；没有这一衔接，提示里的承诺可能无法兑现。[能力变更后的任务续接](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/agents/embedded-agent-runner/plugin-runtime-refresh.ts#L39)

但当前媒体处理会按已知能力、配置、可用提供方和认证条件选择处理路径。这可以降低用户配置负担，却不能证明存在“自主寻找全世界最好的模型”的通用能力，也不能代替对即兴问题求解的解释。[媒体选择实现](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/src/media-understanding/runner.ts#L478)

同样，执行循环继续调用模型、定时唤醒、技能持久化，分别解决可继续执行、何时再执行、经验如何保留；模型是否承担责任、选择什么办法、何时值得行动，仍需要相应指引与模型判断。强制不断循环不等于自主性，放开全部权限也不等于更好的自主性。

## 对知行的直接启发

首先应该审视的是模型承担的职责，而不是组件是否齐全：**用户给出目标后，寻找办法、补足可自行取得的信息、学习必要操作、根据结果调整路径、核实交付，应当属于助手的工作；用户只承担无法代决的选择与必要授权。**

这类职责应在开始、遇阻、能力变化、后台返回和任务结束处保持一致。仅在顶层加一句“更加自主”，同时在其他环节默认要求用户提供方法、把中间步骤当完成，无法形成这种体验。具体能力不足仍可能需要工程补齐，但不能把通用自主性降格为预设场景的功能清单。

判断是否获得了这项能力，要看没有预置解法的新任务中，模型能否主动完成必要探索、遇阻换路并交付可验证结果；同时不越过授权、不虚报完成、不做无价值活动。自然语气是另一项体验指标，不能替代这些行为事实。

## 证据能够支持到哪里

本次已读取官方角色模板、关键系统提示、工具失败与能力变更后的提示、主动跟进与经验复核指令，并沿生产装配路径核对其作用；同时检查了相关测试定义。仓库确有要求“不要只给计划、完成可行动作”的用例，但有的使用模拟提供方，有的需要真实模型；**测试定义存在不代表本次运行通过，更不代表跨场景能力已经被证明。** 本次未运行 OpenClaw、未调用真实模型、未安装其依赖。[行为测试定义](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/qa/scenarios/agents/instruction-followthrough-repo-contract.yaml)、[真实模型继续任务用例](https://github.com/openclaw/openclaw/blob/6be1a9675da07e4f1396daa1f3923abfed8d91b1/qa/scenarios/goals/goal-followthrough-live.yaml)

作者原型曾使用 Claude Code，且个人完整角色文件未公开。这说明不能把不同产品中的体验差异简单归为某方缺少模型或工具，也不能声称已取得作者实例的全部提示。本文解释公开设计如何引导这种行为，不宣称独占性、任意模型上的效果保证，或已经复现原访谈的全部体验。[作者访谈 00:06:25、01:28:52](https://lexfridman.com/peter-steinberger-transcript/)
