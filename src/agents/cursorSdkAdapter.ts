import fs from "node:fs";
import path from "node:path";
import { EvolveConfig, EvidenceCard, EvolutionProposal } from "../types.js";
import { shortHash } from "../utils/hash.js";

export class AgentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

export interface SpecialistRunInput {
  epochId: string;
  specialist: string;
  prompt: string;
  evidencePath: string;
  assetsPath: string;
}

export class CursorSdkAgentAdapter {
  constructor(private readonly config: EvolveConfig) {}

  async runSpecialist(input: SpecialistRunInput): Promise<EvolutionProposal[]> {
    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) throw new AgentUnavailableError("CURSOR_API_KEY is not set");

    const sdk = await import("@cursor/sdk");
    const modelId = await this.resolveModel(sdk, apiKey);
    const cwd = path.dirname(input.evidencePath);
    const prompt = this.buildPrompt(input);

    const agent = await sdk.Agent.create({
      apiKey,
      name: `EVOLVE ${input.specialist} ${input.epochId}`,
      model: { id: modelId, params: [{ id: "thinking", value: this.config.model.thinking }] },
      mode: "plan",
      local: { cwd },
    } as any);

    try {
      const run = await agent.send(prompt);
      const result = await run.wait();
      if (result.status !== "finished" || !result.result) {
        throw new AgentUnavailableError(`Cursor SDK run ended with status ${result.status}`);
      }
      return parseProposalJson(result.result, input.epochId, input.specialist);
    } finally {
      await agent[Symbol.asyncDispose]?.();
    }
  }

  private async resolveModel(sdk: any, apiKey: string): Promise<string> {
    try {
      const models = await sdk.Cursor.models.list({ apiKey });
      const ids = new Set(models.map((model: any) => model.id));
      if (ids.has(this.config.model.preferred)) return this.config.model.preferred;
      if (ids.has(this.config.model.fallback)) return this.config.model.fallback;
    } catch {
      // If model listing fails but auth is valid, let Cursor resolve the preferred id.
    }
    return this.config.model.preferred;
  }

  private buildPrompt(input: SpecialistRunInput): string {
    return `
You are an EVOLVE proposal specialist.

Hard constraints:
- Produce JSON only. No markdown prose.
- Do not edit files. Propose changes only.
- Target system is Cursor only.
- Read the evidence file and asset manifest from disk.
- Prefer rejecting weak ideas over adding noisy agent instructions.
- Every proposal must cite evidenceIds from the evidence file.
- Allowed operation paths must be under ~/.cursor/skills, ~/.cursor/agents, ~/.cursor/rules, or ~/.cursor/hooks.json.
- For first-run safety, new files MUST be EVOLVE-managed:
  - skills: ~/.cursor/skills/evolve/<name>/SKILL.md
  - subagents: ~/.cursor/agents/evolve-<name>.md
  - rules: ~/.cursor/rules/evolve-<name>.mdc
- Do not propose ~/.cursor/agents/<name>.md unless the basename starts with evolve-.

Specialist: ${input.specialist}
Evidence file: ${input.evidencePath}
Asset manifest: ${input.assetsPath}

Return shape:
{
  "proposals": [
    {
      "kind": "skill" | "subagent" | "hook" | "rule" | "garbage",
      "title": "short title",
      "confidence": 0.0,
      "evidenceIds": ["..."],
      "rationale": "specific reusable reason",
      "operations": [
        {"op":"create_file","path":"/absolute/path","content":"...","reason":"..."}
      ]
    }
  ]
}
`.trim();
  }
}

function parseProposalJson(raw: string, epochId: string, specialist: string): EvolutionProposal[] {
  const jsonText = extractJson(raw);
  const parsed = JSON.parse(jsonText) as { proposals?: any[] };
  const proposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];
  return proposals.map((proposal, index) => ({
    id: `prop_${epochId}_${specialist}_${index}_${shortHash(JSON.stringify(proposal))}`,
    epochId,
    specialist,
    kind: proposal.kind,
    title: String(proposal.title ?? "Untitled proposal"),
    confidence: Number(proposal.confidence ?? 0),
    evidenceIds: Array.isArray(proposal.evidenceIds) ? proposal.evidenceIds.map(String) : [],
    operations: Array.isArray(proposal.operations) ? proposal.operations : [],
    rationale: String(proposal.rationale ?? ""),
  }));
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /```json\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) return fenced[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

export function buildOfflineRejectedProposal(
  epochId: string,
  specialist: string,
  evidence: EvidenceCard[],
  reason: string,
): EvolutionProposal {
  return {
    id: `prop_${epochId}_${specialist}_offline_${shortHash(reason)}`,
    epochId,
    specialist,
    kind: specialist.includes("garbage") ? "garbage" : specialist.includes("subagent") ? "subagent" : "skill",
    title: `${specialist} unavailable`,
    confidence: 0,
    evidenceIds: evidence.slice(0, 3).map((card) => card.id),
    operations: [],
    rationale: reason,
  };
}

export async function writeAgentInputs(
  dir: string,
  evidence: EvidenceCard[],
  assetManifest: unknown,
): Promise<{ evidencePath: string; assetsPath: string }> {
  await fs.promises.mkdir(dir, { recursive: true });
  const evidencePath = path.join(dir, "evidence.json");
  const assetsPath = path.join(dir, "assets.json");
  await fs.promises.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.promises.writeFile(assetsPath, `${JSON.stringify(assetManifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return { evidencePath, assetsPath };
}
