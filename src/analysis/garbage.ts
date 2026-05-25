import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import Database from "better-sqlite3";
import { EvolveConfig, GarbageCandidate, EvolutionProposal, ProposalKind } from "../types.js";
import { shortHash } from "../utils/hash.js";

export function detectGarbage(
  config: EvolveConfig,
  epochId: string,
): { candidates: GarbageCandidate[]; proposals: EvolutionProposal[] } {
  const candidates: GarbageCandidate[] = [];

  // Open Cursor DB once for all cursor scans
  let cursorDb: Database.Database | null = null;
  if (config.systems.includes("cursor") && fs.existsSync(config.cursor.appDb)) {
    try {
      cursorDb = new Database(config.cursor.appDb, { readonly: true, fileMustExist: true });
    } catch {
      // skip if DB unavailable
    }
  }

  try {
    for (const system of config.systems) {
      switch (system) {
        case "cursor":
          candidates.push(...scanCursorGarbage(config, cursorDb));
          break;
        case "claude":
          candidates.push(...scanClaudeGarbage(config));
          break;
        case "codex":
          candidates.push(...scanCodexGarbage(config));
          break;
      }
    }
  } finally {
    if (cursorDb) cursorDb.close();
  }

  const capped = candidates
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 40);

  const proposals = capped
    .filter((c) => c.confidence > 0.60 && c.daysSinceLastUse >= config.analysis.garbageMinDaysSinceLastUse)
    .slice(0, 12)
    .map((c) => garbageToProposal(c, epochId));

  return { candidates: capped, proposals };
}

function scanCursorGarbage(
  config: EvolveConfig,
  cursorDb: Database.Database | null,
): GarbageCandidate[] {
  const candidates: GarbageCandidate[] = [];

  candidates.push(...scanAssetDir(config.cursor.skillsDir, "cursor", "skill", config, cursorDb));
  candidates.push(...scanAssetDir(config.cursor.agentsDir, "cursor", "subagent", config, cursorDb));
  candidates.push(...scanAssetDir(config.cursor.rulesDir, "cursor", "rule", config, cursorDb));

  return candidates;
}

function scanClaudeGarbage(config: EvolveConfig): GarbageCandidate[] {
  const candidates: GarbageCandidate[] = [];

  candidates.push(...scanAssetDir(config.claude.skillsDir, "claude", "skill", config, null));
  candidates.push(...scanAssetDir(config.claude.agentsDir, "claude", "subagent", config, null));
  candidates.push(...scanAssetDir(config.claude.commandsDir, "claude", "skill", config, null));

  return candidates;
}

function scanCodexGarbage(config: EvolveConfig): GarbageCandidate[] {
  const candidates: GarbageCandidate[] = [];

  candidates.push(...scanAssetDir(config.codex.skillsDir, "codex", "skill", config, null));
  candidates.push(...scanAssetDir(config.codex.agentsDir, "codex", "subagent", config, null));

  return candidates;
}

function scanAssetDir(
  dir: string,
  system: string,
  kind: ProposalKind,
  config: EvolveConfig,
  cursorDb: Database.Database | null,
): GarbageCandidate[] {
  if (!fs.existsSync(dir)) return [];

  const allFiles = findAssetFiles(dir);

  return allFiles
    .map((filePath) => evaluateFileForGarbage(filePath, system, kind, config, cursorDb))
    .filter((c): c is GarbageCandidate => c !== undefined);
}

function findAssetFiles(dir: string): string[] {
  const patterns = [
    path.join(dir, "**", "SKILL.md"),
    path.join(dir, "**", "*.md"),
    path.join(dir, "*.mdc"),
    path.join(dir, "*.json"),
  ];
  try {
    return fg.sync(patterns, { onlyFiles: true, dot: true, unique: true, cwd: dir, absolute: true });
  } catch {
    return [];
  }
}

