import { cloneData, isPlainObject } from "./internal.js";
import { ORCHESTRATION_ID_RULE, isOrchestrationId } from "./ids.js";
import { parseOrchestrationDefinitionV1 } from "./jsonc.js";
import { loadOrchestrationDefinitionV1 } from "./loader.js";
import type {
  OrchestrationLoadResultV1,
  OrchestrationSystemCapsV1,
  OrchestrationTemplateArrayItemV1,
  OrchestrationTemplateArrayParamV1,
  OrchestrationTemplateParamV1,
  OrchestrationTemplateParamsV1,
  OrchestrationValidationIssueV1,
} from "./types.js";

const TEMPLATE_TOKEN = /\{\{\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)\s*\}\}/g;
const TEMPLATE_PARAM_KEY = /^[A-Za-z0-9_-]+$/;

interface TemplateScope {
  readonly item?: OrchestrationTemplateArrayItemV1;
}

interface ExpansionState {
  readonly groupsByReference: Map<string, ExpansionGroupRecord>;
}

interface ExpansionGroupRecord {
  readonly path: string;
  readonly ids: string[];
}

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

  const paramIssues = validateTemplateParams(params, caps);
  if (paramIssues.length > 0) return { ok: false, issues: paramIssues };

  const parsed =
    typeof templateSource === "string"
      ? parseOrchestrationDefinitionV1(templateSource)
      : { ok: true as const, value: templateSource };

  if (!parsed.ok) return { ok: false, issues: parsed.issues };

  const issues: OrchestrationValidationIssueV1[] = [];
  const state: ExpansionState = { groupsByReference: new Map() };
  const instantiated = instantiateValue(
    cloneData(parsed.value),
    params,
    "$.template",
    issues,
    state,
    {},
  );

  if (issues.length > 0) return { ok: false, issues };
  const groupIssues = validateExpansionGroups(
    instantiated,
    state.groupsByReference,
  );
  if (groupIssues.length > 0) return { ok: false, issues: groupIssues };
  return loadOrchestrationDefinitionV1(
    replaceExpansionGroupReferences(instantiated, state.groupsByReference),
    caps,
  );
}

function validateTemplateParams(
  params: Readonly<Record<string, unknown>>,
  caps: OrchestrationSystemCapsV1,
): readonly OrchestrationValidationIssueV1[] {
  const issues: OrchestrationValidationIssueV1[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") continue;
    if (isTemplateArrayParam(value, `$.params.${key}`, caps, issues)) continue;
    if (!Array.isArray(value)) {
      issues.push({
        path: `$.params.${key}`,
        code: "template_param_invalid",
        message: `template parameter "${key}" must be a string or a bounded array of string-field objects.`,
      });
    }
  }
  return issues;
}

function isTemplateArrayParam(
  value: unknown,
  path: string,
  caps: OrchestrationSystemCapsV1,
  issues: OrchestrationValidationIssueV1[],
): value is OrchestrationTemplateArrayParamV1 {
  if (!Array.isArray(value)) return false;

  if (value.length < 1) {
    issues.push({
      path,
      code: "too_small",
      message: "template array parameter must contain at least one item.",
    });
  }
  if (value.length > caps.maxNodes) {
    issues.push({
      path,
      code: "too_large",
      message: `template array parameter must contain at most ${caps.maxNodes} items.`,
    });
  }

  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isPlainObject(item)) {
      issues.push({
        path: itemPath,
        code: "template_param_invalid",
        message: "template array item must be an object.",
      });
      return;
    }

    for (const [field, fieldValue] of Object.entries(item)) {
      const fieldPath = `${itemPath}.${field}`;
      if (!TEMPLATE_PARAM_KEY.test(field)) {
        issues.push({
          path: fieldPath,
          code: "template_param_invalid",
          message:
            "template array item field names must contain only letters, numbers, underscores, or hyphens.",
        });
      }
      if (field === "index") {
        issues.push({
          path: fieldPath,
          code: "template_param_invalid",
          message: 'template array item field "index" is reserved.',
        });
      }
      if (typeof fieldValue !== "string") {
        issues.push({
          path: fieldPath,
          code: "template_param_invalid",
          message: "template array item fields must be strings.",
        });
      }
    }
  });

  return true;
}

