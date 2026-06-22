import {
  resolveFileRefs,
  type ResolveFileRefsOptions,
  type ResolveResult,
} from "./resolve-file-refs.js";
import type { UserInputPart, UserTurnInput } from "@zhixing/core";
import {
  createMaterialTokenPattern,
  type InputMaterialRegistry,
} from "./input-material-registry.js";
import {
  resolveInputMaterialToken,
  type InputMaterialTokenLabel,
} from "./input-material-resolve.js";

type FileRefResolver = (
  input: string,
  options: ResolveFileRefsOptions,
) => Promise<ResolveResult>;

export interface PrepareUserTurnInputOptions {
  readonly workspaceRoot: string;
  readonly materialRegistry?: InputMaterialRegistry;
  readonly resolveRefs?: FileRefResolver;
}

export interface PreparedUserTurnInput {
  readonly text: string;
  readonly input: UserTurnInput;
  readonly resolvedFiles: readonly string[];
  readonly errors: readonly string[];
}

type InputSegment =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "material-handle";
      readonly token: string;
      readonly label: InputMaterialTokenLabel;
      readonly id: number;
    };

/**
 * 准备发给 core 的用户正文。trim 只用于空输入判断；正文 payload 必须保留
 * 用户原文，文件引用解析只作用于文本片段，不能二次解析出 UI handle。
 */
export async function prepareUserTurnInput(
  input: string,
  options: PrepareUserTurnInputOptions,
): Promise<PreparedUserTurnInput | null> {
  if (input.trim().length === 0) return null;

  if (!options.materialRegistry) {
    const refResult = await resolveTextSegment(input, options);
    return {
      text: refResult.text,
      input: { parts: [{ type: "text", text: refResult.text }] },
      resolvedFiles: refResult.resolvedFiles,
      errors: refResult.errors,
    };
  }

  const parts: UserInputPart[] = [];
  const resolvedFiles: string[] = [];
  const errors: string[] = [];
  let text = "";

  for (const segment of splitInputSegments(input)) {
    if (segment.kind === "text") {
      const refResult = await resolveTextSegment(segment.text, options);
      text += refResult.text;
      resolvedFiles.push(...refResult.resolvedFiles);
      errors.push(...refResult.errors);
      pushTextPart(parts, refResult.text);
      continue;
    }

    text += segment.token;
    const materialResult = await resolveInputMaterialToken(
      {
        token: segment.token,
        label: segment.label,
        id: segment.id,
      },
      options.materialRegistry,
    );
    pushParts(parts, materialResult.input.parts);
    errors.push(...materialResult.errors);
  }

  return {
    text,
    input: { parts },
    resolvedFiles,
    errors,
  };
}

async function resolveTextSegment(
  text: string,
  options: PrepareUserTurnInputOptions,
): Promise<ResolveResult> {
  if (!text.includes("@file:")) {
    return { text, resolvedFiles: [], errors: [] };
  }
  return await (options.resolveRefs ?? resolveFileRefs)(text, {
    workspaceRoot: options.workspaceRoot,
  });
}

function splitInputSegments(input: string): InputSegment[] {
  const segments: InputSegment[] = [];
  let offset = 0;
  for (const match of input.matchAll(createMaterialTokenPattern())) {
    const start = match.index!;
    if (start > offset) {
      segments.push({ kind: "text", text: input.slice(offset, start) });
    }
    segments.push({
      kind: "material-handle",
      token: match[0],
      label: match[1] as InputMaterialTokenLabel,
      id: parseInt(match[2]!, 10),
    });
    offset = start + match[0].length;
  }
  if (offset < input.length) {
    segments.push({ kind: "text", text: input.slice(offset) });
  }
  return segments.length > 0 ? segments : [{ kind: "text", text: input }];
}

function pushParts(parts: UserInputPart[], nextParts: readonly UserInputPart[]): void {
  for (const part of nextParts) {
    if (part.type === "text") {
      pushTextPart(parts, part.text);
    } else {
      parts.push(part);
    }
  }
}

function pushTextPart(parts: UserInputPart[], text: string): void {
  if (text.length === 0) return;
  const last = parts[parts.length - 1];
  if (last?.type === "text") {
    parts[parts.length - 1] = { type: "text", text: last.text + text };
    return;
  }
  parts.push({ type: "text", text });
}
