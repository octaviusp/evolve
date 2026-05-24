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

  for (const system of config.systems) {
    switch (system) {
      case "cursor":
        candidates.push(...scanCursorGarbage(config));
        break;
      case "claude":
        candidates.push(...scanClaudeGarbage(config));
        break;
      case "codex":
        candidates.push(...scanCodexGarbage(config));
        break;
    }
  }

  const proposals = candidates
    .filter((c) => c.confidence > 0.60 && c.daysSinceLastUse >= config.analysis.garbageMinDaysSinceLastUse)
    .map((c) => garbageToProposal(c, epochId));

  return { candidates, proposals };
}

function scanCursorGarbage(config: EvolveConfig): GarbageCandidate[] {
  const candidates: GarbageCandidate[] = [];

  candidates.push(...scanAssetDir(config.cursor.skillsDir, "cursor", "skill", config));
  candidates.push(...scanAssetDir(config.cursor.agentsDir, "cursor", "subagent", config));
  candidates.push(...scanAssetDir(config.cursor.rulesDir, "cursor", "rule", config));

  return candidates;
}

function scanClaudeGarbage(config: EvolveConfig): GarbageCandidate[] {
  const candidates: GarbageCandidate[] = [];

  candidates.push(...scanAssetDir(config.claude.skillsDir, "claude", "skill", config));
  candidates.push(...scanAssetDir(config.claude.agentsDir, "claude", "subagent", config));
  candidates.push(...scanAssetDir(config.claude.commandsDir, "claude", "skill", config));

  return candidates;
}

function scanCodexGarbage(config: EvolveConfig): GarbageCandidate[] {
  const candidates: GarbageCandidate[] = [];

  candidates.push(...scanAssetDir(config.codex.skillsDir, "codex", "skill", config));
  candidates.push(...scanAssetDir(config.codex.agentsDir, "codex", "subagent", config));

  return candidates;
}

function scanAssetDir(
  dir: string,
  system: string,
  kind: ProposalKind,
  config: EvolveConfig,
): GarbageCandidate[] {
  if (!fs.existsSync(dir)) return [];

  const allFiles = findAssetFiles(dir);

  return allFiles
    .map((filePath) => evaluateFileForGarbage(filePath, system, kind, config))
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
): GarbageCandidate | undefined {
  const name = path.basename(filePath, path.extname(filePath));

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
  const lastReferencedAt = findLastReference(filePath, kind, system, config);

  const daysSinceMod = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
  const daysSinceRef = lastReferencedAt
    ? (Date.now() - new Date(lastReferencedAt).getTime()) / (1000 * 60 * 60 * 24)
    : daysSinceMod;
  const daysSinceLastUse = Math.min(daysSinceMod, daysSinceRef);

  if (daysSinceLastUse < config.analysis.garbageAgeDays / 2) return undefined;

  const referencesFound = countReferences(filePath, kind, system, config);

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
  _kind: ProposalKind,
  system: string,
  config: EvolveConfig,
): string | null {
  const assetName = path.basename(filePath, path.extname(filePath));
  const patterns: string[] = [];

  switch (system) {
    case "cursor": {
      const appDb = config.cursor.appDb;
      if (fs.existsSync(appDb)) {
        try {
          // Database imported at top level
          const db = new Database(appDb, { readonly: true, fileMustExist: true });
          try {
            const rows = db
              .prepare(
                `SELECT key FROM cursorDiskKV WHERE key LIKE '%bubbleId:%' AND value LIKE ? LIMIT 1`,
              )
              .all(`%${assetName}%`) as Array<{ key: string }>;
            if (rows.length > 0) return new Date().toISOString();
          } finally {
            db.close();
          }
        } catch {
          // best effort
        }
      }
      break;
    }
    case "claude": {
      patterns.push(path.join(config.claude.projectsDir, "**", "*.jsonl"));
      break;
    }
    case "codex": {
      patterns.push(path.join(config.codex.sessionsDir, "**", "rollout-*.jsonl"));
      break;
    }
  }

  if (patterns.length > 0) {
    try {
      const searchFiles = fg.sync(patterns, { onlyFiles: true, dot: true });
      const recent = searchFiles
        .map((f) => {
          try {
            return { path: f, mtime: fs.statSync(f).mtimeMs };
          } catch {
            return { path: f, mtime: 0 };
          }
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 20);

      for (const { path: searchPath } of recent) {
        try {
          const content = fs.readFileSync(searchPath, "utf8");
          if (content.includes(assetName)) {
            return new Date().toISOString();
          }
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }

  return null;
}

function countReferences(
  filePath: string,
  _kind: ProposalKind,
  system: string,
  config: EvolveConfig,
): number {
  const assetName = path.basename(filePath, path.extname(filePath));
  let count = 0;

  switch (system) {
    case "cursor": {
      const appDb = config.cursor.appDb;
      if (fs.existsSync(appDb)) {
        try {
          // Database imported at top level
          const db = new Database(appDb, { readonly: true, fileMustExist: true });
          try {
            const row = db
              .prepare(
                `SELECT count(*) AS count FROM cursorDiskKV WHERE key LIKE '%bubbleId:%' AND value LIKE ?`,
              )
              .get(`%${assetName}%`) as { count: number };
            count += row.count;
          } finally {
            db.close();
          }
        } catch {
          // best effort
        }
      }
      break;
    }
    case "claude": {
      try {
        const files = fg.sync(
          [path.join(config.claude.projectsDir, "**", "*.jsonl")],
          { onlyFiles: true, dot: true },
        ).slice(0, 30);
        for (const f of files) {
          try {
            const content = fs.readFileSync(f, "utf8");
            count += (content.match(new RegExp(assetName, "g")) ?? []).length;
          } catch {
            // skip
          }
        }
      } catch {
        // skip
      }
      break;
    }
    case "codex": {
      try {
        const files = fg.sync(
          [path.join(config.codex.sessionsDir, "**", "rollout-*.jsonl")],
          { onlyFiles: true, dot: true },
        ).slice(0, 30);
        for (const f of files) {
          try {
            const content = fs.readFileSync(f, "utf8");
            count += (content.match(new RegExp(assetName, "g")) ?? []).length;
          } catch {
            // skip
          }
        }
      } catch {
        // skip
      }
      break;
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