function instantiateValue(
  value: unknown,
  params: Readonly<Record<string, unknown>>,
  path: string,
  issues: OrchestrationValidationIssueV1[],
  state: ExpansionState,
  scope: TemplateScope,
): unknown {
  if (typeof value === "string") {
    return instantiateString(value, params, path, issues, scope);
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const itemPath = `${path}[${index}]`;
      if (isPlainObject(item) && "expandForEach" in item) {
        return expandTemplateItem(item, params, itemPath, issues, state, scope);
      }
      return [
        instantiateValue(item, params, itemPath, issues, state, scope),
      ];
    });
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "expandForEach") {
        issues.push({
          path: `${path}.expandForEach`,
          code: "invalid_literal",
          message: "expandForEach can only be used on objects inside arrays.",
        });
        continue;
      }
      result[key] = instantiateValue(
        item,
        params,
        `${path}.${key}`,
        issues,
        state,
        scope,
      );
    }
    return result;
  }

  return value;
}

function expandTemplateItem(
  templateItem: Record<string, unknown>,
  params: Readonly<Record<string, unknown>>,
  path: string,
  issues: OrchestrationValidationIssueV1[],
  state: ExpansionState,
  scope: TemplateScope,
): unknown[] {
  const paramName = templateItem.expandForEach;
  if (typeof paramName !== "string" || paramName.trim().length === 0) {
    issues.push({
      path: `${path}.expandForEach`,
      code: "invalid_literal",
      message: "expandForEach must name a template array parameter.",
    });
    return [];
  }

  const arrayParamName = paramName.trim();
  const param = params[arrayParamName];
  if (param === undefined) {
    issues.push({
      path: `${path}.expandForEach`,
      code: "template_param_missing",
      message: `template array parameter "${arrayParamName}" is missing.`,
    });
    return [];
  }
  if (!Array.isArray(param)) {
    issues.push({
      path: `${path}.expandForEach`,
      code: "template_param_invalid",
      message: `template parameter "${arrayParamName}" must be an array for expansion.`,
    });
    return [];
  }

  const groupReference = readExpansionGroupReference(
    templateItem,
    path,
    issues,
    state,
  );
  const { expandForEach: _expandForEach, groupId: _groupId, ...itemTemplate } =
    templateItem;
  const expandedIds: string[] = [];

  const expanded = param.map((item, index) => {
    const scopedItem = { ...item, index: String(index + 1) };
    const expandedItem = instantiateValue(
      itemTemplate,
      params,
      `${path}[${index}]`,
      issues,
      state,
      { ...scope, item: scopedItem },
    );
    if (groupReference && isPlainObject(expandedItem)) {
      const id = expandedItem.id;
      if (typeof id === "string") expandedIds.push(id);
    }
    return expandedItem;
  });

  if (groupReference) {
    const group = state.groupsByReference.get(groupReference);
    if (group) group.ids.push(...expandedIds);
  }

  return expanded;
}

function readExpansionGroupReference(
  templateItem: Record<string, unknown>,
  path: string,
  issues: OrchestrationValidationIssueV1[],
  state: ExpansionState,
): string | undefined {
  if (!Object.hasOwn(templateItem, "groupId")) return undefined;

  const groupPath = `${path}.groupId`;
  const groupId = templateItem.groupId;
  if (typeof groupId !== "string") {
    issues.push({
      path: groupPath,
      code: "type_mismatch",
      message: "groupId must be a string.",
    });
    return undefined;
  }

  if (groupId.trim().length === 0) {
    issues.push({
      path: groupPath,
      code: "empty_string",
      message: "groupId must not be empty.",
    });
    return undefined;
  }

  if (!isOrchestrationId(groupId)) {
    issues.push({
      path: groupPath,
      code: "invalid_id",
      message: `groupId ${ORCHESTRATION_ID_RULE}.`,
    });
    return undefined;
  }

  if (state.groupsByReference.has(groupId)) {
    issues.push({
      path: groupPath,
      code: "duplicate_value",
      message: `template expansion groupId "${groupId}" is duplicated.`,
    });
    return undefined;
  }

  state.groupsByReference.set(groupId, { path, ids: [] });
  return groupId;
}

