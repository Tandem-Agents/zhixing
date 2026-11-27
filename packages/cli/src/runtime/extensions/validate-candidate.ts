import { spawn } from "node:child_process";
import { validateExtensionCandidate } from "@zhixing-ai/core/extensions/candidate";
import { channelDeclaration } from "@zhixing-ai/core/channels/extension";
import type { ExtensionCandidate } from "@zhixing-ai/core/extensions/contracts";

export interface CandidateValidationSummary {
  readonly valid: true;
  readonly id: string;
  readonly digest: string;
  readonly protocol: ExtensionCandidate["manifest"]["protocol"];
  readonly contract: number;
  readonly executed: false;
}

const SYNTAX_CHECK_TIMEOUT_MS = 10_000;

async function checkModuleSyntax(
  code: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  abortSignal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--check", "--input-type=module"], {
      env: {},
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      child.kill();
      finish(new Error("候选语法检查已中止"));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("入口 JavaScript 语法检查超时"));
    }, SYNTAX_CHECK_TIMEOUT_MS);
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.once("error", (err) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });
    child.stdin.on("error", () => {
      // Child may exit before consuming all stdin; exit handler reports syntax status.
    });
    child.once("close", (status) => {
      if (status === 0) finish();
      else finish(new Error("入口 JavaScript 语法检查未通过"));
    });
    child.stdin.end(code, "utf8");
  });
}

/** Validate manifest/contract invariants and ESM syntax without executing candidate code. */
export async function validateCandidatePayload(
  raw: unknown,
  options?: { readonly abortSignal?: AbortSignal },
): Promise<{
  readonly candidate: ExtensionCandidate;
  readonly summary: CandidateValidationSummary;
}> {
  const candidate = validateExtensionCandidate(raw);
  channelDeclaration(candidate.manifest);
  await checkModuleSyntax(candidate.code, options?.abortSignal);
  return {
    candidate,
    summary: {
      valid: true,
      id: candidate.manifest.id,
      digest: candidate.manifest.digest,
      protocol: candidate.manifest.protocol,
      contract: candidate.manifest.contract,
      executed: false,
    },
  };
}
