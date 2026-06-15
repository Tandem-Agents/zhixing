import { describe, expect, it } from "vitest";

import * as selection from "../index.js";

describe("selection public API", () => {
  it("exposes the service contract without exposing lifecycle internals", () => {
    expect(selection).toHaveProperty("createSelectionService");
    expect(selection).toHaveProperty("SelectionBusyError");
    expect(selection).toHaveProperty("SelectionValidationError");
    expect(selection).toHaveProperty("SelectionUnavailableError");

    expect(selection).not.toHaveProperty("InlineSelectionRegion");
    expect(selection).not.toHaveProperty("LegacySelectionPresenter");
    expect(selection).not.toHaveProperty("renderSelectionPanel");
    expect(selection).not.toHaveProperty("reduceSelection");
    expect(selection).not.toHaveProperty("validateSelectionRequest");
  });
});
