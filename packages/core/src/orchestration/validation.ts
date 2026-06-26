import { isPlainObject } from "./internal.js";
import type {
  OrchestrationDefinitionV1,
  OrchestrationSystemCapsV1,
  OrchestrationValidationIssueCodeV1,
  OrchestrationValidationIssueV1,
  OrchestrationValidationResultV1,
} from "./types.js";

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

const DEFINITION_KEYS = new Set([
  "version",
  "id",
  "title",
  "description",
  "policy",
  "input",
  "nodes",
]);
const POLICY_KEYS = new Set([
  "maxParallel",
  "maxRunMs",
  "defaultNodeTimeoutMs",
  "defaultMaxTurns",
  "defaultMaxTokens",
  "contextSnapshot",
  "allowedTools",
  "failureMode",
]);
const SNAPSHOT_POLICY_KEYS = new Set(["strategy", "maxTokens"]);
const CONTRACT_KEYS = new Set(["required", "format", "schema", "maxChars"]);
const NODE_KEYS = new Set([
  "id",
  "kind",
  "title",
  "dependsOn",
  "instruction",
  "context",
  "output",
  "policy",
]);
const NODE_CONTEXT_KEYS = new Set([
  "includeRunInput",
  "includeContextSnapshot",
  "includeNodeOutputs",
]);
const NODE_POLICY_KEYS = new Set([
  "timeoutMs",
  "maxTurns",
  "maxTokens",
  "tools",
]);

interface PolicyInfo {
  readonly allowedTools: ReadonlySet<string>;
  readonly hasContextSnapshot: boolean;
}

interface NodeRecord {
  readonly id: string;
  readonly path: string;
  readonly dependsOn: readonly string[];
}

export function validateOrchestrationDefinitionV1(
  value: unknown,
  caps: OrchestrationSystemCapsV1,
): OrchestrationValidationResultV1 {
  const issues: OrchestrationValidationIssueV1[] = [];

  if (!isPlainObject(value)) {
    addIssue(issues, "$", "type_mismatch", "Definition must be an object.");
    return { ok: false, issues };
  }

  validateObjectKeys(value, "$", DEFINITION_KEYS, issues);
  validateVersion(value, issues);
  validateId(value, "id", "$.id", issues);
  validateRequiredString(value, "title", "$.title", issues);
  validateOptionalString(value, "description", "$.description", issues);

  if ("input" in value) {
    validateInputContract(value.input, "$.input", caps, issues);
  }

  const policyInfo = validatePolicy(value.policy, "$.policy", caps, issues);
  const nodeRecords = validateNodes(
    value.nodes,
    "$.nodes",
    caps,
    policyInfo,
    "input" in value,
    issues,
  );
  validateNodeReferences(nodeRecords, issues);

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, definition: value as unknown as OrchestrationDefinitionV1 };
}

function validateVersion(
  value: Record<string, unknown>,
  issues: OrchestrationValidationIssueV1[],
): void {
  if (!("version" in value)) {
    addIssue(issues, "$.version", "missing_required", "version is required.");
    return;
  }

  if (value.version !== 1) {
    addIssue(issues, "$.version", "invalid_literal", "version must be 1.");
  }
}

function validatePolicy(
  value: unknown,
  path: string,
  caps: OrchestrationSystemCapsV1,
  issues: OrchestrationValidationIssueV1[],
): PolicyInfo {
  if (!isPlainObject(value)) {
    addIssue(issues, path, "type_mismatch", "policy must be an object.");
    return { allowedTools: new Set(), hasContextSnapshot: false };
  }

  validateObjectKeys(value, path, POLICY_KEYS, issues);
  validateRequiredBoundedInteger(
    value,
    "maxParallel",
    `${path}.maxParallel`,
    1,
    caps.maxParallel,
    issues,
  );
  validateRequiredBoundedInteger(
    value,
    "maxRunMs",
    `${path}.maxRunMs`,
    1,
    caps.maxRunMs,
    issues,
  );
  validateRequiredBoundedInteger(
    value,
    "defaultNodeTimeoutMs",
    `${path}.defaultNodeTimeoutMs`,
    1,
    caps.maxNodeTimeoutMs,
    issues,
  );
  validateRequiredBoundedInteger(
    value,
    "defaultMaxTurns",
    `${path}.defaultMaxTurns`,
    1,
    caps.maxNodeTurns,
    issues,
  );
  if ("defaultMaxTokens" in value) {
    validateRequiredBoundedInteger(
      value,
      "defaultMaxTokens",
      `${path}.defaultMaxTokens`,
      1,
      caps.maxNodeTokens,
      issues,
    );
  }

  if ("failureMode" in value && value.failureMode !== "fail_fast") {
    addIssue(
      issues,
      `${path}.failureMode`,
      "invalid_literal",
      "failureMode must be fail_fast when provided.",
    );
  }

  const allowedTools = validateToolList(
    value.allowedTools,
    `${path}.allowedTools`,
    new Set(caps.allowedTools),
    issues,
  );
  const hasContextSnapshot =
    "contextSnapshot" in value &&
    validateContextSnapshotPolicy(
      value.contextSnapshot,
      `${path}.contextSnapshot`,
      caps,
      issues,
    );

  return { allowedTools: new Set(allowedTools), hasContextSnapshot };
}

