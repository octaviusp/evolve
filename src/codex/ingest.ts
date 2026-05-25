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
  ["codex", /\bcodex|rollout|custom_tool|spawn_agent\b/i],
  ["coding", /\brefactor|implement|fix|feature|function|class|file|code|write|create|add|update|change\b/i],
  ["review", /\breview|pr|pull request|check|examine|inspect|audit\b/i],
  ["task", /\btask|todo|plan|goal|objective|mission\b/i],
  ["compact", /\bcompacted|context_compacted\b/i],
  ["evolve", /\bevolve|snapshot|rollback|diff|epoch\b/i],
  ["data", /\bdata|json|sql|database|query|api|endpoint|request\b/i],
  ["docs", /\bdoc|readme|comment|explain|description|summary\b/i],
];

export interface CodexIngestResult {
  cards: EvidenceCard[];
  scannedFiles: number;
  scannedEvents: number;
}

export async function ingestCodexEvidence(
  config: EvolveConfig,
  evolveDb: import("better-sqlite3").Database,
): Promise<CodexIngestResult> {
  const rolloutFiles = await findRecentRolloutFiles(config);
  const cards: EvidenceCard[] = [];
  let scannedFiles = 0;
  let scannedEvents = 0;

  for (const rolloutPath of rolloutFiles) {
    scannedFiles++;
    try {
      const content = await fs.promises.readFile(rolloutPath, "utf8");
      const lines = content.split("\n").filter((line) => line.trim().length > 0);

      for (const line of lines) {
        scannedEvents++;
        const hash = sha256(line);
        const sourceId = `codex:${rolloutPath}:${hash}`;
        if (sourceSeen(evolveDb, sourceId)) continue;

        const card = rolloutLineToEvidenceCard(rolloutPath, line, hash, sourceId);
        if (card) cards.push(card);
      }
    } catch {
      // skip unreadable rollouts
    }
  }

  return { cards, scannedFiles, scannedEvents };
}

const MAX_AGE_MS = 72 * 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/require-await
async function findRecentRolloutFiles(config: EvolveConfig): Promise<string[]> {
  const sessionsDir = config.codex.sessionsDir;
  if (!fs.existsSync(sessionsDir)) return [];

  const cutoff = Date.now() - MAX_AGE_MS;
  const candidates: Array<{ path: string; mtime: number }> = [];
  const now = new Date();

  // Target: today and yesterday only (YYYY/MM/DD structure)
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const d = new Date(now);
    d.setDate(d.getDate() - dayOffset);
    const dateDir = path.join(
      sessionsDir,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    );
    if (!fs.existsSync(dateDir)) continue;
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(dateDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.startsWith("rollout-") || !file.name.endsWith(".jsonl")) continue;
      const filePath = path.join(dateDir, file.name);
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
    .slice(0, config.codex.maxRolloutFilesPerEpoch)
    .map((item) => item.path);
}

