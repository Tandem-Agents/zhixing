import fs from 'node:fs/promises';
import path from 'node:path';
import { ConversationDirectoryPageCollector, type ConversationDirectoryPageRequest } from './directory-page.js';
import type { Conversation } from './types.js';

/** Finite, read-only directory projection; no writable repository is created. */
export async function readConversationDirectoryPage(
  root: string,
  input: ConversationDirectoryPageRequest,
  readMetadata: (segment: string) => Promise<Conversation | null> = async segment => {
    try { return JSON.parse(await fs.readFile(path.join(root, segment, 'meta.json'), 'utf8')) as Conversation; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  },
) {
  const page = new ConversationDirectoryPageCollector<Conversation & { conversationId: string }>(input);
  let directory;
  try { directory = await fs.opendir(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return page.result(); throw error; }
  for await (const entry of directory) {
    if (!entry.isDirectory()) continue;
    const meta = await readMetadata(entry.name);
    if (meta && !meta.archived && typeof meta.id === 'string' && typeof meta.name === 'string' &&
        typeof meta.lastActiveAt === 'string' && Number.isFinite(Date.parse(meta.lastActiveAt))) {
      page.add({ ...meta, conversationId: meta.id });
    }
  }
  return page.result();
}
