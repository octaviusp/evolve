import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateProposal } from "../src/evolution/validate.js";
import { EvidenceCard, EvolutionProposal } from "../src/types.js";
import { makeTempRoot, makeTestConfig } from "./helpers.js";

describe("proposal validation", () => {
  it("rejects non-cursor paths and weak confidence", async () => {
    const root = await makeTempRoot("validate");
    const config = makeTestConfig(root);
    const evidence: EvidenceCard[] = [
      {
        id: "e1",
        system: "cursor",
        sourcePath: config.cursor.appDb,
        sourceKey: "k",
        contentHash: "h",
        createdAt: new Date().toISOString(),
        kind: "conversation",
        title: "t",
        summary: "s",
        signals: ["bug"],
        pointers: [],
        redacted: false,
      },
    ];
    const proposal: EvolutionProposal = {
      id: "p1",
      epochId: "epoch",
      specialist: "skill-evolution",
      kind: "skill",
      title: "bad",
      confidence: 0.2,
      evidenceIds: ["e1"],
      rationale: "too weak",
      operations: [
        {
          op: "create_file",
          path: path.join(root, ".codex", "skills", "bad", "SKILL.md"),
          content: "bad",
          reason: "bad",
        },
      ],
    };
    const decision = validateProposal(config, evidence, proposal);
    expect(decision.status).toBe("rejected");
    expect(decision.reasons.join(" ")).toContain("non-Cursor");
  });

  it("rejects first-run create_file operations outside evolve-managed cursor paths", async () => {
    const root = await makeTempRoot("validate-managed");
    const config = makeTestConfig(root);
    const evidence: EvidenceCard[] = [
      {
        id: "e1",
        system: "cursor",
        sourcePath: config.cursor.appDb,
        sourceKey: "k",
        contentHash: "h",
        createdAt: new Date().toISOString(),
        kind: "conversation",
        title: "t",
        summary: "s",
        signals: ["bug"],
        pointers: [],
        redacted: false,
      },
    ];
    const proposal: EvolutionProposal = {
      id: "p2",
      epochId: "epoch",
      specialist: "subagent-evolution",
      kind: "subagent",
      title: "unmanaged agent",
      confidence: 0.95,
      evidenceIds: ["e1"],
      rationale: "This is specific enough to pass the rationale length check.",
      operations: [
        {
          op: "create_file",
          path: path.join(config.cursor.agentsDir, "memory-updater.md"),
          content: "---\nname: memory-updater\n---\nbody",
          reason: "test",
        },
      ],
    };
    const decision = validateProposal(config, evidence, proposal);
    expect(decision.status).toBe("rejected");
    expect(decision.reasons.join(" ")).toContain("EVOLVE-managed");
  });
});
