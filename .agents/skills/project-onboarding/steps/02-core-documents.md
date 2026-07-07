# 核心文档专题了解

## Objective

在整体项目印象基础上，专门阅读核心架构文档，建立继续开发、审查或协作所需的关键架构上下文。

## Resources

None

## Instructions

1. 使用前一步 handoff 作为背景。
2. 查找并阅读“对话持久化与注意力窗口架构 (Transcript Persistence & Attention Window Architecture)”文档。
3. 查找并阅读“统一核心与多接入面 (Unified Core & Access Surfaces)”文档。
4. 查找并阅读“文件化可编排基础设施 (File-based Orchestration Infrastructure)”文档，理解它如何衔接注意力窗口快照、子 Agent 与 orchestrator 执行层。
5. 查找并阅读“生命周期概念定义与规范 (Lifecycle Concepts)”文档。
6. 查找并阅读“工作场景管理能力统一、目录管理与智能创建架构”文档，理解它如何基于会话、接入面、runtime 与领域服务地基统一工作场景管理能力。
7. 查找并阅读“任务推进闭环（Rubric 推进准则）架构”文档，理解它如何基于前述会话、注意力窗口、生命周期与编排地基实现任务推进闭环。
8. 阅读“屏幕渲染 (Screen Rendering)”文档，路径是 `research/internals/screen-rendering/overview.md`。
9. 整理这些文档之间的关系，只输出对后续工作最有用的核心理解和仍需确认的问题。
10. 这是终止 step；完成当前输出后停止。

## Output

产出一份简洁的项目核心上手摘要，包含：

- 项目整体定位；
- 核心模块和接入面；
- 对话持久化、注意力窗口、文件化编排、生命周期、工作场景管理、任务推进闭环和屏幕渲染之间的关系；
- 后续开发或审查时最需要注意的约束；
- 仍不确定的信息。

## Completion Criteria

- 已阅读并提炼指定核心文档。
- 已能说明这些文档之间的架构关系。
- 已形成足够支撑后续开发、审查或协作的项目上下文。
- 不需要继续读取下一步。

## Handoff

None

## Next

END
