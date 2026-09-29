import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ScreenController } from "../../screen/index.js";
import { stringWidth } from "../../tui/line-width.js";
import { stripAnsi } from "../../tui/ansi.js";
import { SelectOperationRegion } from "../select-operation-region.js";

describe("permission note input layout", () => {
  it("anchors the real cursor to a bounded draft tail and submits the whole note", async () => {
    const stream = new PassThrough();
    const stdin = stream as unknown as NodeJS.ReadStream;
    const screen = { attachInput() {}, requestInputRepaint() {} } as unknown as ScreenController;
    const opts = {
      title: "允许并说明", body: [], screen, stdin, columns: 60,
      options: [{ type: "input" as const, value: "note", label: "允许并说明", placeholder: "说明本次授权" }],
    };
    const region = new SelectOperationRegion(opts);
    const done = region.run();
    const key = async (name?: string, text = "") => {
      stream.emit("keypress", text, name ? { name } : undefined);
      await new Promise(resolve => setImmediate(resolve));
    };
    await key("return");
    const initial = region.renderLines();
    expect(initial[region.cursorPosition().row]).not.toContain("说明本次授权");
    expect(initial.join("\n")).toContain("说明本次授权");
    const note = "限制只读范围 ".repeat(12) + "末尾";
    for (const ch of note) await key(undefined, ch);
    for (const columns of [60, 24, 40]) {
      opts.columns = columns;
      const lines = region.renderLines(), cursor = region.cursorPosition();
      const row = lines[cursor.row]!;
      expect(lines.length).toBe(initial.length);
      expect(stripAnsi(row)).toContain("末尾");
      expect(row).toContain("\x1b[7m \x1b[27m");
      expect(cursor.col).toBe(stringWidth(row) - 1);
      expect(cursor.col).toBeLessThan(columns - 1);
    }
    await key("return");
    await expect(done).resolves.toEqual({ kind: "selected", value: "note", note });
    expect(stream.listenerCount("keypress")).toBe(0);
  });
});
