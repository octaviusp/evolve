import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyApprovedProposals, rollback } from "../src/evolution/apply.js";
import { EvolutionProposal } from "../src/types.js";
import { makeTempRoot, makeTestConfig, writeText } from "./helpers.js";

describe("rollback", () => {
  it("restores exact preimage and removes newly-created files", async () => {
    const root = await makeTempRoot("rollback");
    const config = makeTestConfig(root, ["cursor"]);
    const existing = path.join(config.cursor.skillsDir, "evolve", "demo", "SKILL.md");
    const created = path.join(config.cursor.skillsDir, "evolve", "new", "SKILL.md");
    await writeText(existing, "old");
    const proposals: EvolutionProposal[] = [
      {
        id: "p1",
        epochId: "epoch",
        specialist: "skill-evolution",
        kind: "skill",
        title: "change",
        confidence: 0.9,
        evidenceIds: ["e1"],
        rationale: "change",
        operations: [
          { op: "replace_file", path: existing, content: "new", reason: "test" },
          { op: "create_file", path: created, content: "created", reason: "test" },
        ],
      },
    ];
    const manifest = await applyApprovedProposals(config, "epoch", proposals);
    expect(await fs.promises.readFile(existing, "utf8")).toBe("new");
    expect(fs.existsSync(created)).toBe(true);
    await rollback(manifest);
    expect(await fs.promises.readFile(existing, "utf8")).toBe("old");
    expect(fs.existsSync(created)).toBe(false);
  });
});
