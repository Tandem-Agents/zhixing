import path from "node:path";

export interface GuidanceResolvedRoots {
  readonly homeDir: string;
  readonly workdir?: string;
}

export type GuidanceScopeId = "global" | "workscene";

export interface GuidanceScope {
  readonly id: GuidanceScopeId;
  readonly label: string;
  readonly source: string;
  resolveRoot(roots: GuidanceResolvedRoots): string | null;
  resolvePath(roots: GuidanceResolvedRoots): string | null;
}

export interface GuidanceWarningInput {
  readonly message: string;
}

export interface ReadGuidanceFileInput {
  readonly scopeRoot: string;
  readonly path: string;
  readonly reportWarning: (event: GuidanceWarningInput) => void;
}

export type ReadGuidanceFile = (
  input: ReadGuidanceFileInput,
) => Promise<string | null>;

export interface GuidanceSection {
  readonly scope: GuidanceScopeId;
  readonly source: string;
  readonly label: string;
  readonly content: string;
}

export interface LoadLayeredGuidanceInput {
  readonly roots: GuidanceResolvedRoots;
  readonly readGuidanceFile: ReadGuidanceFile;
  readonly reportWarning: (event: GuidanceWarningInput) => void;
  readonly scopes?: readonly GuidanceScope[];
}

export const GUIDANCE_FILENAME = "ZHIXING.md";

export const DEFAULT_GUIDANCE_SCOPES: readonly GuidanceScope[] = [
  {
    id: "global",
    label: "全局约定",
    source: "ZHIXING_HOME/ZHIXING.md",
    resolveRoot: (roots) => roots.homeDir,
    resolvePath: (roots) => path.join(roots.homeDir, GUIDANCE_FILENAME),
  },
  {
    id: "workscene",
    label: "工作场景约定",
    source: "workdir/ZHIXING.md",
    resolveRoot: (roots) => roots.workdir ?? null,
    resolvePath: (roots) =>
      roots.workdir ? path.join(roots.workdir, GUIDANCE_FILENAME) : null,
  },
];

export async function loadLayeredGuidance(
  input: LoadLayeredGuidanceInput,
): Promise<string | null> {
  const sections: GuidanceSection[] = [];
  for (const scope of input.scopes ?? DEFAULT_GUIDANCE_SCOPES) {
    const scopeRoot = scope.resolveRoot(input.roots);
    const filePath = scope.resolvePath(input.roots);
    if (!scopeRoot || !filePath) continue;

    let content: string | null;
    try {
      content = await input.readGuidanceFile({
        scopeRoot,
        path: filePath,
        reportWarning: (event) =>
          input.reportWarning({
            message: `${scope.label}：${event.message}`,
          }),
      });
    } catch (err) {
      input.reportWarning({
        message: `${scope.label}读取失败：${errorMessage(err)}`,
      });
      continue;
    }

    if (content === null || content.trim().length === 0) continue;
    sections.push({
      scope: scope.id,
      source: scope.source,
      label: scope.label,
      content,
    });
  }

  if (sections.length === 0) return null;
  return renderGuidancePayload(sections);
}

export function renderGuidancePayload(
  sections: readonly GuidanceSection[],
): string {
  return sections.map(renderGuidanceSection).join("\n\n");
}

function renderGuidanceSection(section: GuidanceSection): string {
  return [
    `# ${section.label}`,
    `scope: ${section.scope}`,
    `source: ${section.source}`,
    section.content,
  ].join("\n");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
