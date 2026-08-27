import path from "node:path";
import { describe, expect, it } from "vitest";

import * as coreRoot from "../index.js";
import * as worksceneSurface from "./index.js";
import {
  getWorkSceneConversationsRoot,
  getWorkSceneDir,
  getWorkSceneIndexPath,
  getWorkScenesRoot,
} from "./paths.js";

describe("workscene storage paths", () => {
  it("keeps registry and conversation layout stable without a memory path surface", () => {
    const home = path.resolve("isolated-zhixing-home");
    const sceneId = "team/alpha";
    const sceneDirectory = path.join(
      home,
      "workscenes",
      "zid-dGVhbS9hbHBoYQ",
    );

    expect(getWorkScenesRoot(home)).toBe(path.join(home, "workscenes"));
    expect(getWorkSceneIndexPath(home)).toBe(
      path.join(home, "workscenes", "index.json"),
    );
    expect(getWorkSceneDir(sceneId, home)).toBe(sceneDirectory);
    expect(getWorkSceneConversationsRoot(sceneId, home)).toBe(
      path.join(sceneDirectory, "conversations"),
    );

    expect(worksceneSurface).not.toHaveProperty("getWorkSceneMemoryDir");
    expect(coreRoot).not.toHaveProperty("getWorkSceneMemoryDir");
    expect(coreRoot).not.toHaveProperty("getMemoryDir");
    expect(coreRoot).not.toHaveProperty("AnchorMemoryGlobalStateAdapter");
  });
});
