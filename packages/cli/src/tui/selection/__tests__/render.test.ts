import { describe, expect, it } from "vitest";

import { stripAnsi } from "../../ansi.js";
import { stringWidth } from "../../line-width.js";
import {
  makeInitialSelectionState,
  reduceSelection,
} from "../state.js";
import {
  computeMaxPanelRows,
  renderSelectionPanel,
} from "../render.js";
import { validateSelectionRequest } from "../types.js";

describe("renderSelectionPanel", () => {
  it("renders all options in one panel and never exceeds terminal width", () => {
    const request = validateSelectionRequest({
      title: "选择下一步",
      body: ["这是一段用于解释当前选择的说明。"],
      options: [
        { value: "continue", label: "继续", hotkey: "c", tone: "primary" },
        { value: "stop", label: "停止", hotkey: "s", tone: "danger" },
        { value: "later", label: "稍后处理", hotkey: "l" },
      ],
    });
    const rendered = renderSelectionPanel(
      request,
      makeInitialSelectionState(request),
      { columns: 48, viewportRows: 18, statusRows: 2 },
    );

    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    expect(stripAnsi(rendered.lines.join("\n"))).toContain("选择下一步");
    expect(stripAnsi(rendered.lines.join("\n"))).toContain("稍后处理");
    expect(rendered.lines.every((line) => stringWidth(line) <= 47)).toBe(true);
  });

  it("folds optional body instead of introducing scroll or pagination", () => {
    const request = validateSelectionRequest({
      title: "选择",
      body: ["一", "二", "三", "四", "五"],
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });
    const rendered = renderSelectionPanel(
      request,
      makeInitialSelectionState(request),
      { columns: 40, viewportRows: 10, statusRows: 0, minScrollRows: 1 },
    );

    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    const plain = stripAnsi(rendered.lines.join("\n"));
    expect(plain).toContain("说明已折叠");
    expect(plain).not.toContain("五");
  });

  it("refuses tiny terminals instead of rendering a broken panel", () => {
    const request = validateSelectionRequest({
      title: "选择",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" },
        { value: "d", label: "D" },
        { value: "e", label: "E" },
      ],
    });

    expect(
      renderSelectionPanel(request, makeInitialSelectionState(request), {
        columns: 80,
        viewportRows: 7,
        minScrollRows: 1,
      }),
    ).toEqual({ kind: "unavailable", reason: "terminal is too short" });

    expect(
      renderSelectionPanel(request, makeInitialSelectionState(request), {
        columns: 20,
        viewportRows: 30,
      }),
    ).toEqual({ kind: "unavailable", reason: "terminal is too narrow" });
  });

  it("renders input and confirm layers with their own hints", () => {
    const request = validateSelectionRequest({
      title: "选择",
      submitLabel: "保存",
      cancelLabel: "放弃",
      options: [
        {
          value: "input",
          label: "输入名称",
          input: { placeholder: "名称" },
        },
        {
          value: "danger",
          label: "删除",
          confirm: {
            title: "确认删除",
            body: ["不可撤销"],
            confirmLabel: "删除",
            cancelLabel: "返回",
          },
        },
      ],
    });

    const selectRendered = renderSelectionPanel(
      request,
      makeInitialSelectionState(request),
      { columns: 50, viewportRows: 20 },
    );
    expect(selectRendered.kind).toBe("rendered");
    if (selectRendered.kind !== "rendered") return;
    expect(stripAnsi(selectRendered.lines.join("\n"))).toContain(
      "Enter 保存 · Esc 放弃",
    );

    const inputState = reduceSelection(
      makeInitialSelectionState(request),
      { kind: "enter" },
      request,
    ).state;
    const inputRendered = renderSelectionPanel(request, inputState, {
      columns: 50,
      viewportRows: 20,
    });
    expect(inputRendered.kind).toBe("rendered");
    if (inputRendered.kind !== "rendered") return;
    expect(stripAnsi(inputRendered.lines.join("\n"))).toContain(
      "Enter 保存 · Esc 返回",
    );

    const confirmState = reduceSelection(
      makeInitialSelectionState(request),
      { kind: "down" },
      request,
    ).state;
    const activeConfirm = reduceSelection(
      confirmState,
      { kind: "enter" },
      request,
    ).state;
    const confirmRendered = renderSelectionPanel(request, activeConfirm, {
      columns: 50,
      viewportRows: 20,
    });
    expect(confirmRendered.kind).toBe("rendered");
    if (confirmRendered.kind !== "rendered") return;
    const plain = stripAnsi(confirmRendered.lines.join("\n"));
    expect(plain).toContain("确认删除");
    expect(plain).toContain("Enter 删除 · Esc 返回");
  });
});

describe("computeMaxPanelRows", () => {
  it("reserves existing screen status rows and command scroll rows", () => {
    expect(
      computeMaxPanelRows({
        columns: 80,
        viewportRows: 20,
        statusRows: 3,
        minScrollRows: 4,
      }),
    ).toBe(13);
  });
});
