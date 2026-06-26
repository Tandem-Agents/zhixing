import type { TokenUsage } from "../types/llm.js";
import type { Message } from "../types/messages.js";
import type { JsonSchema } from "../types/tools.js";

export type OrchestrationSourceModeV1 = "trusted";
export type OrchestrationNodeKindV1 = "agent";
export type OrchestrationContractFormatV1 = "text" | "json";
export type OrchestrationFailureModeV1 = "fail_fast";
export type OrchestrationContextSnapshotStrategyV1 = "full_or_fail" | "tail";
export type OrchestrationNodeOutputReferenceV1 =
  | "dependencies"
  | readonly string[];

export type OrchestrationValidationIssueCodeV1 =
  | "cycle_dependency"
  | "duplicate_id"
  | "duplicate_value"
  | "empty_string"
  | "invalid_id"
  | "invalid_literal"
  | "invalid_reference"
  | "missing_context_snapshot_policy"
  | "missing_input_contract"
  | "missing_required"
  | "parse_error"
  | "template_param_invalid"
  | "template_param_missing"
  | "too_large"
  | "too_small"
  | "type_mismatch"
  | "unknown_property"
  | "unknown_reference";

export interface OrchestrationValidationIssueV1 {
  readonly path: string;
  readonly code: OrchestrationValidationIssueCodeV1;
  readonly message: string;
}

export interface OrchestrationSystemCapsV1 {
  readonly maxNodes: number;
  readonly maxParallel: number;
  readonly maxRunMs: number;
  readonly maxNodeTimeoutMs: number;
  readonly maxNodeTurns: number;
  readonly maxNodeTokens: number;
  readonly maxContextSnapshotTokens: number;
  readonly maxInstructionChars: number;
  readonly maxInputChars: number;
  readonly maxOutputChars: number;
  readonly allowedNodeKinds: readonly OrchestrationNodeKindV1[];
  readonly allowedTools: readonly string[];
}

export interface OrchestrationInputContractV1 {
  readonly required?: boolean;
  readonly format: OrchestrationContractFormatV1;
  readonly schema?: JsonSchema;
  readonly maxChars?: number;
}

export interface OrchestrationOutputContractV1 {
  readonly required: true;
  readonly format: OrchestrationContractFormatV1;
  readonly schema?: JsonSchema;
  readonly maxChars?: number;
}

export interface NormalizedOrchestrationInputContractV1 {
  readonly required: boolean;
  readonly format: OrchestrationContractFormatV1;
  readonly schema?: JsonSchema;
  readonly maxChars: number;
}

export interface NormalizedOrchestrationOutputContractV1 {
  readonly required: true;
  readonly format: OrchestrationContractFormatV1;
  readonly schema?: JsonSchema;
  readonly maxChars: number;
}

export interface OrchestrationContextSnapshotPolicyV1 {
  readonly strategy: OrchestrationContextSnapshotStrategyV1;
  readonly maxTokens?: number;
}

export interface OrchestrationPolicyV1 {
  readonly maxParallel: number;
  readonly maxRunMs: number;
  readonly defaultNodeTimeoutMs: number;
  readonly defaultMaxTurns: number;
  readonly defaultMaxTokens?: number;
  readonly contextSnapshot?: OrchestrationContextSnapshotPolicyV1;
  readonly allowedTools: readonly string[];
  readonly failureMode?: OrchestrationFailureModeV1;
}

export interface OrchestrationNodeContextV1 {
  readonly includeRunInput?: boolean;
  readonly includeContextSnapshot?: boolean;
  readonly includeNodeOutputs?: OrchestrationNodeOutputReferenceV1;
}

export interface OrchestrationNodePolicyV1 {
  readonly timeoutMs?: number;
  readonly maxTurns?: number;
  readonly maxTokens?: number;
  readonly tools?: readonly string[];
}

export interface OrchestrationNodeV1 {
  readonly id: string;
  readonly kind: OrchestrationNodeKindV1;
  readonly title?: string;
  readonly dependsOn?: readonly string[];
  readonly instruction: string;
  readonly context?: OrchestrationNodeContextV1;
  readonly output: OrchestrationOutputContractV1;
  readonly policy?: OrchestrationNodePolicyV1;
}

export interface OrchestrationDefinitionV1 {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly policy: OrchestrationPolicyV1;
  readonly input?: OrchestrationInputContractV1;
  readonly nodes: readonly OrchestrationNodeV1[];
}