function evaluateFileForGarbage(
  filePath: string,
  system: string,
  kind: ProposalKind,
  config: EvolveConfig,
  cursorDb: Database.Database | null,
): GarbageCandidate | undefined {
  const name = path.basename(filePath, path.extname(filePath));

  // NEVER garbage collect core definition files
  const protectedNames = ["SKILL", "AGENTS", "README", "INDEX", "LICENSE", "CONTRIBUTING"];
  if (protectedNames.includes(name)) return undefined;

  // NEVER garbage collect files in root skill directories (only subdirs)
  const skillDirMatch = filePath.match(/\/skills\/([^/]+)\/([^/]+)\.md$/);
  if (skillDirMatch) {
    // This is a file directly inside a skill directory, not a subdirectory
    // Only allow garbage for deep references/rules/examples
    const depth = filePath.split(path.sep).filter(Boolean).length;
    const skillBaseDepth = filePath.indexOf("/skills/") >= 0
      ? filePath.split("/skills/")[0].split(path.sep).filter(Boolean).length + 2
      : 0;
    if (depth - skillBaseDepth <= 1) return undefined; // Only allow depth 2+ (references/rules/etc)
  }

  if (name.startsWith("evolve-")) return undefined;
  if (filePath.includes(".evolve") || filePath.includes("evolve.sqlite")) return undefined;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return undefined;
  }

  const lastModifiedAt = new Date(stat.mtimeMs).toISOString();
  const createdAt = new Date(stat.birthtimeMs).toISOString();
  const lastReferencedAt = findLastReference(filePath, system, cursorDb);

  const daysSinceMod = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
  const daysSinceRef = lastReferencedAt
    ? (Date.now() - new Date(lastReferencedAt).getTime()) / (1000 * 60 * 60 * 24)
    : daysSinceMod;
  const daysSinceLastUse = Math.min(daysSinceMod, daysSinceRef);

  if (daysSinceLastUse < config.analysis.garbageAgeDays / 2) return undefined;

  const referencesFound = countReferences(filePath, system, cursorDb);

  let confidence = 0;
  if (daysSinceLastUse > config.analysis.garbageAgeDays) confidence += 0.4;
  if (daysSinceLastUse > config.analysis.garbageAgeDays * 2) confidence += 0.3;
  if (referencesFound === 0) confidence += 0.3;
  if (stat.size < 500) confidence += 0.1;

  confidence = Math.min(confidence, 1.0);

  const evictionReason = buildEvictionReason(daysSinceLastUse, referencesFound);

  return {
    id: `gc_${system}_${shortHash(filePath)}`,
    path: filePath,
    system: system as "cursor" | "claude" | "codex",
    kind,
    name,
    createdAt,
    lastReferencedAt,
    lastModifiedAt,
    daysSinceLastUse: Math.round(daysSinceLastUse),
    referencesFound,
    confidence,
    evictionReason,
  };
}

function findLastReference(
  filePath: string,
  system: string,
  cursorDb: Database.Database | null,
): string | null {
  const assetName = path.basename(filePath, path.extname(filePath));

  if (system === "cursor" && cursorDb) {
    try {
      const rows = cursorDb
        .prepare(
          `SELECT key FROM cursorDiskKV WHERE key LIKE '%bubbleId:%' AND CAST(value AS TEXT) LIKE ? LIMIT 1`,
        )
        .all(`%${assetName}%`) as Array<{ key: string }>;
      if (rows.length > 0) return new Date().toISOString();
    } catch {
      // best effort
    }
  }

  return null;
}

function countReferences(
  filePath: string,
  system: string,
  cursorDb: Database.Database | null,
): number {
  const assetName = path.basename(filePath, path.extname(filePath));
  let count = 0;

  if (system === "cursor" && cursorDb) {
    try {
      const row = cursorDb
        .prepare(
          `SELECT count(*) AS count FROM cursorDiskKV WHERE key LIKE '%bubbleId:%' AND CAST(value AS TEXT) LIKE ?`,
        )
        .get(`%${assetName}%`) as { count: number };
      count += row.count;
    } catch {
      // best effort
    }
  }

  return count;
}

function buildEvictionReason(daysSinceLastUse: number, referencesFound: number): string {
  const parts: string[] = [];
  parts.push(`Last used ${Math.round(daysSinceLastUse)} days ago`);
  if (referencesFound === 0) {
    parts.push("no references found in recent sessions");
  } else {
    parts.push(`only ${referencesFound} reference(s) found`);
  }
  return parts.join("; ");
}

function garbageToProposal(
  candidate: GarbageCandidate,
  epochId: string,
): EvolutionProposal {
  const archivePath = candidate.path.replace(
    /(\.[^.]+)$/,
    `.archived-${Date.now()}$1`,
  );

  return {
    id: `prop_${epochId}_gc_${shortHash(candidate.path)}`,
    epochId,
    specialist: "garbage-collector",
    kind: "garbage",
    title: `Archive unused ${candidate.kind}: ${candidate.name}`,
    confidence: candidate.confidence,
    evidenceIds: [candidate.id],
    operations: [
      {
        op: "archive_file",
        path: candidate.path,
        archivePath,
        reason: candidate.evictionReason,
      },
    ],
    rationale: candidate.evictionReason,
  };
}
