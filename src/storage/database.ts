import path from "node:path";
import Database from "better-sqlite3";
import { EvolveConfig, EvidenceCard, EvolutionProposal, Snapshot, ValidationDecision } from "../types.js";
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

export function recordSnapshot(db: Database.Database, snapshot: Snapshot, jsonPath: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO snapshots (id, label, created_at, json_path) VALUES (?, ?, ?, ?)",
  ).run(snapshot.id, snapshot.label, snapshot.createdAt, jsonPath);
}

export function findSnapshotPath(db: Database.Database, idOrLabel: string): string | undefined {
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
  ).run(proposal.id, proposal.epochId, proposal.specialist, status, JSON.stringify(proposal));
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
