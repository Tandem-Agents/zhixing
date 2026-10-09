import type { ConversationCommitSummary } from '@zhixing/core/contracts';
import type { TranscriptRunRecord } from '@zhixing/core/transcript';

export function conversationCommitSummary(record: Omit<TranscriptRunRecord, 'messages'>): ConversationCommitSummary {
  const control = record.postTurnControl, intent = control?.intent;
  const handedOff = !!intent?.handoff?.remaining.length;
  const navigation = handedOff ? undefined : intent?.kind === 'enter' ? { kind: 'enter' as const, sceneId: intent.sceneId }
    : intent?.kind === 'exit' ? { kind: 'exit' as const } : intent?.kind === 'set_workdir'
      ? { kind: 'set_workdir' as const, sceneId: intent.sceneId, workspace: intent.workspace } : undefined;
  return { runIndex: record.runIndex, ...(record.usage ? { usage: record.usage } : {}),
    ...(navigation ? { navigation } : {}), handedOff, conflict: !!control?.conflict,
    controlRecovery: !!record.postTurnControl || !!record.worksceneContinuation };
}
