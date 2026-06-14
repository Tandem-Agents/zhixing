// 分片化 transcript —— append-only 原文持久化（索引 + 分片 + 清空事件 + 倒读原语）

export type {
  AppendRunResult,
  ClearRecord,
  RunRecord,
  RunRecordInput,
  RunRecordRef,
  ShardHeader,
  ShardRecordLine,
  TranscriptIndex,
  TranscriptShardMeta,
} from "./types.js";
export {
  DEFAULT_MAX_SHARD_BYTES,
  SHARD_FORMAT_VERSION,
  TRANSCRIPT_INDEX_VERSION,
} from "./types.js";

export {
  ShardedTranscriptStore,
  type ShardedTranscriptStoreOptions,
} from "./store.js";

export {
  countRuns,
  createReadOnlyTranscriptSource,
  readRunsReverse,
  type ReadRunsReverseOptions,
  type RunRecordWithRef,
  type TranscriptReadSource,
} from "./reader.js";
