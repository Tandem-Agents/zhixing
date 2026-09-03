import type {
  ConversationAdoptionReviewProjection,
  ConversationResumePort,
} from "@zhixing/core/conversation/application";

type ConversationResumeIdentity = Parameters<
  ConversationResumePort["restoreIdentity"]
>[0];
type ConversationResumeAdoptionInput = Parameters<
  NonNullable<ConversationResumePort["reviewAdoption"]>
>[0];

interface AnchorConversationResumeIdentity {
  touch(conversationId: string): Promise<Readonly<{
    id: string;
    name: string;
    createdAt: string;
    lastActiveAt: string;
  }> | null>;
}

interface AnchorConversationResumeRecovery {
  recoverConversation(conversationId: string): Promise<unknown>;
}

interface AnchorConversationAdoptionReview {
  reviewForSurface(input: Readonly<{
    conversationId: string;
    surfacePrincipal: string;
    connectionId: string;
  }>): Promise<ConversationAdoptionReviewProjection | undefined>;
}

/** Anchor mechanism binding for the Conversation-owned resume command. */
export function createAnchorConversationResumePort(input: Readonly<{
  identity: AnchorConversationResumeIdentity;
  recovery?: AnchorConversationResumeRecovery;
  adoptionReview: AnchorConversationAdoptionReview;
}>): ConversationResumePort {
  return Object.freeze({
    restoreIdentity: async (conversationId: ConversationResumeIdentity) => {
      const restored = await input.identity.touch(conversationId);
      return restored
        ? Object.freeze({
            conversationId,
            name: restored.name,
            createdAt: restored.createdAt,
            lastActiveAt: restored.lastActiveAt,
          })
        : null;
    },
    recoverDependentLifecycle: async (
      conversationId: ConversationResumeIdentity,
    ) => {
      await input.recovery?.recoverConversation(conversationId);
    },
    reviewAdoption: async (request: ConversationResumeAdoptionInput) =>
      request.caller.kind === "surface"
        ? input.adoptionReview.reviewForSurface({
            conversationId: request.conversationId,
            surfacePrincipal: request.caller.surfacePrincipal,
            connectionId: request.caller.connectionId,
          })
        : undefined,
  });
}
