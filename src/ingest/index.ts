import { EvolveConfig, EvidenceCard, CrossSystemEvidence } from "../types.js";
import { ingestCursorEvidence } from "../cursor/ingest.js";
import { ingestClaudeEvidence } from "../claude/ingest.js";
import { ingestCodexEvidence } from "../codex/ingest.js";

export interface MultiSystemIngestResult {
  evidence: EvidenceCard[];
  crossSystem: CrossSystemEvidence;
  stats: {
    cursor: { cards: number; scannedRows: number };
    claude: { cards: number; scannedFiles: number; scannedEvents: number };
    codex: { cards: number; scannedFiles: number; scannedEvents: number };
  };
}

export async function ingestAllSystems(
  config: EvolveConfig,
  evolveDb: import("better-sqlite3").Database,
): Promise<MultiSystemIngestResult> {
  const allCards: EvidenceCard[] = [];
  const stats = {
    cursor: { cards: 0, scannedRows: 0 },
    claude: { cards: 0, scannedFiles: 0, scannedEvents: 0 },
    codex: { cards: 0, scannedFiles: 0, scannedEvents: 0 },
  };

  if (config.systems.includes("cursor")) {
    const result = ingestCursorEvidence(config, evolveDb);
    allCards.push(...result.cards);
    stats.cursor = { cards: result.cards.length, scannedRows: result.scannedRows };
  }

  if (config.systems.includes("claude")) {
    const result = await ingestClaudeEvidence(config, evolveDb);
    allCards.push(...result.cards);
    stats.claude = {
      cards: result.cards.length,
      scannedFiles: result.scannedFiles,
      scannedEvents: result.scannedEvents,
    };
  }

  if (config.systems.includes("codex")) {
    const result = await ingestCodexEvidence(config, evolveDb);
    allCards.push(...result.cards);
    stats.codex = {
      cards: result.cards.length,
      scannedFiles: result.scannedFiles,
      scannedEvents: result.scannedEvents,
    };
  }

  const crossSystem = buildCrossSystemEvidence(allCards);

  return { evidence: allCards, crossSystem, stats };
}

function buildCrossSystemEvidence(
  cards: EvidenceCard[],
): CrossSystemEvidence {
  const systemSummary = {
    cursor: cards.filter((c) => c.system === "cursor").length,
    claude: cards.filter((c) => c.system === "claude").length,
    codex: cards.filter((c) => c.system === "codex").length,
  };

  const signalMap = new Map<string, { systems: Set<string>; cardIds: string[]; count: number }>();

  for (const card of cards) {
    for (const signal of card.signals) {
      const entry = signalMap.get(signal) ?? {
        systems: new Set(),
        cardIds: [],
        count: 0,
      };
      entry.systems.add(card.system);
      entry.cardIds.push(card.id);
      entry.count++;
      signalMap.set(signal, entry);
    }
  }

  const crossReferences = Array.from(signalMap.entries())
    .filter(([, entry]) => entry.systems.size > 1 && entry.count >= 2)
    .map(([signal, entry]) => ({
      signal,
      systems: Array.from(entry.systems) as Array<"cursor" | "claude" | "codex">,
      cardIds: entry.cardIds.slice(0, 50),
      count: entry.count,
    }))
    .sort((a, b) => b.count - a.count);

  const timestamps = cards
    .map((c) => new Date(c.createdAt).getTime())
    .filter((t) => !isNaN(t));

  return {
    cards,
    systemSummary,
    crossReferences,
    periodStart: timestamps.length > 0
      ? new Date(Math.min(...timestamps)).toISOString()
      : new Date().toISOString(),
    periodEnd: new Date().toISOString(),
  };
}

export function deduplicateEvidence(cards: EvidenceCard[]): EvidenceCard[] {
  const seen = new Set<string>();
  return cards.filter((card) => {
    const key = `${card.system}:${card.contentHash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sortEvidenceByRelevance(cards: EvidenceCard[]): EvidenceCard[] {
  const signalWeights: Record<string, number> = {
    bug: 5,
    retry: 4,
    "agent-assets": 4,
    tests: 3,
    coding: 3,
    review: 2,
    evolve: 2,
    compact: 1,
  };

  return [...cards].sort((a, b) => {
    const wA = a.signals.reduce((sum, s) => sum + (signalWeights[s] ?? 1), 0);
    const wB = b.signals.reduce((sum, s) => sum + (signalWeights[s] ?? 1), 0);
    return wB - wA;
  });
}
