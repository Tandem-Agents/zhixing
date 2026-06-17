import {
  WorkflowValidationError,
  type JsonValue,
  type WorkflowDefinition,
} from "@zhixing/core";
import type { ServerContext } from "../../context.js";
import {
  WorkflowManagerError,
  type StartWorkflowInput,
} from "../../workflow/index.js";
import { RpcAppError, RpcErrors, type MethodEntry } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";

interface WorkflowStartParams {
  conversationId?: unknown;
  goal?: unknown;
  input?: unknown;
  definition?: unknown;
  definitionId?: unknown;
  origin?: unknown;
  detach?: unknown;
}

interface WorkflowInstanceParams {
  instanceId?: unknown;
}

interface WorkflowDecisionParams {
  instanceId?: unknown;
  decisionId?: unknown;
  resultOptionId?: unknown;
  actor?: unknown;
  rationale?: unknown;
  detach?: unknown;
}

interface WorkflowCancelParams {
  instanceId?: unknown;
  reason?: unknown;
}

interface WorkflowResumeParams extends WorkflowInstanceParams {
  detach?: unknown;
}

export function buildWorkflowStartMethod(): MethodEntry {
  return {
    name: "workflow.start",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as WorkflowStartParams;
      const input: StartWorkflowInput = {
        conversationId: requireNonEmptyString(
          params.conversationId,
          "workflow.start requires 'conversationId'",
        ),
        goal: requireNonEmptyString(params.goal, "workflow.start requires 'goal'"),
        input: (params.input ?? {}) as JsonValue,
        definition: requireDefinition(params.definition),
        definitionId:
          params.definitionId === undefined
            ? undefined
            : requireNonEmptyString(
                params.definitionId,
                "workflow.start 'definitionId' must be a non-empty string",
              ),
        origin: params.origin as JsonValue | undefined,
      };
      return runWorkflowCall(() =>
        params.detach === true
          ? requireWorkflow(ctx.server).startDetached(input)
          : requireWorkflow(ctx.server).start(input),
      );
    },
  };
}

export function buildWorkflowGetMethod(): MethodEntry {
  return {
    name: "workflow.get",
    requiresAuth: true,
    handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as WorkflowInstanceParams;
      const instanceId = requireNonEmptyString(
        params.instanceId,
        "workflow.get requires 'instanceId'",
      );
      return requireWorkflow(ctx.server).get(instanceId);
    },
  };
}

export function buildWorkflowDecideMethod(): MethodEntry {
  return {
    name: "workflow.decide",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as WorkflowDecisionParams;
      const input = {
        instanceId: requireNonEmptyString(
          params.instanceId,
          "workflow.decide requires 'instanceId'",
        ),
        decisionId: requireNonEmptyString(
          params.decisionId,
          "workflow.decide requires 'decisionId'",
        ),
        resultOptionId: requireNonEmptyString(
          params.resultOptionId,
          "workflow.decide requires 'resultOptionId'",
        ),
        actor: requireDecisionActor(params.actor),
      };
      const rationale = params.rationale === undefined
        ? undefined
        : requireNonEmptyString(
            params.rationale,
            "workflow.decide 'rationale' must be a non-empty string",
          );
      const decisionInput = rationale === undefined ? input : { ...input, rationale };
      return runWorkflowCall(() =>
        params.detach === true
          ? requireWorkflow(ctx.server).decideDetached(decisionInput)
          : requireWorkflow(ctx.server).decide(decisionInput),
      );
    },
  };
}

export function buildWorkflowCancelMethod(): MethodEntry {
  return {
    name: "workflow.cancel",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as WorkflowCancelParams;
      await runWorkflowCall(() =>
        requireWorkflow(ctx.server).cancel(
          requireNonEmptyString(
            params.instanceId,
            "workflow.cancel requires 'instanceId'",
          ),
          typeof params.reason === "string" && params.reason.length > 0
            ? params.reason
            : "Workflow canceled",
        ),
      );
      return { canceled: true };
    },
  };
}

export function buildWorkflowResumeMethod(): MethodEntry {
  return {
    name: "workflow.resume",
    requiresAuth: true,
    async handler(rawParams, ctx) {
      const params = (rawParams ?? {}) as WorkflowResumeParams;
      const instanceId = requireNonEmptyString(
        params.instanceId,
        "workflow.resume requires 'instanceId'",
      );
      return runWorkflowCall(() =>
        params.detach === true
          ? requireWorkflow(ctx.server).resumeDetached(instanceId)
          : requireWorkflow(ctx.server).resume(instanceId),
      );
    },
  };
}

function requireWorkflow(server: ServerContext) {
  if (!server.workflow) {
    throw new RpcAppError(
      RPC_ERROR_CODES.INTERNAL_ERROR,
      "WorkflowManager not configured on server",
    );
  }
  return server.workflow;
}

async function runWorkflowCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof WorkflowManagerError) {
      if (error.code === "not_found") throw RpcErrors.notFound(error.message);
      if (error.code === "invalid_input" || error.code === "invalid_state") {
        throw RpcErrors.invalidParams(error.message);
      }
    }
    if (error instanceof WorkflowValidationError) {
      throw new RpcAppError(
        RPC_ERROR_CODES.INVALID_PARAMS,
        "Workflow definition is invalid",
        { issues: error.issues },
      );
    }
    throw error;
  }
}

function requireDefinition(value: unknown): WorkflowDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw RpcErrors.invalidParams("workflow.start requires 'definition'");
  }
  return value as WorkflowDefinition;
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw RpcErrors.invalidParams(message);
  }
  return value;
}

function requireDecisionActor(value: unknown): "human" | "agent" | "rule" {
  if (value === "human" || value === "agent" || value === "rule") return value;
  throw RpcErrors.invalidParams(
    "workflow.decide requires 'actor' of human, agent, or rule",
  );
}
