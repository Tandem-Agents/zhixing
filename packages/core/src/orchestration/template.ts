import { cloneData, isPlainObject } from "./internal.js";
import { parseOrchestrationDefinitionV1 } from "./jsonc.js";
import { loadOrchestrationDefinitionV1 } from "./loader.js";
import type {
  OrchestrationLoadResultV1,
  OrchestrationSystemCapsV1,
  OrchestrationTemplateParamV1,
  OrchestrationTemplateParamsV1,
  OrchestrationValidationIssueV1,
} from "./types.js";

const TEMPLATE_TOKEN = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;

export function instantiateTrustedOrchestrationTemplateV1(
  templateSource: string | unknown,
  params: OrchestrationTemplateParamsV1,
  caps: OrchestrationSystemCapsV1,
): OrchestrationLoadResultV1 {
  if (!isPlainObject(params)) {
    return {
      ok: false,
      issues: [
        {
          path: "$.params",
          code: "type_mismatch",
          message: "template params must be an object.",
        },
      ],
    };
  }

  const paramIssues = validateTemplateParams(params);
  if (paramIssues.length > 0) return { ok: false, issues: paramIssues };

  const parsed =
    typeof templateSource === "string"
      ? parseOrchestrationDefinitionV1(templateSource)
      : { ok: true as const, value: templateSource };

  if (!parsed.ok) return { ok: false, issues: parsed.issues };

  const issues: OrchestrationValidationIssueV1[] = [];
  const instantiated = instantiateValue(
    cloneData(parsed.value),
    params,
    "$.template",
    issues,
  );

  if (issues.length > 0) return { ok: false, issues };
  return loadOrchestrationDefinitionV1(instantiated, caps);
}

function validateTemplateParams(
  params: Readonly<Record<string, unknown>>,
): readonly OrchestrationValidationIssueV1[] {
  const issues: OrchestrationValidationIssueV1[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (!isTemplateParam(value)) {
      issues.push({
        path: `$.params.${key}`,
        code: "template_param_invalid",
        message: `template parameter "${key}" must be a string.`,
      });
    }
  }
  return issues;
}

function instantiateValue(
  value: unknown,
  params: Readonly<Record<string, unknown>>,
  path: string,
  issues: OrchestrationValidationIssueV1[],
): unknown {
  if (typeof value === "string") {
    return instantiateString(value, params, path, issues);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      instantiateValue(item, params, `${path}[${index}]`, issues),
    );
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = instantiateValue(item, params, `${path}.${key}`, issues);
    }
    return result;
  }

  return value;
}

function instantiateString(
  value: string,
  params: Readonly<Record<string, unknown>>,
  path: string,
  issues: OrchestrationValidationIssueV1[],
): string {
  return value.replace(TEMPLATE_TOKEN, (_match, key: string) => {
    const param = params[key];
    if (param === undefined) {
      issues.push({
        path,
        code: "template_param_missing",
        message: `template parameter "${key}" is missing.`,
      });
      return "";
    }

    if (!isTemplateParam(param)) {
      issues.push({
        path,
        code: "template_param_invalid",
        message: `template parameter "${key}" must be a string.`,
      });
      return "";
    }

    return String(param);
  });
}

function isTemplateParam(value: unknown): value is OrchestrationTemplateParamV1 {
  return typeof value === "string";
}
