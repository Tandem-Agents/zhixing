import { describe, expect, it } from "vitest";

import { stripAnsi } from "../../ansi.js";
import { stringWidth } from "../../line-width.js";
import {
  makeInitialSelectionState,
  reduceSelection,
} from "../state.js";
import {
  computeDetailsBodyRows,
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
    expect(stripAnsi(rendered.lines.join("\n"))).toContain("↑/↓ 选择");
    expect(stripAnsi(rendered.lines[0] ?? "")).not.toContain("…");
    expect(rendered.lines.every((line) => stringWidth(line) <= 47)).toBe(true);
  });

  it("keeps hotkeys near labels and descriptions in a compact option row", () => {
    const request = validateSelectionRequest({
      title: "停止知行",
      body: ["停止后会断开其他接入面: feishu"],
      options: [
        {
          value: "stop",
          label: "停止知行",
          hotkey: "s",
          tone: "danger",
          description: "关闭服务, 当前终端也会退出",
        },
        { value: "cancel", label: "返回", hotkey: "c" },
      ],
    });
    const rendered = renderSelectionPanel(
      request,
      makeInitialSelectionState(request),
      { columns: 120, viewportRows: 18, statusRows: 2 },
    );

    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    const plainLines = rendered.lines.map((renderedLine) => stripAnsi(renderedLine));
    expect(plainLines.join("\n")).toContain(
      "停止知行  ·  停止后会断开其他接入面: feishu",
    );
    const stopLine = plainLines.find((renderedLine) =>
      renderedLine.includes("停止知行") && renderedLine.includes("(s)")
    );
    expect(stopLine).toBeDefined();
    expect(stopLine).toContain("停止知行  (s)   关闭服务, 当前终端也会退出");
    expect(stringWidth(stopLine ?? "")).toBeLessThan(64);
  });

  it("caps long descriptions before the whole line reaches screen width", () => {
    const request = validateSelectionRequest({
      title: "选择操作",
      body: ["关键说明"],
      options: [
        {
          value: "continue",
          label: "继续",
          hotkey: "c",
          description: "长说明".repeat(80),
        },
        { value: "cancel", label: "返回", hotkey: "x" },
      ],
    });
    const rendered = renderSelectionPanel(
      request,
      makeInitialSelectionState(request),
      { columns: 120, viewportRows: 18, statusRows: 2 },
    );

    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    const optionLine = rendered.lines
      .map((renderedLine) => stripAnsi(renderedLine))
      .find((renderedLine) => renderedLine.includes("(c)"));
    expect(optionLine).toContain("…");
    expect(stringWidth(optionLine ?? "")).toBeLessThan(72);
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

  it("renders request details as a scrollable disclosure layer", () => {
    const request = validateSelectionRequest({
      title: "选择",
      details: { title: "完整说明", body: ["一", "二", "三", "四", "五"] },
      options: [{ value: "a", label: "A" }],
    });
    const detailsRenderOptions = {
      columns: 40,
      viewportRows: 8,
      minScrollRows: 1,
    };
    const reduceOptions = {
      detailBodyRows: computeDetailsBodyRows(detailsRenderOptions),
    };
    const initial = makeInitialSelectionState(request);
    const selectRendered = renderSelectionPanel(request, initial, {
      columns: 40,
      viewportRows: 10,
      minScrollRows: 1,
    });
    expect(selectRendered.kind).toBe("rendered");
    if (selectRendered.kind !== "rendered") return;
    expect(stripAnsi(selectRendered.lines.join("\n"))).toContain("→ 详情");

    const detailsState = reduceSelection(
      initial,
      { kind: "details" },
      request,
    ).state;
    const firstPage = renderSelectionPanel(request, detailsState, {
      ...detailsRenderOptions,
    });
    expect(firstPage.kind).toBe("rendered");
    if (firstPage.kind !== "rendered") return;
    const firstPlain = stripAnsi(firstPage.lines.join("\n"));
    expect(firstPlain).toContain("完整说明 1-4/5");
    expect(firstPlain).toContain("一");
    expect(firstPlain).not.toContain("五");

    const scrolledState = reduceSelection(
      detailsState,
      { kind: "down" },
      request,
      reduceOptions,
    ).state;
    const secondPage = renderSelectionPanel(request, scrolledState, {
      ...detailsRenderOptions,
    });
    expect(secondPage.kind).toBe("rendered");
    if (secondPage.kind !== "rendered") return;
    const secondPlain = stripAnsi(secondPage.lines.join("\n"));
    expect(secondPlain).toContain("完整说明 2-5/5");
    expect(secondPlain).toContain("五");

    const bottomState = Array.from({ length: 3 }).reduce(
      (current) =>
        reduceSelection(current, { kind: "down" }, request, reduceOptions).state,
      scrolledState,
    );
    const bottomPage = renderSelectionPanel(request, bottomState, {
      ...detailsRenderOptions,
    });
    expect(bottomPage.kind).toBe("rendered");
    if (bottomPage.kind !== "rendered") return;
    const bottomPlain = stripAnsi(bottomPage.lines.join("\n"));
    expect(bottomPlain).toContain("完整说明 2-5/5");
    expect(bottomPlain).toContain("二");
    expect(bottomPlain).toContain("五");
  });

  it("prefers selected option details over request details", () => {
    const request = validateSelectionRequest({
      title: "选择",
      details: { title: "请求详情", body: ["请求"] },
      options: [
        {
          value: "a",
          label: "A",
          details: { title: "选项详情", body: ["选项"] },
        },
      ],
    });
    const detailsState = reduceSelection(
      makeInitialSelectionState(request),
      { kind: "details" },
      request,
    ).state;

    const rendered = renderSelectionPanel(request, detailsState, {
      columns: 40,
      viewportRows: 10,
      minScrollRows: 1,
    });
    expect(rendered.kind).toBe("rendered");
    if (rendered.kind !== "rendered") return;
    const plain = stripAnsi(rendered.lines.join("\n"));
    expect(plain).toContain("选项详情");
    expect(plain).toContain("选项");
    expect(plain).not.toContain("请求");
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
      "Enter 保存 · ↑/↓ 选择 · Esc 放弃",
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
