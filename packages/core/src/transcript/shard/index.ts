// 分片化 transcript —— append-only 原文持久化（索引 + 分片 + 清空事件 + 倒读原语）

export type {
  AppendRunOptions,
  AppendRunResult,
  AppendCommittedRunResult,
  ClearRecord,
  CommittedRunSource,
  RunRecord,
  TranscriptRunRecord,
  RunRecordInput,
  RunRecordRef,
  ShardHeader,
  ShardRecordLine,
  TranscriptIndex,
  TranscriptShardMeta,
  TranscriptShardRef,
  TranscriptView,
} from "./types.js";
export {
  DEFAULT_MAX_SHARD_BYTES,
  SHARD_FORMAT_VERSION,
  TRANSCRIPT_INDEX_VERSION,
  TranscriptDirectoryDamagedError,
  TranscriptOutcomeUnknownError,
  TranscriptViewBusyError,
} from "./types.js";

export {
  ShardedTranscriptStore,
  type RetainShardsReport,
  type ShardedTranscriptStoreOptions,
} from "./store.js";
export { readDirectoryView } from "./directory-view.js";

export {
  countRuns,
  countRunsInView,
  createReadOnlyTranscriptSource,
  readRunsReverse,
  type ReadRunsReverseOptions,
  type RunRecordWithRef,
  type TranscriptReadSource,
} from "./reader.js";
