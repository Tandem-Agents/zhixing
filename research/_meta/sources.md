# 信息源索引 (Source Index)

> 所有研究引用的信息源及其可信度评估

## 一级来源（源码级，直接可验证）

### OpenClaw 源码

- **仓库**: https://github.com/openclaw/openclaw
- **可信度**: ★★★★★ — 开源仓库，直接阅读源码
- **版本说明**: [记录所分析的版本/commit]

### Claude Code 源码级分析

2026 年 3 月 31 日，Claude Code v2.1.88 的 npm 包因构建配置错误，通过 source map 泄露了约 512K 行 TypeScript 源码（~1,900 文件，150+ 目录）。Anthropic 已确认此为发布打包的人为失误。社区基于此产出了多份系统化的架构还原：

#### cablate/claude-code-research

- **URL**: https://github.com/cablate/claude-code-research
- **可信度**: ★★★★☆ — 基于真实源码的系统化逆向分析
- **内容**: 75 份源码分析报告 + 8 份行为研究报告，覆盖 10 个领域（Agent 架构、安全、System Prompt、上下文管理、技能系统等）
- **格式**: 交互式 HTML 查看器，本地打开即可浏览

#### claude-code-from-source（18 章技术书）

- **站点**: https://claude-code-from-source.com
- **仓库**: https://github.com/alejandrobalderas/claude-code-from-source
- **可信度**: ★★★★☆ — 基于真实源码的架构还原，但代码示例为原创伪代码
- **内容**: 18 章系统化解读，覆盖基础架构、核心循环、多智能体编排、记忆系统、工具执行、终端 UI、MCP 集成、性能工程
- **特点**: 不含 Claude Code 实际源码，全部为教学性的架构模式提取

#### Haseeb Qureshi 架构分析

- **URL**: https://gist.github.com/Haseeb-Qureshi/d0dc36844c19d26303ce09b42e7188c1
- **可信度**: ★★★★☆ — 知名开发者的深度分析，含与 OpenAI Codex 的对比
- **亮点**: async generator 模式、React/Ink 终端 UI、四层上下文压缩策略

#### Yanchuk 架构深度剖析

- **URL**: https://gist.github.com/yanchuk/0c47dd351c2805236e44ec3935e9095d
- **可信度**: ★★★★☆ — 单文档 14 节完整架构参考
- **内容**: 核心执行循环、上下文管理、多智能体编排、工具系统、权限安全、Hook 系统、技能插件、MCP 集成、状态管理、设计模式

### Hermes Agent 源码

- **仓库**: https://github.com/NousResearch/hermes-agent
- **本地路径**: `E:\Dev\longxia\hermes-agent-main`
- **可信度**: ★★★★★ — 开源仓库（MIT），直接阅读源码
- **版本说明**: v0.6.0 (2026-03-30)
- **技术栈**: Python，核心文件 ~9,200 行（run_agent.py）
- **规模**: 48,000+ GitHub Stars，207 贡献者

#### Hermes Agent 官方文档

- **URL**: https://hermes-agent.nousresearch.com/docs/
- **可信度**: ★★★★★ — 官方开发者文档
- **内容**: 完整的架构指南（Architecture → Agent Loop → Prompt Assembly → Provider Runtime → Tools → Session → Gateway → Compression）
- **架构页**: https://hermes-agent.nousresearch.com/docs/developer-guide/architecture/

#### hermes-agent-self-evolution（自进化引擎）

- **仓库**: https://github.com/NousResearch/hermes-agent-self-evolution
- **可信度**: ★★★★☆ — 官方独立仓库，DSPy + GEPA 进化框架
- **内容**: 基于遗传帕累托进化的技能/提示/工具自动优化引擎

#### 社区测评与分析

- [Hermes Agent 评测：越用越聪明的开源 AI 智能体](https://www.aixq.cc/18601.html) — AI 星球深度测评
- [万字详解：OpenClaw "高替" Hermes Agent 的 Skills 系统](https://www.aixq.cc/17820.html) — Skills 系统专项分析
- [Hermes 智能体记忆系统架构深度解析与设计哲学](https://www.jdon.com/91062-hermes-agent-memory-system-design.html) — 极道记忆系统分析
- **可信度**: ★★★☆☆ — 需与一级来源交叉验证

## 二级来源（官方文档与权威资料）

### Anthropic 官方文档

- **URL**: https://docs.anthropic.com
- **可信度**: ★★★★★
- **覆盖**: Claude API、Tool Use、MCP 协议

### Claude Code 官方文档

- **URL**: https://docs.anthropic.com/en/docs/claude-code
- **可信度**: ★★★★★
- **覆盖**: 官方功能说明、使用指南（不含内部实现细节）

### OpenAI 官方文档

- **URL**: https://platform.openai.com/docs
- **可信度**: ★★★★★
- **覆盖**: Function Calling、Assistants API

## 三级来源（社区文章与分析）

### 深度技术文章

- **可信度**: ★★★☆☆ — 需与一级来源交叉验证
- [Claude Code 512K Lines 全系统解析](https://dev.to/ishaaan/claude-codes-source-code-exposed-every-system-explained-from-scratch-512k-lines-4blp) — dev.to 综合分析
- [Architecture Analysis (redreamality)](https://redreamality.com/blog/claude-code-source-leak-architecture-analysis/) — 五层架构分析
- [Inside Claude Code's System Prompt](https://www.claudecodecamp.com/p/inside-claude-code-s-system-prompt) — System Prompt 专项分析
- [KAIROS & Internal Architecture (claudelab)](https://claudelab.net/en/articles/claude-code/claude-code-sourcemap-kairos-internal-architecture) — KAIROS 守护模式与未发布模型

### 社区讨论

- **可信度**: ★★☆☆☆ — 作为线索而非结论

---

> **引用原则**：每个研究结论至少需要一个一级来源或两个二级来源的支撑。三级来源仅作为线索和补充。一级来源中的社区分析虽基于真实源码，但经过了分析者的理解和转述，与直接阅读源码仍有差异，需注意标注。
