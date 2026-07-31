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
    expect(interfaceMethods(source, "WorkspaceBindingRecoveryPort")).toEqual({
      beginReset: 2,
      completeReset: 2,
      status: 0,
    });
    const block = specification.match(/interface WorkspaceBindingRecoveryPort \{[\s\S]*?\n\}/u)?.[0];
    expect(block, "normative recovery port block").toBeDefined();
    expect(interfaceMethods(block!, "WorkspaceBindingRecoveryPort")).toEqual({
      beginReset: 2,
      completeReset: 2,
      status: 0,
    });
    expect(block).not.toContain("reset(");
  });
});

function interfaceMethods(source: string, name: string): Record<string, number> {
  const tree = ts.createSourceFile("contract.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods: Record<string, number> = {};
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      for (const member of node.members) {
        if (ts.isMethodSignature(member) && ts.isIdentifier(member.name)) {
          methods[member.name.text] = member.parameters.length;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return Object.fromEntries(Object.entries(methods).sort(([left], [right]) => left.localeCompare(right)));
}
