import { describe, expect, it } from "vitest";
import { worksceneConversationId } from "../conversation/scope-id.js";
import {
  conversationRunTrustScope,
  jobRunTrustScopeInput,
  resolveExecutionTrustScope,
  workspaceTrustIdentity,
} from "./scope.js";

const binding = { deviceId: "device-a", bindingRef: "binding-1" };

describe("jobRunTrustScopeInput", () => {
  it("job 只看清单工作区：有绑定按工作区及修订，改路径换修订即换范围，没有才 main", () => {
    const workspace = { ...binding, workspaceBindingRevision: 2 };
    expect(resolveExecutionTrustScope(jobRunTrustScopeInput({ workspace }))).toEqual({
      kind: "workspace",
      hash: workspaceTrustIdentity("device-a", "binding-1"),
      revision: 2,
    });
    expect(resolveExecutionTrustScope(jobRunTrustScopeInput({ workspace: { ...workspace, workspaceBindingRevision: 3 } })))
      .toMatchObject({ kind: "workspace", revision: 3 });
    expect(resolveExecutionTrustScope(jobRunTrustScopeInput({}))).toEqual({ kind: "main" });
    expect(resolveExecutionTrustScope(jobRunTrustScopeInput({ workspace: null }))).toEqual({ kind: "main" });
  });
});

describe("conversationRunTrustScope", () => {
  it("owner 侧：工作场景对话→scene，主对话显式选工作区→workspace（无修订），否则→main", () => {
    expect(conversationRunTrustScope(worksceneConversationId("scene-1", "primary"), { workspace: binding }))
      .toEqual({ kind: "scene", sceneId: "scene-1" });
    expect(conversationRunTrustScope("conversation-1", { workspace: binding })).toEqual({
      kind: "workspace",
      hash: workspaceTrustIdentity("device-a", "binding-1"),
    });
    expect(conversationRunTrustScope("conversation-1", undefined)).toEqual({ kind: "main" });
  });

  it("与执行端从清单推导的范围同一身份，只差执行端知道的修订", () => {
    const owner = conversationRunTrustScope("conversation-1", { workspace: binding });
    const executor = resolveExecutionTrustScope({ workspace: { ...binding, workspaceBindingRevision: 4 } });
    expect(executor).toEqual({ ...owner, revision: 4 });
  });
});

describe("resolveExecutionTrustScope", () => {
  it("工作场景对话优先归 scene，即使本次运行带工作区", () => {
    expect(resolveExecutionTrustScope({
      sceneId: "scene-1",
      workspace: { ...binding, workspaceBindingRevision: 2 },
    })).toEqual({ kind: "scene", sceneId: "scene-1" });
  });

  it("带工作区绑定的运行归 workspace：身份来自设备＋bindingRef，修订随清单", () => {
    expect(resolveExecutionTrustScope({
      workspace: { ...binding, workspaceBindingRevision: 2 },
    })).toEqual({
      kind: "workspace",
      hash: workspaceTrustIdentity("device-a", "binding-1"),
      revision: 2,
    });
    // owner 选定执行目标前不知道修订：同一身份、不带修订
    expect(resolveExecutionTrustScope({ workspace: binding })).toEqual({
      kind: "workspace",
      hash: workspaceTrustIdentity("device-a", "binding-1"),
    });
  });

  it("其余运行归 main", () => {
    expect(resolveExecutionTrustScope({})).toEqual({ kind: "main" });
  });

  it("身份只由绑定决定：换设备或删除重建（新 bindingRef）即新范围", () => {
    const original = workspaceTrustIdentity("device-a", "binding-1");
    expect(workspaceTrustIdentity("device-a", "binding-1")).toBe(original);
    expect(workspaceTrustIdentity("device-b", "binding-1")).not.toBe(original);
    expect(workspaceTrustIdentity("device-a", "binding-2")).not.toBe(original);
    expect(original).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("拒绝空身份与非法修订", () => {
    expect(() => resolveExecutionTrustScope({ sceneId: "" })).toThrow(TypeError);
    expect(() => resolveExecutionTrustScope({
      workspace: { ...binding, workspaceBindingRevision: 0 },
    })).toThrow(TypeError);
    expect(() => resolveExecutionTrustScope({
      workspace: { deviceId: "", bindingRef: "binding-1" },
    })).toThrow(TypeError);
  });
});
