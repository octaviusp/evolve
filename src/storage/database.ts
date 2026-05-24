import path from "node:path";
import Database from "better-sqlite3";
import {
  EvolveConfig,
  EvidenceCard,
  EvolutionProposal,
  Snapshot,
  ValidationDecision,
  PatternMatch,
  GarbageCandidate,
} from "../types.js";
import { ensureDir } from "../utils/fs.js";

export interface EvolveDatabase {
  db: Database.Database;
  close(): void;
}

export async function openEvolveDatabase(config: EvolveConfig): Promise<EvolveDatabase> {
  await ensureDir(config.stateDir);
  const dbPath = path.join(config.stateDir, "evolve.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return {
    db,
    close: () => db.close(),
  };
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_items (
      source_id TEXT PRIMARY KEY,
      system TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      processed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evidence_cards (
      id TEXT PRIMARY KEY,
      system TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      json_path TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS epochs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      pre_snapshot_id TEXT,
      post_snapshot_id TEXT,
      summary_path TEXT,
      diff_path TEXT,
      rollback_path TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      epoch_id TEXT NOT NULL,
      specialist TEXT NOT NULL,
      status TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      proposal_id TEXT PRIMARY KEY,
      epoch_id TEXT NOT NULL,
      status TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS patterns (
      id TEXT PRIMARY KEY,
      workflow TEXT NOT NULL,
      systems TEXT NOT NULL,
      occurrences INTEGER NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      confidence REAL NOT NULL,
      recommended_form TEXT NOT NULL,
      epoch_id TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS garbage_candidates (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      system TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      days_since_last_use INTEGER NOT NULL,
      references_found INTEGER NOT NULL,
      confidence REAL NOT NULL,
      status TEXT NOT NULL,
      epoch_id TEXT NOT NULL,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asset_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_path TEXT NOT NULL,
      asset_name TEXT NOT NULL,
      system TEXT NOT NULL,
      referenced_at TEXT NOT NULL,
      epoch_id TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_source_items_system ON source_items(system);
    CREATE INDEX IF NOT EXISTS idx_evidence_cards_system ON evidence_cards(system);
    CREATE INDEX IF NOT EXISTS idx_evidence_cards_signals ON evidence_cards(json);
    CREATE INDEX IF NOT EXISTS idx_epochs_status ON epochs(status);
    CREATE INDEX IF NOT EXISTS idx_patterns_workflow ON patterns(workflow);
    CREATE INDEX IF NOT EXISTS idx_garbage_system ON garbage_candidates(system);
    CREATE INDEX IF NOT EXISTS idx_garbage_status ON garbage_candidates(status);
    CREATE INDEX IF NOT EXISTS idx_asset_usage_path ON asset_usage_log(asset_path);
  `);
}

export function sourceSeen(db: Database.Database, sourceId: string): boolean {
  const row = db.prepare("SELECT 1 FROM source_items WHERE source_id = ?").get(sourceId);
  return Boolean(row);
}

export function recordEvidence(db: Database.Database, card: EvidenceCard): void {
  const insertSource = db.prepare(`
    INSERT OR IGNORE INTO source_items
      (source_id, system, source_path, source_key, content_hash, processed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertCard = db.prepare(`
    INSERT OR IGNORE INTO evidence_cards
      (id, system, source_path, source_key, content_hash, created_at, json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  insertSource.run(card.id, card.system, card.sourcePath, card.sourceKey, card.contentHash, now);
  insertCard.run(
    card.id,
    card.system,
    card.sourcePath,
    card.sourceKey,
    card.contentHash,
    card.createdAt,
    JSON.stringify(card),
  );
}

export function latestEvidence(db: Database.Database, limit: number): EvidenceCard[] {
  const rows = db
    .prepare("SELECT json FROM evidence_cards ORDER BY created_at DESC LIMIT ?")
    .all(limit) as Array<{ json: string }>;
  return rows.map((row) => JSON.parse(row.json) as EvidenceCard);
}

export function evidenceBySystem(
  db: Database.Database,
  system: string,
  limit: number,
): EvidenceCard[] {
  const rows = db
    .prepare(
      "SELECT json FROM evidence_cards WHERE system = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(system, limit) as Array<{ json: string }>;
  return rows.map((row) => JSON.parse(row.json) as EvidenceCard);
}

export function recordSnapshot(
  db: Database.Database,
  snapshot: Snapshot,
  jsonPath: string,
): void {
  db.prepare(
    "INSERT OR REPLACE INTO snapshots (id, label, created_at, json_path) VALUES (?, ?, ?, ?)",
  ).run(snapshot.id, snapshot.label, snapshot.createdAt, jsonPath);
}

export function findSnapshotPath(
  db: Database.Database,
  idOrLabel: string,
): string | undefined {
  const row = db
    .prepare("SELECT json_path FROM snapshots WHERE id = ? OR label = ?")
    .get(idOrLabel, idOrLabel) as { json_path: string } | undefined;
  return row?.json_path;
}

export function recordProposal(
  db: Database.Database,
  proposal: EvolutionProposal,
  status: "pending" | "approved" | "rejected",
): void {
  db.prepare(
    "INSERT OR REPLACE INTO proposals (id, epoch_id, specialist, status, json) VALUES (?, ?, ?, ?, ?)",
  ).run(
    proposal.id,
    proposal.epochId,
    proposal.specialist,
    status,
    JSON.stringify(proposal),
  );
}

export function recordDecision(
  db: Database.Database,
  epochId: string,
  decision: ValidationDecision,
): void {
  db.prepare(
    "INSERT OR REPLACE INTO decisions (proposal_id, epoch_id, status, json) VALUES (?, ?, ?, ?)",
  ).run(decision.proposalId, epochId, decision.status, JSON.stringify(decision));
}

export function recordPattern(db: Database.Database, pattern: PatternMatch, epochId: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO patterns
     (id, workflow, systems, occurrences, first_seen, last_seen, confidence, recommended_form, epoch_id, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pattern.id,
    pattern.workflow,
    JSON.stringify(pattern.systems),
    pattern.occurrences,
    pattern.firstSeen,
    pattern.lastSeen,
    pattern.confidence,
    pattern.recommendedForm,
    epochId,
    JSON.stringify(pattern),
  );
}

export function recordGarbageCandidate(
  db: Database.Database,
  candidate: GarbageCandidate,
  epochId: string,
  status: "detected" | "proposed" | "archived" | "skipped",
): void {
  db.prepare(
    `INSERT OR REPLACE INTO garbage_candidates
     (id, path, system, kind, name, days_since_last_use, references_found, confidence, status, epoch_id, json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    candidate.id,
    candidate.path,
    candidate.system,
    candidate.kind,
    candidate.name,
    candidate.daysSinceLastUse,
    candidate.referencesFound,
    candidate.confidence,
    status,
    epochId,
    JSON.stringify(candidate),
  );
}

export function recordAssetUsage(
  db: Database.Database,
  assetPath: string,
  assetName: string,
  system: string,
  epochId: string,
): void {
  db.prepare(
    `INSERT INTO asset_usage_log (asset_path, asset_name, system, referenced_at, epoch_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(assetPath, assetName, system, new Date().toISOString(), epochId);
}

export function getStaleGarbage(
  db: Database.Database,
  system: string,
  minConfidence: number,
): GarbageCandidate[] {
  const rows = db
    .prepare(
      `SELECT json FROM garbage_candidates
       WHERE system = ? AND confidence >= ? AND status = 'detected'
       ORDER BY confidence DESC LIMIT 50`,
    )
    .all(system, minConfidence) as Array<{ json: string }>;
  return rows.map((row) => JSON.parse(row.json) as GarbageCandidate);
}

export function getRecentPatterns(
  db: Database.Database,
  workflows: string[],
): PatternMatch[] {
  if (workflows.length === 0) return [];
  const placeholders = workflows.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT json FROM patterns
       WHERE workflow IN (${placeholders})
       ORDER BY last_seen DESC LIMIT 30`,
    )
    .all(...workflows) as Array<{ json: string }>;
  return rows.map((row) => JSON.parse(row.json) as PatternMatch);
}

export function getEpochCount(db: Database.Database): number {
  const row = db.prepare("SELECT count(*) AS count FROM epochs").get() as { count: number };
  return row.count;
}

export function getDbStats(db: Database.Database): Record<string, number> {
  const tables = [
    "source_items",
    "evidence_cards",
    "snapshots",
    "epochs",
    "proposals",
    "decisions",
    "patterns",
    "garbage_candidates",
    "asset_usage_log",
  ];
  const stats: Record<string, number> = {};
  for (const table of tables) {
    const row = db
      .prepare(`SELECT count(*) AS count FROM ${table}`)
      .get() as { count: number };
    stats[table] = row.count;
  }
  return stats;
}
