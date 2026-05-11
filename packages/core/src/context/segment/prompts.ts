/**
 * 段切换压缩指令模板 —— 缓存安全分叉请求的末尾追加 user message。
 *
 * 请求形态约束：
 *   - system + tools + 上一段完整 messages 全部 byte-equal 上一轮（cache 完美命中）
 *   - 这条指令是末尾追加的 user message，唯一的新 token，几乎免费
 *
 * 输出契约：LLM 必须返回 <facts>/<state>/<active> 三段 XML 包裹。parser 对单段
 * 缺失做兜底，但 prompt 显式约束仍需保留——降低兜底触发频率、提高摘要质量。
 *
 * task_list 协作：prompt 显式要求 LLM 在 <state> 段逐项总结 in_progress 任务
 * 进展，让新段 LLM 能继续工作。task_list state 本身跨段保留（不被段切换清空），
 * 摘要承担的是"任务进展叙述"职责，不是"任务状态再写一遍"。
 */

export const SEGMENT_SUMMARIZE_INSTRUCTION = `<summarize-instruction>
请把以上对话压缩为简洁摘要。输出严格按以下三段 XML 结构：

<facts>讨论过的事实、事件、决策——结论性陈述，不展开过程</facts>
<state>当前进行中的任务、未完成事项、用户当前期望——让协作者知道现在该接着做什么。
       重要：如果当前对话中 task_list 工具有标记为 in_progress 的项，必须逐项总结进展，
       让新段 LLM 能继续工作；task_list 状态本身跨段保留不变（不被段切换清空）。</state>
<active>后续协作必须知道的具体信息：文件路径、变量名、技术决策、用户偏好等——保留协作锚点</active>

约束：
- 总长度不超过 500 字
- 输出语言与对话主体语言一致
- 不复述过程细节，只保留协作必需的结论
- 不要在结构外添加任何解释或问候
</summarize-instruction>`;
