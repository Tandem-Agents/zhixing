/**
 * 对话全域键的 scope 编码 —— 路由正确性的根基:send 装配 / 持久化 / 目录
 * 全部由此派生,解析错即全链路由错。
 */

import { describe, expect, it } from "vitest";
import {
  assertLocalConversationIdForDevice,
  isLocalConversationId,
  localConversationId,
  parseLocalConversationId,
  parseConversationId,
  worksceneConversationId,
} from "../scope-id.js";

describe("conversation scope-id", () => {
  it("场景对话全域键:构造与解析互逆,localId 可含冒号", () => {
    const id = worksceneConversationId("scene-1", "conv_abc");
    expect(id).toBe("ws:scene-1:conv_abc");
    expect(parseConversationId(id)).toEqual({
      scope: { kind: "workscene", sceneId: "scene-1" },
      localId: "conv_abc",
    });

    expect(parseConversationId("ws:s1:a:b")).toEqual({
      scope: { kind: "workscene", sceneId: "s1" },
      localId: "a:b",
    });
  });

  it("非 ws: 前缀一律 user scope:裸 id 与渠道会话 id 整体作 localId", () => {
    expect(parseConversationId("conv_123")).toEqual({
      scope: { kind: "user" },
      localId: "conv_123",
    });
    expect(parseConversationId("dm:feishu:ou_xxx")).toEqual({
      scope: { kind: "user" },
      localId: "dm:feishu:ou_xxx",
    });
  });

  it("异形 ws: id(缺段)回落 user,不路由进场景库", () => {
    for (const bad of ["ws:", "ws:only-scene", "ws::conv", "ws:s1:"]) {
      expect(parseConversationId(bad).scope).toEqual({ kind: "user" });
    }
  });

  it("本地域身份只被出生设备接受，且非法 ULID 不形成路由身份", () => {
    const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const id = localConversationId("device-abcdef", ulid);
    expect(id).toBe(`local-device-a-${ulid}`);
    expect(parseLocalConversationId(id)).toEqual({
      devicePrefix: "device-a",
      ulid,
    });
    expect(assertLocalConversationIdForDevice(id, "device-abcdef")).toEqual({
      devicePrefix: "device-a",
      ulid,
    });
    const fingerprintId = localConversationId(
      "fp:uAbcdefghijklmnopqrstuvwxyz0123456789",
      ulid,
    );
    expect(fingerprintId).toBe(`local-Abcdefgh-${ulid}`);
    expect(
      assertLocalConversationIdForDevice(
        fingerprintId,
        "fp:uAbcdefghijklmnopqrstuvwxyz0123456789",
      ),
    ).toEqual({ devicePrefix: "Abcdefgh", ulid });
    expect(() =>
      assertLocalConversationIdForDevice(id, "another-device"),
    ).toThrow("does not belong");
    expect(() => localConversationId("bad:id-value", ulid)).toThrow(
      "path-safe local prefix",
    );
    expect(isLocalConversationId("local-device-a-not-a-ulid")).toBe(false);
  });
});
