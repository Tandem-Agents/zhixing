import type { JsonValue } from "../types/distributed.js";

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
      category: MemoryCategoryDto;
      id: string;
      meta: Record<string, JsonValue>;
      content: string;
    }
  | { domain: "journal"; content: string; date?: string }
  | { domain: "people"; id: string; meta: PersonMetaDto; content: string };
