import Database from "better-sqlite3";
import { EvolveConfig, EvidenceCard } from "../types.js";
import { sourceSeen } from "../storage/database.js";
import { sha256, shortHash } from "../utils/hash.js";
import { redactSecrets } from "../utils/redact.js";

const SIGNAL_PATTERNS: Array<[string, RegExp]> = [
  ["bug", /\bbug|broken|wrong|regression|failure|failed\b/i],
  ["retry", /\bretry|again|rerun|second attempt|try again\b/i],
  ["tests", /\btest|typecheck|lint|build\b/i],
  ["agent-assets", /\bskill|subagent|hook|rule|memory|prompt\b/i],
  ["cursor", /\bcursor|composer|agent\b/i],
  ["evolve", /\bevolve|snapshot|rollback|diff\b/i],
];

export interface CursorIngestResult {
  cards: EvidenceCard[];
  scannedRows: number;
}

export function ingestCursorEvidence(
  config: EvolveConfig,
  evolveDb: Database.Database,
): CursorIngestResult {
  const db = new Database(config.cursor.appDb, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `
          SELECT key, value
          FROM cursorDiskKV
          WHERE key LIKE 'bubbleId:%'
          ORDER BY key DESC
          LIMIT ?
        `,
      )
      .all(config.cursor.maxBubbleRowsPerEpoch) as Array<{ key: string; value: Buffer }>;

    const cards: EvidenceCard[] = [];
    for (const row of rows) {
      const raw = row.value.toString("utf8");
      const hash = sha256(raw);
      const sourceId = `cursor:${row.key}:${hash}`;
      if (sourceSeen(evolveDb, sourceId)) continue;
      const card = bubbleToEvidenceCard(config.cursor.appDb, row.key, raw, hash, sourceId);
      if (card) cards.push(card);
    }
    return { cards, scannedRows: rows.length };
  } finally {
    db.close();
  }
}

function bubbleToEvidenceCard(
  sourcePath: string,
  sourceKey: string,
  raw: string,
  hash: string,
  id: string,
): EvidenceCard | undefined {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const text = extractUsefulText(parsed);
  if (text.length < 24) return undefined;
  const { text: redactedText, redacted } = redactSecrets(text);
  const signals = SIGNAL_PATTERNS.filter(([, pattern]) => pattern.test(redactedText)).map(
    ([signal]) => signal,
  );
  if (signals.length === 0) return undefined;

  const title = makeTitle(parsed, redactedText);
  return {
    id,
    system: "cursor",
    sourcePath,
    sourceKey,
    contentHash: hash,
    createdAt: new Date().toISOString(),
    kind: "conversation",
    title,
    summary: redactedText.slice(0, 1200),
    signals,
    pointers: [`${sourceKey}`, `sha256:${shortHash(hash)}`],
    redacted,
  };
}

function extractUsefulText(parsed: any): string {
  const parts: string[] = [];
  for (const key of ["text", "richText"]) {
    if (typeof parsed[key] === "string") parts.push(parsed[key]);
  }
  if (parsed.thinking?.text && typeof parsed.thinking.text === "string") {
    parts.push(parsed.thinking.text);
  }
  if (parsed.toolFormerData) {
    parts.push(JSON.stringify(parsed.toolFormerData).slice(0, 1600));
  }
  if (Array.isArray(parsed.codeBlocks)) {
    parts.push(JSON.stringify(parsed.codeBlocks).slice(0, 1200));
  }
  return parts.join("\n").trim();
}

function makeTitle(parsed: any, text: string): string {
  const type = parsed.type === 1 ? "User" : parsed.type === 2 ? "Assistant" : "Bubble";
  const first = text
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim()
    .slice(0, 80);
  return `${type}: ${first ?? "Cursor conversation signal"}`;
}
