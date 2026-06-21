/**
 * 会话 turn 主输出流投影。
 *
 * ConversationManager / runTurnWithCommit 管会话事实;这里只管把一次 turn 的
 * 运行产出按 session wire 协议推给同会话 observer。RPC、飞书、后续其它
 * 接入面复用同一投影语义,避免入口各自消费 generator 后产生漂移。
 */

import {
  stripPresentationFromAgentYield,
  type RunResult,
  type UserTurnInput,
  userTurnInputFromText,
} from "@zhixing/core";
import type { ManagedSession, ConversationManager } from "../runtime/conversation-manager.js";
import { runTurnWithCommit, type RunTurnHooks } from "../runtime/run-turn.js";
import type { RunTurnOptions } from "../runtime/types.js";
import {
  SESSION_NOTIFICATIONS,
  toWireAgentResult,
  type SessionCompletePayload,
  type SessionDeltaPayload,
} from "./session-wire.js";

export type SessionTurnNotify = (method: string, params: unknown) => void;

export type ProjectedSessionTurnResult =
  | { kind: "settled"; runResult: RunResult }
  | { kind: "aborted" }
  | { kind: "error"; error: unknown };

interface ProjectSessionTurnBaseOptions {
  readonly manager: ConversationManager;
  readonly managed: ManagedSession;
  readonly turnId: string;
  readonly runOptions?: RunTurnOptions;
  readonly hooks?: RunTurnHooks;
  readonly notify: SessionTurnNotify;
  readonly abortSignal?: AbortSignal;
  readonly onModeSwitchIntent?: (
    intent: NonNullable<RunResult["pendingModeSwitch"]>,
  ) => void;
}

export type ProjectSessionTurnOptions = ProjectSessionTurnBaseOptions &
  (
    | { readonly text: string; readonly input?: never }
    | { readonly input: UserTurnInput; readonly text?: never }
  );

export async function projectSessionTurn(
  opts: ProjectSessionTurnOptions,
): Promise<ProjectedSessionTurnResult> {
  const conversationId = opts.managed.conversationId;
  const input = toProjectSessionTurnInput(opts);

  try {
    const gen = runTurnWithCommit(
      opts.manager,
      conversationId,
      input,
      opts.runOptions,
      opts.hooks,
    );

    while (true) {
      const iter = await gen.next();
      if (iter.done) {
        const runResult = iter.value;
        if (runResult.pendingModeSwitch) {
          opts.onModeSwitchIntent?.(runResult.pendingModeSwitch);
        }
        opts.notify(SESSION_NOTIFICATIONS.complete, {
          conversationId,
          sessionId: conversationId,
          turnId: opts.turnId,
          result: toWireAgentResult(runResult.agentResult),
        } satisfies SessionCompletePayload);
        return { kind: "settled", runResult };
      }

      opts.notify(SESSION_NOTIFICATIONS.delta, {
        conversationId,
        sessionId: conversationId,
        turnId: opts.turnId,
        delta: stripPresentationFromAgentYield(iter.value),
      } satisfies SessionDeltaPayload);
    }
  } catch (err) {
    if (opts.abortSignal?.aborted) return { kind: "aborted" };

    const message = err instanceof Error ? err.message : String(err);
    opts.notify(SESSION_NOTIFICATIONS.complete, {
      conversationId,
      sessionId: conversationId,
      turnId: opts.turnId,
      result: {
        reason: "error",
        error: { name: "RuntimeError", message },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    } satisfies SessionCompletePayload);
    return { kind: "error", error: err };
  }
}

function toProjectSessionTurnInput(opts: ProjectSessionTurnOptions): UserTurnInput {
  if (opts.input !== undefined) return opts.input;
  if (opts.text !== undefined) return userTurnInputFromText(opts.text);
  throw new Error("projectSessionTurn requires text or input");
}
