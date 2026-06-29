import { describe, expect, it } from "vitest";

import {
  MAX_SELECTION_OPTIONS,
  SelectionValidationError,
  validateSelectionRequest,
} from "../types.js";

describe("validateSelectionRequest", () => {
  it("trims title and picks the first enabled option by default", () => {
    const request = validateSelectionRequest({
      title: "  操作选择  ",
      options: [
        { value: "disabled", label: "禁用", disabled: true },
        { value: "run", label: "执行" },
      ],
    });

    expect(request.title).toBe("操作选择");
    expect(request.initialIndex).toBe(1);
  });

  it("caps options to a small, readable decision set", () => {
    expect(() =>
      validateSelectionRequest({
        title: "选择",
        options: Array.from({ length: MAX_SELECTION_OPTIONS + 1 }, (_, index) => ({
          value: `value-${index}`,
          label: `选项 ${index}`,
        })),
      }),
    ).toThrow(SelectionValidationError);
  });

  it("rejects duplicated values and duplicated hotkeys case-insensitively", () => {
    expect(() =>
      validateSelectionRequest({
        title: "选择",
        options: [
          { value: "same", label: "A" },
          { value: "same", label: "B" },
        ],
      }),
    ).toThrow(/duplicated/);

    expect(() =>
      validateSelectionRequest({
        title: "选择",
        options: [
          { value: "a", label: "A", hotkey: "x" },
          { value: "b", label: "B", hotkey: "X" },
        ],
      }),
    ).toThrow(/hotkey is duplicated/);
  });

  it("rejects disabled actionable options and disabled initial selection", () => {
    expect(() =>
      validateSelectionRequest({
        title: "选择",
        options: [
          {
            value: "danger",
            label: "危险操作",
            disabled: true,
            confirm: { title: "确认危险操作" },
          },
        ],
      }),
    ).toThrow(/disabled option cannot declare/);

    expect(() =>
      validateSelectionRequest({
        title: "选择",
        initialValue: "disabled",
        options: [
          { value: "disabled", label: "禁用", disabled: true },
          { value: "run", label: "执行" },
        ],
      }),
    ).toThrow(/initialValue points to disabled/);
  });

  it("rejects invalid hotkeys and empty nested labels", () => {
    expect(() =>
      validateSelectionRequest({
        title: "选择",
        options: [{ value: "a", label: "A", hotkey: "ab" }],
      }),
    ).toThrow(/printable/);

    expect(() =>
      validateSelectionRequest({
        title: "选择",
        options: [
          { value: "name", label: "命名", input: { placeholder: " " } },
        ],
      }),
    ).toThrow(/placeholder is empty/);

    expect(() =>
      validateSelectionRequest({
        title: "选择",
        options: [
          { value: "delete", label: "删除", confirm: { title: " " } },
        ],
      }),
    ).toThrow(/confirm title is empty/);
  });

  it("validates request and option details as reusable disclosure content", () => {
    const request = validateSelectionRequest({
      title: "选择",
      details: { title: "完整说明", body: ["第一行", "", "第三行"] },
      options: [
        {
          value: "review",
          label: "查看",
          details: { body: ["选项详情"] },
        },
      ],
    });

    expect(request.details?.title).toBe("完整说明");
    expect(request.options[0]?.details?.body).toEqual(["选项详情"]);

    expect(() =>
      validateSelectionRequest({
        title: "选择",
        details: { body: [] },
        options: [{ value: "a", label: "A" }],
      }),
    ).toThrow(/details body is empty/);

    expect(() =>
      validateSelectionRequest({
        title: "选择",
        options: [
          { value: "a", label: "A", details: { title: " ", body: ["x"] } },
        ],
      }),
    ).toThrow(/option details.*title is empty/);
  });
});
