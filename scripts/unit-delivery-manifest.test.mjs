import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const generator = fileURLToPath(
  new URL("./unit-delivery-manifest.mjs", import.meta.url),
);

test("delivery manifest expands renames and binds every changed path", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhixing-delivery-manifest-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await copyFile(generator, path.join(root, "scripts", "unit-delivery-manifest.mjs"));
  await Promise.all([
    write("old name.txt", "rename-me\n"),
    write("modified.txt", "before\n"),
    write("deleted.txt", "delete-me\n"),
  ]);
  git(["init"]);
  git(["config", "user.email", "delivery-manifest@example.invalid"]);
  git(["config", "user.name", "Delivery Manifest Test"]);
  git(["config", "diff.renames", "true"]);
  git(["config", "core.autocrlf", "false"]);
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]);

  await rename(
    path.join(root, "old name.txt"),
    path.join(root, "renamed name.txt"),
  );
  await write("modified.txt", "after\n");
  await unlink(path.join(root, "deleted.txt"));
  await write("added.txt", "added\n");
  await write("-特殊 name [x]#.txt", "special\n");

  const manifest = generate(["--base", base]);
  const statuses = new Map(
    manifest.entries.map(({ status, path: repositoryPath }) => [
      repositoryPath,
      status,
    ]),
  );
  assert.deepEqual(
    Object.fromEntries([...statuses].sort(([left], [right]) => left.localeCompare(right, "en-US"))),
    {
      "-特殊 name [x]#.txt": "A",
      "added.txt": "A",
      "deleted.txt": "D",
      "modified.txt": "M",
      "old name.txt": "D",
      "renamed name.txt": "A",
    },
  );
  assert.equal(manifest.deletedCount, 2);
  assert.equal(
    manifest.entries.find(({ path: repositoryPath }) => repositoryPath === "old name.txt").blob,
    manifest.entries.find(({ path: repositoryPath }) => repositoryPath === "renamed name.txt").blob,
  );

  const stored = "research/design/workbench/test-delivery-manifest.json";
  generate(["--base", base, "--write", stored]);
  generate(["--base", base, "--check", stored]);
  await write("added-after-manifest.txt", "stale\n");
  assert.throws(
    () => generate(["--base", base, "--check", stored]),
    /Delivery manifest is stale/u,
  );

  async function write(repositoryPath, contents) {
    const target = path.join(root, repositoryPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }

  function generate(args) {
    const output = execFileSync(
      process.execPath,
      [path.join(root, "scripts", "unit-delivery-manifest.mjs"), ...args],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return output ? JSON.parse(output) : undefined;
  }

  function git(args) {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
});
