import { describe, expect, it } from "vitest";
import { validateMessage, validateNonEmptyUserTurnInput } from "./values.js";

describe("消息来源协议", () => {
  const message = { role: "user", content: [{ type: "text", text: "正文不附加来源前缀" }] };
  const identity = { id: "message-1", source: { kind: "conversation", conversationId: "source-a" } };

  it("兼容无来源的已有消息，并保留逐条来源", () => {
    expect(validateMessage(message)).toEqual(message);
    for (const source of [identity.source, { kind: "user" }]) {
      const identified = { ...message, inputIdentity: { ...identity, source } };
      expect(validateMessage(JSON.parse(JSON.stringify(identified)))).toEqual(identified);
    }
  });

  it("窗口首部标记只接受两种类别，且不与输入身份并存", () => {
    for (const windowHead of ["context", "note"]) {
      for (const role of ["user", "assistant"]) {
        const marked = { ...message, role, windowHead };
        expect(validateMessage(JSON.parse(JSON.stringify(marked)))).toEqual(marked);
      }
    }
    expect(() => validateMessage({ ...message, windowHead: "summary" })).toThrow("window head");
    expect(() => validateMessage({ ...message, windowHead: true })).toThrow("window head");
    expect(() => validateMessage({ ...message, windowHead: "context", inputIdentity: identity })).toThrow("window head");
  });

  it("不允许将 assistant 或工具结果伪装为用户输入", () => {
    expect(() => validateMessage({ ...message, role: "assistant", inputIdentity: identity })).toThrow();
    expect(() => validateMessage({ ...message, content: [{ type: "tool_result", toolUseId: "tool-1", content: "ok" }], inputIdentity: identity })).toThrow();
  });

  it("工具结果的处置事实只接受封闭联合里的确切形状", () => {
    const disposition = { kind: "not-started", reason: "exclusive-control", selectedTool: "control" };
    const block = (value: unknown) => ({ role: "user", content: [{ type: "tool_result", toolUseId: "tool-1", content: "x", isError: true, disposition: value }] });
    expect(validateMessage(block(disposition))).toEqual(block(disposition));
    for (const invalid of [{ ...disposition, kind: "failed" }, { ...disposition, extra: 1 }, { kind: "not-started" }, "not-started", null]) {
      expect(() => validateMessage(block(invalid))).toThrow("disposition");
    }
  });

  it.each([
    { id: "", source: identity.source },
    { ...identity, source: { kind: "conversation" } },
    { ...identity, source: { kind: "user", conversationId: "source-a" } },
    { ...identity, source: { kind: "other" } },
    { ...identity, unregistered: true },
  ])("拒绝缺失或开放的来源合同：%j", (inputIdentity) => {
    expect(() => validateMessage({ ...message, inputIdentity })).toThrow();
  });

  it("严格校验文件材料描述，允许 0 字节空文件包装文本并拒绝非法字符或 assistant 冒用", () => {
    const material = { kind: "file", name: "chip-sample.txt", byteSize: 0 };
    const validTurn = {
      parts: [{ type: "text", text: '<file path="E:/a/chip-sample.txt">\n\n</file>', material }],
    };
    expect(validateNonEmptyUserTurnInput(validTurn)).toEqual(validTurn);
    const validMsg = {
      role: "user",
      content: [{ type: "text", text: '<file path="E:/a/chip-sample.txt">\n\n</file>', material }],
    };
    expect(validateMessage(validMsg)).toEqual(validMsg);

    // assistant 不得携带用户文件材料描述
    expect(() => validateMessage({ ...validMsg, role: "assistant" })).toThrow("assistant");

    // 带 material 的块正文不能为空
    expect(() =>
      validateNonEmptyUserTurnInput({ parts: [{ type: "text", text: "", material }] }),
    ).toThrow();
    expect(() =>
      validateMessage({ role: "user", content: [{ type: "text", text: "", material }] }),
    ).toThrow();

    // 非法材料元数据（含 NEL / C1 / U+2028 / U+2029 / 方括号 / 冗余字段 / 负数）一律拒绝
    for (const bad of [
      { kind: "image", name: "a.txt", byteSize: 1 },
      { kind: "file", name: "a\u0085b.txt", byteSize: 1 },
      { kind: "file", name: "a\u009bb.txt", byteSize: 1 },
      { kind: "file", name: "a\u2028b.txt", byteSize: 1 },
      { kind: "file", name: "a\u2029b.txt", byteSize: 1 },
      { kind: "file", name: "a]b.txt", byteSize: 1 },
      { kind: "file", name: "", byteSize: 1 },
      { kind: "file", name: "a.txt", byteSize: -1 },
      { kind: "file", name: "a.txt", byteSize: 1, extra: true },
    ]) {
      expect(() =>
        validateNonEmptyUserTurnInput({ parts: [{ type: "text", text: "<file/>", material: bad }] }),
      ).toThrow();
      expect(() =>
        validateMessage({ role: "user", content: [{ type: "text", text: "<file/>", material: bad }] }),
      ).toThrow();
    }
  });
});
