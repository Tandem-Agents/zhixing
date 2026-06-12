/**
 * ConversationDirectory 持久层实现 —— 用真实 repo + transcript(临时 home)锁
 * 与 server 契约的对齐:不存在的表达(rename null / remove false)、倒读分页
 * 的 hasMore 探测与游标续读、读容错(未知对话空页)。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import {
  ConversationRepository,
  ShardedTranscriptStore,
  conversationsDir,
  extractFirstText,
} from "@zhixing/core";
import { createConversationDirectory } from "../conversation-directory.js";

let originalHome: string | undefined;
let directory: ReturnType<typeof createConversationDirectory>;
let repo: ConversationRepository;
let transcript: ShardedTranscriptStore;

beforeEach(async () => {
  const tmp = await createTempDir("conv-dir");
  originalHome = process.env.ZHIXING_HOME;
  process.env.ZHIXING_HOME = tmp;
  repo = new ConversationRepository({ kind: "user" });
  transcript = new ShardedTranscriptStore(conversationsDir({ kind: "user" }));
  directory = createConversationDirectory({ repo, transcript });
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.ZHIXING_HOME;
  else process.env.ZHIXING_HOME = originalHome;
});

function record(text: string) {
  return {
    timestamp: new Date().toISOString(),
    messages: [
      { role: "user" as const, content: [{ type: "text" as const, text }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: `re:${text}` }] },
    ],
  };
}

describe("conversation directory(持久层实现)", () => {
  it("rename:不存在返回 null;存在改名后 list 可见", async () => {
    expect(await directory.rename("ghost", "x")).toBeNull();

    const created = await repo.create({ name: "原名" });
    const renamed = await directory.rename(created.id, "新名");
    expect(renamed?.name).toBe("新名");
    const list = await directory.list();
    expect(list.find((c) => c.id === created.id)?.name).toBe("新名");
  });

  it("remove:不存在返回 false;存在删除后盘上消失", async () => {
    expect(await directory.remove("ghost")).toBe(false);

    const created = await repo.create({ name: "待删" });
    expect(await directory.remove(created.id)).toBe(true);
    expect(await repo.get(created.id)).toBeNull();
  });

  it("readRunsReverse:倒序分页、hasMore 探测、游标续读;未知对话空页", async () => {
    for (const t of ["一", "二", "三"]) {
      await transcript.appendRunRecord("c3", record(t));
    }

    const page1 = await directory.readRunsReverse("c3", { limit: 2 });
    expect(page1.runs).toHaveLength(2);
    expect(extractFirstText(page1.runs[0]!.record.messages[0]!)).toBe("三");
    expect(extractFirstText(page1.runs[1]!.record.messages[0]!)).toBe("二");
    expect(page1.hasMore).toBe(true);

    const last = page1.runs[1]!;
    const page2 = await directory.readRunsReverse("c3", {
      limit: 2,
      before: { shardId: last.shardId, runIndex: last.record.runIndex },
    });
    expect(page2.runs).toHaveLength(1);
    expect(extractFirstText(page2.runs[0]!.record.messages[0]!)).toBe("一");
    expect(page2.hasMore).toBe(false);

    expect(await directory.readRunsReverse("nope", { limit: 5 })).toEqual({
      runs: [],
      hasMore: false,
    });
  });
});
