import fs from "node:fs";
import path from "node:path";
import { EvolveConfig, EvidenceCard } from "../types.js";
import { sourceSeen } from "../storage/database.js";
import { sha256, shortHash } from "../utils/hash.js";
import { redactSecrets } from "../utils/redact.js";

const SIGNAL_PATTERNS: Array<[string, RegExp]> = [
  ["bug", /\bbug|broken|wrong|regression|failure|failed|error\b/i],
  ["retry", /\bretry|again|rerun|second attempt|try again|redo\b/i],
  ["tests", /\btest|typecheck|lint|build|compile|run\b/i],
  ["agent-assets", /\bskill|subagent|hook|rule|memory|prompt|config\b/i],
  ["claude", /\bclaude|system prompt|tool_use|thinking\b/i],
  ["coding", /\brefactor|implement|fix|feature|function|class|file|code|write|create|add|update|change\b/i],
  ["review", /\breview|pr|pull request|check|examine|inspect|audit\b/i],
  ["task", /\btask|todo|plan|goal|objective|mission\b/i],
  ["compact", /\bcompact_boundary|compaction\b/i],
  ["evolve", /\bevolve|snapshot|rollback|diff|epoch\b/i],
  ["data", /\bdata|json|sql|database|query|api|endpoint|request\b/i],
  ["docs", /\bdoc|readme|comment|explain|description|summary\b/i],
];

export interface ClaudeIngestResult {
  cards: EvidenceCard[];
  scannedFiles: number;
  scannedEvents: number;
}

const MAX_AGE_MS = 72 * 60 * 60 * 1000;

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

      // Sample: read last 300 lines only (most recent context is at end for append-only JSONL)
      const recentLines = lines.slice(-300);

      for (const line of recentLines) {
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

// eslint-disable-next-line @typescript-eslint/require-await
async function findRecentSessionFiles(config: EvolveConfig): Promise<string[]> {
  const projectsDir = config.claude.projectsDir;
  if (!fs.existsSync(projectsDir)) return [];

  const cutoff = Date.now() - MAX_AGE_MS;
  const candidates: Array<{ path: string; mtime: number }> = [];

  // Walk project directories (faster than recursive glob)
  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of dirEntries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const projectDir = path.join(projectsDir, entry.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      if (file.name.includes("subagent") || file.name.includes("agent-")) continue;
      const filePath = path.join(projectDir, file.name);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs > cutoff) {
          candidates.push({ path: filePath, mtime: stat.mtimeMs });
        }
      } catch {
        // skip
      }
    }
  }

  return candidates
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
  if (text.length < 8) return undefined;

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

  if (parsed.type === "last-prompt") {
    parts.push(`session:${parsed.sessionId ?? "unknown"}`);
    if (parsed.leafUuid) parts.push(`last-message:${parsed.leafUuid}`);
  }

  if (parsed.type === "permission-mode") {
    parts.push(`permissions:${parsed.permissionMode ?? "unknown"}`);
  }

  if (parsed.type === "file-history-snapshot") {
    parts.push(`file-snapshot:${parsed.messageId ?? "unknown"}`);
  }

  if (parsed.type === "system" && parsed.subtype) {
    parts.push(`system:${parsed.subtype}`);
  }

  if (parsed.type === "user" || parsed.type === "assistant") {
    parts.push(`role:${parsed.type}`);
  }

  if (typeof parsed.message?.content === "string") {
    parts.push(parsed.message.content);
  } else if (Array.isArray(parsed.message?.content)) {
    for (const block of parsed.message.content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block?.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block?.type === "thinking" && typeof block.thinking === "string") {
        parts.push(`thinking: ${block.thinking.slice(0, 200)}`);
      } else if (block?.type === "tool_use") {
        parts.push(`tool_use:${block.name ?? "unknown"}`);
        if (typeof block.input === "object") {
          parts.push(JSON.stringify(block.input).slice(0, 400));
        }
      } else if (block?.type === "tool_result") {
        const resultText = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content);
        parts.push(resultText.slice(0, 400));
      }
    }
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
// ... rest of file unchanged from here