function validateContextSnapshotPolicy(
  value: unknown,
  path: string,
  caps: OrchestrationSystemCapsV1,
  issues: OrchestrationValidationIssueV1[],
): boolean {
  if (!isPlainObject(value)) {
    addIssue(issues, path, "type_mismatch", "contextSnapshot must be an object.");
    return false;
  }

  validateObjectKeys(value, path, SNAPSHOT_POLICY_KEYS, issues);

  if (!("strategy" in value)) {
    addIssue(
      issues,
      `${path}.strategy`,
      "missing_required",
      "contextSnapshot.strategy is required.",
    );
  } else if (value.strategy !== "full_or_fail" && value.strategy !== "tail") {
    addIssue(
      issues,
      `${path}.strategy`,
      "invalid_literal",
      "contextSnapshot.strategy must be full_or_fail or tail.",
    );
  }

  if ("maxTokens" in value) {
    validateRequiredBoundedInteger(
      value,
      "maxTokens",
      `${path}.maxTokens`,
      1,
      caps.maxContextSnapshotTokens,
      issues,
    );
  }

  return true;
}

function validateInputContract(
  value: unknown,
  path: string,
  caps: OrchestrationSystemCapsV1,
  issues: OrchestrationValidationIssueV1[],
): void {
  if (!isPlainObject(value)) {
    addIssue(issues, path, "type_mismatch", "input must be an object.");
    return;
  }

  validateObjectKeys(value, path, CONTRACT_KEYS, issues);
  validateOptionalBoolean(value, "required", `${path}.required`, issues);
  validateFormat(value, `${path}.format`, issues);
  if ("maxChars" in value) {
    validateRequiredBoundedInteger(
      value,
      "maxChars",
      `${path}.maxChars`,
      1,
      caps.maxInputChars,
      issues,
    );
  }
  validateOptionalSchema(value.schema, `${path}.schema`, issues);
}

function validateOutputContract(
  value: unknown,
  path: string,
  caps: OrchestrationSystemCapsV1,
  issues: OrchestrationValidationIssueV1[],
): void {
  if (!isPlainObject(value)) {
    addIssue(issues, path, "type_mismatch", "output must be an object.");
    return;
  }

  validateObjectKeys(value, path, CONTRACT_KEYS, issues);
  if (value.required !== true) {
    addIssue(issues, `${path}.required`, "invalid_literal", "output.required must be true.");
  }
  validateFormat(value, `${path}.format`, issues);
  if ("maxChars" in value) {
    validateRequiredBoundedInteger(
      value,
      "maxChars",
      `${path}.maxChars`,
      1,
      caps.maxOutputChars,
      issues,
    );
  }
  validateOptionalSchema(value.schema, `${path}.schema`, issues);
}

