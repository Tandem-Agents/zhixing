import {
  resolveFileRefs,
  type ResolveFileRefsOptions,
  type ResolveResult,
} from "./resolve-file-refs.js";

type FileRefResolver = (
  input: string,
  options: ResolveFileRefsOptions,
) => Promise<ResolveResult>;

export interface PrepareUserTurnInputOptions {
  readonly workspaceRoot: string;
  readonly resolveRefs?: FileRefResolver;
}

export interface PreparedUserTurnInput {
  readonly text: string;
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

  if (!input.includes("@file:")) {
    return {
      text: input,
      resolvedFiles: [],
      errors: [],
    };
  }

  const refResult = await (options.resolveRefs ?? resolveFileRefs)(input, {
    workspaceRoot: options.workspaceRoot,
  });
  return {
    text: refResult.text,
    resolvedFiles: refResult.resolvedFiles,
    errors: refResult.errors,
  };
}
