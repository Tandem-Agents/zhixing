import {
  resolveFileRefs,
  type ResolveFileRefsOptions,
  type ResolveResult,
} from "./resolve-file-refs.js";
import type { UserTurnInput } from "@zhixing/core";
import type { InputMaterialRegistry } from "./input-material-registry.js";
import { resolveInputMaterials } from "./input-material-resolve.js";

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

/**
 * 准备发给 core 的用户正文。trim 只用于空输入判断；正文 payload 必须保留
 * 用户原文，文件引用解析也只替换命中的引用片段。
 */
export async function prepareUserTurnInput(
  input: string,
  options: PrepareUserTurnInputOptions,
): Promise<PreparedUserTurnInput | null> {
  if (input.trim().length === 0) return null;

  const refResult = input.includes("@file:")
    ? await (options.resolveRefs ?? resolveFileRefs)(input, {
        workspaceRoot: options.workspaceRoot,
      })
    : { text: input, resolvedFiles: [], errors: [] };

  if (!options.materialRegistry) {
    return {
      text: refResult.text,
      input: { parts: [{ type: "text", text: refResult.text }] },
      resolvedFiles: refResult.resolvedFiles,
      errors: refResult.errors,
    };
  }

  const materialResult = await resolveInputMaterials(
    refResult.text,
    options.materialRegistry,
  );
  return {
    text: refResult.text,
    input: materialResult.input,
    resolvedFiles: refResult.resolvedFiles,
    errors: [...refResult.errors, ...materialResult.errors],
  };
}