function rolloutLineToEvidenceCard(
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

  const text = extractCodexText(parsed);
  if (text.length < 8) return undefined;

  const { text: redactedText, redacted } = redactSecrets(text);
  const signals = SIGNAL_PATTERNS.filter(([, pattern]) => pattern.test(redactedText)).map(
    ([signal]) => signal,
  );
  if (signals.length === 0) return undefined;

  const kind = parsed.type === "session_meta" || parsed.type === "turn_context"
    ? "session_meta"
    : parsed.type === "event_msg"
    ? "hook_event"
    : "conversation";

  const title = makeCodexTitle(parsed, redactedText);

  return {
    id,
    system: "codex",
    sourcePath,
    sourceKey: `${parsed.type}:${sourcePath.split("/").pop()}`,
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

function extractCodexText(parsed: any): string {
  const parts: string[] = [];
  const p = parsed.payload;

  if (parsed.type === "response_item") {
    if (p && typeof p === "object") {
      if (p.type) parts.push(`response:${p.type}`);
      if (p.role) parts.push(`role:${p.role}`);
      if (Array.isArray(p.content)) {
        for (const block of p.content) {
          if (typeof block === "string") {
            parts.push(block);
          } else if (typeof block === "object") {
            if (typeof block.text === "string") {
              parts.push(block.text.slice(0, 600));
            }
            if (block.summary) {
              for (const s of Array.isArray(block.summary) ? block.summary : [block.summary]) {
                if (typeof s?.text === "string") parts.push(s.text.slice(0, 400));
              }
            }
          }
        }
      }
      if (Array.isArray(p.output)) {
        for (const item of p.output) {
          if (item.type === "message" && Array.isArray(item.content)) {
            for (const block of item.content) {
              if (typeof block.text === "string") parts.push(block.text.slice(0, 600));
            }
          } else if (item.type === "function_call") {
            parts.push(`fn_call:${item.name ?? "?"}`);
          } else if (item.type === "function_call_output") {
            const out = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
            parts.push(out.slice(0, 400));
          }
        }
      }
    }
  }

  if (parsed.type === "event_msg") {
    if (p && typeof p === "object") {
      const subtype = p.type ?? p.event ?? parsed.event_msg_type ?? "unknown";
      parts.push(`event:${subtype}`);
      if (typeof p.message === "string") parts.push(p.message.slice(0, 600));
      if (typeof p.phase === "string") parts.push(`phase:${p.phase}`);
      if (p.turn_id) parts.push(`turn:${p.turn_id}`);
      if (typeof p.text_elements === "string") parts.push(p.text_elements.slice(0, 600));
      if (Array.isArray(p.text_elements)) {
        for (const t of p.text_elements) {
          if (typeof t === "string") parts.push(t.slice(0, 400));
        }
      }
      if (typeof p.memory_citation === "string") parts.push(p.memory_citation.slice(0, 400));
    } else if (typeof p === "string") {
      parts.push(`event_data:${p.slice(0, 400)}`);
    }
  }

  if (parsed.type === "session_meta") {
    if (p && typeof p === "object") {
      if (p.agent_role) parts.push(`agent_role:${p.agent_role}`);
      if (p.agent_nickname) parts.push(`agent:${p.agent_nickname}`);
      if (p.forked_from_id) parts.push(`forked_from:${p.forked_from_id}`);
      if (p.cwd) parts.push(`cwd:${p.cwd}`);
      if (p.id) parts.push(`session_id:${p.id}`);
    }
  }

  if (parsed.type === "turn_context") {
    if (p && typeof p === "object") {
      if (p.cwd) parts.push(`cwd:${p.cwd}`);
      if (p.model) parts.push(`model:${p.model}`);
      if (p.permission_profile) parts.push(`perms:${p.permission_profile}`);
      if (typeof p.user_instructions === "string") {
        parts.push(p.user_instructions.slice(0, 600));
      }
      if (p.current_date) parts.push(`date:${p.current_date}`);
    }
  }

  if (parsed.type === "compacted") {
    if (Array.isArray(p?.replacement_history ?? parsed.replacement_history)) {
      const rh = p?.replacement_history ?? parsed.replacement_history;
      parts.push(`compacted:${rh.length} replacements`);
    }
  }

  return parts.join("\n").trim();
}

function makeCodexTitle(parsed: any, text: string): string {
  const p = parsed.payload;
  const subtype = p?.type ?? p?.event_msg_type ?? "";
  const typeLabel = parsed.type === "response_item"
    ? `Response(${subtype || "message"})`
    : parsed.type === "event_msg"
    ? `Event(${subtype || "unknown"})`
    : parsed.type === "session_meta"
    ? `Session(${p?.agent_nickname ?? "root"})`
    : parsed.type === "turn_context"
    ? "TurnConfig"
    : parsed.type === "compacted"
    ? "Compaction"
    : `Event(${parsed.type})`;

  const first = text
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0 && !line.startsWith("response:") && !line.startsWith("event:"))
    ?.trim()
    .slice(0, 80);

  return `Codex ${typeLabel}: ${first ?? "Codex rollout event"}`;
}
