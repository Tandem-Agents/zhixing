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
});