function instantiateString(
  value: string,
  params: Readonly<Record<string, unknown>>,
  path: string,
  issues: OrchestrationValidationIssueV1[],
  scope: TemplateScope,
): string {
  return value.replace(TEMPLATE_TOKEN, (_match, key: string) => {
    if (key.startsWith("item.")) {
      return instantiateItemString(key, scope, path, issues);
    }

    const param = params[key];
    if (param === undefined) {
      issues.push({
        path,
        code: "template_param_missing",
        message: `template parameter "${key}" is missing.`,
      });
      return "";
    }

    if (!isTemplateScalarParam(param)) {
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

function instantiateItemString(
  key: string,
  scope: TemplateScope,
  path: string,
  issues: OrchestrationValidationIssueV1[],
): string {
  const field = key.slice("item.".length);
  if (!scope.item) {
    issues.push({
      path,
      code: "template_param_missing",
      message: `template item parameter "${key}" is not in scope.`,
    });
    return "";
  }

  if (!Object.hasOwn(scope.item, field)) {
    issues.push({
      path,
      code: "template_param_missing",
      message: `template item parameter "${key}" is missing.`,
    });
    return "";
  }

  const value = scope.item[field];
  if (typeof value !== "string") {
    issues.push({
      path,
      code: "template_param_missing",
      message: `template item parameter "${key}" is missing.`,
    });
    return "";
  }
  return value;
}

function validateExpansionGroups(
  value: unknown,
  groupsByReference: ReadonlyMap<string, ExpansionGroupRecord>,
): readonly OrchestrationValidationIssueV1[] {
  if (groupsByReference.size === 0) return [];

  const issues: OrchestrationValidationIssueV1[] = [];
  const nodeIds = collectNodeIds(value);
  for (const [groupId, group] of groupsByReference) {
    if (nodeIds.has(groupId)) {
      issues.push({
        path: `${group.path}.groupId`,
        code: "invalid_reference",
        message: `template expansion groupId "${groupId}" conflicts with a node id.`,
      });
    }
  }
  return issues;
}

function collectNodeIds(value: unknown): ReadonlySet<string> {
  const nodeIds = new Set<string>();
  if (!isPlainObject(value) || !Array.isArray(value.nodes)) return nodeIds;

  for (const node of value.nodes) {
    if (!isPlainObject(node)) continue;
    const id = node.id;
    if (typeof id === "string") nodeIds.add(id);
  }
  return nodeIds;
}

function replaceExpansionGroupReferences(
  value: unknown,
  groupsByReference: ReadonlyMap<string, ExpansionGroupRecord>,
): unknown {
  if (groupsByReference.size === 0) return value;

  if (!isPlainObject(value) || !Array.isArray(value.nodes)) return value;

  return {
    ...value,
    nodes: value.nodes.map((node) =>
      isPlainObject(node) && Array.isArray(node.dependsOn)
        ? {
            ...node,
            dependsOn: expandDependencyReferences(
              node.dependsOn,
              groupsByReference,
            ),
          }
        : node,
    ),
  };
}

function expandDependencyReferences(
  value: readonly unknown[],
  groupsByReference: ReadonlyMap<string, ExpansionGroupRecord>,
): readonly unknown[] {
  const result: unknown[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    const expansion =
      typeof item === "string" ? groupsByReference.get(item)?.ids : undefined;
    const references = expansion ?? [item];
    for (const reference of references) {
      if (typeof reference === "string") {
        if (seen.has(reference)) continue;
        seen.add(reference);
      }
      result.push(reference);
    }
  }

  return result;
}

function isTemplateScalarParam(
  value: unknown,
): value is Extract<OrchestrationTemplateParamV1, string> {
  return typeof value === "string";
}
