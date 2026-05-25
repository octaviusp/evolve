import {
  EvolveConfig,
  EvidenceCard,
  CrossSystemEvidence,
  PatternMatch,
  EvolutionProposal,
  ProposalKind,
  ProposalOperation,
  FilterResult,
} from "../types.js";
import { shortHash } from "../utils/hash.js";

const WORKFLOW_SIGNATURES: Record<string, string[]> = {
  "debugging-cycle": ["bug", "retry"],
  "test-fix-loop": ["tests", "coding", "retry"],
  "code-review": ["review", "coding"],
  "refactoring": ["coding"],
  "asset-creation": ["agent-assets", "coding"],
  "tool-usage": ["task"],
  "session-management": ["compact"],
  "evolve-meta": ["evolve"],
};

const FORM_PRIORITY: Record<string, ProposalKind> = {
  "debugging-cycle": "subagent",
  "test-fix-loop": "automation",
  "code-review": "subagent",
  "refactoring": "skill",
  "asset-creation": "skill",
  "tool-usage": "skill",
  "session-management": "automation",
  "evolve-meta": "automation",
};

export function detectPatterns(
  crossSystem: CrossSystemEvidence,
  config: EvolveConfig,
): PatternMatch[] {
  const patterns: PatternMatch[] = [];
  const cards = crossSystem.cards;

  for (const [workflow, signals] of Object.entries(WORKFLOW_SIGNATURES)) {
    const matchingCards = cards.filter((card) =>
      signals.some((signal) => card.signals.includes(signal)),
    );

    if (matchingCards.length < config.analysis.minOccurrencesForPattern) continue;

    const systems = new Set(matchingCards.map((c) => c.system));
    const timestamps = matchingCards
      .map((c) => new Date(c.createdAt).getTime())
      .filter((t) => !isNaN(t));

    const confidence = calculateConfidence(matchingCards, signals);
    const signalStrength = matchingCards.length / Math.max(cards.length, 1);

    if (confidence < config.analysis.minConfidenceForProposal) continue;

    const recommendedForm = FORM_PRIORITY[workflow] ?? "skill";
    const existingAssets = findRelatedExistingAssets(workflow, cards);

    patterns.push({
      id: `pat_${workflow}_${shortHash(JSON.stringify(matchingCards.map((c) => c.id)))}`,
      workflow,
      systems: Array.from(systems) as Array<"cursor" | "claude" | "codex">,
      evidenceIds: matchingCards.slice(0, 30).map((c) => c.id),
      occurrences: matchingCards.length,
      firstSeen: timestamps.length > 0
        ? new Date(Math.min(...timestamps)).toISOString()
        : new Date().toISOString(),
      lastSeen: timestamps.length > 0
        ? new Date(Math.max(...timestamps)).toISOString()
        : new Date().toISOString(),
      confidence,
      signalStrength,
      recommendedForm,
      rationale: buildRationale(workflow, matchingCards.length, systems.size),
      relatedExistingAssets: existingAssets,
    });
  }

  return patterns
    .sort((a, b) => b.confidence * b.signalStrength - a.confidence * a.signalStrength)
    .slice(0, config.analysis.maxProposalsPerEpoch);
}

function calculateConfidence(cards: EvidenceCard[], signals: string[]): number {
  if (cards.length < 2) return 0;

  const signalHits = signals.filter((signal) =>
    cards.some((card) => card.signals.includes(signal)),
  ).length;
  const signalCoverage = signalHits / signals.length;

  const systemBonus = new Set(cards.map((c) => c.system)).size > 1 ? 0.15 : 0;
  const countBonus = Math.min(cards.length / 20, 0.2);

  return Math.min(signalCoverage * 0.65 + systemBonus + countBonus, 1.0);
}

function findRelatedExistingAssets(workflow: string, cards: EvidenceCard[]): string[] {
  const assets: string[] = [];
  const assetCards = cards.filter((c) => c.signals.includes("agent-assets"));
  for (const card of assetCards) {
    const existing = card.pointers.filter(
      (p) => p.includes("skill") || p.includes("agent") || p.includes("rule"),
    );
    assets.push(...existing);
  }
  return [...new Set(assets)].slice(0, 10);
}

