import path from "node:path";
import { getZhixingHome, toSafePathSegment } from "../paths.js";
import type { RubricSource } from "./types.js";

export const RUBRIC_FILE = "RUBRIC.md";

export function getRubricsRoot(): string {
  return path.join(getZhixingHome(), "rubrics");
}

export function rubricsIndexPath(root: string): string {
  return path.join(root, "index.json");
}

export function rubricSourceRoot(root: string, source: RubricSource): string {
  return path.join(root, source);
}

export function rubricsArchivedRoot(root: string): string {
  return path.join(root, "archived");
}

export function rubricDirPath(
  root: string,
  source: RubricSource,
  id: string,
): string {
  return path.join(rubricSourceRoot(root, source), toSafePathSegment(id));
}
