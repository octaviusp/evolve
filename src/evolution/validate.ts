import fs from "node:fs";
import path from "node:path";
import { EvolveConfig, EvidenceCard, EvolutionProposal, ValidationDecision } from "../types.js";
import { ensureInside } from "../paths.js";
import { containsSecret } from "../utils/redact.js";

export function validateProposal(
  config: EvolveConfig,
  evidence: EvidenceCard[],
  proposal: EvolutionProposal,
): ValidationDecision {
  const reasons: string[] = [];
  const evidenceIds = new Set(evidence.map((card) => card.id));
  if (proposal.confidence < 0.78) reasons.push("confidence below 0.78 threshold");
  if (proposal.evidenceIds.length === 0) reasons.push("no evidence ids cited");
  for (const id of proposal.evidenceIds) {
    if (!evidenceIds.has(id)) reasons.push(`unknown evidence id: ${id}`);
  }
  if (proposal.operations.length === 0) reasons.push("no operations proposed");
  if (proposal.rationale.trim().length < 24) reasons.push("rationale is too short");

  for (const operation of proposal.operations) {
    const allowedRoots = [
      config.cursor.skillsDir,
      config.cursor.agentsDir,
      config.cursor.rulesDir,
      path.dirname(config.cursor.hooksPath),
    ];
    if (!ensureInside(operation.path, allowedRoots)) {
      reasons.push(`path outside Cursor mutation roots: ${operation.path}`);
    }
    if (operation.path.includes(".codex") || operation.path.includes(".claude")) {
      reasons.push(`non-Cursor path rejected: ${operation.path}`);
    }
    if (
      config.mutation.conservativeFirstRun &&
      (operation.op === "create_file" || operation.op === "replace_file") &&
      !isEvolveManagedPath(config, operation.path)
    ) {
      reasons.push(`first-run mutation must target an EVOLVE-managed path: ${operation.path}`);
    }
    if ("content" in operation && containsSecret(operation.content)) {
      reasons.push(`operation content appears to contain a secret: ${operation.path}`);
    }
    if ("content" in operation && operation.content.length > 16_000) {
      reasons.push(`operation content too large: ${operation.path}`);
    }
    if (operation.op === "replace_file" && fs.existsSync(operation.path)) {
      const existing = fs.readFileSync(operation.path, "utf8");
      if (!existing.includes("<!-- EVOLVE:BEGIN") && !isEvolveManagedPath(config, operation.path)) {
        reasons.push(`replace_file rejected for unmanaged file: ${operation.path}`);
      }
    }
    if (operation.op === "archive_file" && !fs.existsSync(operation.path)) {
      reasons.push(`archive source does not exist: ${operation.path}`);
    }
  }

  return {
    proposalId: proposal.id,
    status: reasons.length === 0 ? "approved" : "rejected",
    reasons: reasons.length === 0 ? ["approved by deterministic guardrails"] : reasons,
  };
}

function isEvolveManagedPath(config: EvolveConfig, filePath: string): boolean {
  const normalized = path.resolve(filePath);
  return (
    normalized.startsWith(path.join(config.cursor.skillsDir, "evolve")) ||
    path.basename(normalized).startsWith("evolve-")
  );
}
