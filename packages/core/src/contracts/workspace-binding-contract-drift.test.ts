import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("workspace binding recovery contract", () => {
  it("keeps the executable TypeScript port and normative specification mechanically aligned", async () => {
    const [source, specification] = await Promise.all([
      readFile(path.join(repositoryRoot, "packages/core/src/contracts/ports.ts"), "utf8"),
      readFile(path.join(repositoryRoot, "research/design/modules/distributed-runtime/specification.md"), "utf8"),
    ]);
    const block = specification.match(/interface WorkspaceBindingRecoveryPort \{[\s\S]*?\n\}/u)?.[0];
    expect(block, "normative recovery port block").toBeDefined();
    expect(interfaceMethods(source, "WorkspaceBindingRecoveryPort")).toEqual(
      interfaceMethods(block!, "WorkspaceBindingRecoveryPort"),
    );
    expect(block).not.toContain("reset(");
  });
});

function interfaceMethods(source: string, name: string): Record<string, string> {
  const tree = ts.createSourceFile("contract.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const printer = ts.createPrinter({ removeComments: true });
  const methods: Record<string, string> = {};
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      for (const member of node.members) {
        if (ts.isMethodSignature(member) && ts.isIdentifier(member.name)) {
          methods[member.name.text] = printer
            .printNode(ts.EmitHint.Unspecified, member, tree)
            .replace(/\s+/gu, " ")
            .trim();
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return Object.fromEntries(Object.entries(methods).sort(([left], [right]) => left.localeCompare(right)));
}
