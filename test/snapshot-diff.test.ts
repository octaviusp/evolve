import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSnapshot } from "../src/snapshot.js";
import { diffSnapshots, renderDiffMarkdown } from "../src/diff.js";
import { openEvolveDatabase } from "../src/storage/database.js";
import { makeTempRoot, makeTestConfig, writeText } from "./helpers.js";

describe("snapshot and diff", () => {
  it("captures Cursor assets and renders section-level diffs", async () => {
    const root = await makeTempRoot("snapshot");
    const config = makeTestConfig(root, ["cursor"]);
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

  it("captures multi-system snapshots", async () => {
    const root = await makeTempRoot("snapshot-multi");
    const config = makeTestConfig(root, ["cursor", "claude"]);

    await writeText(
      path.join(config.cursor.skillsDir, "evolve", "test", "SKILL.md"),
      "---\nname: test\n---\n# Test\n",
    );
    await writeText(
      path.join(config.claude.skillsDir, "evolve", "claude-test", "SKILL.md"),
      "---\nname: claude-test\n---\n# Claude Test\n",
    );

    const handle = await openEvolveDatabase(config);
    try {
      const { snapshot } = await createSnapshot(config, handle.db, "multi");
      expect(snapshot.systems).toContain("cursor");
      expect(snapshot.systems).toContain("claude");
      expect(snapshot.files.length).toBeGreaterThanOrEqual(2);
      const systems = snapshot.files.map((f) => f.system);
      expect(systems).toContain("cursor");
      expect(systems).toContain("claude");
    } finally {
      handle.close();
    }
  });
});
