import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import {
  DefinitionValidator,
  type WorkflowDefinition,
  type WorkflowInstance,
} from "@zhixing/core";
import { JsonWorkflowStore } from "../index.js";

function instance(id: string, status: WorkflowInstance["status"]): WorkflowInstance {
  const definition: WorkflowDefinition = {
    id: "wf.store",
    name: "Store workflow",
    nodes: [
      {
        nodeId: "work",
        kind: "agent",
        executor: { executorId: "work" },
      },
    ],
    edges: [],
  };
  const validated = new DefinitionValidator({
    allowedExecutors: ["work"],
  }).validate(definition);

  return {
    instanceId: id,
    conversationId: "conv-1",
    goal: "persist",
    input: {},
    definition: validated.definition,
    definitionId: validated.definition.id,
    status,
    nodeRuns: [],
    decisions: [],
    artifacts: [],
    errors: [],
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
  };
}

describe("JsonWorkflowStore", () => {
  it("persists workflow instances and reloads unfinished state", async () => {
    const dir = await createTempDir("workflow-store");
    const filePath = join(dir, "instances.json");
    const store = new JsonWorkflowStore({ filePath });

    await store.create(instance("wf-1", "running"));
    await store.create(instance("wf-2", "succeeded"));
    await store.update("wf-1", (current) => ({
      ...current,
      status: "waiting_decision",
      updatedAt: "2026-06-17T00:00:01.000Z",
    }));

    const raw = JSON.parse(await readFile(filePath, "utf-8")) as {
      instances: WorkflowInstance[];
    };
    expect(raw.instances.map((entry) => entry.instanceId)).toEqual([
      "wf-1",
      "wf-2",
    ]);

    const reloaded = new JsonWorkflowStore({ filePath });
    expect(await reloaded.get("wf-1")).toMatchObject({
      instanceId: "wf-1",
      status: "waiting_decision",
    });
    expect((await reloaded.listUnfinished()).map((entry) => entry.instanceId)).toEqual([
      "wf-1",
    ]);
  });
});
