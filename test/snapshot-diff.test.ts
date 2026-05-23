import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSnapshot } from "../src/snapshot.js";
import { diffSnapshots, renderDiffMarkdown } from "../src/diff.js";
import { openEvolveDatabase } from "../src/storage/database.js";
import { makeTempRoot, makeTestConfig, writeText } from "./helpers.js";

describe("snapshot and diff", () => {
  it("captures cursor assets and renders section-level diffs", async () => {
    const root = await makeTempRoot("snapshot");
    const config = makeTestConfig(root);
    const skill = path.join(config.cursor.skillsDir, "evolve", "demo", "SKILL.md");
    await writeText(
      skill,
      "---\nname: demo\n---\n# Demo\n\n<!-- EVOLVE:BEGIN main -->\nOld\n<!-- EVOLVE:END main -->\n",
    );
    const handle = await openEvolveDatabase(config);
    try {
      const before = await createSnapshot(config, handle.db, "before");
      await writeText(
        skill,
        "---\nname: demo\n---\n# Demo\n## Added\n\n<!-- EVOLVE:BEGIN main -->\nNew\n<!-- EVOLVE:END main -->\n",
      );
      const after = await createSnapshot(config, handle.db, "after");
      const diff = diffSnapshots(before.snapshot, after.snapshot);
      expect(diff.modified).toHaveLength(1);
      expect(diff.modified[0].sectionChanges.join(" ")).toContain("## Added");
      expect(renderDiffMarkdown(diff)).toContain("```diff");
    } finally {
      handle.close();
    }
  });
});
