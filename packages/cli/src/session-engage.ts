import { extractUserTurnInputText } from "@zhixing/core";
import type { SessionSendEngage } from "@zhixing/server";
import {
  prepareUserTurnInput,
  type PreparedUserTurnInput,
  type PrepareUserTurnInputOptions,
} from "./user-turn-input.js";

const UNSUPPORTED_NON_TEXT_MATERIAL_MESSAGE =
  "多视角评议目前只支持文本内容；请将图片转成文字说明，或移除图片后再触发 @。";

export interface SessionSendEngageParseResult {
  readonly inputWithoutTrigger: string;
}

export type PreparedSessionSendEngage =
  | {
      readonly kind: "ready";
      readonly engage: SessionSendEngage;
      readonly question: string;
      readonly preparedQuestion: PreparedUserTurnInput;
    }
  | {
      readonly kind: "invalid";
      readonly question: string;
      readonly preparedQuestion: PreparedUserTurnInput;
      readonly errors: readonly string[];
    };

export function parseSessionSendEngageInput(
  input: string,
): SessionSendEngageParseResult | undefined {
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== "@") continue;
    const next = input[index + 1];
    if (!isSessionEngageWhitespace(next)) continue;

    const previous = input[index - 1];
    if (index !== 0 && !isSessionEngageWhitespace(previous)) continue;

    const suffix = input.slice(index + 1).trim();
    if (suffix.length === 0) return undefined;

    const inputWithoutTrigger = buildInputWithoutTrigger(input, index);
    if (inputWithoutTrigger.trim().length === 0) return undefined;
    return { inputWithoutTrigger };
  }
  return undefined;
}

export async function prepareSessionSendEngage(
  input: string,
  options: PrepareUserTurnInputOptions,
): Promise<PreparedSessionSendEngage | undefined> {
  const parsed = parseSessionSendEngageInput(input);
  if (!parsed) return undefined;

  const preparedQuestion = await prepareUserTurnInput(
    parsed.inputWithoutTrigger,
    options,
  );
  if (!preparedQuestion) return undefined;

  const question = extractUserTurnInputText(preparedQuestion.input).trim();
  if (question.length === 0) return undefined;

  const hasNonTextPart = preparedQuestion.input.parts.some(
    (part) => part.type !== "text",
  );
  if (hasNonTextPart) {
    return {
      kind: "invalid",
      question,
      preparedQuestion,
      errors: [UNSUPPORTED_NON_TEXT_MATERIAL_MESSAGE],
    };
  }

  return {
    kind: "ready",
    engage: { kind: "perspectives", question },
    question,
    preparedQuestion,
  };
}

function buildInputWithoutTrigger(input: string, triggerIndex: number): string {
  const rawPrefix = input.slice(0, triggerIndex);
  const prefix = rawPrefix.trimEnd();
  const suffix = input.slice(triggerIndex + 1).trimStart();
  if (prefix.length === 0) return suffix.trim();
  if (suffix.length === 0) return prefix.trim();
  const separator = /[\r\n]/u.test(rawPrefix.slice(prefix.length)) ? "\n" : " ";
  return `${prefix}${separator}${suffix}`.trim();
}

function isSessionEngageWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/u.test(char);
}
