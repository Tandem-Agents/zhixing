import { AgentError } from "./errors.js";
import type { ModelInfo } from "./llm.js";
import type { ContentBlock, ImageSource, Message } from "./messages.js";

export interface UserInputTextPart {
  readonly type: "text";
  readonly text: string;
}

export interface UserInputImagePart {
  readonly type: "image";
  readonly source: ImageSource;
  readonly name?: string;
  readonly mimeType?: string;
  readonly size?: number;
}

export type UserInputPart = UserInputTextPart | UserInputImagePart;

export interface UserTurnInput {
  readonly parts: readonly UserInputPart[];
}

export type UserTurnInputLike = string | UserTurnInput;

export interface ModelInputCapabilities {
  readonly images: boolean;
}

export type ModelInputCapabilityOverride = Partial<ModelInputCapabilities>;

export interface ResolveModelInputCapabilitiesInput {
  readonly model: string;
  readonly providerModels?: readonly Pick<ModelInfo, "id" | "supportsImages">[];
  readonly overrides?: Record<string, ModelInputCapabilityOverride>;
}

export function resolveModelInputCapabilities(
  input: ResolveModelInputCapabilitiesInput,
): ModelInputCapabilities {
  const providerModels = input.providerModels ?? [];
  const declared = providerModels.find((model) => model.id === input.model);
  const override = input.overrides?.[input.model];
  return {
    images: override?.images ?? (declared?.supportsImages === true),
  };
}

export function userTurnInputFromText(text: string): UserTurnInput {
  return { parts: [{ type: "text", text }] };
}

export function normalizeUserTurnInput(input: UserTurnInputLike): UserTurnInput {
  return typeof input === "string" ? userTurnInputFromText(input) : input;
}

export function isUserTurnInput(value: unknown): value is UserTurnInput {
  if (!value || typeof value !== "object") return false;
  const parts = (value as { parts?: unknown }).parts;
  return Array.isArray(parts) && parts.every(isUserInputPart);
}

export function hasUserTurnInputContent(input: UserTurnInput): boolean {
  return input.parts.some((part) => {
    switch (part.type) {
      case "text":
        return part.text.length > 0;
      case "image":
        return true;
    }
  });
}

export function isNonEmptyUserTurnInput(
  value: unknown,
): value is UserTurnInput {
  return isUserTurnInput(value) && hasUserTurnInputContent(value);
}

export function userMessageFromTurnInput(input: UserTurnInputLike): Message {
  const normalized = normalizeUserTurnInput(input);
  const content: ContentBlock[] = [];

  for (const part of normalized.parts) {
    switch (part.type) {
      case "text":
        if (part.text.length > 0) {
          content.push({ type: "text", text: part.text });
        }
        break;
      case "image":
        content.push({ type: "image", source: part.source });
        break;
    }
  }

  return { role: "user", content };
}

export function extractUserTurnInputText(input: UserTurnInputLike): string {
  return normalizeUserTurnInput(input).parts
    .filter((part): part is UserInputTextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function validateMessagesAgainstInputCapabilities(
  messages: readonly Message[],
  capabilities: ModelInputCapabilities,
): AgentError | null {
  if (!capabilities.images && messages.some(messageContainsImage)) {
    return new AgentError(
      "当前模型不支持图片输入。请切换到支持图片输入的模型，或移除图片后重试。",
      "invalid_request",
      false,
    );
  }
  return null;
}

export function messageContainsImage(message: Message): boolean {
  return message.content.some((block) => block.type === "image");
}

function isUserInputPart(value: unknown): value is UserInputPart {
  if (!value || typeof value !== "object") return false;
  const part = value as Record<string, unknown>;
  if (part.type === "text") return typeof part.text === "string";
  if (part.type !== "image") return false;
  const source = part.source;
  if (!source || typeof source !== "object") return false;
  const imageSource = source as Record<string, unknown>;
  if (imageSource.type === "base64") {
    return (
      typeof imageSource.mediaType === "string" &&
      typeof imageSource.data === "string"
    );
  }
  return imageSource.type === "url" && typeof imageSource.url === "string";
}
