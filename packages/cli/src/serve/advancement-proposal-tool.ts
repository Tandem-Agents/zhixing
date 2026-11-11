/**
 * 推进提议工具——主 Agent 在同一次主请求里判断是否值得启动推进闭环。
 *
 * 只发出提议意图、不执行任何效果：提议随运行提交，由推进应用接受、生成 Rubric 草案并请用户确认，
 * 确认前不执行原任务。它是排他初始控制工具：只在本运行还没有启动任何工具、且产品为本运行启用时可用，
 * 同批其他调用不启动，成功后本运行结束（批次门在 core loop）。工具常驻会话运行时，是否可用由每次运行的
 * turnOrigin.enabledControls 决定，不逐回合增删工具集。
 */
import { ADVANCEMENT_PROPOSAL_TOOL } from "@zhixing-ai/core/advancement/proposal-identity";
import type { ToolDefinition } from "@zhixing-ai/core";
import { emitPostTurnControlIntent } from "@zhixing-ai/orchestrator/runtime";

const DESCRIPTION = [
  "当用户交来的是值得“先确认验收标准（Rubric）、再执行并由独立验收盯到完成”的任务时调用，",
  "例如要求做到测试全绿、按明确标准交付或审查、需要多轮推进与客观完成信号的工作。",
  "调用后本次运行立即结束，系统会生成 Rubric 草案请用户确认，确认前不执行原任务。",
  "只能在本次运行还没有调用任何其他工具时使用；提问、讨论或轻量即时的任务直接回答或执行，不要调用。",
  "不需要任何参数。",
].join("");

export function createAdvancementProposalTool(): ToolDefinition {
  return {
    name: ADVANCEMENT_PROPOSAL_TOOL,
    description: DESCRIPTION,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: false,
    // 提议只写入本地推进状态（随运行提交登记），无外部副作用：按应用状态写归 internal，不弹确认
    boundaries: [{ boundaryType: "app-state", access: "write", dynamic: false }],
    exclusiveInitialControl: {
      validateInput: (input) => (Object.keys(input).length === 0 ? undefined : `${ADVANCEMENT_PROPOSAL_TOOL} 不接受参数`),
    },
    call: async () => {
      emitPostTurnControlIntent({ kind: "propose_advancement" });
      return {
        content: "已提出推进：系统将生成 Rubric 草案请用户确认；本次运行到此结束，确认前不执行原任务。",
      };
    },
  };
}
