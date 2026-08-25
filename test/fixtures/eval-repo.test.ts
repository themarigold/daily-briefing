// test/fixtures/eval-repo.test.ts
import { test, expect } from "bun:test";
import { $ } from "bun";
import { join } from "node:path";
import { buildEvalRepo } from "./eval-repo";

test("builder: sha→unit, un-collapsed uncommitted, manifest written", async () => {
  const { dir, shaToUnit } = await buildEvalRepo({
    commits: [{ files: ["packages/api/x.ts"], daysAgo: 1, message: "api", expectUnit: "packages/api" }],
    uncommitted: [".claude/worktrees/x"], workspaceManifest: { "package.json": '{"workspaces":["packages/*"]}' },
  });
  expect([...shaToUnit.values()]).toContainEqual({ repo: dir, root: "packages/api" });
  expect(await $`git -C ${dir} status --porcelain`.text()).toContain("?? .claude/worktrees/x");
  expect(await Bun.file(join(dir, "package.json")).text()).toContain("workspaces");
});