function validateNodes(
  value: unknown,
  path: string,
  caps: OrchestrationSystemCapsV1,
  policyInfo: PolicyInfo,
  hasInputContract: boolean,
  issues: OrchestrationValidationIssueV1[],
): readonly NodeRecord[] {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "type_mismatch", "nodes must be an array.");
    return [];
  }

  if (value.length < 1) {
    addIssue(issues, path, "too_small", "nodes must contain at least one node.");
  }

  if (value.length > caps.maxNodes) {
    addIssue(
      issues,
      path,
      "too_large",
      `nodes must contain at most ${caps.maxNodes} nodes.`,
    );
    return [];
  }

  const ids = new Set<string>();
  const records: NodeRecord[] = [];
  const allowedKinds = new Set(caps.allowedNodeKinds);

  value.forEach((node, index) => {
    const nodePath = `${path}[${index}]`;
    if (!isPlainObject(node)) {
      addIssue(issues, nodePath, "type_mismatch", "node must be an object.");
      return;
    }

    validateObjectKeys(node, nodePath, NODE_KEYS, issues);
    const id = validateId(node, "id", `${nodePath}.id`, issues);
    if (id !== undefined) {
      if (ids.has(id)) {
        addIssue(
          issues,
          `${nodePath}.id`,
          "duplicate_id",
          `node id "${id}" is duplicated.`,
        );
      }
      ids.add(id);
    }

    if (node.kind !== "agent") {
      addIssue(
        issues,
        `${nodePath}.kind`,
        "invalid_literal",
        "node.kind must be agent.",
      );
    } else if (!allowedKinds.has("agent")) {
      addIssue(
        issues,
        `${nodePath}.kind`,
        "invalid_literal",
        "agent nodes are not enabled by system caps.",
      );
    }

    validateOptionalString(node, "title", `${nodePath}.title`, issues);
    validateRequiredString(
      node,
      "instruction",
      `${nodePath}.instruction`,
      issues,
      caps.maxInstructionChars,
    );
    const dependsOn = validateOptionalStringArray(
      node.dependsOn,
      `${nodePath}.dependsOn`,
      issues,
    );
    if (id !== undefined) {
      records.push({ id, path: nodePath, dependsOn });
    }
    if ("context" in node) {
      validateNodeContext(
        node.context,
        `${nodePath}.context`,
        policyInfo,
        hasInputContract,
        dependsOn,
        issues,
      );
    }
    validateOutputContract(node.output, `${nodePath}.output`, caps, issues);
    if ("policy" in node) {
      validateNodePolicy(
        node.policy,
        `${nodePath}.policy`,
        caps,
        policyInfo.allowedTools,
        issues,
      );
    }
  });

  return records;
}

function validateNodeContext(
  value: unknown,
  path: string,
  policyInfo: PolicyInfo,
  hasInputContract: boolean,
  dependsOn: readonly string[],
  issues: OrchestrationValidationIssueV1[],
): void {
  if (!isPlainObject(value)) {
    addIssue(issues, path, "type_mismatch", "context must be an object.");
    return;
  }

  validateObjectKeys(value, path, NODE_CONTEXT_KEYS, issues);
  const includeRunInput = validateOptionalBoolean(
    value,
    "includeRunInput",
    `${path}.includeRunInput`,
    issues,
  );
  if (includeRunInput === true && !hasInputContract) {
    addIssue(
      issues,
      `${path}.includeRunInput`,
      "missing_input_contract",
      "includeRunInput requires definition input.",
    );
  }
  const includeSnapshot = validateOptionalBoolean(
    value,
    "includeContextSnapshot",
    `${path}.includeContextSnapshot`,
    issues,
  );
  if (includeSnapshot === true && !policyInfo.hasContextSnapshot) {
    addIssue(
      issues,
      `${path}.includeContextSnapshot`,
      "missing_context_snapshot_policy",
      "includeContextSnapshot requires policy.contextSnapshot.",
    );
  }
  validateNodeOutputReferences(
    value.includeNodeOutputs,
    `${path}.includeNodeOutputs`,
    dependsOn,
    issues,
  );
}

