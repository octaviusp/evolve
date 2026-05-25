import fs from "node:fs";
import path from "node:path";
import { EvolveConfig, EvidenceCard, EvolutionProposal, ValidationDecision, SupportedSystem } from "../types.js";
import { ensureInside } from "../paths.js";
import { containsSecret } from "../utils/redact.js";

export function validateProposal(
  config: EvolveConfig,
  evidence: EvidenceCard[],
  proposal: EvolutionProposal,
): ValidationDecision {
  const reasons: string[] = [];
  const evidenceIds = new Set(evidence.map((card) => card.id));

  if (proposal.confidence < 0.60) reasons.push("confidence below 0.60 threshold");
  if (proposal.evidenceIds.length === 0) reasons.push("no evidence ids cited");

  // Evidence ID matching: skip for garbage proposals (which use candidate IDs)
  if (proposal.kind !== "garbage") {
    let unknownCount = 0;
    for (const id of proposal.evidenceIds) {
      if (!evidenceIds.has(id)) unknownCount++;
    }
    if (unknownCount > 0 && unknownCount === proposal.evidenceIds.length) {
      reasons.push("all evidence ids outside current window");
    }
  }

  if (proposal.operations.length === 0) reasons.push("no operations proposed");
  if (proposal.rationale.trim().length < 20) reasons.push("rationale is too short");

  for (const operation of proposal.operations) {
    const pathStr = operation.path;
    const system = detectSystemForPath(pathStr, config);

    if (!system) {
      reasons.push(`path outside any managed system root: ${pathStr}`);
      continue;
    }

    if (!config.systems.includes(system)) {
      reasons.push(`system ${system} not enabled in config: ${pathStr}`);
      continue;
    }

    const allowedRoots = getAllowedRoots(config, system);
    if (!ensureInside(pathStr, allowedRoots)) {
      reasons.push(`path outside ${system} mutation roots: ${pathStr}`);
    }

    if (
      config.mutation.conservativeFirstRun &&
      (operation.op === "create_file" || operation.op === "replace_file") &&
      !isEvolveManagedPath(config, pathStr, system)
    ) {
      reasons.push(`first-run mutation must target an EVOLVE-managed path: ${pathStr}`);
    }

    if ("content" in operation && containsSecret(operation.content)) {
      reasons.push(`operation content appears to contain a secret: ${pathStr}`);
    }

    if ("content" in operation && operation.content.length > 64_000) {
      reasons.push(`operation content too large: ${pathStr}`);
    }

    if (operation.op === "replace_file" && fs.existsSync(pathStr)) {
      const existing = fs.readFileSync(pathStr, "utf8");
      if (!existing.includes("<!-- EVOLVE:BEGIN") && !isEvolveManagedPath(config, pathStr, system)) {
        reasons.push(`replace_file rejected for unmanaged file: ${pathStr}`);
      }
    }

    if (operation.op === "archive_file" && !fs.existsSync(pathStr)) {
      reasons.push(`archive source does not exist: ${pathStr}`);
    }

    if (operation.op === "archive_file") {
      const archivePath = operation.archivePath;
      if (archivePath && !ensureInside(archivePath, [...allowedRoots, config.stateDir])) {
        reasons.push(`archive destination outside allowed paths: ${archivePath}`);
      }
    }
  }

  return {
    proposalId: proposal.id,
    status: reasons.length === 0 ? "approved" : "rejected",
    reasons: reasons.length === 0 ? ["approved by deterministic guardrails"] : reasons,
  };
}

function detectSystemForPath(
  filePath: string,
  config: EvolveConfig,
): SupportedSystem | undefined {
  const systemChecks: Array<[SupportedSystem, string[]]> = [
    ["cursor", [config.cursor.home, config.cursor.skillsDir, config.cursor.agentsDir, config.cursor.rulesDir]],
    ["claude", [config.claude.home, config.claude.skillsDir, config.claude.agentsDir, config.claude.commandsDir]],
    ["codex", [config.codex.home, config.codex.skillsDir, config.codex.agentsDir]],
  ];

  for (const [system, roots] of systemChecks) {
    if (ensureInside(filePath, roots)) return system;
  }

  return undefined;
}

function getAllowedRoots(config: EvolveConfig, system: SupportedSystem): string[] {
  switch (system) {
    case "cursor":
      return [
        config.cursor.skillsDir,
        config.cursor.agentsDir,
        config.cursor.rulesDir,
        path.dirname(config.cursor.hooksPath),
        config.cursor.home,
      ];
    case "claude":
      return [
        config.claude.skillsDir,
        config.claude.agentsDir,
        config.claude.commandsDir,
        path.dirname(config.claude.hooksPath),
        config.claude.home,
      ];
    case "codex":
      return [
        config.codex.skillsDir,
        config.codex.agentsDir,
        config.codex.hooksDir,
        config.codex.home,
      ];
    default:
      return [];
  }
}

function isEvolveManagedPath(
  config: EvolveConfig,
  filePath: string,
  system: SupportedSystem,
): boolean {
  const normalized = path.resolve(filePath);

  switch (system) {
    case "cursor":
      return (
        normalized.startsWith(path.join(config.cursor.skillsDir, "evolve")) ||
        path.basename(normalized).startsWith("evolve-")
      );
    case "claude":
      return (
        normalized.startsWith(path.join(config.claude.skillsDir, "evolve")) ||
        path.basename(normalized).startsWith("evolve-")
      );
    case "codex":
      return (
        normalized.startsWith(path.join(config.codex.skillsDir, "evolve")) ||
        path.basename(normalized).startsWith("evolve-")
      );
    default:
      return false;
  }
}