function buildRationale(workflow: string, count: number, systemCount: number): string {
  const labels: Record<string, string> = {
    "debugging-cycle": "Repeated debugging cycles detected — workflow would benefit from a dedicated subagent",
    "test-fix-loop": "Test-fix loops observed — could automate with a skill or hook",
    "code-review": "Recurring code review patterns — subagent could standardize checks",
    "refactoring": "Frequent refactoring detected — reusable skill would improve consistency",
    "asset-creation": "Multiple agent assets created — consolidate into reusable skills",
    "tool-usage": "Repeated tool usage pattern — skill could encode best practices",
    "session-management": "Session compaction/management detected — automation would reduce overhead",
    "evolve-meta": "EVOLVE meta-work detected — self-improving automation possible",
  };

  const base = labels[workflow] ?? `Repeated workflow detected across ${count} events`;
  const cross = systemCount > 1
    ? ` across ${systemCount} systems`
    : "";
  return `${base} (${count} occurrences${cross})`;
}

export function generateProposals(
  patterns: PatternMatch[],
  crossSystem: CrossSystemEvidence,
  epochId: string,
  config: EvolveConfig,
): EvolutionProposal[] {
  const proposals: EvolutionProposal[] = [];

  for (const pattern of patterns) {
    if (pattern.recommendedForm === "skip") continue;

    const operations = generateOperations(pattern, config);
    if (operations.length === 0) continue;

    proposals.push({
      id: `prop_${epochId}_pattern_${shortHash(pattern.workflow)}`,
      epochId,
      specialist: "pattern-detector",
      kind: pattern.recommendedForm,
      title: buildProposalTitle(pattern),
      confidence: pattern.confidence,
      evidenceIds: pattern.evidenceIds,
      operations,
      rationale: pattern.rationale,
    });
  }

  return proposals;
}

function generateOperations(
  pattern: PatternMatch,
  config: EvolveConfig,
): ProposalOperation[] {
  const operations: ProposalOperation[] = [];
  const name = pattern.workflow.replace(/-/g, "_");

  for (const system of pattern.systems) {
    switch (pattern.recommendedForm) {
      case "skill": {
        const skillDir = getSkillsDir(config, system);
        if (!skillDir) continue;
        const skillPath = `${skillDir}/evolve/${name}/SKILL.md`;
        operations.push({
          op: "create_file",
          path: skillPath,
          content: generateSkillContent(pattern),
          reason: `Detected recurring ${pattern.workflow} workflow in ${system}`,
        });
        break;
      }
      case "subagent": {
        const agentsDir = getAgentsDir(config, system);
        if (!agentsDir) continue;
        const agentPath = `${agentsDir}/evolve-${name}.md`;
        operations.push({
          op: "create_file",
          path: agentPath,
          content: generateSubagentContent(pattern, system),
          reason: `Detected ${pattern.workflow} suitable for delegation in ${system}`,
        });
        break;
      }
      case "automation": {
        const hooksDir = getHooksDir(config, system);
        if (!hooksDir) continue;
        const hookPath = `${hooksDir}/evolve-${name}.json`;
        operations.push({
          op: "create_file",
          path: hookPath,
          content: generateAutomationContent(pattern, system),
          reason: `Detected automatable ${pattern.workflow} in ${system}`,
        });
        break;
      }
      default:
        break;
    }
  }

  return operations;
}

function getSkillsDir(config: EvolveConfig, system: string): string | undefined {
  switch (system) {
    case "cursor": return config.cursor.skillsDir;
    case "claude": return config.claude.skillsDir;
    case "codex": return config.codex.skillsDir;
    default: return undefined;
  }
}

function getAgentsDir(config: EvolveConfig, system: string): string | undefined {
  switch (system) {
    case "cursor": return config.cursor.agentsDir;
    case "claude": return config.claude.agentsDir;
    case "codex": return config.codex.agentsDir;
    default: return undefined;
  }
}

function getHooksDir(config: EvolveConfig, system: string): string | undefined {
  switch (system) {
    case "cursor": return config.cursor.home;
    case "claude": return config.claude.home;
    case "codex": return config.codex.hooksDir;
    default: return undefined;
  }
}

function buildProposalTitle(pattern: PatternMatch): string {
  const labels: Record<string, string> = {
    "debugging-cycle": "Debugging Subagent",
    "test-fix-loop": "Test-Fix Automation",
    "code-review": "Code Review Subagent",
    "refactoring": "Refactoring Skill",
    "asset-creation": "Asset Creation Skill",
    "tool-usage": "Tool Usage Skill",
    "session-management": "Session Management Automation",
    "evolve-meta": "EVOLVE Self-Improvement",
  };
  const base = labels[pattern.workflow] ?? pattern.workflow;
  const systems = pattern.systems.join("/");
  return `[${systems}] ${base}`;
}