function validateNodePolicy(
  value: unknown,
  path: string,
  caps: OrchestrationSystemCapsV1,
  definitionAllowedTools: ReadonlySet<string>,
  issues: OrchestrationValidationIssueV1[],
): void {
  if (!isPlainObject(value)) {
    addIssue(issues, path, "type_mismatch", "node policy must be an object.");
    return;
  }

  validateObjectKeys(value, path, NODE_POLICY_KEYS, issues);
  if ("timeoutMs" in value) {
    validateRequiredBoundedInteger(
      value,
      "timeoutMs",
      `${path}.timeoutMs`,
      1,
      caps.maxNodeTimeoutMs,
      issues,
    );
  }
  if ("maxTurns" in value) {
    validateRequiredBoundedInteger(
      value,
      "maxTurns",
      `${path}.maxTurns`,
      1,
      caps.maxNodeTurns,
      issues,
    );
  }
  if ("maxTokens" in value) {
    validateRequiredBoundedInteger(
      value,
      "maxTokens",
      `${path}.maxTokens`,
      1,
      caps.maxNodeTokens,
      issues,
    );
  }
  if ("tools" in value) {
    validateToolList(value.tools, `${path}.tools`, definitionAllowedTools, issues);
  }
}

function validateNodeReferences(
  records: readonly NodeRecord[],
  issues: OrchestrationValidationIssueV1[],
): void {
  const ids = new Set(records.map((record) => record.id));
  let hasReferenceIssue = false;

  for (const record of records) {
    for (const dependency of record.dependsOn) {
      if (dependency === record.id) {
        hasReferenceIssue = true;
        addIssue(
          issues,
          `${record.path}.dependsOn`,
          "invalid_reference",
          `node "${record.id}" cannot depend on itself.`,
        );
      } else if (!ids.has(dependency)) {
        hasReferenceIssue = true;
        addIssue(
          issues,
          `${record.path}.dependsOn`,
          "unknown_reference",
          `dependency "${dependency}" does not exist.`,
        );
      }
    }
  }

  if (!hasReferenceIssue) {
    const cycle = findCycle(records);
    if (cycle.length > 0) {
      addIssue(
        issues,
        "$.nodes",
        "cycle_dependency",
        `nodes contain a dependency cycle: ${cycle.join(" -> ")}.`,
      );
    }
  }
}

function findCycle(records: readonly NodeRecord[]): readonly string[] {
  const dependencies = new Map(
    records.map((record) => [record.id, [...record.dependsOn]] as const),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): readonly string[] => {
    if (visited.has(id)) return [];
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return start >= 0 ? [...stack.slice(start), id] : [id, id];
    }

    visiting.add(id);
    stack.push(id);
    const deps = dependencies.get(id) ?? [];
    for (const dependency of deps) {
      const cycle = visit(dependency);
      if (cycle.length > 0) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return [];
  };

  for (const record of records) {
    const cycle = visit(record.id);
    if (cycle.length > 0) return cycle;
  }

  return [];
}

function validateId(
  object: Record<string, unknown>,
  key: string,
  path: string,
  issues: OrchestrationValidationIssueV1[],
): string | undefined {
  const value = validateRequiredString(object, key, path, issues);
  if (value !== undefined && !ID_PATTERN.test(value)) {
    addIssue(
      issues,
      path,
      "invalid_id",
      "id must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.",
    );
  }
  return value;
}

function validateRequiredString(
  object: Record<string, unknown>,
  key: string,
  path: string,
  issues: OrchestrationValidationIssueV1[],
  maxLength?: number,
): string | undefined {
  if (!(key in object)) {
    addIssue(issues, path, "missing_required", `${key} is required.`);
    return undefined;
  }

  const value = object[key];
  if (typeof value !== "string") {
    addIssue(issues, path, "type_mismatch", `${key} must be a string.`);
    return undefined;
  }

  if (value.trim().length === 0) {
    addIssue(issues, path, "empty_string", `${key} must not be empty.`);
  }

  if (maxLength !== undefined && value.length > maxLength) {
    addIssue(
      issues,
      path,
      "too_large",
      `${key} must contain at most ${maxLength} characters.`,
    );
  }

  return value;
}

function validateOptionalString(
  object: Record<string, unknown>,
  key: string,
  path: string,
  issues: OrchestrationValidationIssueV1[],
): void {
  if (!(key in object) || object[key] === undefined) return;
  if (typeof object[key] !== "string") {
    addIssue(issues, path, "type_mismatch", `${key} must be a string.`);
  }
}

