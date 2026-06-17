import { randomUUID } from "node:crypto";
import type { JsonValue, WorkflowInstance } from "@zhixing/core";
import {
  CODING_QUALITY_WORKFLOW_ID,
  createCodingQualityWorkflowDefinition,
} from "@zhixing/orchestrator/workflow";
import type { CoreHostLink } from "../runtime/core-host-connection.js";

export interface StartReliableWorkInput {
  readonly goal: string;
  readonly context?: string;
}

export interface DecideReliableWorkInput {
  readonly instanceId: string;
  readonly decisionId: string;
  readonly optionId: string;
  readonly rationale?: string;
}

export class RpcReliableWorkFacade {
  constructor(private readonly link: CoreHostLink) {}

  async start(input: StartReliableWorkInput): Promise<WorkflowInstance> {
    const client = await this.link.getClient();
    const definition = createCodingQualityWorkflowDefinition();
    const conversationId = createWorkConversationId();
    const workflowInput: Record<string, JsonValue> = { goal: input.goal };
    if (input.context && input.context.trim().length > 0) {
      workflowInput["context"] = input.context.trim();
    }

    return client.request<WorkflowInstance>("workflow.start", {
      conversationId,
      goal: input.goal,
      input: workflowInput,
      definition,
      definitionId: CODING_QUALITY_WORKFLOW_ID,
      origin: {
        surface: "cli",
        command: "work",
      },
      detach: true,
    });
  }

  async get(instanceId: string): Promise<WorkflowInstance | null> {
    const client = await this.link.getClient();
    return client.request<WorkflowInstance | null>("workflow.get", {
      instanceId,
    });
  }

  async decide(input: DecideReliableWorkInput): Promise<WorkflowInstance> {
    const client = await this.link.getClient();
    const params: Record<string, unknown> = {
      instanceId: input.instanceId,
      decisionId: input.decisionId,
      resultOptionId: input.optionId,
      actor: "human",
      detach: true,
    };
    if (input.rationale && input.rationale.trim().length > 0) {
      params["rationale"] = input.rationale.trim();
    }
    return client.request<WorkflowInstance>("workflow.decide", params);
  }

  async resume(instanceId: string): Promise<WorkflowInstance> {
    const client = await this.link.getClient();
    return client.request<WorkflowInstance>("workflow.resume", {
      instanceId,
      detach: true,
    });
  }

  async cancel(instanceId: string, reason?: string): Promise<void> {
    const client = await this.link.getClient();
    await client.request("workflow.cancel", {
      instanceId,
      reason,
    });
  }
}

function createWorkConversationId(): string {
  return `work_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}