function generateSkillContent(pattern: PatternMatch): string {
  const lines = [
    `---`,
    `name: evolve-${pattern.workflow}`,
    `description: EVOLVE-generated skill for ${pattern.workflow} workflow`,
    `type: skill`,
    `---`,
    ``,
    `# ${pattern.workflow.replace(/-/g, " ")}`,
    ``,
    `Auto-generated by EVOLVE pattern detection.`,
    ``,
    `## Workflow`,
    ``,
    `Detected across ${pattern.occurrences} events in ${pattern.systems.join(", ")}.`,
    ``,
    `<!-- EVOLVE:BEGIN workflow -->`,
    `## Instructions`,
    ``,
    `1. Analyze the task context`,
    `2. Apply the ${pattern.workflow} pattern`,
    `3. Verify results`,
    ``,
    `<!-- EVOLVE:END workflow -->`,
    ``,
    `## Evidence`,
    ``,
    `- First seen: ${pattern.firstSeen}`,
    `- Last seen: ${pattern.lastSeen}`,
    `- Confidence: ${(pattern.confidence * 100).toFixed(0)}%`,
  ];
  return lines.join("\n");
}

function generateSubagentContent(pattern: PatternMatch, system: string): string {
  const lines = [
    `---`,
    `name: evolve-${pattern.workflow}`,
    `description: EVOLVE-generated subagent for ${pattern.workflow}`,
    `model: haiku`,
    `tools: ["Read", "Glob", "Grep", "Bash", "Edit", "Write"]`,
    `---`,
    ``,
    `# ${pattern.workflow.replace(/-/g, " ")} Agent`,
    ``,
    `You are a specialized subagent for ${pattern.workflow} workflows detected in ${system}.`,
    ``,
    `## Context`,
    ``,
    `This workflow was detected across ${pattern.occurrences} events.`,
    `First seen: ${pattern.firstSeen}. Last seen: ${pattern.lastSeen}.`,
    ``,
    `<!-- EVOLVE:BEGIN instructions -->`,
    `## Core Instructions`,
    ``,
    `1. Receive the ${pattern.workflow} task`,
    `2. Execute according to established patterns`,
    `3. Report results back to the parent agent`,
    ``,
    `<!-- EVOLVE:END instructions -->`,
  ];
  return lines.join("\n");
}

function generateAutomationContent(pattern: PatternMatch, system: string): string {
  return JSON.stringify(
    {
      name: `evolve-${pattern.workflow}`,
      description: `EVOLVE-generated automation for ${pattern.workflow} in ${system}`,
      trigger: "SessionStart",
      workflow: pattern.workflow,
      occurrences: pattern.occurrences,
      systems: pattern.systems,
      firstSeen: pattern.firstSeen,
      lastSeen: pattern.lastSeen,
      confidence: pattern.confidence,
    },
    null,
    2,
  );
}

export function filterProposals(
  proposals: EvolutionProposal[],
  config: EvolveConfig,
): FilterResult {
  const passed: EvolutionProposal[] = [];
  const filtered: Array<{ proposal: EvolutionProposal; reason: string }> = [];
  const byKind: Record<string, { total: number; passed: number }> = {};

  for (const proposal of proposals) {
    byKind[proposal.kind] = byKind[proposal.kind] ?? { total: 0, passed: 0 };
    byKind[proposal.kind].total++;

    if (!config.analysis.filterLayerEnabled) {
      passed.push(proposal);
      byKind[proposal.kind].passed++;
      continue;
    }

    if (proposal.confidence < config.analysis.minConfidenceForProposal) {
      filtered.push({ proposal, reason: `confidence ${proposal.confidence.toFixed(2)} below threshold` });
      continue;
    }

    // Garbage proposals only need their own candidate evidence
    const minEvidence = proposal.kind === "garbage" ? 1 : 2;
    if (proposal.evidenceIds.length < minEvidence) {
      filtered.push({ proposal, reason: "insufficient evidence citations" });
      continue;
    }

    if (proposal.rationale.trim().length < 20) {
      filtered.push({ proposal, reason: "rationale too short" });
      continue;
    }

    if (proposal.operations.some((op) => op.op === "create_file" && op.content.length < 40)) {
      filtered.push({ proposal, reason: "generated content too thin" });
      continue;
    }

    passed.push(proposal);
    byKind[proposal.kind].passed++;
  }

  const cappedPassed = passed.slice(0, config.analysis.maxProposalsPerEpoch);

  return {
    passed: cappedPassed,
    filtered,
    stats: {
      total: proposals.length,
      passed: cappedPassed.length,
      filtered: filtered.length + (passed.length - cappedPassed.length),
      byKind,
    },
  };
}
