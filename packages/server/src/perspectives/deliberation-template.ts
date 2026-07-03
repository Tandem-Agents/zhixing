export const PERSPECTIVES_DELIBERATION_DEFINITION_ID =
  "multi-perspective-deliberation";

export const PERSPECTIVES_CONVERGENCE_NODE_ID = "converge";

export const PERSPECTIVES_DELIBERATION_TEMPLATE = `{
  "version": 1,
  "id": "${PERSPECTIVES_DELIBERATION_DEFINITION_ID}",
  "title": "多视角发散收敛",
  "description": "多个隔离视角独立评议、交叉吸收并收敛为唯一最终版本。",
  "policy": {
    "maxParallel": 5,
    "maxRunMs": 900000,
    "defaultNodeTimeoutMs": 300000,
    "defaultMaxTurns": 4,
    "defaultMaxTokens": 8000,
    "contextSnapshot": {
      "strategy": "tail",
      "maxTokens": 12000
    },
    "allowedTools": [],
    "failureMode": "fail_fast"
  },
  "input": {
    "required": true,
    "format": "text",
    "maxChars": 12000
  },
  "nodes": [
    {
      "id": "diverge-{{item.index}}",
      "kind": "agent",
      "title": "{{item.name}} · 独立评议",
      "expandForEach": "perspectives",
      "groupId": "diverge",
      "instruction": "你是本轮评议的一个独立视角。\\n\\n视角：{{item.name}}\\n职责：{{item.charge}}\\n\\n请基于用户问题和只读上下文独立思考，给出该视角下最强、最清晰、最能经得起长期检验的判断。不要迎合其它未知视角，不要写过程说明，只输出该视角的完整结论。",
      "context": {
        "includeRunInput": true,
        "includeContextSnapshot": true,
        "includeNodeOutputs": []
      },
      "output": {
        "required": true,
        "format": "text",
        "maxChars": 12000
      },
      "policy": {
        "tools": [],
        "modelRole": "{{item.modelRole}}",
        "maxTurns": 4,
        "maxTokens": 8000
      }
    },
    {
      "id": "cross-{{item.index}}",
      "kind": "agent",
      "title": "{{item.name}} · 交叉吸收",
      "expandForEach": "perspectives",
      "groupId": "cross",
      "dependsOn": ["diverge"],
      "instruction": "你是本轮评议的交叉吸收节点。\\n\\n你的视角：{{item.name}}\\n你的职责：{{item.charge}}\\n\\n依赖输出包含第一轮全部视角的独立版本，其中也包括你所属视角的第一轮版本。你的第一轮版本是 id 为 diverge-{{item.index}} 的输出。请把其它视角当作外部评议意见，判断它们相对你的版本有哪些更强的事实、推理、风险识别或表达方式，并融合出该视角下更优的最终版本。不要简单投票，不要保留分歧清单，只输出融合后的完整版本。",
      "context": {
        "includeRunInput": true,
        "includeContextSnapshot": true,
        "includeNodeOutputs": "dependencies"
      },
      "output": {
        "required": true,
        "format": "text",
        "maxChars": 14000
      },
      "policy": {
        "tools": [],
        "modelRole": "{{item.modelRole}}",
        "maxTurns": 4,
        "maxTokens": 9000
      }
    },
    {
      "id": "${PERSPECTIVES_CONVERGENCE_NODE_ID}",
      "kind": "agent",
      "title": "唯一最终版本",
      "dependsOn": ["cross"],
      "instruction": "你是最终收敛节点。依赖输出包含各视角交叉吸收后的最优版本。请从中提炼唯一最终答案：保留真正成立的洞见，消除重复和摇摆，补齐关键遗漏，给出能直接回到主线对话的最终版本。不要提及编排、节点或内部流程，不要输出多版本方案，最终答案必须是一个整体。",
      "context": {
        "includeRunInput": true,
        "includeContextSnapshot": true,
        "includeNodeOutputs": "dependencies"
      },
      "output": {
        "required": true,
        "format": "text",
        "maxChars": 16000
      },
      "policy": {
        "tools": [],
        "modelRole": "power",
        "maxTurns": 4,
        "maxTokens": 10000
      }
    }
  ]
}`;
