import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { EvolveConfig, EvidenceCard } from "../types.js";
import { sourceSeen } from "../storage/database.js";
import { sha256, shortHash } from "../utils/hash.js";
import { redactSecrets } from "../utils/redact.js";

const SIGNAL_PATTERNS: Array<[string, RegExp]> = [
  ["bug", /\bbug|broken|wrong|regression|failure|failed\b/i],
  ["retry", /\bretry|again|rerun|second attempt|try again\b/i],
  ["tests", /\btest|typecheck|lint|build\b/i],
  ["agent-assets", /\bskill|subagent|hook|rule|memory|prompt\b/i],
  ["claude", /\bclaude|system prompt|tool_use|thinking\b/i],
  ["task", /\bTask tool|subagent|Task\b/i],
  ["compact", /\bcompact_boundary|compaction\b/i],
  ["evolve", /\bevolve|snapshot|rollback|diff\b/i],
  ["coding", /\brefactor|implement|fix|feature|debug\b/i],
  ["review", /\breview|pr|pull request|code review\b/i],
];

export interface ClaudeIngestResult {
  cards: EvidenceCard[];
  scannedFiles: number;
  scannedEvents: number;
}

export async function ingestClaudeEvidence(
  config: EvolveConfig,
  evolveDb: import("better-sqlite3").Database,
): Promise<ClaudeIngestResult> {
  const sessionFiles = await findRecentSessionFiles(config);
  const cards: EvidenceCard[] = [];
  let scannedFiles = 0;
  let scannedEvents = 0;

  for (const sessionPath of sessionFiles) {
    scannedFiles++;
    try {
      const content = await fs.promises.readFile(sessionPath, "utf8");
      const lines = content.split("\n").filter((line) => line.trim().length > 0);

      for (const line of lines) {
        scannedEvents++;
        const hash = sha256(line);
        const sourceId = `claude:${sessionPath}:${hash}`;
        if (sourceSeen(evolveDb, sourceId)) continue;

        const card = sessionLineToEvidenceCard(sessionPath, line, hash, sourceId);
        if (card) cards.push(card);
      }
    } catch {
      // skip unreadable sessions
    }
  }

  return { cards, scannedFiles, scannedEvents };
}

async function findRecentSessionFiles(config: EvolveConfig): Promise<string[]> {
  const projectsDir = config.claude.projectsDir;
  if (!fs.existsSync(projectsDir)) return [];

  const jsonlFiles = await fg(
    [
      path.join(projectsDir, "**", "*.jsonl"),
      `!${path.join(projectsDir, "**", "subagents", "**")}`,
    ],
    {
      onlyFiles: true,
      dot: true,
      deep: 5,
    },
  );

  const withStats = await Promise.all(
    jsonlFiles.map(async (filePath) => {
      try {
        const stat = await fs.promises.stat(filePath);
        return { path: filePath, mtime: stat.mtimeMs };
      } catch {
        return { path: filePath, mtime: 0 };
      }
    }),
  );

  return withStats
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, config.claude.maxSessionFilesPerEpoch)
    .map((item) => item.path);
}

function sessionLineToEvidenceCard(
  sourcePath: string,
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

  if (!parsed.type) return undefined;

  const text = extractClaudeText(parsed);
  if (text.length < 24) return undefined;

  const { text: redactedText, redacted } = redactSecrets(text);
  const signals = SIGNAL_PATTERNS.filter(([, pattern]) => pattern.test(redactedText)).map(
    ([signal]) => signal,
  );
  if (signals.length === 0) return undefined;

  const kind = parsed.type === "system" ? "session_meta" : "conversation";
  const title = makeClaudeTitle(parsed, redactedText);

  return {
    id,
    system: "claude",
    sourcePath,
    sourceKey: `${parsed.type}:${parsed.uuid ?? "unknown"}`,
    contentHash: hash,
    createdAt: new Date().toISOString(),
    kind,
    title,
    summary: redactedText.slice(0, 1200),
    signals,
    pointers: [`${sourcePath}`, `sha256:${shortHash(hash)}`, `type:${parsed.type}`],
    redacted,
  };
}

function extractClaudeText(parsed: any): string {
  const parts: string[] = [];

  if (typeof parsed.message?.content === "string") {
    parts.push(parsed.message.content);
  } else if (Array.isArray(parsed.message?.content)) {
    for (const block of parsed.message.content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block?.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block?.type === "thinking" && typeof block.thinking === "string") {
        parts.push(block.thinking);
      } else if (block?.type === "tool_use") {
        parts.push(`tool_use:${block.name ?? "unknown"}`);
        if (typeof block.input === "object") {
          parts.push(JSON.stringify(block.input).slice(0, 800));
        }
      } else if (block?.type === "tool_result") {
        const resultText = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content);
        parts.push(resultText.slice(0, 800));
      }
    }
  }

  if (typeof parsed.message?.role === "string") {
    parts.unshift(`role:${parsed.message.role}`);
  }

  if (parsed.type === "system" && parsed.subtype) {
    parts.unshift(`system:${parsed.subtype}`);
  }

  if (parsed.parentUuid) {
    parts.unshift(`parentUuid:${parsed.parentUuid}`);
  }

  return parts.join("\n").trim();
}

function makeClaudeTitle(parsed: any, text: string): string {
  const typeLabel = parsed.type === "user"
    ? "User"
    : parsed.type === "assistant"
    ? "Assistant"
    : parsed.type === "system"
    ? `System(${parsed.subtype ?? "unknown"})`
    : `Event(${parsed.type})`;

  const first = text
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0 && !line.startsWith("role:"))
    ?.trim()
    .slice(0, 80);

  return `Claude ${typeLabel}: ${first ?? "Claude session event"}`;
}
