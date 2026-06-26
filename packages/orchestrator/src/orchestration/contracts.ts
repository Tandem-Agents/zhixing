import type {
  JsonSchema,
  JsonSchemaProperty,
  NormalizedOrchestrationInputContractV1,
  NormalizedOrchestrationOutputContractV1,
  OrchestrationContractFormatV1,
  OrchestrationErrorV1,
  OrchestrationNodeOutputV1,
  OrchestrationValidationIssueV1,
} from "@zhixing/core";

export function validateRunInputV1(
  contract: NormalizedOrchestrationInputContractV1 | undefined,
  runInput: unknown,
): readonly OrchestrationValidationIssueV1[] {
  if (contract === undefined) return [];
  const issues: OrchestrationValidationIssueV1[] = [];

  if (runInput === undefined) {
    if (contract.required) {
      issues.push(issue("$.input", "missing_required", "run input is required."));
    }
    return issues;
  }

  validateContractValue(runInput, contract.format, contract.maxChars, "$.input", issues);
  if (contract.format === "json" && contract.schema) {
    validateJsonSchema(runInput, contract.schema, "$.input", issues);
  }
  return issues;
}

export function validateNodeOutputV1(
  nodeId: string,
  output: OrchestrationNodeOutputV1 | undefined,
  contract: NormalizedOrchestrationOutputContractV1,
): OrchestrationErrorV1 | undefined {
  if (output === undefined) {
    return nodeError(nodeId, "output_contract_failed", "node did not return output.");
  }
  if (output.nodeId !== nodeId) {
    return nodeError(
      nodeId,
      "output_contract_failed",
      `node returned output for "${output.nodeId}" instead of "${nodeId}".`,
    );
  }
  if (output.format !== contract.format) {
    return nodeError(
      nodeId,
      "output_contract_failed",
      `node output format "${output.format}" does not match contract "${contract.format}".`,
    );
  }
  if (output.content.trim().length === 0) {
    return nodeError(nodeId, "output_contract_failed", "node output is empty.");
  }
  if (output.content.length > contract.maxChars) {
    return nodeError(
      nodeId,
      "output_contract_failed",
      `node output exceeds maxChars ${contract.maxChars}.`,
    );
  }

  if (contract.format === "json") {
    const parsed = parseJsonOutput(output.content);
    if (!parsed.ok) {
      return nodeError(nodeId, "output_contract_failed", parsed.message);
    }
    if (contract.schema) {
      const issues: OrchestrationValidationIssueV1[] = [];
      validateJsonSchema(parsed.value, contract.schema, `$.nodes.${nodeId}.output`, issues);
      if (issues.length > 0) {
        return nodeError(
          nodeId,
          "output_contract_failed",
          issues.map((validationIssue) => validationIssue.message).join("; "),
        );
      }
    }
  }

  return undefined;
}

function validateContractValue(
  value: unknown,
  format: OrchestrationContractFormatV1,
  maxChars: number,
  path: string,
  issues: OrchestrationValidationIssueV1[],
): void {
  if (format === "text") {
    if (typeof value !== "string") {
      issues.push(issue(path, "type_mismatch", "text input must be a string."));
      return;
    }
    if (value.length > maxChars) {
      issues.push(issue(path, "too_large", `text input exceeds maxChars ${maxChars}.`));
    }
    return;
  }

  if (!isJsonCompatible(value)) {
    issues.push(issue(path, "type_mismatch", "json input must be JSON-compatible."));
    return;
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > maxChars) {
    issues.push(issue(path, "too_large", `json input exceeds maxChars ${maxChars}.`));
  }
}

function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  path: string,
  issues: OrchestrationValidationIssueV1[],
): void {
  if (!isPlainObject(value)) {
    issues.push(issue(path, "type_mismatch", "value must be an object."));
    return;
  }

  for (const requiredKey of schema.required ?? []) {
    if (!(requiredKey in value)) {
      issues.push(
        issue(`${path}.${requiredKey}`, "missing_required", `${requiredKey} is required.`),
      );
    }
  }

  for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
    if (value[key] !== undefined) {
      validateJsonSchemaProperty(value[key], propertySchema, `${path}.${key}`, issues);
    }
  }

  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties ?? {}));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        issues.push(
          issue(`${path}.${key}`, "unknown_property", `${key} is not allowed.`),
        );
      }
    }
  }
}

function validateJsonSchemaProperty(
  value: unknown,
  schema: JsonSchemaProperty,
  path: string,
  issues: OrchestrationValidationIssueV1[],
): void {
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") {
        issues.push(issue(path, "type_mismatch", `${path} must be a string.`));
      }
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        issues.push(issue(path, "type_mismatch", `${path} must be a number.`));
      }
      return;
    case "integer":
      if (!Number.isInteger(value)) {
        issues.push(issue(path, "type_mismatch", `${path} must be an integer.`));
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        issues.push(issue(path, "type_mismatch", `${path} must be a boolean.`));
      }
      return;
    case "array":
      if (!Array.isArray(value)) {
        issues.push(issue(path, "type_mismatch", `${path} must be an array.`));
        return;
      }
      if (schema.items) {
        value.forEach((item, index) =>
          validateJsonSchemaProperty(item, schema.items!, `${path}[${index}]`, issues),
        );
      }
      return;
    case "object":
      validateJsonSchema(
        value,
        {
          type: "object",
          properties: schema.properties,
          required: schema.required,
          additionalProperties:
            typeof schema.additionalProperties === "boolean"
              ? schema.additionalProperties
              : undefined,
        },
        path,
        issues,
      );
      return;
    case "null":
      if (value !== null) {
        issues.push(issue(path, "type_mismatch", `${path} must be null.`));
      }
      return;
    default:
      return;
  }
}

function parseJsonOutput(
  content: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch (error) {
    return {
      ok: false,
      message: `node output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonCompatible(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonCompatible);
  if (isPlainObject(value)) {
    return Object.values(value).every((item) => item !== undefined && isJsonCompatible(item));
  }
  return false;
}

function issue(
  path: string,
  code: OrchestrationValidationIssueV1["code"],
  message: string,
): OrchestrationValidationIssueV1 {
  return { path, code, message };
}

function nodeError(
  nodeId: string,
  type: string,
  message: string,
): OrchestrationErrorV1 {
  return { type, message, origin: "node", nodeId };
}