function validateRequiredBoundedInteger(
  object: Record<string, unknown>,
  key: string,
  path: string,
  min: number,
  max: number,
  issues: OrchestrationValidationIssueV1[],
): number | undefined {
  if (!(key in object)) {
    addIssue(issues, path, "missing_required", `${key} is required.`);
    return undefined;
  }

  const value = object[key];
  if (!Number.isInteger(value)) {
    addIssue(issues, path, "type_mismatch", `${key} must be an integer.`);
    return undefined;
  }

  const numberValue = value as number;
  if (numberValue < min) {
    addIssue(issues, path, "too_small", `${key} must be at least ${min}.`);
  }
  if (numberValue > max) {
    addIssue(issues, path, "too_large", `${key} must be at most ${max}.`);
  }

  return numberValue;
}

function validateOptionalBoolean(
  object: Record<string, unknown>,
  key: string,
  path: string,
  issues: OrchestrationValidationIssueV1[],
): boolean | undefined {
  if (!(key in object) || object[key] === undefined) return undefined;
  if (typeof object[key] !== "boolean") {
    addIssue(issues, path, "type_mismatch", `${key} must be a boolean.`);
    return undefined;
  }
  return object[key] as boolean;
}

function validateFormat(
  object: Record<string, unknown>,
  path: string,
  issues: OrchestrationValidationIssueV1[],
): void {
  if (!("format" in object)) {
    addIssue(issues, path, "missing_required", "format is required.");
    return;
  }

  if (object.format !== "text" && object.format !== "json") {
    addIssue(issues, path, "invalid_literal", "format must be text or json.");
  }
}

function validateOptionalSchema(
  value: unknown,
  path: string,
  issues: OrchestrationValidationIssueV1[],
): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    addIssue(issues, path, "type_mismatch", "schema must be an object.");
    return;
  }
  if (value.type !== "object") {
    addIssue(issues, `${path}.type`, "invalid_literal", "schema.type must be object.");
  }
}

function validateOptionalStringArray(
  value: unknown,
  path: string,
  issues: OrchestrationValidationIssueV1[],
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    addIssue(issues, path, "type_mismatch", "value must be an array.");
    return [];
  }
  return validateStringArrayItems(value, path, issues);
}

function validateToolList(
  value: unknown,
  path: string,
  allowedTools: ReadonlySet<string>,
  issues: OrchestrationValidationIssueV1[],
): readonly string[] {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "type_mismatch", "tools must be an array.");
    return [];
  }

  const tools = validateStringArrayItems(value, path, issues);
  for (const tool of tools) {
    if (!allowedTools.has(tool)) {
      addIssue(
        issues,
        path,
        "invalid_reference",
        `tool "${tool}" is not allowed here.`,
      );
    }
  }
  return tools;
}

function validateStringArrayItems(
  values: readonly unknown[],
  path: string,
  issues: OrchestrationValidationIssueV1[],
): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  values.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof item !== "string") {
      addIssue(issues, itemPath, "type_mismatch", "array item must be a string.");
      return;
    }
    if (item.trim().length === 0) {
      addIssue(issues, itemPath, "empty_string", "array item must not be empty.");
      return;
    }
    if (seen.has(item)) {
      addIssue(issues, itemPath, "duplicate_value", `"${item}" is duplicated.`);
      return;
    }
    seen.add(item);
    result.push(item);
  });

  return result;
}

function validateNodeOutputReferences(
  value: unknown,
  path: string,
  dependsOn: readonly string[],
  issues: OrchestrationValidationIssueV1[],
): void {
  if (value === undefined || value === "dependencies") return;
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      path,
      "invalid_literal",
      "includeNodeOutputs must be dependencies or an array of dependency ids.",
    );
    return;
  }

  const references = validateStringArrayItems(value, path, issues);
  const directDependencies = new Set(dependsOn);
  for (const reference of references) {
    if (!directDependencies.has(reference)) {
      addIssue(
        issues,
        path,
        "invalid_reference",
        `node output reference "${reference}" must be a direct dependency.`,
      );
    }
  }
}

function validateObjectKeys(
  object: Record<string, unknown>,
  path: string,
  allowedKeys: ReadonlySet<string>,
  issues: OrchestrationValidationIssueV1[],
): void {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) {
      addIssue(
        issues,
        `${path}.${key}`,
        "unknown_property",
        `unknown property "${key}".`,
      );
    }
  }
}

function addIssue(
  issues: OrchestrationValidationIssueV1[],
  path: string,
  code: OrchestrationValidationIssueCodeV1,
  message: string,
): void {
  issues.push({ path, code, message });
}
