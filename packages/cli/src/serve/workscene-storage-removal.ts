/** Conversation-owned demand to remove one committed Workscene projection. */
export interface WorksceneConversationStorageRemovalPort {
  removeConversation(sceneId: string, localConversationId: string): Promise<void>;
}

/** Workscene-owned demand to remove one committed scene projection. */
export interface WorksceneSceneStorageRemovalPort {
  removeScene(sceneId: string): Promise<void>;
}
