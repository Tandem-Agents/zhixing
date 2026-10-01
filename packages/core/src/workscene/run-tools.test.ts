import { describe, expect, it } from "vitest";
import { WorksceneRunToolApplicationService, type WorksceneToolRun } from "./run-tools.js";

const handoff = { goal: "完成报告", constraints: [], completed: [], remaining: ["校验结果"] };
const task = { conversationId: "ws:reports:primary", runId: "run-1", goal: "报告" };

describe("Workscene run tool application", () => {
  it("only admits handoff from a durable Anchor conversation", () => {
    let run: WorksceneToolRun = { conversationId: "default", durableConversation: false, tasks: [] };
    const application = new WorksceneRunToolApplicationService(() => run);
    expect(application.handoff(undefined)).toBeUndefined();
    expect(() => application.handoff(handoff)).toThrow("耐久对话");
    run = { ...run, durableConversation: true };
    const copy = application.handoff(handoff)!;
    copy.remaining.push("调用方修改");
    expect(handoff.remaining).toEqual(["校验结果"]);
    expect(application.canReturnToMain()).toBe(false);
    run = { ...run, conversationId: "ws:reports:primary" };
    expect(application.canReturnToMain()).toBe(true);
  });

  it("only selects a task from the current admitted snapshot", () => {
    let run: WorksceneToolRun = { durableConversation: true, tasks: [task] };
    const application = new WorksceneRunToolApplicationService(() => run);
    expect(application.stopTarget(task)).toEqual({ target: task });
    expect(application.stopTarget({ ...task, runId: "guessed" })).toHaveProperty("error");
    const items = application.tasks() as typeof task[];
    items[0]!.runId = "changed";
    expect(application.stopTarget(task)).toEqual({ target: task });
    run = { ...run, durableConversation: false };
    expect(application.stopTarget(task)).toEqual({ error: "停止委托需要当前耐久对话" });
  });
});
