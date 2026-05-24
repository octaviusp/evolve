import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateProposal } from "../src/evolution/validate.js";
import { EvidenceCard, EvolutionProposal } from "../src/types.js";
import { makeTempRoot, makeTestConfig } from "./helpers.js";

describe("proposal validation", () => {
  it("rejects weak confidence and unknown evidence ids", async () => {
    const root = await makeTempRoot("validate");
    const config = makeTestConfig(root, ["cursor"]);
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
      evidenceIds: ["e2"],
      rationale: "too weak and unknown evidence",
      operations: [
        {
          op: "create_file",
          path: path.join(config.cursor.skillsDir, "evolve", "test", "SKILL.md"),
          content: "test skill content for validation",
          reason: "test",
        },
      ],
    };
    const decision = validateProposal(config, evidence, proposal);
    expect(decision.status).toBe("rejected");
    expect(decision.reasons.some((r: string) => r.includes("confidence"))).toBe(true);
    expect(decision.reasons.some((r: string) => r.includes("unknown evidence"))).toBe(true);
  });

  it("rejects first-run create_file outside evolve-managed paths", async () => {
    const root = await makeTempRoot("validate-managed");
    const config = makeTestConfig(root, ["cursor"]);
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
    expect(decision.reasons.some((r: string) => r.includes("EVOLVE-managed"))).toBe(true);
  });

  it("approves valid Cursor evolve-managed proposals", async () => {
    const root = await makeTempRoot("validate-ok");
    const config = makeTestConfig(root, ["cursor"]);
    config.mutation.conservativeFirstRun = false;

    const evidence: EvidenceCard[] = [
      {
        id: "e1",
        system: "cursor",
        sourcePath: config.cursor.appDb,
        sourceKey: "k",
        contentHash: "h",
        createdAt: new Date().toISOString(),
        kind: "conversation",
        title: "Test evidence",
        summary: "Evidence for testing validation of valid proposals with sufficient content.",
        signals: ["bug", "agent-assets"],
        pointers: [],
        redacted: false,
      },
    ];
    const proposal: EvolutionProposal = {
      id: "p3",
      epochId: "epoch",
      specialist: "skill-evolution",
      kind: "skill",
      title: "Valid evolve skill",
      confidence: 0.85,
      evidenceIds: ["e1"],
      rationale: "A well-justified proposal with enough evidence and a clear rationale.",
      operations: [
        {
          op: "create_file",
          path: path.join(config.cursor.skillsDir, "evolve", "test-skill", "SKILL.md"),
          content: "---\nname: test-skill\ndescription: A test skill\n---\n\n# Test Skill\n\nContent.",
          reason: "Detected a recurring pattern that would benefit from a skill.",
        },
      ],
    };
    const decision = validateProposal(config, evidence, proposal);
    expect(decision.status).toBe("approved");
  });
});
