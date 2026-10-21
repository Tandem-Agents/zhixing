import { type ConversationDirectoryPageRequest } from './directory-page.js';
import { ConversationDirectoryIndex } from './directory-index.js';
import type { Conversation } from './types.js';

/** Read-only business projection. Its disposable local cache is maintained by
 * storage infrastructure, without constructing a writable business repository. */
export async function readConversationDirectoryPage(
  root: string,
  input: ConversationDirectoryPageRequest,
  readMetadata?: (segment: string) => Promise<Conversation | null>,
  signal?: AbortSignal,
) {
  return new ConversationDirectoryIndex(root).page(input, readMetadata, signal);
}

export async function prepareConversationDirectory(root: string, signal?: AbortSignal): Promise<void> {
  await new ConversationDirectoryIndex(root).prepare(undefined, signal);
}

export async function readConversationDirectory(root: string): Promise<Conversation[]> {
  return new ConversationDirectoryIndex(root).list();
}
