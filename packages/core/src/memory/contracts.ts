import type { Digest, IsoTime, JsonValue } from "../types/distributed.js";

/** Logical memory boundary; physical paths never cross the authority port. */
export type MemoryScopeRef =
  | { kind: "personal" }
  | { kind: "workscene"; sceneId: string };

/** 记忆分类的 wire 值域快照。 */
export type MemoryCategoryDto = "profile" | "person" | "journal";

/** 人物元数据的 wire 字段白名单。 */
export interface PersonMetaDto {
  name: string;
  relation: string;
  birthday?: string;
  tags?: string[];
}

/** 三个记忆写入域共享的封闭追加合同。 */
export type MemoryAppendPayload =
  | {
      domain: "memory";
      scope: MemoryScopeRef;
      category: "profile";
      id: "profile";
      meta: Record<string, JsonValue>;
      content: string;
      expectedDigest?: Digest;
    }
  | { domain: "journal"; scope: MemoryScopeRef; content: string; date?: string }
  | {
      domain: "people";
      scope: MemoryScopeRef;
      id: string;
      meta: PersonMetaDto;
      content: string;
      expectedDigest?: Digest;
    };

interface MemoryLogicalEntryBase {
  scope: MemoryScopeRef;
  meta: Record<string, JsonValue>;
  content: string;
  revision: number;
  digest: Digest;
  updatedAt?: IsoTime;
}

export type MemoryLogicalEntry = MemoryLogicalEntryBase &
  (
    | { domain: "memory"; category: "profile"; id: "profile" }
    | { domain: "people"; category?: never; id: string }
    | { domain: "journal"; category?: never; id: string }
  );