export interface NormalizedOrchestrationContextSnapshotPolicyV1 {
  readonly strategy: OrchestrationContextSnapshotStrategyV1;
  readonly maxTokens: number;
}

export interface NormalizedOrchestrationPolicyV1 {
  readonly maxParallel: number;
  readonly maxRunMs: number;
  readonly defaultNodeTimeoutMs: number;
  readonly defaultMaxTurns: number;
  readonly defaultMaxTokens: number;
  readonly contextSnapshot?: NormalizedOrchestrationContextSnapshotPolicyV1;
  readonly allowedTools: readonly string[];
  readonly failureMode: OrchestrationFailureModeV1;
}

export interface NormalizedOrchestrationNodeContextV1 {
  readonly includeRunInput: boolean;
  readonly includeContextSnapshot: boolean;
  readonly includeNodeOutputs: OrchestrationNodeOutputReferenceV1;
}

export interface NormalizedOrchestrationNodePolicyV1 {
  readonly timeoutMs: number;
  readonly maxTurns: number;
  readonly maxTokens: number;
  readonly tools: readonly string[];
}

export interface NormalizedOrchestrationNodeV1 {
  readonly id: string;
  readonly kind: OrchestrationNodeKindV1;
  readonly title?: string;
  readonly dependsOn: readonly string[];
  readonly instruction: string;
  readonly context: NormalizedOrchestrationNodeContextV1;
  readonly output: NormalizedOrchestrationOutputContractV1;
  readonly policy: NormalizedOrchestrationNodePolicyV1;
}

export interface NormalizedOrchestrationDefinitionV1 {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly policy: NormalizedOrchestrationPolicyV1;
  readonly input?: NormalizedOrchestrationInputContractV1;
  readonly nodeIds: readonly string[];
  readonly nodesById: Readonly<Record<string, NormalizedOrchestrationNodeV1>>;
}

export interface OrchestrationPlanV1 {
  readonly topologicalOrder: readonly string[];
  readonly rootNodeIds: readonly string[];
  readonly dependencies: Readonly<Record<string, readonly string[]>>;
  readonly dependents: Readonly<Record<string, readonly string[]>>;
}

export interface OrchestrationExecutableV1 {
  readonly sourceMode: OrchestrationSourceModeV1;
  readonly definition: NormalizedOrchestrationDefinitionV1;
  readonly plan: OrchestrationPlanV1;
  readonly caps: OrchestrationSystemCapsV1;
}

export type OrchestrationParseResultV1 =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issues: readonly OrchestrationValidationIssueV1[] };

export type OrchestrationValidationResultV1 =
  | { readonly ok: true; readonly definition: OrchestrationDefinitionV1 }
  | { readonly ok: false; readonly issues: readonly OrchestrationValidationIssueV1[] };

export type OrchestrationLoadResultV1 =
  | { readonly ok: true; readonly executable: OrchestrationExecutableV1 }
  | { readonly ok: false; readonly issues: readonly OrchestrationValidationIssueV1[] };

export type OrchestrationTemplateParamV1 = string;
export type OrchestrationTemplateParamsV1 = Readonly<
  Record<string, OrchestrationTemplateParamV1>
>;

export interface OrchestrationContextSnapshotV1 {
  readonly source: "attention_window";
  readonly strategy: OrchestrationContextSnapshotStrategyV1;
  readonly messages: readonly Message[];
  readonly estimatedTokens: number;
  readonly capturedAt: string;
}

export type OrchestrationNodeRunStatusV1 =
  | "completed"
  | "failed"
  | "aborted"
  | "skipped";

export interface OrchestrationNodeOutputV1 {
  readonly nodeId: string;
  readonly format: OrchestrationContractFormatV1;
  readonly content: string;
}

export interface OrchestrationNodeRunResultV1 {
  readonly nodeId: string;
  readonly status: OrchestrationNodeRunStatusV1;
  readonly output?: OrchestrationNodeOutputV1;
  readonly error?: string;
  readonly usage?: TokenUsage;
  readonly durationMs: number;
}

export interface OrchestrationRunResultV1 {
  readonly definitionId: string;
  readonly status: "completed" | "failed" | "aborted";
  readonly nodeResults: Readonly<Record<string, OrchestrationNodeRunResultV1>>;
  readonly usage?: TokenUsage;
  readonly durationMs: number;
}
